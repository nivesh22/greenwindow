"""Backtest runner and summary on a 10-day synthetic fixture (spec 10.3), no network."""

import json

import pandas as pd

from greenwindow.backtest import runner
from greenwindow.backtest.summary import summarize
from greenwindow.config import load_settings
from greenwindow.models.naive import SeasonalNaive
from tests.test_models import synthetic_obs

SETTINGS = load_settings()


def test_backtest_on_fixture() -> None:
    obs = synthetic_obs(days=40)
    origins = runner.origins_for(obs, days=10, horizon=SETTINGS.horizon_h)
    assert len(origins) == 10 and all(o.hour == 0 for o in origins)
    assert origins[-1] + pd.Timedelta(hours=47) <= obs.index.max()

    models = [SeasonalNaive(24, window_hours=28 * 24), SeasonalNaive(168, window_hours=28 * 24)]
    jobs = runner.build_jobs(obs, origins, models, SETTINGS)
    assert len(jobs) == 10 * 2  # benchmarks have no sensitivity runs
    frames = [runner.run_one(j) for j in jobs]
    assert all(isinstance(f, pd.DataFrame) for f in frames)
    res = pd.concat(frames, ignore_index=True)
    assert len(res) == 10 * 2 * 48
    res = res.join(obs["ci_actual"].rename("actual"), on="target_ts_utc").join(
        obs[["temp_c", "wind100", "solar_wm2", "is_bank_holiday"]], on="target_ts_utc"
    )

    summary, tables = summarize(res, obs, origins, SETTINGS, seconds=1.0)
    json.dumps(summary, allow_nan=False)
    assert summary["origins"]["count"] == 10
    buckets = {r["horizon_bucket"] for r in summary["rows"]}
    assert buckets == {"all", "1-6", "7-24", "25-48"}
    assert len(summary["rows"]) == 2 * 4
    assert set(tables) == {"MAE by local hour of day", "MAE by wind tercile", "MAE by day type"}


def test_failed_model_is_recorded_not_raised() -> None:
    obs = synthetic_obs(days=10)
    origin = obs.index[-48]
    job = (SeasonalNaive(168, window_hours=56 * 24), obs, origin, 48, SETTINGS.quantiles, "default", 0)
    obs_short = obs[obs.index >= origin - pd.Timedelta(days=5)]
    out = runner.run_one((job[0], obs_short, *job[2:]))
    assert isinstance(out, str) and "snaive_168" in out
