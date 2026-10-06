"""Forecast accuracy metrics (spec 6.5)."""

from __future__ import annotations

from collections.abc import Mapping

import numpy as np


def _a(x) -> np.ndarray:
    return np.asarray(x, dtype=float)


def mae(y, yhat) -> float:
    return float(np.mean(np.abs(_a(y) - _a(yhat))))


def rmse(y, yhat) -> float:
    return float(np.sqrt(np.mean((_a(y) - _a(yhat)) ** 2)))


def mase(y, yhat, y_train_window, m: int = 24) -> float:
    """MAE scaled by the in-sample seasonal-naive MAE of the training window."""
    tr = _a(y_train_window)
    scale = np.mean(np.abs(tr[m:] - tr[:-m]))
    return mae(y, yhat) / scale


def pinball_values(y, q_pred, tau: float) -> np.ndarray:
    diff = _a(y) - _a(q_pred)
    return np.maximum(tau * diff, (tau - 1) * diff)


def pinball(y, q_pred, tau: float) -> float:
    return float(np.mean(pinball_values(y, q_pred, tau)))


def wql(y, q_preds: Mapping[float, object]) -> float:
    """Weighted quantile loss: mean over levels of 2 * sum(pinball) / sum(|y|)."""
    denom = np.sum(np.abs(_a(y)))
    return float(np.mean([2 * np.sum(pinball_values(y, q, tau)) / denom for tau, q in q_preds.items()]))


def coverage(y, lo, hi) -> float:
    y = _a(y)
    return float(np.mean((y >= _a(lo)) & (y <= _a(hi))))
