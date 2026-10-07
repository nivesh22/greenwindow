"""Rolling-origin backtest (spec 6.4, 8.2). `python -m greenwindow.backtest.runner [--end YYYY-MM-DD]`

- Observations are rebuilt from the APIs with Historical Forecast weather only (Decision D3), so the run
  needs no pipeline state. Future covariates at each origin are the hindcast weather for those hours:
  better than a real 1-2-day-ahead forecast, which is the documented optimism bias (spec 5.3 item 3).
- Origins: daily at 00:00 UTC over the last `--days` days, the last one at least 48h before the latest actual.
- Every model sees the same rolling window (D8). Sensitivity runs use every third origin.
- Outputs: backtest_out/backtest_results.parquet, web/public/backtest_summary.json, docs/results.md.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import numpy as np
import pandas as pd

from greenwindow.backtest.summary import summarize, write_results_md
from greenwindow.config import ROOT, load_locations, load_settings
from greenwindow.export.app_json import iso
from greenwindow.ingest.build_observations import build_observations
from greenwindow.ingest.carbon import fetch_carbon_actuals
from greenwindow.ingest.weather import fetch_weather, national_weather
from greenwindow.models.base import COVARIATES, Forecaster, forecast_at, future_index
from greenwindow.models.registry import live_models

log = logging.getLogger("greenwindow.backtest")
OUT_DIR = ROOT / "backtest_out"
SUMMARY_PATH = ROOT / "web" / "public" / "backtest_summary.json"
RESULTS_MD = ROOT / "docs" / "results.md"
SENSITIVITY = {"classical_window_days": [28, 84], "chronos_context_days": [14, 56]}


def load_history(end: pd.Timestamp, days: int, max_window_days: int) -> tuple[pd.DataFrame, pd.Series]:
    """Observations with hindcast weather, and the NESO forecast as published (hourly), up to `end`."""
    settings, locs = load_settings(), load_locations()
    start = end - pd.Timedelta(days=days + max_window_days + 3)
    carbon = fetch_carbon_actuals(start, end, settings.carbon_chunk_days)
    wx = national_weather(fetch_weather("hindcast", locs, start=start.date(), end=end.date()), locs)
    obs = build_observations(carbon, wx)
    published = carbon.set_index("from_utc")["ci_forecast_published"]
    neso = published.groupby(published.index.floor("h")).mean()
    return obs, neso


def origins_for(obs: pd.DataFrame, days: int, horizon: int) -> list[pd.Timestamp]:
    last_actual = obs["ci_actual"].last_valid_index()
    last_origin = (last_actual - pd.Timedelta(hours=horizon - 1)).floor("D")
    return list(pd.date_range(end=last_origin, periods=days, freq="D"))


def _rows(fc: pd.DataFrame, model: str, origin: pd.Timestamp, setting: str, value: int) -> pd.DataFrame:
    fc = fc.rename(columns={"q0.1": "q10", "q0.5": "q50", "q0.9": "q90"})
    return pd.DataFrame(
        {
            "origin_utc": origin,
            "model": model,
            "target_ts_utc": fc.index,
            "horizon_h": np.arange(1, len(fc) + 1),
            "mean": fc["mean"].to_numpy(),
            "q10": fc["q10"].to_numpy(),
            "q50": fc["q50"].to_numpy(),
            "q90": fc["q90"].to_numpy(),
            "setting": setting,
            "setting_value": value,
        }
    )


def run_one(job: tuple[Forecaster, pd.DataFrame, pd.Timestamp, int, tuple[float, ...], str, int]) -> pd.DataFrame | str:
    model, obs, origin, horizon, quantiles, setting, value = job
    try:
        fc = forecast_at(model, obs, origin, obs if model.uses_covariates else None, horizon, quantiles)
        return _rows(fc, model.name, origin, setting, value)
    except Exception as e:  # recorded, never fatal: one model failing must not stop the backtest
        return f"{model.name} @ {origin:%Y-%m-%d} ({setting}={value}): {type(e).__name__}: {e}"


def build_jobs(obs: pd.DataFrame, origins: list[pd.Timestamp], models: list[Forecaster], settings) -> list[tuple]:
    h, q = settings.horizon_h, settings.quantiles
    jobs = []
    for origin in origins:
        window = obs[obs.index < origin + pd.Timedelta(hours=h)]  # rows at/after origin only feed future covariates
        for m in models:
            default = settings.chronos_context_days if m.family == "foundation" else settings.classical_window_days
            setting = "chronos_context_days" if m.family == "foundation" else "classical_window_days"
            jobs.append((m, window, origin, h, q, setting, default))
    sens_origins = origins[::3]
    for origin in sens_origins:
        window = obs[obs.index < origin + pd.Timedelta(hours=h)]
        for m in models:
            if m.family == "benchmark":
                continue
            setting = "chronos_context_days" if m.family == "foundation" else "classical_window_days"
            for days in SENSITIVITY[setting]:
                jobs.append((replace(m, window_hours=days * 24), window, origin, h, q, setting, days))
    return jobs


def run_backtest(end: pd.Timestamp, days: int, workers: int, include_chronos: bool = True) -> dict[str, Any]:
    settings = load_settings()
    t0 = time.perf_counter()
    max_window = max(SENSITIVITY["classical_window_days"] + [settings.classical_window_days])
    obs, neso = load_history(end, days, max_window)
    origins = origins_for(obs, days, settings.horizon_h)
    models = live_models(settings, include_chronos)
    jobs = build_jobs(obs, origins, models, settings)
    log.info("%d origins %s..%s, %d model runs", len(origins), origins[0].date(), origins[-1].date(), len(jobs))

    heavy = [j for j in jobs if j[0].family == "foundation"]  # torch stays in the main process
    light = [j for j in jobs if j[0].family != "foundation"]
    results: list[pd.DataFrame | str] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        results += list(pool.map(run_one, light, chunksize=4))
    results += [run_one(j) for j in heavy]
    failures = [r for r in results if isinstance(r, str)]
    for f in failures:
        log.warning("failed: %s", f)

    frames = [r for r in results if isinstance(r, pd.DataFrame)]
    for origin in origins:  # NESO forecast as published (lead time unknown, spec 5.3 item 7)
        idx = future_index(origin, settings.horizon_h)
        vals = neso.reindex(idx)
        if vals.notna().all():
            frames.append(
                _rows(
                    pd.DataFrame({"mean": vals, "q0.1": np.nan, "q0.5": vals, "q0.9": np.nan}, index=idx),
                    "neso_published",
                    origin,
                    "default",
                    0,
                )
            )
    res = pd.concat(frames, ignore_index=True)
    res = res.join(obs["ci_actual"].rename("actual"), on="target_ts_utc")
    res = res.join(obs[[*COVARIATES, "wind100"]], on="target_ts_utc")
    OUT_DIR.mkdir(exist_ok=True)
    res.to_parquet(OUT_DIR / "backtest_results.parquet")

    seconds = time.perf_counter() - t0
    summary, tables = summarize(res, obs, origins, settings, seconds)
    SUMMARY_PATH.write_text(json.dumps(summary, allow_nan=False, indent=1), encoding="utf-8")
    write_results_md(RESULTS_MD, summary, tables, failures, seconds)
    log.info("done in %.1f min; %d failures", seconds / 60, len(failures))
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description="Rolling-origin backtest (spec 6.4).")
    ap.add_argument("--end", help="UTC date to end the data at (default: now). Pin it to reproduce a run.")
    ap.add_argument("--days", type=int, default=90, help="number of daily origins")
    ap.add_argument("--workers", type=int, default=max(1, min(4, (os.cpu_count() or 2) - 1)))
    ap.add_argument("--no-chronos", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    end = pd.Timestamp(args.end, tz="UTC") if args.end else pd.Timestamp(datetime.now(UTC)).floor("h")
    run_backtest(end, args.days, args.workers, include_chronos=not args.no_chronos)
    print(f"wrote {SUMMARY_PATH} and {RESULTS_MD}; generated {iso(pd.Timestamp(datetime.now(UTC)))}")


if __name__ == "__main__":
    main()
