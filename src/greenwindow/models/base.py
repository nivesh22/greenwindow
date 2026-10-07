"""Forecaster interface, output contract, and the origin-safe runner (spec 6.2)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

import numpy as np
import pandas as pd

# wind_cf (power-curve capacity factor) replaces raw wind100 speed: closer to what drives the fuel mix.
COVARIATES = ["temp_c", "wind_cf", "solar_wm2", "is_bank_holiday"]
TARGET = "ci_actual"
CROSSING_TOL = 1e-6


class ForecastContractError(ValueError):
    pass


class Forecaster(Protocol):
    name: str
    label: str
    family: str  # "benchmark" | "classical" | "foundation"
    uses_covariates: bool

    def forecast(
        self,
        history: pd.DataFrame,
        future_covariates: pd.DataFrame | None,
        horizon: int,
        quantiles: Sequence[float],
    ) -> pd.DataFrame:
        """Index: the `horizon` hours after history ends. Columns: 'mean' and 'q<tau>' per quantile."""
        ...


def qcol(tau: float) -> str:
    return f"q{tau:g}"


def future_index(origin: pd.Timestamp, horizon: int) -> pd.DatetimeIndex:
    return pd.date_range(origin, periods=horizon, freq="1h", name="ts_utc")


def prepare_history(history: pd.DataFrame, window_hours: int, max_gap_h: int) -> pd.DataFrame:
    """Last `window_hours` rows with gaps of <= max_gap_h interpolated (spec 9). Raises if gaps remain."""
    h = history.iloc[-window_hours:].copy()
    numeric = [c for c in h.columns if c != "is_bank_holiday"]
    for col in numeric:
        h[col] = h[col].interpolate(limit=max_gap_h, limit_area="inside")
    if h[numeric].isna().any().any():
        bad = h[numeric].isna().sum()
        raise ValueError(f"history has gaps longer than {max_gap_h}h: {bad[bad > 0].to_dict()}")
    return h


def validate_forecast(fc: pd.DataFrame, origin: pd.Timestamp, horizon: int, quantiles: Sequence[float]) -> pd.DataFrame:
    """Spec 6.2/9 contract. Sorts quantiles only if crossings are tiny; otherwise raises."""
    expected = future_index(origin, horizon)
    cols = ["mean", *(qcol(t) for t in quantiles)]
    if list(fc.columns) != cols:
        raise ForecastContractError(f"columns {list(fc.columns)} != {cols}")
    if not fc.index.equals(expected):
        raise ForecastContractError("index is not the next `horizon` hours after the origin")
    if fc.isna().any().any() or not np.isfinite(fc.to_numpy()).all():
        raise ForecastContractError("forecast contains NaN or inf")
    q = fc[cols[1:]].to_numpy()
    worst = float(np.max(-np.diff(q, axis=1), initial=0.0))
    if worst > CROSSING_TOL:
        raise ForecastContractError(f"quantiles cross by {worst:.3g}")
    if worst > 0:
        fc = fc.copy()
        fc[cols[1:]] = np.sort(q, axis=1)
    return fc


def forecast_at(
    model: Forecaster,
    observations: pd.DataFrame,
    origin: pd.Timestamp,
    future_covariates: pd.DataFrame | None,
    horizon: int,
    quantiles: Sequence[float],
) -> pd.DataFrame:
    """Run `model` at `origin`, passing only rows strictly before it (rule 4: no leakage)."""
    history = observations.loc[observations.index < origin, [TARGET, *COVARIATES]]
    fut = None
    if model.uses_covariates:
        if future_covariates is None:
            raise ValueError(f"{model.name} needs future covariates")
        fut = future_covariates.reindex(future_index(origin, horizon))[COVARIATES]
        if fut.isna().any().any():
            raise ValueError(f"{model.name}: future covariates incomplete for the {horizon}h horizon")
    fc = model.forecast(history, fut, horizon, quantiles)
    return validate_forecast(fc, origin, horizon, quantiles)
