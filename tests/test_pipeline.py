"""End-to-end pipeline on fixture data with no network (spec 10.3), plus exporter and scorer checks."""

import json
from datetime import UTC, datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from greenwindow.backtest import metrics
from greenwindow.export.app_json import ExportError, validate_files
from greenwindow.live import pipeline
from greenwindow.live.scorer import score_snapshots

NOW = datetime(2026, 10, 5, 12, 17, tzinfo=UTC)
LAST_ACTUAL = pd.Timestamp("2026-10-05T10:00Z")


def fake_carbon(start, end, chunk_days=30):
    ts = pd.date_range(pd.Timestamp(start).floor("h"), pd.Timestamp(end), freq="30min", inclusive="left")
    t = np.arange(len(ts))
    actual = 180 + 40 * np.sin(2 * np.pi * t / 48)
    actual[ts >= LAST_ACTUAL + pd.Timedelta(hours=1)] = np.nan  # actuals lag the clock
    return pd.DataFrame({"from_utc": ts, "ci_actual": actual, "ci_forecast_published": actual})


def fake_weather(kind, locations, start=None, end=None, past_days=7, forecast_days=3):
    if kind == "hindcast":
        idx = pd.date_range(
            pd.Timestamp(start, tz="UTC"), pd.Timestamp(end, tz="UTC") + pd.Timedelta(hours=23), freq="h"
        )
    else:
        now = pd.Timestamp(NOW).floor("D")
        idx = pd.date_range(
            now - pd.Timedelta(days=past_days), now + pd.Timedelta(days=forecast_days), freq="h", inclusive="left"
        )
    rows = [
        pd.DataFrame({"ts_utc": idx, "location": loc.name, "temp_c": 12.0, "wind100": 9.0, "solar_wm2": 50.0})
        for loc in locations
    ]
    return pd.concat(rows, ignore_index=True)


def fake_neso(now):
    ts = pd.date_range(pd.Timestamp(now), periods=96, freq="30min")
    return pd.DataFrame({"from_utc": ts, "ci_forecast": 170.0})


