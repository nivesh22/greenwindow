import importlib.util
import time

import numpy as np
import pandas as pd
import pytest

from greenwindow.config import load_settings
from greenwindow.models.base import ForecastContractError, forecast_at, future_index, validate_forecast
from greenwindow.models.registry import live_models

SETTINGS = load_settings()
H, Q = SETTINGS.horizon_h, SETTINGS.quantiles
HAS_CHRONOS = importlib.util.find_spec("chronos") is not None
MODELS = live_models(SETTINGS, include_chronos=HAS_CHRONOS)
RUNTIME_BUDGET_S = 60


def synthetic_obs(days: int = 60, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    n = days * 24
    idx = pd.date_range("2026-07-01", periods=n, freq="h", tz="UTC", name="ts_utc")
    t = np.arange(n)
    wind = np.clip(8 + 4 * np.sin(t / 50) + rng.normal(0, 1.5, n), 0, None)
    solar = np.clip(500 * np.sin((t % 24 - 6) / 12 * np.pi), 0, None)
    temp = 15 + 4 * np.sin((t % 24 - 9) / 24 * 2 * np.pi) + rng.normal(0, 1, n)
    ci = 200 + 40 * np.sin((t % 24 - 12) / 24 * 2 * np.pi) - 6 * wind - 0.05 * solar + rng.normal(0, 8, n)
    return pd.DataFrame(
        {
            "ci_actual": ci,
            "n_halfhours": 2,
            "temp_c": temp,
            "wind100": wind,
            "solar_wm2": solar,
            "is_bank_holiday": False,
        },
        index=idx,
    )


OBS = synthetic_obs()
ORIGIN = OBS.index[-H]  # last H rows are "the future"


@pytest.fixture(params=MODELS, ids=lambda m: m.name)
def model(request):
    return request.param


def run(model, obs: pd.DataFrame = OBS) -> pd.DataFrame:
    return forecast_at(model, obs, ORIGIN, obs, H, Q)


def test_output_contract(model) -> None:
    t0 = time.perf_counter()
    fc = run(model)
    assert time.perf_counter() - t0 < RUNTIME_BUDGET_S
    assert fc.index.equals(future_index(ORIGIN, H))
    assert not fc.isna().any().any()
    assert (fc["q0.1"] <= fc["q0.5"]).all() and (fc["q0.5"] <= fc["q0.9"]).all()


def test_no_leakage(model) -> None:
    """Changing rows at or after the origin must not change the forecast (rule 4)."""
    tampered = OBS.copy()
    tampered.loc[tampered.index >= ORIGIN, "ci_actual"] = 9999.0
    pd.testing.assert_frame_equal(run(model), run(model, tampered))


def test_deterministic(model) -> None:
    pd.testing.assert_frame_equal(run(model), run(model))


def test_snaive_24_repeats_yesterday() -> None:
    m = next(x for x in MODELS if x.name == "snaive_24")
    fc = run(m)
    hist = OBS.loc[OBS.index < ORIGIN, "ci_actual"]
    np.testing.assert_allclose(fc["mean"].iloc[:24], hist.iloc[-24:].to_numpy())
    np.testing.assert_allclose(fc["mean"].iloc[24:], hist.iloc[-24:].to_numpy())


def test_long_gap_makes_model_fail() -> None:
    m = next(x for x in MODELS if x.name == "snaive_24")
    gappy = OBS.copy()
    gappy.loc[ORIGIN - pd.Timedelta(hours=10) : ORIGIN - pd.Timedelta(hours=5), "ci_actual"] = np.nan
    with pytest.raises(ValueError, match="gaps"):
        run(m, gappy)


def test_validate_forecast_rejects_crossing_and_sorts_tiny() -> None:
    idx = future_index(ORIGIN, H)
    fc = pd.DataFrame({"mean": 1.0, "q0.1": 1.0, "q0.5": 2.0, "q0.9": 3.0}, index=idx)
    with pytest.raises(ForecastContractError, match="cross"):
        validate_forecast(fc.assign(**{"q0.9": 1.5}), ORIGIN, H, Q)
    tiny = validate_forecast(fc.assign(**{"q0.1": 2.0 + 1e-9}), ORIGIN, H, Q)
    assert (tiny["q0.1"] <= tiny["q0.5"]).all()
    with pytest.raises(ForecastContractError, match="index"):
        validate_forecast(fc.iloc[:-1], ORIGIN, H, Q)
