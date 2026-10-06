"""Write the public JSON contract read by the web app (spec 7.6, Decision D12).

Run standalone (`python -m greenwindow.export.app_json`) to re-export from the stored parquet files.
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from greenwindow.live import store
from greenwindow.live.scorer import BUCKETS, leaderboard

SCHEMA_VERSION = 1
MAX_BYTES = 300_000
LEADERBOARD_DAYS = 14
RECENT_DAYS = 7
ATTRIBUTION = [
    "Carbon intensity data: National Energy System Operator (NESO) Carbon Intensity API, CC BY 4.0.",
    "Weather data by Open-Meteo.com, CC BY 4.0.",
]
FAMILIES = {"benchmark", "classical", "foundation"}


class ExportError(ValueError):
    pass


def iso(ts: pd.Timestamp | datetime) -> str:
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def r1(x: Any) -> float | None:
    if x is None or (isinstance(x, float) and math.isnan(x)) or pd.isna(x):
        return None
    return round(float(x), 1)


def build_files(
    observations: pd.DataFrame,
    snapshots: pd.DataFrame,
    scores: pd.DataFrame,
    models_meta: list[dict[str, Any]],
    generated_at: pd.Timestamp,
    horizon: int,
) -> dict[str, dict[str, Any]]:
    gen = iso(generated_at)
    latest_run = snapshots.sort_values("issued_at_utc")["run_id"].iloc[-1]
    run = snapshots[snapshots["run_id"] == latest_run]
    actual_idx = observations["ci_actual"].dropna().index
    known = {m["name"] for m in models_meta}

    series = []
    for model, g in run.groupby("model", sort=False):
        if model not in known or len(g) != horizon:
            continue  # contract: exactly `horizon` points per series
        g = g.sort_values("target_ts_utc")
        points = [
            {"ts": iso(r.target_ts_utc), "mean": r1(r.mean), "q10": r1(r.q10), "q50": r1(r.q50), "q90": r1(r.q90)}
            for r in g.itertuples()
        ]
        series.append({"model": model, "points": points})

    recent = observations[observations.index > observations.index.max() - pd.Timedelta(days=RECENT_DAYS)]
    rows, n_runs = leaderboard(scores, generated_at, LEADERBOARD_DAYS) if len(scores) else ([], 0)

    return {
        "meta.json": {
            "schema_version": SCHEMA_VERSION,
            "generated_at_utc": gen,
            "latest_run_id": latest_run,
            "latest_actual_ts_utc": iso(actual_idx.max()) if len(actual_idx) else None,
            "models": models_meta,
            "attribution": ATTRIBUTION,
        },
        "latest_forecast.json": {
            "schema_version": SCHEMA_VERSION,
            "generated_at_utc": gen,
            "run_id": latest_run,
            "issued_at_utc": iso(run["issued_at_utc"].iloc[0]),
            "horizon": horizon,
            "series": series,
        },
        "recent_observations.json": {
            "schema_version": SCHEMA_VERSION,
            "generated_at_utc": gen,
            "points": [
                {
                    "ts": iso(ts),
                    "ci_actual": r1(r.ci_actual),
                    "temp_c": r1(r.temp_c),
                    "wind100": r1(r.wind100),
                    "solar_wm2": r1(r.solar_wm2),
                }
                for ts, r in recent.iterrows()
            ],
        },
        "leaderboard.json": {
            "schema_version": SCHEMA_VERSION,
            "generated_at_utc": gen,
            "window_days": LEADERBOARD_DAYS,
            "n_runs": n_runs,
            "rows": [{k: (r1(v) if isinstance(v, float) else v) for k, v in row.items()} for row in rows],
        },
    }


def validate_files(files: dict[str, dict[str, Any]]) -> None:
    """Python-side contract checks; the web app re-validates with zod (spec 9: never publish bad data)."""
    for name, doc in files.items():
        if doc.get("schema_version") != SCHEMA_VERSION or not str(doc.get("generated_at_utc", "")).endswith("Z"):
            raise ExportError(f"{name}: bad schema_version or generated_at_utc")
        text = json.dumps(doc, allow_nan=False)  # raises on NaN/inf
        if len(text.encode()) > MAX_BYTES:
            raise ExportError(f"{name}: {len(text)} bytes exceeds {MAX_BYTES}")
    meta, fc = files["meta.json"], files["latest_forecast.json"]
    for m in meta["models"]:
        if m["family"] not in FAMILIES:
            raise ExportError(f"meta.json: bad family {m['family']}")
    if not fc["series"]:
        raise ExportError("latest_forecast.json: no series")
    for s in fc["series"]:
        pts = s["points"]
        if len(pts) != fc["horizon"]:
            raise ExportError(f"latest_forecast.json: {s['model']} has {len(pts)} points")
        for p in pts:
            if p["q50"] is None:
                raise ExportError(f"latest_forecast.json: {s['model']} q50 missing")
            if p["q10"] is not None and not (p["q10"] <= p["q50"] <= p["q90"]):
                raise ExportError(f"latest_forecast.json: {s['model']} quantiles cross at {p['ts']}")
    buckets = {b for b, _, _ in BUCKETS}
    for row in files["leaderboard.json"]["rows"]:
        if row["horizon_bucket"] not in buckets:
            raise ExportError(f"leaderboard.json: bad bucket {row['horizon_bucket']}")


def write_files(files: dict[str, dict[str, Any]], out_dir: Path) -> None:
    """Validate everything first, then write temp files and swap them in (all or none)."""
    validate_files(files)
    out_dir.mkdir(parents=True, exist_ok=True)
    tmps = []
    for name, doc in files.items():
        tmp = out_dir / f".{name}.tmp"
        tmp.write_text(json.dumps(doc, allow_nan=False, separators=(",", ":")), encoding="utf-8")
        tmps.append((tmp, out_dir / name))
    for tmp, final in tmps:
        tmp.replace(final)


def main() -> None:
    from greenwindow.config import load_settings
    from greenwindow.live.pipeline import models_meta

    settings = load_settings()
    obs, snaps, scores = (store.read_table(n) for n in ("observations", "forecast_snapshots", "scores"))
    if obs is None or snaps is None:
        raise SystemExit("no pipeline data yet; run the pipeline first")
    files = build_files(
        obs,
        snaps,
        scores if scores is not None else snaps.iloc[0:0],
        models_meta(settings),
        pd.Timestamp(datetime.now(UTC)),
        settings.horizon_h,
    )
    write_files(files, store.app_data_dir())
    print(f"wrote {len(files)} files to {store.app_data_dir()}")


if __name__ == "__main__":
    main()
