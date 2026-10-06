"""Additive ETS with daily seasonality (spec 6.2: ets; FPP ch. 8).

Fixed spec: ETS(A, N, A) with a 24h season: additive error, no trend, additive seasonality. A damped trend
was tried first and drifted badly over 48h (backtest MASE ~2); see docs/decisions.md.
Prediction intervals are statsmodels' analytic intervals for this additive model.
"""

from __future__ import annotations

import warnings
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.stats import norm
from statsmodels.tsa.exponential_smoothing.ets import ETSModel

from greenwindow.models.base import TARGET, future_index, prepare_history, qcol


@dataclass
class ETS:
    season: int = 24
    window_hours: int = 56 * 24
    max_gap_h: int = 3
    name: str = "ets"
    label: str = "ETS (daily season)"
    family: str = "classical"
    uses_covariates: bool = False

    def forecast(
        self, history: pd.DataFrame, future_covariates: pd.DataFrame | None, horizon: int, quantiles: Sequence[float]
    ) -> pd.DataFrame:
        # A RangeIndex Series, not an ndarray: statsmodels 0.15 ETS get_prediction fails on bare arrays.
        y = prepare_history(history, self.window_hours, self.max_gap_h)[TARGET].reset_index(drop=True)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fit = ETSModel(y, error="add", trend=None, seasonal="add", seasonal_periods=self.season).fit(
                disp=False, maxiter=200
            )
            pred = fit.get_prediction(start=len(y), end=len(y) + horizon - 1)
        mean = np.asarray(pred.predicted_mean)
        se = np.sqrt(np.asarray(pred.var_pred_mean))
        out = {"mean": mean} | {qcol(t): mean + norm.ppf(t) * se for t in quantiles}
        origin = history.index[-1] + pd.Timedelta(hours=1)
        return pd.DataFrame(out, index=future_index(origin, horizon))
