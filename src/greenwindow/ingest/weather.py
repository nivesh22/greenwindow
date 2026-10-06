"""Open-Meteo weather (spec 6.1; hosts and variables verified in V3/V4).

Decision D3: only forecast products are model input. History comes from the Historical Forecast
API; recent days and the future come from the Forecast API. Never the ERA5 archive.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

import pandas as pd

from greenwindow.config import Location
from greenwindow.ingest.http import get_json

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
HINDCAST_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
VARIABLES = {"temperature_2m": "temp_c", "wind_speed_100m": "wind100", "shortwave_radiation": "solar_wm2"}
WEIGHT_KEY = {"temp_c": "temp", "wind100": "wind", "solar_wm2": "solar"}
WEATHER_COLUMNS = list(WEIGHT_KEY)


def _params(locations: list[Location]) -> dict[str, Any]:
    return {
        "latitude": ",".join(f"{loc.lat}" for loc in locations),
        "longitude": ",".join(f"{loc.lon}" for loc in locations),
        "hourly": ",".join(VARIABLES),
        "timezone": "UTC",
        "wind_speed_unit": "ms",
    }


def parse_weather(payload: Any, locations: list[Location]) -> pd.DataFrame:
    """Open-Meteo payload (one object per location) -> long frame: ts_utc, location, temp_c, wind100, solar_wm2."""
    items = payload if isinstance(payload, list) else [payload]
    if len(items) != len(locations):
        raise ValueError(f"expected {len(locations)} locations, got {len(items)}")
    frames = []
    for loc, item in zip(locations, items, strict=True):
        hourly = item["hourly"]
        missing = [v for v in VARIABLES if v not in hourly]
        if missing:
            raise KeyError(f"Open-Meteo response missing variables {missing}")
        f = pd.DataFrame({col: pd.to_numeric(pd.Series(hourly[v]), errors="coerce") for v, col in VARIABLES.items()})
        f.insert(0, "location", loc.name)
        f.insert(0, "ts_utc", pd.to_datetime(hourly["time"]).tz_localize("UTC"))
        frames.append(f)
    return pd.concat(frames, ignore_index=True)


def fetch_weather(
    kind: Literal["hindcast", "forecast"],
    locations: list[Location],
    start: date | None = None,
    end: date | None = None,
    past_days: int = 7,
    forecast_days: int = 3,
) -> pd.DataFrame:
    """Hourly weather per location. hindcast: [start, end] dates; forecast: past_days back to forecast_days ahead."""
    params = _params(locations)
    if kind == "hindcast":
        if start is None or end is None:
            raise ValueError("hindcast needs start and end dates")
        params |= {"start_date": start.isoformat(), "end_date": end.isoformat()}
        url = HINDCAST_URL
    else:
        params |= {"past_days": past_days, "forecast_days": forecast_days}
        url = FORECAST_URL
    return parse_weather(get_json(url, params), locations)


def national_weather(long: pd.DataFrame, locations: list[Location]) -> pd.DataFrame:
    """Weighted national features indexed by ts_utc. A null at any point with weight > 0 makes the hour null."""
    out = {}
    for col, key in WEIGHT_KEY.items():
        wide = long.pivot_table(index="ts_utc", columns="location", values=col, dropna=False)
        weights = pd.Series({loc.name: loc.weights[key] for loc in locations})
        used = list(weights[weights > 0].index)
        wide = wide.reindex(columns=used)
        out[col] = (wide * weights[used]).sum(axis=1).where(wide.notna().all(axis=1))
    df = pd.DataFrame(out).sort_index()
    df.index.name = "ts_utc"
    return df
