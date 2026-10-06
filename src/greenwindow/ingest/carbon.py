"""NESO Carbon Intensity API, GB national (spec 6.1; endpoints verified in V1)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import pandas as pd

from greenwindow.ingest.http import get_json

BASE = "https://api.carbonintensity.org.uk"


def _fmt(ts: datetime | pd.Timestamp) -> str:
    return pd.Timestamp(ts).tz_convert("UTC").strftime("%Y-%m-%dT%H:%MZ")


def parse_intensity(payload: dict[str, Any]) -> pd.DataFrame:
    """API payload -> half-hourly frame (from_utc, ci_actual, ci_forecast_published). Raises on schema change."""
    rows = payload["data"]
    for row in rows:
        if "from" not in row or not {"forecast", "actual"} <= set(row.get("intensity", {})):
            raise ValueError(f"Carbon API schema changed: {row}")
    df = pd.DataFrame(
        {
            "from_utc": pd.to_datetime([r["from"] for r in rows], utc=True),
            "ci_actual": [r["intensity"]["actual"] for r in rows],
            "ci_forecast_published": [r["intensity"]["forecast"] for r in rows],
        }
    )
    df[["ci_actual", "ci_forecast_published"]] = df[["ci_actual", "ci_forecast_published"]].astype("float64")
    return df.drop_duplicates("from_utc", keep="last").sort_values("from_utc").reset_index(drop=True)


def fetch_carbon_actuals(start: datetime, end: datetime, chunk_days: int = 30) -> pd.DataFrame:
    """Half-hourly actuals and published forecasts for [start, end), in chunks of <= chunk_days (V1)."""
    start_ts, end_ts = pd.Timestamp(start).tz_convert("UTC"), pd.Timestamp(end).tz_convert("UTC")
    parts, s = [], start_ts
    while s < end_ts:
        e = min(s + timedelta(days=chunk_days), end_ts)
        parts.append(parse_intensity(get_json(f"{BASE}/intensity/{_fmt(s)}/{_fmt(e)}")))
        s = e
    if not parts:
        return parse_intensity({"data": []})
    df = pd.concat(parts).drop_duplicates("from_utc", keep="last").sort_values("from_utc")
    return df[(df["from_utc"] >= start_ts) & (df["from_utc"] < end_ts)].reset_index(drop=True)


def fetch_neso_forward_forecast(now: datetime) -> pd.DataFrame:
    """Next ~48h half-hourly NESO forecast. cols: from_utc, ci_forecast."""
    df = parse_intensity(get_json(f"{BASE}/intensity/{_fmt(now)}/fw48h"))
    return df.rename(columns={"ci_forecast_published": "ci_forecast"})[["from_utc", "ci_forecast"]]
