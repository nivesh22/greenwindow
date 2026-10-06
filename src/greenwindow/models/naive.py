"""Seasonal naive benchmarks (spec 6.2: snaive_24, snaive_168)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd

from greenwindow.models.base import TARGET, future_index, prepare_history, qcol


@dataclass
class SeasonalNaive:
    period: int
    window_hours: int = 56 * 24
    max_gap_h: int = 3
    family: str = "benchmark"
    uses_covariates: bool = False

    @property
    def name(self) -> str:
        return f"snaive_{self.period}"

    @property
    def label(self) -> str:
        return {24: "Seasonal naive (yesterday)", 168: "Seasonal naive (last week)"}.get(self.period, self.name)

    def forecast(
        self, history: pd.DataFrame, future_covariates: pd.DataFrame | None, horizon: int, quantiles: Sequence[float]
    ) -> pd.DataFrame:
        """y[T+h] = y[T+h-k*m], k = ceil(h/m). Intervals: empirical quantiles of lag-m differences in the window,
        scaled by sqrt(k) for forecasts k seasons ahead (as for a seasonal random walk)."""
        y = prepare_history(history, self.window_hours, self.max_gap_h)[TARGET].to_numpy()
        m = self.period
        if len(y) < 2 * m:
            raise ValueError(f"{self.name} needs at least {2 * m} hours of history")
        h = np.arange(1, horizon + 1)
        k = np.ceil(h / m).astype(int)
        point = y[len(y) - 1 + h - k * m]
        resid = y[m:] - y[:-m]
        out = {"mean": point}
        for tau in quantiles:
            out[qcol(tau)] = point + np.quantile(resid, tau) * np.sqrt(k)
        origin = history.index[-1] + pd.Timedelta(hours=1)
        return pd.DataFrame(out, index=future_index(origin, horizon))
