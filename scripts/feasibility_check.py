"""GreenWindow feasibility gate (spec Section 14).

Proves, before any building, that the free data is reachable and clean enough,
that the models run on a CPU, and that the plumbing (git, GitHub raw host, Node)
works. Writes feasibility_out/feasibility_report.md and .json.

Usage:
    python scripts/feasibility_check.py                 # full run
    python scripts/feasibility_check.py --skip-chronos  # skip the Chronos-2 download

Exit code is 1 only on a NO-GO verdict.
"""

from __future__ import annotations

import argparse
import importlib
import inspect
import json
import platform
import re
import shutil
import subprocess
import sys
import time
import traceback
import warnings
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import requests

CARBON_BASE = "https://api.carbonintensity.org.uk"
OM_FORECAST = "https://api.open-meteo.com/v1/forecast"
OM_HINDCAST = "https://historical-forecast-api.open-meteo.com/v1/forecast"
WEATHER_VARS = ["temperature_2m", "wind_speed_100m", "shortwave_radiation"]
USER_AGENT = "greenwindow-feasibility/0.1 (+https://github.com/nivesh22/greenwindow)"
RAW_PROBE_URL = "https://raw.githubusercontent.com/nivesh22/greenwindow/main/README.md"

# Provisional points for the gate only. Final coordinates and weights are chosen in T1.
LOCATIONS = [
    {"name": "London", "lat": 51.51, "lon": -0.13, "weight": 0.25},
    {"name": "Birmingham", "lat": 52.48, "lon": -1.90, "weight": 0.25},
    {"name": "Glasgow", "lat": 55.86, "lon": -4.25, "weight": 0.25},
    {"name": "Aberdeen", "lat": 57.15, "lon": -2.09, "weight": 0.25},
]

HORIZON = 48
QUANTILES = [0.1, 0.5, 0.9]
OUT_DIR = Path("feasibility_out")

SESSION = requests.Session()
SESSION.headers["User-Agent"] = USER_AGENT


# --------------------------------------------------------------------------- results


@dataclass
class Check:
    id: str
    title: str
    blocking: bool
    status: str = "SKIP"  # PASS | WARN | FAIL | SKIP | INFO
    detail: str = ""
    evidence: dict[str, Any] = field(default_factory=dict)
    seconds: float = 0.0


RESULTS: list[Check] = []
SHARED: dict[str, Any] = {}  # data passed between checks
USED_SYNTHETIC = False


def run_check(cid: str, title: str, blocking: bool, fn: Callable[[Check], None]) -> Check:
    c = Check(cid, title, blocking)
    t0 = time.perf_counter()
    try:
        fn(c)
    except Exception as e:  # a crashed check is a failed check, never a crashed gate
        c.status = "FAIL"
        c.detail = f"{type(e).__name__}: {e}"
        c.evidence["traceback"] = traceback.format_exc(limit=3)
    c.seconds = round(time.perf_counter() - t0, 2)
    RESULTS.append(c)
    mark = {"PASS": "ok ", "WARN": "!! ", "FAIL": "XX ", "SKIP": "-- ", "INFO": "i  "}[c.status]
    print(f"[{mark}] {c.id:<3} {c.title}: {c.detail}", flush=True)
    return c


# --------------------------------------------------------------------------- helpers


