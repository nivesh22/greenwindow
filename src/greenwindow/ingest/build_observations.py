"""Merge carbon and weather into the hourly observations table (spec 6.1, 7.1)."""

from __future__ import annotations

import pandas as pd

from greenwindow.features.calendar import bank_holiday_flag
from greenwindow.ingest.weather import WEATHER_COLUMNS
from greenwindow.schemas import OBSERVATION_COLUMNS, validate_observations


def carbon_to_hourly(carbon_hh: pd.DataFrame) -> pd.DataFrame:
    """Half-hours -> hour-beginning means. n_halfhours counts non-null actuals (0, 1 or 2)."""
    s = carbon_hh.set_index("from_utc")["ci_actual"]
    g = s.groupby(s.index.floor("h"))
    out = pd.DataFrame({"ci_actual": g.mean(), "n_halfhours": g.count().astype("int8")})
    out.index.name = "ts_utc"
    return out


def _finish(df: pd.DataFrame) -> pd.DataFrame:
    """Reindex to a gap-free hourly range, recompute calendar flags, validate."""
    idx = pd.date_range(df.index.min(), df.index.max(), freq="1h", name="ts_utc")
    df = df.reindex(idx)
    df["n_halfhours"] = df["n_halfhours"].fillna(0).astype("int8")
    df["is_bank_holiday"] = bank_holiday_flag(idx)
    return validate_observations(df[OBSERVATION_COLUMNS])


def build_observations(carbon_hh: pd.DataFrame, weather_national: pd.DataFrame) -> pd.DataFrame:
    """Hourly table over the span of the carbon data; gaps become explicit NaN rows (spec 7.1)."""
    hourly = carbon_to_hourly(carbon_hh)
    if hourly.empty:
        raise ValueError("no carbon data")
    return _finish(hourly.join(weather_national[WEATHER_COLUMNS], how="left"))


def merge_observations(old: pd.DataFrame | None, new: pd.DataFrame) -> pd.DataFrame:
    """Overlay new rows on old (newer values win: recent actuals get revised), then re-validate."""
    if old is None or old.empty:
        return _finish(new)
    return _finish(pd.concat([old[~old.index.isin(new.index)], new]).sort_index())
