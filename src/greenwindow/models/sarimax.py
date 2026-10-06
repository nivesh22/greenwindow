"""SARIMAX dynamic harmonic regression with weather and holiday regressors (spec 6.2: sarimax_wx).

FPP ch. 10 style: ARMA errors, Fourier terms for daily (24h) and weekly (168h) seasonality,
plus temperature, 100m wind, solar radiation and a bank-holiday dummy as regressors.
"""

from __future__ import annotations

import warnings
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import norm
from statsmodels.tsa.statespace.sarimax import SARIMAX

from greenwindow.models.base import COVARIATES, TARGET, future_index, prepare_history, qcol


def fourier_terms(index: pd.DatetimeIndex, period: int, k: int) -> pd.DataFrame:
    hours = index.asi8 // 3_600_000_000_000  # hours since epoch: same phase for every origin
    cols = {}
    for i in range(1, k + 1):
        cols[f"sin{period}_{i}"] = np.sin(2 * np.pi * i * hours / period)
        cols[f"cos{period}_{i}"] = np.cos(2 * np.pi * i * hours / period)
    return pd.DataFrame(cols, index=index)


@dataclass
class SarimaxWeather:
    order: tuple[int, int, int] = (2, 0, 1)
    k_daily: int = 3
    k_weekly: int = 2
    window_hours: int = 56 * 24
    max_gap_h: int = 3
    name: str = "sarimax_wx"
    label: str = "SARIMAX + weather"
    family: str = "classical"
    uses_covariates: bool = True

    def _exog(self, df: pd.DataFrame) -> pd.DataFrame:
        x = df[COVARIATES].astype(float)
        return pd.concat(
            [x, fourier_terms(df.index, 24, self.k_daily), fourier_terms(df.index, 168, self.k_weekly)], axis=1
        )

    def forecast(
        self, history: pd.DataFrame, future_covariates: pd.DataFrame | None, horizon: int, quantiles: Sequence[float]
    ) -> pd.DataFrame:
        if future_covariates is None:
            raise ValueError("sarimax_wx needs future covariates")
        h = prepare_history(history, self.window_hours, self.max_gap_h)
        x_hist, x_fut = self._exog(h), self._exog(future_covariates)
        keep = x_hist.columns[x_hist.std() > 0]  # e.g. no bank holiday in the window -> drop the dummy
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fit = SARIMAX(h[TARGET].to_numpy(), exog=x_hist[keep].to_numpy(), order=self.order, trend="c").fit(
                disp=False, maxiter=200
            )
            pred = fit.get_forecast(steps=horizon, exog=x_fut[keep].to_numpy())
        mean = np.asarray(pred.predicted_mean)
        se = np.asarray(pred.se_mean)
        out = {"mean": mean} | {qcol(t): mean + norm.ppf(t) * se for t in quantiles}
        origin = history.index[-1] + pd.Timedelta(hours=1)
        return pd.DataFrame(out, index=future_index(origin, horizon))