def get(url: str, params: dict | None = None, timeout: float = 60, tries: int = 4) -> requests.Response:
    """GET with exponential backoff on 429/5xx/timeouts (spec 6.1)."""
    last: Exception | None = None
    for i in range(tries):
        try:
            r = SESSION.get(url, params=params, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                last = RuntimeError(f"HTTP {r.status_code}")
            else:
                return r
        except requests.RequestException as e:
            last = e
        time.sleep(2**i)
    raise RuntimeError(f"GET {url} failed after {tries} tries: {last}")


def iso_min(ts: datetime) -> str:
    return ts.strftime("%Y-%m-%dT%H:%MZ")


def carbon_range(start: datetime, end: datetime) -> pd.DataFrame:
    """Half-hourly carbon intensity for [start, end]. Single request (caller keeps it <= API max)."""
    r = get(f"{CARBON_BASE}/intensity/{iso_min(start)}/{iso_min(end)}")
    r.raise_for_status()
    return carbon_frame(r.json()["data"])


def carbon_frame(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(
        {
            "from_utc": pd.to_datetime([d["from"] for d in rows], utc=True),
            "ci_actual": [d["intensity"]["actual"] for d in rows],
            "ci_forecast": [d["intensity"]["forecast"] for d in rows],
        }
    )
    df[["ci_actual", "ci_forecast"]] = df[["ci_actual", "ci_forecast"]].astype("float64")
    return df.drop_duplicates("from_utc").sort_values("from_utc").reset_index(drop=True)


def carbon_chunked(start: datetime, end: datetime, chunk_days: int) -> pd.DataFrame:
    parts, s = [], start
    while s < end:
        e = min(s + timedelta(days=chunk_days), end)
        parts.append(carbon_range(s, e))
        s = e
    return pd.concat(parts).drop_duplicates("from_utc").sort_values("from_utc").reset_index(drop=True)


def to_hourly(hh: pd.DataFrame) -> pd.DataFrame:
    """Hour-beginning UTC means of the half-hours (spec 6.1)."""
    g = hh.set_index("from_utc").groupby(pd.Grouper(freq="1h"))
    out = pd.DataFrame(
        {
            "ci_actual": g["ci_actual"].mean(),
            "ci_forecast": g["ci_forecast"].mean(),
            "n_halfhours": g["ci_actual"].count().astype("int8"),
        }
    )
    out.index.name = "ts_utc"
    return out


def weather(kind: str, params_extra: dict) -> pd.DataFrame:
    """Hourly weighted national weather from the four points. kind: 'forecast' | 'hindcast'."""
    url = OM_FORECAST if kind == "forecast" else OM_HINDCAST
    params = {
        "latitude": ",".join(str(p["lat"]) for p in LOCATIONS),
        "longitude": ",".join(str(p["lon"]) for p in LOCATIONS),
        "hourly": ",".join(WEATHER_VARS),
        "timezone": "UTC",
        "wind_speed_unit": "ms",
        **params_extra,
    }
    r = get(url, params=params)
    r.raise_for_status()
    payload = r.json()
    payload = payload if isinstance(payload, list) else [payload]
    frames = []
    for loc, p in zip(LOCATIONS, payload, strict=True):
        h = p["hourly"]
        missing = [v for v in WEATHER_VARS if v not in h]
        if missing:
            raise KeyError(f"Open-Meteo response missing variables {missing}")
        f = pd.DataFrame({v: pd.to_numeric(pd.Series(h[v]), errors="coerce") for v in WEATHER_VARS})
        f.index = pd.to_datetime(h["time"]).tz_localize("UTC")
        frames.append(f * loc["weight"])
    SHARED.setdefault("weather_units", payload[0].get("hourly_units"))
    nat = sum(frames)
    # A null at any point should stay null nationally rather than silently shrink the weighted sum.
    any_null = pd.concat([f.isna() for f in frames]).groupby(level=0).any()
    nat = nat.mask(any_null)
    nat.columns = ["temp_c", "wind100_ms", "solar_wm2"]
    nat.index.name = "ts_utc"
    return nat


def which(cmd: str, extra: list[str] = ()) -> str | None:
    found = shutil.which(cmd)
    if found:
        return found
    for d in extra:
        for name in (cmd, f"{cmd}.exe", f"{cmd}.cmd"):
            p = Path(d) / name
            if p.exists():
                return str(p)
    return None


def run_cmd(args: list[str], timeout: float = 30) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def synthetic_series(n_hours: int, seed: int = 0) -> pd.DataFrame:
    """Plausible carbon + weather series, used only when the live data cannot be fetched."""
    rng = np.random.default_rng(seed)
    idx = pd.date_range(end=pd.Timestamp.now(tz="UTC").floor("D"), periods=n_hours, freq="1h", name="ts_utc")
    t = np.arange(n_hours)
    wind = np.clip(8 + 4 * np.sin(t / 50) + rng.normal(0, 1.5, n_hours), 0, None)
    solar = np.clip(400 * np.sin((t % 24 - 6) / 12 * np.pi), 0, None)
    temp = 12 + 4 * np.sin((t % 24 - 9) / 24 * 2 * np.pi) + rng.normal(0, 1, n_hours)
    ci = 200 + 40 * np.sin((t % 24 - 12) / 24 * 2 * np.pi) - 8 * wind - 0.05 * solar + rng.normal(0, 10, n_hours)
    return pd.DataFrame({"ci_actual": ci, "temp_c": temp, "wind100_ms": wind, "solar_wm2": solar}, index=idx)


def mae(y: np.ndarray, yhat: np.ndarray) -> float:
    return float(np.mean(np.abs(np.asarray(y) - np.asarray(yhat))))


# --------------------------------------------------------------------------- A: machine


def a1(c: Check) -> None:
    v = sys.version_info
    c.evidence["python"] = platform.python_version()
    c.status = "PASS" if v >= (3, 10) else "FAIL"
    c.detail = f"Python {platform.python_version()}" + ("" if v >= (3, 11) else " (spec pins 3.11)")


def a2(c: Check, skip_chronos: bool) -> None:
    needed = ["pandas", "numpy", "statsmodels", "pyarrow", "requests"]
    if not skip_chronos:
        needed += ["torch", "chronos"]
    versions, missing = {}, []
    for mod in needed + ["psutil", "prophet"]:
        try:
            m = importlib.import_module(mod)
            versions[mod] = getattr(m, "__version__", "?")
        except Exception:
            if mod in needed:
                missing.append(mod)
            else:
                versions[mod] = None
    c.evidence["versions"] = versions
    if missing:
        c.status, c.detail = "FAIL", f"missing: {', '.join(missing)}"
    else:
        c.status = "PASS"
        c.detail = ", ".join(f"{k} {v}" for k, v in versions.items() if v) + (
            " (torch/chronos not required: --skip-chronos)" if skip_chronos else ""
        )


def a3(c: Check) -> None:
    disk_gb = shutil.disk_usage(Path.cwd()).free / 1e9
    try:
        import psutil

        ram_gb = psutil.virtual_memory().total / 1e9
    except ImportError:
        ram_gb = None
    c.evidence.update(ram_gb=ram_gb and round(ram_gb, 1), free_disk_gb=round(disk_gb, 1), cpu=platform.processor())
    ok = (ram_gb is None or ram_gb >= 8) and disk_gb >= 5
    c.status = "PASS" if ok else "WARN"
    c.detail = f"RAM {ram_gb and round(ram_gb, 1)} GB, free disk {disk_gb:.1f} GB"


# --------------------------------------------------------------------------- B: carbon API


def b1(c: Check) -> None:
    r = get(f"{CARBON_BASE}/intensity")
    r.raise_for_status()
    row = r.json()["data"][0]
    have = set(row) | set(row.get("intensity", {}))
    need = {"from", "to", "forecast", "actual", "index"}
    c.evidence["sample"] = row
    missing = need - have
    c.status = "FAIL" if missing else "PASS"
    c.detail = f"missing fields {sorted(missing)}" if missing else "fields from, to, forecast, actual, index present"


def b2(c: Check) -> None:
    now = datetime.now(UTC).replace(second=0, microsecond=0)
    r = get(f"{CARBON_BASE}/intensity/{iso_min(now)}/fw48h")
    r.raise_for_status()
    df = carbon_frame(r.json()["data"])
    future = df[df["from_utc"] > pd.Timestamp(now)]
    n = len(df)
    non_null_future_actuals = int(future["ci_actual"].notna().sum())
    SHARED["neso_fw"] = df
    c.evidence.update(
        n_halfhours=n,
        first=str(df["from_utc"].min()),
        last=str(df["from_utc"].max()),
        future_actuals_non_null=non_null_future_actuals,
    )
    c.status = "PASS" if n >= 90 else ("WARN" if n >= 48 else "FAIL")
    if non_null_future_actuals:
        c.status = "FAIL"
    c.detail = f"{n} half-hours, future actuals non-null: {non_null_future_actuals}"


def b3(c: Check) -> None:
    end = datetime.now(UTC).replace(minute=0, second=0, microsecond=0) - timedelta(days=1)
    accepted: dict[int, Any] = {}
    for days in (32, 31, 30, 28, 14, 7, 1):
        r = get(f"{CARBON_BASE}/intensity/{iso_min(end - timedelta(days=days))}/{iso_min(end)}")
        ok = r.status_code == 200 and "data" in r.json()
        accepted[days] = True if ok else r.json().get("error", {}).get("message", r.status_code)
    c.evidence["accepted_by_days"] = accepted
    max_ok = max((d for d, v in accepted.items() if v is True), default=0)
    SHARED["max_range_days"] = max_ok
    c.status = "PASS" if max_ok >= 7 else "FAIL"
    c.detail = f"largest accepted range tested: {max_ok} days"


def b4(c: Check) -> None:
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    counts = {}
    for years in (1, 2):
        s = today - timedelta(days=365 * years)
        df = carbon_range(s, s + timedelta(days=1))
        counts[f"{years}y"] = {"rows": len(df), "actual_non_null": int(df["ci_actual"].notna().sum())}
    c.evidence["counts"] = counts
    ok = all(v["actual_non_null"] > 0 for v in counts.values())
    c.status = "PASS" if ok else "FAIL"
    c.detail = ", ".join(f"{k} back: {v['actual_non_null']} actuals" for k, v in counts.items())


def b5(c: Check) -> None:
    now = datetime.now(UTC)
    end = now.replace(minute=0, second=0, microsecond=0)
    chunk = max(1, min(SHARED.get("max_range_days", 7), 28))
    # 60 days: 28 for this check, the rest so the classical models get a 56-day window.
    hh = carbon_chunked(end - timedelta(days=60), end, chunk)
    hh = hh[hh["from_utc"] < pd.Timestamp(end)]
    SHARED["carbon_hh"] = hh
    last28 = hh[hh["from_utc"] >= pd.Timestamp(end - timedelta(days=28))]
    expected = 28 * 48
    missing = expected - int(last28["ci_actual"].notna().sum())
    pct = 100 * missing / expected
    latest = hh.loc[hh["ci_actual"].notna(), "from_utc"].max()
    age_h = (pd.Timestamp(now) - latest).total_seconds() / 3600
    c.evidence.update(
        expected_halfhours=expected,
        missing_actuals=missing,
        missing_pct=round(pct, 2),
        latest_actual=str(latest),
        latest_age_h=round(age_h, 2),
    )
    if pct > 5 or age_h >= 6:
        c.status = "FAIL"
    elif pct > 1:
        c.status = "WARN"
    else:
        c.status = "PASS"
    c.detail = f"missing actuals {pct:.2f}% of last 28 days; latest actual {age_h:.1f} h old"


def b6(c: Check) -> None:
    hh = SHARED.get("carbon_hh")
    if hh is None:
        c.status, c.detail = "SKIP", "no carbon data (B5 failed)"
        return
    h = to_hourly(hh)
    h = h[h.index >= h.index.max() - pd.Timedelta(days=28)]
    snaive = h["ci_actual"].shift(24)
    m = h["ci_actual"].notna() & h["ci_forecast"].notna() & snaive.notna()
    neso_mae = mae(h.loc[m, "ci_actual"], h.loc[m, "ci_forecast"])
    sn_mae = mae(h.loc[m, "ci_actual"], snaive[m])
    c.evidence.update(n_hours=int(m.sum()), neso_mae=round(neso_mae, 2), snaive24_mae=round(sn_mae, 2))
    c.status = "INFO"
    c.detail = (
        f"last 28 days hourly MAE: NESO as published {neso_mae:.1f}, seasonal naive 24h {sn_mae:.1f} "
        "(NESO lead time unknown, V2)"
    )


# --------------------------------------------------------------------------- C: weather API


def c1(c: Check) -> None:
    w = weather("forecast", {"forecast_days": 3, "past_days": 1})
    now = pd.Timestamp.now(tz="UTC").floor("h")
    fut = w[w.index > now].iloc[:HORIZON]
    SHARED["weather_fc"] = w
    nulls = int(fut.isna().sum().sum())
    c.evidence.update(units=SHARED.get("weather_units"), future_hours=len(fut), nulls=nulls, last=str(w.index.max()))
    c.status = "PASS" if len(fut) >= HORIZON and nulls == 0 else "FAIL"
    c.detail = f"{len(fut)} future hours, {nulls} nulls in next 48h"


def c2(c: Check) -> None:
    end = datetime.now(UTC).date() - timedelta(days=1)
    start = end - timedelta(days=60)
    w = weather("hindcast", {"start_date": start.isoformat(), "end_date": end.isoformat()})
    SHARED["weather_hc"] = w
    expected = (end - start).days * 24 + 24
    present = int(w.notna().all(axis=1).sum())
    null_pct = 100 * float(w.isna().any(axis=1).mean())
    c.evidence.update(
        host=OM_HINDCAST,
        start=str(start),
        end=str(end),
        expected_hours=expected,
        rows=len(w),
        complete_hours=present,
        null_pct=round(null_pct, 2),
        units=SHARED.get("weather_units"),
    )
    c.status = "PASS" if present >= 0.9 * expected and null_pct <= 5 else "FAIL"
    c.detail = f"{present}/{expected} complete hours over 61 days, {null_pct:.2f}% rows with nulls"


def c3(c: Check) -> None:
    end = datetime.now(UTC).date() - timedelta(days=365)
    start = end - timedelta(days=6)
    w = weather("hindcast", {"start_date": start.isoformat(), "end_date": end.isoformat()})
    null_pct = 100 * float(w.isna().any(axis=1).mean()) if len(w) else 100.0
    c.evidence.update(start=str(start), end=str(end), rows=len(w), null_pct=round(null_pct, 2))
    c.status = "PASS" if len(w) and null_pct <= 5 else "WARN"
    c.detail = f"{len(w)} rows a year back, {null_pct:.2f}% with nulls"


def c4(c: Check) -> None:
    hh, w = SHARED.get("carbon_hh"), SHARED.get("weather_hc")
    if hh is None or w is None:
        c.status, c.detail = "FAIL", "needs B5 and C2 data"
        return
    h = to_hourly(hh)
    h = h[h["ci_actual"].notna()]
    h = h[(h.index >= w.index.min()) & (h.index <= w.index.max())]
    overlap = h.index.intersection(w.dropna().index)
    pct = 100 * len(overlap) / max(len(h), 1)
    c.evidence.update(carbon_hours=len(h), overlap_hours=len(overlap), overlap_pct=round(pct, 2))
    c.status = "PASS" if pct >= 95 else "FAIL"
    c.detail = f"{pct:.1f}% of carbon hours have weather"
    obs = to_hourly(hh)[["ci_actual"]].join(w, how="inner")
    SHARED["obs"] = obs


# --------------------------------------------------------------------------- D: models


def model_frame() -> tuple[pd.DataFrame, pd.Timestamp]:
    """Hourly obs with covariates, and an origin with 48 actual hours after it."""
    global USED_SYNTHETIC
    obs = SHARED.get("obs")
    if obs is None or obs["ci_actual"].notna().sum() < 24 * 30:
        USED_SYNTHETIC = True
        obs = synthetic_series(24 * 60)
    obs = obs.copy()
    obs["ci_actual"] = obs["ci_actual"].interpolate(limit=3)
    last_actual = obs["ci_actual"].last_valid_index()
    origin = (last_actual - pd.Timedelta(hours=HORIZON - 1)).floor("D")
    return obs, origin


def split(obs: pd.DataFrame, origin: pd.Timestamp, window_days: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    hist = obs[(obs.index < origin) & (obs.index >= origin - pd.Timedelta(days=window_days))]
    fut = obs[(obs.index >= origin)].iloc[:HORIZON]
    return hist, fut


def fourier(index: pd.DatetimeIndex, period: int, k: int) -> pd.DataFrame:
    t = (index.asi8 // 3_600_000_000_000).astype(float)  # hours since epoch
    cols = {}
    for i in range(1, k + 1):
        cols[f"s{period}_{i}"] = np.sin(2 * np.pi * i * t / period)
        cols[f"c{period}_{i}"] = np.cos(2 * np.pi * i * t / period)
    return pd.DataFrame(cols, index=index)


def exog(df: pd.DataFrame) -> pd.DataFrame:
    return pd.concat(
        [df[["temp_c", "wind100_ms", "solar_wm2"]], fourier(df.index, 24, 3), fourier(df.index, 168, 2)], axis=1
    )


def d1(c: Check) -> None:
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    obs, origin = model_frame()
    hist, fut = split(obs, origin, 56)
    hist = hist.dropna()
    t0 = time.perf_counter()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        res = SARIMAX(hist["ci_actual"], exog=exog(hist), order=(2, 0, 1), trend="c").fit(disp=False, maxiter=200)
        fc = res.get_forecast(steps=len(fut), exog=exog(fut))
    fit_s = time.perf_counter() - t0
    pred = fc.predicted_mean.to_numpy()
    lo, hi = fc.conf_int(alpha=0.2).to_numpy().T
    err = mae(fut["ci_actual"], pred)
    c.evidence.update(
        spec="SARIMAX(2,0,1)+const, exog: weather + Fourier(24,k=3) + Fourier(168,k=2) [gate only, not final]",
        train_hours=len(hist),
        origin=str(origin),
        fit_seconds=round(fit_s, 2),
        mae_48h=round(err, 2),
        coverage80=round(float(np.mean((fut["ci_actual"] >= lo) & (fut["ci_actual"] <= hi))), 2),
    )
    SHARED["mae_sarimax"] = err
    c.status = "PASS" if fit_s < 60 and len(pred) == HORIZON else ("WARN" if len(pred) == HORIZON else "FAIL")
    c.detail = f"fit+forecast {fit_s:.1f} s on {len(hist)} h, 48h MAE {err:.1f}"


def d2(c: Check) -> None:
    from statsmodels.tsa.statespace.structural import UnobservedComponents

    obs, origin = model_frame()
    hist, fut = split(obs, origin, 56)
    hist = hist.dropna()
    cols = ["temp_c", "wind100_ms", "solar_wm2"]
    t0 = time.perf_counter()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        res = UnobservedComponents(
            hist["ci_actual"],
            level="local level",
            freq_seasonal=[{"period": 24, "harmonics": 3}],
            exog=hist[cols],
        ).fit(disp=False, maxiter=200)
        pred = res.get_forecast(steps=len(fut), exog=fut[cols]).predicted_mean.to_numpy()
    s = time.perf_counter() - t0
    err = mae(fut["ci_actual"], pred)
    c.evidence.update(fit_seconds=round(s, 2), mae_48h=round(err, 2))
    c.status = "PASS" if s < 90 and len(pred) == HORIZON else "WARN"
    c.detail = f"{s:.1f} s, 48h MAE {err:.1f}"


def d3(c: Check) -> None:
    try:
        from prophet import Prophet
    except Exception:
        c.status, c.detail = "SKIP", "prophet not installed (optional course model)"
        return
    obs, origin = model_frame()
    hist, fut = split(obs, origin, 56)
    hist = hist.dropna()
    cols = ["temp_c", "wind100_ms", "solar_wm2"]

    def prep(df: pd.DataFrame) -> pd.DataFrame:
        out = df[cols].copy()
        out["ds"] = df.index.tz_localize(None)
        out["y"] = df["ci_actual"].to_numpy()
        return out.reset_index(drop=True)

    t0 = time.perf_counter()
    m = Prophet(daily_seasonality=True, weekly_seasonality=True, yearly_seasonality=False)
    for col in cols:
        m.add_regressor(col)
    m.fit(prep(hist))
    out = m.predict(prep(fut).drop(columns="y"))
    s = time.perf_counter() - t0
    err = mae(fut["ci_actual"], out["yhat"])
    c.evidence.update(seconds=round(s, 2), rows=len(out), mae_48h=round(err, 2))
    c.status = "PASS" if len(out) == HORIZON else "FAIL"
    c.detail = f"{len(out)} rows in {s:.1f} s, 48h MAE {err:.1f}"


def d4(c: Check, skip: bool) -> None:
    if skip:
        c.status, c.detail = "SKIP", "--skip-chronos"
        return
    import psutil
    import torch
    from chronos import Chronos2Pipeline

    torch.manual_seed(0)
    sig = inspect.signature(Chronos2Pipeline.predict_df)
    c.evidence["predict_df_signature"] = str(sig)  # V5 evidence
    params = set(sig.parameters)

    proc = psutil.Process()
    rss0 = proc.memory_info().rss
    t0 = time.perf_counter()
    pipe = Chronos2Pipeline.from_pretrained("amazon/chronos-2", device_map="cpu")
    load_s = time.perf_counter() - t0

    obs, origin = model_frame()
    hist, fut = split(obs, origin, 28)
    hist = hist.copy()
    cov = ["temp_c", "wind100_ms", "solar_wm2"]

    def long(df: pd.DataFrame, with_target: bool, with_cov: bool) -> pd.DataFrame:
        out = pd.DataFrame({"id": "gb", "timestamp": df.index.tz_localize(None)})
        if with_target:
            out["target"] = df["ci_actual"].to_numpy()
        if with_cov:
            for col in cov:
                out[col] = df[col].to_numpy()
        return out

    # Pass only the keyword names the installed version actually has (V5: never assume a signature).
    def call(context: pd.DataFrame, future: pd.DataFrame | None) -> pd.DataFrame:
        kw: dict[str, Any] = {}
        for name, val in (
            ("prediction_length", HORIZON),
            ("quantile_levels", QUANTILES),
            ("id_column", "id"),
            ("timestamp_column", "timestamp"),
            ("target", "target"),
        ):
            if name in params:
                kw[name] = val
        if future is not None:
            if "future_df" not in params:
                raise TypeError(f"predict_df has no future_df parameter: {sig}")
            kw["future_df"] = future
        return pipe.predict_df(context, **kw)

    runs = {}
    for label, ctx, futdf in (
        ("univariate", long(hist, True, False), None),
        ("covariates", long(hist, True, True), long(fut, False, True)),
    ):
        call(ctx, futdf)  # warm-up
        t1 = time.perf_counter()
        out = call(ctx, futdf)
        warm = time.perf_counter() - t1
        qcols = [col for col in out.columns if str(col) in {"0.1", "0.5", "0.9"}]
        q = out[sorted(qcols, key=float)].to_numpy() if len(qcols) == 3 else None
        mono = bool(q is not None and np.all(np.diff(q, axis=1) >= -1e-6))
        med = out[[col for col in qcols if str(col) == "0.5"][0]].to_numpy() if qcols else None
        runs[label] = {
            "rows": len(out),
            "columns": [str(x) for x in out.columns],
            "warm_seconds": round(warm, 2),
            "quantiles_monotone": mono,
            "mae_48h": None if med is None else round(mae(fut["ci_actual"], med), 2),
        }
    peak_mb = (proc.memory_info().rss - rss0) / 1e6
    c.evidence.update(load_seconds=round(load_s, 1), rss_increase_mb=round(peak_mb), context_hours=len(hist), runs=runs)
    worst = max(r["warm_seconds"] for r in runs.values())
    ok = all(r["rows"] == HORIZON and r["quantiles_monotone"] for r in runs.values())
    if not ok or worst > 600:
        c.status = "FAIL"
    elif worst > 120:
        c.status = "WARN"
    else:
        c.status = "PASS"
    c.detail = "; ".join(
        f"{k}: {v['rows']} rows, warm {v['warm_seconds']} s, MAE {v['mae_48h']}" for k, v in runs.items()
    )


# --------------------------------------------------------------------------- E: toolchain


GH_PATHS = [r"C:\Program Files\GitHub CLI"]


def e1(c: Check) -> None:
    git = which("git")
    c.status = "PASS" if git else "WARN"
    c.detail = run_cmd([git, "--version"]).stdout.strip() if git else "git not found"


def e2(c: Check) -> None:
    gh = which("gh", GH_PATHS)
    if not gh:
        c.status, c.detail = "WARN", "gh not found"
        return
    st = run_cmd([gh, "auth", "status"])
    text = st.stdout + st.stderr
    acct = re.search(r"account (\S+)", text)
    c.status = "PASS" if st.returncode == 0 else "WARN"
    c.detail = f"logged in as {acct.group(1)}" if acct and st.returncode == 0 else "gh present, not logged in"


def e3(c: Check) -> None:
    urls = {
        "github_api": "https://api.github.com",
        "raw": RAW_PROBE_URL,
        "huggingface": "https://huggingface.co/amazon/chronos-2",
    }
    codes = {}
    for k, u in urls.items():
        try:
            codes[k] = get(u, timeout=30).status_code
        except (requests.RequestException, RuntimeError) as e:
            codes[k] = str(e)
    c.evidence["status_codes"] = codes
    ok = all(isinstance(v, int) and v < 400 for v in codes.values())
    c.status = "PASS" if ok else "FAIL"
    c.detail = ", ".join(f"{k} {v}" for k, v in codes.items())


def e4(c: Check) -> None:
    r = requests.get(RAW_PROBE_URL, headers={"Origin": "https://greenwindow.vercel.app"}, timeout=30)
    acao = r.headers.get("Access-Control-Allow-Origin")
    cc = r.headers.get("Cache-Control", "")
    m = re.search(r"max-age=(\d+)", cc)
    max_age = int(m.group(1)) if m else None
    c.evidence.update(url=RAW_PROBE_URL, status=r.status_code, access_control_allow_origin=acao, cache_control=cc)
    if not acao:
        c.status = "FAIL"
    elif max_age is None or max_age > 900:
        c.status = "WARN"
    else:
        c.status = "PASS"
    c.detail = f"Access-Control-Allow-Origin: {acao}; Cache-Control: {cc}"


def e5(c: Check) -> None:
    node, npm = which("node"), which("npm")
    if not node:
        c.status, c.detail = "FAIL", "node not found"
        return
    v = run_cmd([node, "--version"]).stdout.strip()
    npm_v = run_cmd([npm, "--version"], timeout=60).stdout.strip() if npm else None
    major = int(v.lstrip("v").split(".")[0])
    c.evidence.update(node=v, npm=npm_v)
    c.status = "PASS" if major >= 20 and npm_v else "FAIL"
    c.detail = f"node {v}, npm {npm_v}"


def e6(c: Check) -> None:
    r = SESSION.get(
        "https://registry.npmjs.org/react", timeout=30, headers={"Accept": "application/vnd.npm.install-v1+json"}
    )
    c.status = "PASS" if r.status_code == 200 else "FAIL"
    c.detail = f"HTTP {r.status_code}"


def e7(c: Check) -> None:
    v = which("vercel")
    c.status = "PASS" if v else "INFO"
    c.detail = "vercel CLI present" if v else "not installed (optional; Vercel MCP or web UI can deploy)"


# --------------------------------------------------------------------------- report


def verdict() -> str:
    if any(r.status == "FAIL" and r.blocking for r in RESULTS):
        return "NO-GO"
    if (
        any(r.status in ("WARN", "FAIL") for r in RESULTS)
        or USED_SYNTHETIC
        or any(r.status == "SKIP" and r.blocking for r in RESULTS)
    ):
        return "CONDITIONAL"
    return "GO"


def write_report(v: str, args: argparse.Namespace) -> None:
    OUT_DIR.mkdir(exist_ok=True)
    meta = {
        "generated_at_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "verdict": v,
        "synthetic_model_data": USED_SYNTHETIC,
        "args": vars(args),
        "platform": platform.platform(),
    }
    (OUT_DIR / "feasibility_report.json").write_text(
        json.dumps({**meta, "checks": [asdict(r) for r in RESULTS]}, indent=2, default=str), encoding="utf-8"
    )

    lines = [
        "# GreenWindow feasibility report",
        "",
        f"- Generated: {meta['generated_at_utc']}",
        f"- Verdict: **{v}**",
        f"- Model checks on synthetic data: {USED_SYNTHETIC}",
        f"- Flags: {' '.join(sys.argv[1:]) or '(none)'}",
        f"- Platform: {meta['platform']}",
        "",
        "| ID | Check | Blocking | Status | Detail | Seconds |",
        "|----|-------|----------|--------|--------|---------|",
    ]
    for r in RESULTS:
        detail = r.detail.replace("|", "\\|")
        lines.append(f"| {r.id} | {r.title} | {'yes' if r.blocking else 'no'} | {r.status} | {detail} | {r.seconds} |")

    ev = {r.id: r for r in RESULTS}

    def e(cid: str, key: str) -> Any:
        return ev[cid].evidence.get(key) if cid in ev else None

    lines += [
        "",
        "## Evidence (for spec Section 2.2)",
        "",
        f"- **V1 (Carbon API range):** `/intensity/{{from}}/{{to}}` and `/intensity/{{from}}/fw48h` both respond. "
        f"Range test by days: `{e('B3', 'accepted_by_days')}`. Largest accepted: {SHARED.get('max_range_days')} days.",
        f"- **V2 (NESO forecast vintage):** not answerable from one run. Last-28-day MAE as published: "
        f"NESO {e('B6', 'neso_mae')}, seasonal naive 24h {e('B6', 'snaive24_mae')}. Stored snapshots will settle it.",
        f"- **V3 (Historical Forecast API):** host `{OM_HINDCAST}`, params `latitude`, `longitude` (comma lists), "
        f"`hourly`, `start_date`, `end_date`, `timezone=UTC`, `wind_speed_unit=ms`. "
        f"{e('C2', 'complete_hours')}/{e('C2', 'expected_hours')} complete hours.",
        f"- **V4 (variables and units):** `{', '.join(WEATHER_VARS)}`; units returned: `{SHARED.get('weather_units')}`.",
        f"- **V5 (Chronos-2 predict_df):** `{e('D4', 'predict_df_signature') or 'not run'}`",
        f"- **V8 (Chronos-2 CPU cost):** load {e('D4', 'load_seconds')} s, RSS increase {e('D4', 'rss_increase_mb')} MB, "
        f"runs `{e('D4', 'runs')}`",
        f"- **V9 (raw host CORS):** `{e('E4', 'access_control_allow_origin')}`, `{e('E4', 'cache_control')}`",
        "",
        "## Notes",
        "",
        "- Weather points and equal weights here are provisional for the gate; T1 sets the real ones.",
        "- The single-origin MAE numbers are smoke tests, not evidence about which model is better (spec 14.6).",
        "- The SARIMAX/UCM specifications here are placeholders until the course specifications are confirmed (spec 13.1 Q3).",
    ]
    (OUT_DIR / "feasibility_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-chronos", action="store_true", help="skip the Chronos-2 download and D4")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    np.random.seed(0)

    run_check("A1", "Python version", True, a1)
    run_check("A2", "Packages importable", True, lambda c: a2(c, args.skip_chronos))
    run_check("A3", "Machine size", False, a3)
    run_check("B1", "Carbon API reachable, schema", True, b1)
    run_check("B2", "48h forward view", True, b2)
    run_check("B3", "Max date range per request", True, b3)
    run_check("B4", "History 1 and 2 years back", True, b4)
    run_check("B5", "Last 28 days complete and fresh", True, b5)
    run_check("B6", "NESO vs seasonal naive (info)", False, b6)
    run_check("C1", "Weather forecast next 48h", True, c1)
    run_check("C2", "Historical Forecast API", True, c2)
    run_check("C3", "Hindcast 12 months back", False, c3)
    run_check("C4", "Carbon and weather align", True, c4)
    run_check("D1", "SARIMAX with covariates", True, d1)
    run_check("D2", "Structural model (UCM)", False, d2)
    run_check("D3", "Prophet with regressors", False, d3)
    run_check("D4", "Chronos-2 on CPU", True, lambda c: d4(c, args.skip_chronos))
    run_check("E1", "git present", False, e1)
    run_check("E2", "gh present and logged in", False, e2)
    run_check("E3", "GitHub, raw host, Hugging Face reachable", True, e3)
    run_check("E4", "Raw host CORS for browser reads", True, e4)
    run_check("E5", "Node 20+ and npm", True, e5)
    run_check("E6", "npm registry reachable", True, e6)
    run_check("E7", "Vercel CLI (optional)", False, e7)

    v = verdict()
    write_report(v, args)
    print(f"\nVerdict: {v}. Report: {OUT_DIR / 'feasibility_report.md'}")
    return 1 if v == "NO-GO" else 0


if __name__ == "__main__":
    sys.exit(main())
