"""Chronos-2 zero-shot adapters (spec 6.3: chronos2_uni, chronos2_cov).

predict_df signature verified for chronos-forecasting 2.3.2 (spec V5). Covariates are extra columns in
the context frame; those also present in `future_df` are treated as known-future covariates.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import pandas as pd

from greenwindow.models.base import COVARIATES, TARGET, future_index, prepare_history, qcol

MODEL_ID = "amazon/chronos-2"
SERIES_ID = "gb"


@lru_cache(maxsize=1)
def load_pipeline() -> Any:
    """Load once per process (spec 6.3)."""
    import torch
    from chronos import Chronos2Pipeline

    torch.manual_seed(0)
    return Chronos2Pipeline.from_pretrained(MODEL_ID, device_map="cpu")


def _long(df: pd.DataFrame, target: bool, covariates: bool) -> pd.DataFrame:
    out = pd.DataFrame({"id": SERIES_ID, "timestamp": df.index.tz_localize(None)})
    if target:
        out["target"] = df[TARGET].to_numpy(dtype=float)
    if covariates:
        for col in COVARIATES:
            out[col] = df[col].to_numpy(dtype=float)
    return out


@dataclass
class Chronos2:
    with_covariates: bool
    window_hours: int = 28 * 24
    max_gap_h: int = 3
    family: str = "foundation"

    @property
    def name(self) -> str:
        return "chronos2_cov" if self.with_covariates else "chronos2_uni"

    @property
    def label(self) -> str:
        return "Chronos-2 + weather" if self.with_covariates else "Chronos-2"

    @property
    def uses_covariates(self) -> bool:
        return self.with_covariates

    def forecast(
        self, history: pd.DataFrame, future_covariates: pd.DataFrame | None, horizon: int, quantiles: Sequence[float]
    ) -> pd.DataFrame:
        h = prepare_history(history, self.window_hours, self.max_gap_h)
        context = _long(h, target=True, covariates=self.with_covariates)
        future = None
        if self.with_covariates:
            if future_covariates is None:
                raise ValueError("chronos2_cov needs future covariates")
            future = _long(future_covariates, target=False, covariates=True)
        pred = load_pipeline().predict_df(
            context,
            future_df=future,
            id_column="id",
            timestamp_column="timestamp",
            target="target",
            prediction_length=horizon,
            quantile_levels=list(quantiles),
        )
        origin = history.index[-1] + pd.Timedelta(hours=1)
        out = {"mean": pred["predictions"].to_numpy()} | {qcol(t): pred[f"{t:g}"].to_numpy() for t in quantiles}
        return pd.DataFrame(out, index=future_index(origin, horizon))