@pytest.fixture
def patched(monkeypatch, tmp_path):
    monkeypatch.setenv("GREENWINDOW_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(pipeline, "fetch_carbon_actuals", fake_carbon)
    monkeypatch.setattr(pipeline, "fetch_weather", fake_weather)
    monkeypatch.setattr(pipeline, "fetch_neso_forward_forecast", fake_neso)
    return tmp_path


def test_pipeline_end_to_end_and_idempotent(patched) -> None:
    report = pipeline.run_pipeline(NOW, include_chronos=False)
    assert report.run_id == "20261005T11"  # origin = hour after the latest actual
    expected = {"neso", "snaive_24", "snaive_168", "ets", "sarimax_wx", "ucm_wx", "prophet_wx"}
    assert set(report.ok) == expected, report.failed

    snaps = pd.read_parquet(patched / "parquet" / "forecast_snapshots.parquet")
    assert len(snaps) == 7 * 48 and snaps.groupby(["run_id", "model", "target_ts_utc"]).size().max() == 1

    pipeline.run_pipeline(NOW, include_chronos=False)  # same run_id: rows replaced, not duplicated
    again = pd.read_parquet(patched / "parquet" / "forecast_snapshots.parquet")
    assert len(again) == len(snaps)

    files = {p.name: json.loads(p.read_text()) for p in (patched / "app_data").glob("*.json")}
    assert set(files) == {"meta.json", "latest_forecast.json", "recent_observations.json", "leaderboard.json"}
    fc = files["latest_forecast.json"]
    assert fc["issued_at_utc"] == "2026-10-05T11:00:00Z"
    assert all(len(s["points"]) == 48 for s in fc["series"])
    assert files["meta.json"]["latest_actual_ts_utc"] == "2026-10-05T10:00:00Z"


def test_observations_missing_a_column_are_rebuilt(patched) -> None:
    pipeline.run_pipeline(NOW, include_chronos=False)
    path = patched / "parquet" / "observations.parquet"
    pd.read_parquet(path).drop(columns="wind_cf").to_parquet(path)  # as stored before wind_cf existed
    report = pipeline.run_pipeline(NOW, include_chronos=False)
    assert "ets" in report.ok, report.failed
    obs = pd.read_parquet(path)
    assert "wind_cf" in obs.columns and obs["wind_cf"].notna().all()


def test_blend_backfilled_from_stored_snapshots(patched, monkeypatch) -> None:
    from greenwindow.models import blend

    pipeline.run_pipeline(NOW, include_chronos=False)
    path = patched / "parquet" / "forecast_snapshots.parquet"
    snaps = pd.read_parquet(path)
    chronos = snaps[snaps["model"] == "prophet_wx"].assign(model=blend.CHRONOS)  # stand-in for a stored Chronos run
    pd.concat([snaps, chronos], ignore_index=True).to_parquet(path)

    def later_carbon(start, end, chunk_days=30):  # six hours more actuals -> a new run_id
        df = fake_carbon(start, end, chunk_days)
        df["ci_actual"] = 180.0
        return df[df["from_utc"] < LAST_ACTUAL + pd.Timedelta(hours=7)]

    monkeypatch.setattr(pipeline, "fetch_carbon_actuals", later_carbon)
    report = pipeline.run_pipeline(NOW + timedelta(hours=6), include_chronos=False)
    assert report.run_id == "20261005T17"
    after = pd.read_parquet(path)
    old_run = snaps["run_id"].iloc[0]
    assert set(after.loc[after["model"] == blend.NAME, "run_id"]) == {old_run}  # backfilled, nothing else touched
    before = snaps.set_index(["run_id", "model", "horizon_h"]).sort_index()
    kept = after.set_index(["run_id", "model", "horizon_h"]).loc[before.index]
    pd.testing.assert_frame_equal(kept, before)


def test_invalid_export_is_rejected(patched) -> None:
    pipeline.run_pipeline(NOW, include_chronos=False)
    files = {p.name: json.loads(p.read_text()) for p in (patched / "app_data").glob("*.json")}
    files["latest_forecast.json"]["series"][0]["points"].pop()
    with pytest.raises(ExportError, match="points"):
        validate_files(files)


def test_scores_and_metrics_by_hand() -> None:
    ts = pd.date_range("2026-10-05", periods=2, freq="h", tz="UTC")
    snaps = pd.DataFrame(
        {
            "run_id": "r",
            "issued_at_utc": ts[0],
            "model": "m",
            "target_ts_utc": ts,
            "horizon_h": [1, 2],
            "mean": [100.0, 100.0],
            "q10": [90.0, 90.0],
            "q50": [100.0, 100.0],
            "q90": [110.0, 110.0],
        }
    )
    obs = pd.DataFrame({"ci_actual": [105.0, 120.0]}, index=ts)
    s = score_snapshots(snaps, obs)
    assert s["abs_err"].tolist() == [5.0, 20.0]
    assert s["in_80"].tolist() == [True, False]
    assert s["pin90"].tolist() == pytest.approx([0.5, 9.0])  # 0.1 * (110 - 105), 0.9 * (120 - 110)

    assert metrics.mae([1, 3], [2, 2]) == 1.0
    assert metrics.rmse([0, 0], [3, 4]) == pytest.approx(np.sqrt(12.5))
    assert metrics.pinball([10], [8], 0.1) == pytest.approx(0.2)
    assert metrics.coverage([1, 5, 9], [0, 0, 0], [6, 6, 6]) == pytest.approx(2 / 3)
    assert metrics.mase([2, 2], [1, 1], [0, 1, 2, 3], m=2) == pytest.approx(0.5)
    assert metrics.wql([10, 10], {0.5: [8, 12]}) == pytest.approx(2 * (1 + 1) / 20)
