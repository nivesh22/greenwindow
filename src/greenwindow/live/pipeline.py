"""One live pipeline run (spec 4.2, 6.6). `python -m greenwindow.live.pipeline`

Origin choice: the forecast origin is the hour after the latest actual (not the wall-clock hour), so no
model ever needs imputed trailing values. `run_id` is that origin hour. See docs/decisions.md.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pandas as pd

from greenwindow.config import Settings, load_locations, load_settings
from greenwindow.export.app_json import build_files, write_files
from greenwindow.features.calendar import bank_holiday_flag
from greenwindow.ingest.build_observations import build_observations, merge_observations
from greenwindow.ingest.carbon import fetch_carbon_actuals, fetch_neso_forward_forecast
from greenwindow.ingest.weather import fetch_weather, national_weather
from greenwindow.live import store
from greenwindow.live.scorer import apply_retention, score_snapshots
from greenwindow.models import blend
from greenwindow.models.base import COVARIATES, forecast_at, future_index
from greenwindow.models.registry import NESO, live_models
from greenwindow.schemas import OBSERVATION_COLUMNS, validate_observations

log = logging.getLogger("greenwindow.pipeline")


@dataclass
class RunReport:
    run_id: str = ""
    ok: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)
    skipped: dict[str, str] = field(default_factory=dict)
    seconds: dict[str, float] = field(default_factory=dict)


def models_meta(settings: Settings, include_chronos: bool = True) -> list[dict[str, Any]]:
    ms = [
        {"name": m.name, "label": m.label, "family": m.family, "uses_covariates": m.uses_covariates}
        for m in live_models(settings, include_chronos)
    ]
    if include_chronos:
        ms.append(blend.META)
    return ms + [NESO]


def run_id_for(origin: pd.Timestamp) -> str:
    return origin.strftime("%Y%m%dT%H")


def refresh_observations(now: pd.Timestamp, settings: Settings) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Steps 1 and 3: update observations; return them and the national weather frame (past week + next days)."""
    locs = load_locations()
    old = store.read_table("observations")
    if old is not None and set(OBSERVATION_COLUMNS) - set(old.columns):
        # a new derived column: rebuild from the APIs rather than leave history half-filled
        log.info("stored observations lack %s; re-bootstrapping", sorted(set(OBSERVATION_COLUMNS) - set(old.columns)))
        old = None
    recent_wx = national_weather(fetch_weather("forecast", locs, past_days=settings.recent_refresh_days), locs)
    if old is None:
        start = now - pd.Timedelta(days=settings.bootstrap_days)
        log.info("bootstrapping %d days of history", settings.bootstrap_days)
        hind = national_weather(fetch_weather("hindcast", locs, start=start.date(), end=now.date()), locs)
        wx = recent_wx.combine_first(hind)
    else:
        start = now - pd.Timedelta(days=settings.recent_refresh_days)
        wx = recent_wx
    carbon = fetch_carbon_actuals(start, now, settings.carbon_chunk_days)
    new = build_observations(carbon, wx)
    if old is not None:
        # keep older weather where the refresh window has none
        new = new.fillna(old.reindex(new.index)[new.columns])
    obs = merge_observations(old, new)
    obs = obs.loc[: obs["ci_actual"].last_valid_index()]  # no trailing rows without actuals
    return validate_observations(obs), recent_wx


def neso_rows(origin: pd.Timestamp, horizon: int) -> pd.DataFrame:
    hh = fetch_neso_forward_forecast(origin.to_pydatetime())
    hourly = hh.set_index("from_utc")["ci_forecast"].groupby(lambda t: t.floor("h")).mean()
    idx = future_index(origin, horizon)
    hourly = hourly.reindex(idx)
    if hourly.isna().any():
        raise ValueError(f"NESO forward forecast covers {hourly.notna().sum()}/{horizon} hours")
    return pd.DataFrame({"mean": hourly, "q10": float("nan"), "q50": hourly, "q90": float("nan")}, index=idx)


