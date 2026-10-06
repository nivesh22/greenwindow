"""Table schemas and validators (spec 7). Plain pandas checks; see docs/decisions.md."""

from __future__ import annotations

import pandas as pd

OBSERVATION_COLUMNS = ["ci_actual", "n_halfhours", "temp_c", "wind100", "solar_wm2", "is_bank_holiday"]
CI_RANGE = (0.0, 600.0)
WEATHER_BOUNDS = {"temp_c": (-40.0, 50.0), "wind100": (0.0, 80.0), "solar_wm2": (0.0, 1400.0)}


class SchemaError(ValueError):
    pass


def check_hourly_index(index: pd.Index, name: str) -> None:
    if not isinstance(index, pd.DatetimeIndex) or str(index.tz) != "UTC":
        raise SchemaError(f"{name}: index must be a UTC DatetimeIndex")
    if not index.is_unique or not index.is_monotonic_increasing:
        raise SchemaError(f"{name}: timestamps must be unique and increasing")
    if (index != index.floor("h")).any():
        raise SchemaError(f"{name}: timestamps must be hour-beginning")
    if len(index) > 1 and (index[1:] - index[:-1] != pd.Timedelta(hours=1)).any():
        raise SchemaError(f"{name}: hourly gaps must be explicit rows")


def validate_observations(df: pd.DataFrame) -> pd.DataFrame:
    """Spec 7.1. Returns df unchanged or raises SchemaError."""
    check_hourly_index(df.index, "observations")
    missing = [c for c in OBSERVATION_COLUMNS if c not in df.columns]
    if missing:
        raise SchemaError(f"observations: missing columns {missing}")
    if not df["n_halfhours"].isin([0, 1, 2]).all():
        raise SchemaError("observations: n_halfhours must be 0, 1 or 2")
    ci = df["ci_actual"].dropna()
    if ((ci < CI_RANGE[0]) | (ci > CI_RANGE[1])).any():
        raise SchemaError("observations: ci_actual outside [0, 600]")
    for col, (lo, hi) in WEATHER_BOUNDS.items():
        v = df[col].dropna()
        if ((v < lo) | (v > hi)).any():
            raise SchemaError(f"observations: {col} outside physical bounds [{lo}, {hi}]")
    return df
