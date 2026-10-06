"""Structural time-series model with weather regressors (course week 4; FPP / Harvey UCM).

Fixed spec: local level + stochastic trigonometric seasonals for 24h (3 harmonics) and 168h (2 harmonics)
+ AR(1) irregular + weather and bank-holiday regressors. Intervals from the Kalman filter forecast variance.
"""

from __future__ import annotations

import warnings
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import norm
from statsmodels.tsa.statespace.structural import UnobservedComponents

from greenwindow.models.base import COVARIATES, TARGET, future_index, prepare_history, qcol


@dataclass
class UCMWeather:
    window_hours: int = 56 * 24
    max_gap_h: int = 3
    name: str = "ucm_wx"
    label: str = "Structural model (UCM) + weather"
    family: str = "classical"
    uses_covariates: bool = True

    def forecast(
        self, history: pd.DataFrame, future_covariates: pd.DataFrame | None, horizon: int, quantiles: Sequence[float]
    ) -> pd.DataFrame:
        if future_covariates is None:
            raise ValueError("ucm_wx needs future covariates")
        h = prepare_history(history, self.window_hours, self.max_gap_h)
        x_hist, x_fut = h[COVARIATES].astype(float), future_covariates[COVARIATES].astype(float)
        keep = x_hist.columns[x_hist.std() > 0]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fit = UnobservedComponents(
                h[TARGET].to_numpy(),
                level="local level",
                freq_seasonal=[{"period": 24, "harmonics": 3}, {"period": 168, "harmonics": 2}],
                autoregressive=1,
                exog=x_hist[keep].to_numpy(),
            ).fit(disp=False, maxiter=200)
            pred = fit.get_forecast(steps=horizon, exog=x_fut[keep].to_numpy())
        mean = np.asarray(pred.predicted_mean)
        se = np.asarray(pred.se_mean)
        out = {"mean": mean} | {qcol(t): mean + norm.ppf(t) * se for t in quantiles}
        origin = history.index[-1] + pd.Timedelta(hours=1)
        return pd.DataFrame(out, index=future_index(origin, horizon))