def to_snapshot(fc: pd.DataFrame, model: str, run_id: str, origin: pd.Timestamp) -> pd.DataFrame:
    fc = fc.rename(columns={"q0.1": "q10", "q0.5": "q50", "q0.9": "q90"})
    return pd.DataFrame(
        {
            "run_id": run_id,
            "issued_at_utc": origin,
            "model": model,
            "target_ts_utc": fc.index,
            "horizon_h": range(1, len(fc) + 1),
            "mean": fc["mean"].to_numpy(),
            "q10": fc["q10"].to_numpy(),
            "q50": fc["q50"].to_numpy(),
            "q90": fc["q90"].to_numpy(),
        }
    )


def run_pipeline(now: datetime, include_chronos: bool = True) -> RunReport:
    settings = load_settings()
    now_ts = pd.Timestamp(now).tz_convert("UTC").floor("h")
    report = RunReport()

    obs, wx = refresh_observations(now_ts, settings)
    origin = obs["ci_actual"].last_valid_index() + pd.Timedelta(hours=1)
    run_id = report.run_id = run_id_for(origin)
    horizon, q = settings.horizon_h, settings.quantiles
    log.info("run %s: %d observation rows up to %s", run_id, len(obs), obs.index.max())

    fut = wx.reindex(future_index(origin, horizon))
    fut["is_bank_holiday"] = bank_holiday_flag(fut.index)
    covariates_ok = not fut[COVARIATES].isna().any().any()

    new_rows = []
    try:
        new_rows.append(to_snapshot(neso_rows(origin, horizon), "neso", run_id, origin))
        report.ok.append("neso")
    except Exception as e:  # fail one model, not the run
        report.failed["neso"] = f"{type(e).__name__}: {e}"

    for model in live_models(settings, include_chronos):
        if model.uses_covariates and not covariates_ok:
            report.skipped[model.name] = "weather forecast shorter than horizon"
            continue
        t0 = time.perf_counter()
        try:
            fc = forecast_at(model, obs, origin, fut if model.uses_covariates else None, horizon, q)
            new_rows.append(to_snapshot(fc, model.name, run_id, origin))
            report.ok.append(model.name)
        except Exception as e:
            report.failed[model.name] = f"{type(e).__name__}: {e}"
        report.seconds[model.name] = round(time.perf_counter() - t0, 2)

    if not new_rows:
        raise RuntimeError(f"every model failed: {report.failed}")

    old = store.read_table("forecast_snapshots")
    kept = [old[old["run_id"] != run_id]] if old is not None else []  # same run_id: replace (idempotent)
    snaps = pd.concat([*kept, *new_rows], ignore_index=True)
    blended = blend.blend_rows(snaps, horizon)  # this run, plus any earlier run that has both components
    if run_id in set(blended["run_id"]):
        report.ok.append(blend.NAME)
    snaps = pd.concat([snaps, blended], ignore_index=True)
    snaps = apply_retention(snaps, now_ts, settings.retention_days)
    scores = score_snapshots(snaps, obs)

    files = build_files(
        obs, snaps, scores, models_meta(settings, include_chronos), pd.Timestamp(datetime.now(UTC)), horizon
    )
    write_files(files, store.app_data_dir())  # validates first; on failure the previous files stay
    store.write_table("observations", obs)
    store.write_table("forecast_snapshots", snaps)
    store.write_table("scores", scores)
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description="Run one GreenWindow pipeline pass.")
    ap.add_argument("--no-chronos", action="store_true", help="skip Chronos-2 models")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    report = run_pipeline(datetime.now(UTC), include_chronos=not args.no_chronos)
    log.info("report: %s", report)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### Run {report.run_id}\n\n- ok: {', '.join(report.ok)}\n")
            for k, v in {**report.failed, **report.skipped}.items():
                f.write(f"- {k}: {v}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
