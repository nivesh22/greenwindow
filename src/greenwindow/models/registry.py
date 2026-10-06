"""Model registry (spec 6.2). The live pipeline runs every model listed by `live_models()`."""

from __future__ import annotations

from greenwindow.config import Settings
from greenwindow.models.base import Forecaster
from greenwindow.models.naive import SeasonalNaive
from greenwindow.models.sarimax import SarimaxWeather

NESO = {"name": "neso", "label": "NESO (operator forecast)", "family": "benchmark", "uses_covariates": False}


def live_models(settings: Settings, include_chronos: bool = True) -> list[Forecaster]:
    classical_h = settings.classical_window_days * 24
    gap = settings.max_interp_gap_h
    models: list[Forecaster] = [
        SeasonalNaive(24, window_hours=classical_h, max_gap_h=gap),
        SeasonalNaive(168, window_hours=classical_h, max_gap_h=gap),
        SarimaxWeather(window_hours=classical_h, max_gap_h=gap),
    ]
    if include_chronos:
        from greenwindow.models.chronos2 import Chronos2

        ctx = settings.chronos_context_days * 24
        models += [Chronos2(False, window_hours=ctx, max_gap_h=gap), Chronos2(True, window_hours=ctx, max_gap_h=gap)]
    return models
