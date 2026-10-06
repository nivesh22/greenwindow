"""Prophet with weather regressors (course week 2).

Fixed spec: piecewise-linear trend, daily and weekly seasonality (no yearly: the 56-day window is too short),
temperature, 100m wind, solar radiation and bank-holiday regressors. P10/P90 from Prophet's simulated
80% interval (interval_width=0.8); the simulation is seeded so forecasts are reproducible.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd

from greenwindow.models.base import COVARIATES, TARGET, future_index, prepare_history


def _quiet() -> None:
    for name in ("prophet", "cmdstanpy"):
        logging.getLogger(name).setLevel(logging.WARNING)


@dataclass
class ProphetWeather:
    window_hours: int = 56 * 24
    max_gap_h: int = 3
    seed: int = 0
    name: str = "prophet_wx"
    label: str = "Prophet + weather"
    family: str = "classical"
    uses_covariates: bool = True

    def forecast(
        self, history: pd.DataFrame, future_covariates: pd.DataFrame | None, horizon: int, quantiles: Sequence[float]
    ) -> pd.DataFrame:
        from prophet import Prophet

        _quiet()
        if future_covariates is None:
            raise ValueError("prophet_wx needs future covariates")
        if tuple(quantiles) != (0.1, 0.5, 0.9):
            raise ValueError("prophet_wx provides only the 0.1/0.5/0.9 quantiles")
        h = prepare_history(history, self.window_hours, self.max_gap_h)
        regs = [c for c in COVARIATES if h[c].astype(float).std() > 0]

        def frame(df: pd.DataFrame) -> pd.DataFrame:
            out = df[regs].astype(float).reset_index(drop=True)
            out.insert(0, "ds", df.index.tz_localize(None))
            return out

        train = frame(h)
        train["y"] = h[TARGET].to_numpy()
        m = Prophet(
            daily_seasonality=True,
            weekly_seasonality=True,
            yearly_seasonality=False,
            interval_width=0.8,
            uncertainty_samples=500,
        )
        for r in regs:
            m.add_regressor(r)
        m.fit(train, algorithm="LBFGS", seed=self.seed)
        state = np.random.get_state()
        np.random.seed(self.seed)
        try:
            pred = m.predict(frame(future_covariates))
        finally:
            np.random.set_state(state)
        origin = history.index[-1] + pd.Timedelta(hours=1)
        yhat = pred["yhat"].to_numpy()
        return pd.DataFrame(
            {"mean": yhat, "q0.1": pred["yhat_lower"].to_numpy(), "q0.5": yhat, "q0.9": pred["yhat_upper"].to_numpy()},
            index=future_index(origin, horizon),
        )
