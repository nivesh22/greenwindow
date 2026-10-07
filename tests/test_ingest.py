from datetime import UTC, datetime

import numpy as np
import pandas as pd
import pytest

from greenwindow.config import Location, load_locations, load_settings
from greenwindow.features.calendar import bank_holiday_flag
from greenwindow.ingest import carbon, weather
from greenwindow.ingest.build_observations import build_observations, carbon_to_hourly, merge_observations
from greenwindow.schemas import SchemaError, validate_observations

LOCS = [
    Location("A", 51.0, 0.0, {"temp": 0.5, "wind": 0.0, "solar": 1.0}),
    Location("B", 55.0, -4.0, {"temp": 0.5, "wind": 1.0, "solar": 0.0}),
]


def hh_frame(start: str, values: list[float | None]) -> pd.DataFrame:
    ts = pd.date_range(start, periods=len(values), freq="30min", tz="UTC")
    return pd.DataFrame({"from_utc": ts, "ci_actual": pd.array(values, dtype="float64")})


def weather_national(index: pd.DatetimeIndex) -> pd.DataFrame:
    return pd.DataFrame({"temp_c": 10.0, "wind100": 8.0, "wind_cf": 0.3, "solar_wm2": 100.0}, index=index)


# ---------------------------------------------------------------- config


def test_config_loads_and_weights_sum_to_one() -> None:
    s = load_settings()
    assert s.horizon_h == 48 and s.quantiles == (0.1, 0.5, 0.9)
    locs = load_locations()
    assert len(locs) == 7
    for key in ("temp", "wind", "solar"):
        assert sum(loc.weights[key] for loc in locs) == pytest.approx(1.0)


def test_bad_weights_rejected(tmp_path) -> None:
    p = tmp_path / "loc.yaml"
    p.write_text("points:\n  - {name: X, lat: 1, lon: 2, weights: {temp: 0.5, wind: 1, solar: 1}}\n")
    with pytest.raises(ValueError, match="temp"):
        load_locations(p)


# ---------------------------------------------------------------- carbon


def test_parse_intensity() -> None:
    payload = {
        "data": [
            {"from": "2026-10-05T00:00Z", "to": "2026-10-05T00:30Z", "intensity": {"forecast": 150, "actual": 140}},
            {"from": "2026-10-05T00:30Z", "to": "2026-10-05T01:00Z", "intensity": {"forecast": 151, "actual": None}},
        ]
    }
    df = carbon.parse_intensity(payload)
    assert str(df["from_utc"].dt.tz) == "UTC"
    assert df["ci_actual"].tolist()[0] == 140 and np.isnan(df["ci_actual"].iloc[1])


def test_parse_intensity_rejects_schema_change() -> None:
    with pytest.raises(ValueError, match="schema"):
        carbon.parse_intensity({"data": [{"from": "2026-10-05T00:00Z", "intensity": {"value": 1}}]})


def test_fetch_carbon_actuals_chunks(monkeypatch) -> None:
    calls: list[str] = []

    def fake_get_json(url: str, params=None):
        calls.append(url)
        frm = url.split("/")[-2]
        return {"data": [{"from": frm, "intensity": {"forecast": 1, "actual": 1}}]}

    monkeypatch.setattr(carbon, "get_json", fake_get_json)
    df = carbon.fetch_carbon_actuals(datetime(2026, 1, 1, tzinfo=UTC), datetime(2026, 3, 1, tzinfo=UTC), 30)
    assert len(calls) == 2  # 59 days -> 30 + 29
    assert len(df) == 2


# ---------------------------------------------------------------- aggregation and observations


def test_halfhour_to_hour_with_2_1_0_present() -> None:
    hh = hh_frame("2026-10-05T00:00Z", [100, 120, 90, None, None, None])
    h = carbon_to_hourly(hh)
    assert h["ci_actual"].tolist()[:2] == [110, 90]
    assert np.isnan(h["ci_actual"].iloc[2])
    assert h["n_halfhours"].tolist() == [2, 1, 0]


@pytest.mark.parametrize("day", ["2026-03-29", "2026-10-25"])
def test_clock_change_days_have_no_gaps_or_duplicates(day: str) -> None:
    hh = hh_frame(f"{day}T00:00Z", [150.0] * 48)
    obs = build_observations(hh, weather_national(pd.date_range(day, periods=24, freq="h", tz="UTC")))
    assert len(obs) == 24 and obs.index.is_unique
    assert (obs.index[1:] - obs.index[:-1] == pd.Timedelta(hours=1)).all()


def test_missing_hours_become_explicit_rows() -> None:
    a = hh_frame("2026-10-05T00:00Z", [100, 100])
    b = hh_frame("2026-10-05T03:00Z", [100, 100])
    idx = pd.date_range("2026-10-05", periods=4, freq="h", tz="UTC")
    obs = build_observations(pd.concat([a, b]), weather_national(idx))
    assert len(obs) == 4 and obs["n_halfhours"].tolist() == [2, 0, 0, 2]


def test_merge_newer_values_win() -> None:
    idx = pd.date_range("2026-10-05", periods=3, freq="h", tz="UTC")
    old = build_observations(hh_frame("2026-10-05T00:00Z", [100] * 6), weather_national(idx))
    new = build_observations(hh_frame("2026-10-05T02:00Z", [200, 200, 300, 300]), weather_national(idx.shift(2)))
    merged = merge_observations(old, new)
    assert merged["ci_actual"].tolist() == [100, 100, 200, 300]


def test_bank_holiday_flag_uses_london_date() -> None:
    idx = pd.DatetimeIndex(["2026-12-24T23:00Z", "2026-12-25T00:00Z", "2026-08-30T23:00Z"])
    # 2026-08-30 23:00 UTC is 00:00 BST on Mon 31 Aug, the late summer bank holiday.
    assert bank_holiday_flag(idx).tolist() == [False, True, True]


def test_validate_rejects_bad_data() -> None:
    idx = pd.date_range("2026-10-05", periods=3, freq="h", tz="UTC")
    good = pd.DataFrame(
        {
            "ci_actual": 100.0,
            "n_halfhours": 2,
            "temp_c": 10.0,
            "wind100": 5.0,
            "wind_cf": 0.1,
            "solar_wm2": 0.0,
            "is_bank_holiday": False,
        },
        index=idx,
    )
    validate_observations(good)
    with pytest.raises(SchemaError, match="outside"):
        validate_observations(good.assign(ci_actual=[100, 700, 100]))
    with pytest.raises(SchemaError, match="unique"):
        validate_observations(good.set_axis(idx[[0, 0, 1]]))
    with pytest.raises(SchemaError, match="gaps"):
        validate_observations(good.set_axis(idx[[0, 1]].append(idx[[2]] + pd.Timedelta(hours=1))))


# ---------------------------------------------------------------- weather


def om_payload(times: list[str], **vals: list[float | None]) -> dict:
    hourly = {
        "time": times,
        "temperature_2m": [1.0] * len(times),
        "wind_speed_100m": [2.0] * len(times),
        "shortwave_radiation": [3.0] * len(times),
    }
    hourly.update(vals)
    return {"hourly": hourly}


def test_national_weather_weights_and_null_propagation() -> None:
    t = ["2026-10-05T00:00", "2026-10-05T01:00"]
    payload = [om_payload(t, temperature_2m=[10.0, 10.0]), om_payload(t, temperature_2m=[20.0, None])]
    nat = weather.national_weather(weather.parse_weather(payload, LOCS), LOCS)
    assert nat["temp_c"].iloc[0] == pytest.approx(15.0)
    assert np.isnan(nat["temp_c"].iloc[1])  # B has weight 0.5 and is null
    assert nat["wind100"].tolist() == [2.0, 2.0]  # only B has wind weight
    assert nat["wind_cf"].tolist() == [0.0, 0.0]  # 2 m/s is below cut-in


def test_wind_capacity_factor_curve() -> None:
    cf = weather.wind_capacity_factor(pd.Series([0.0, 3.0, 7.5, 12.0, 20.0, 25.0, np.nan]))
    assert cf.iloc[:2].tolist() == [0.0, 0.0]
    assert 0.0 < cf.iloc[2] < 0.5  # cubic ramp: half of rated speed gives well under half of output
    assert cf.iloc[3:5].tolist() == [1.0, 1.0]
    assert cf.iloc[5] == 0.0  # storm cut-out
    assert np.isnan(cf.iloc[6])


def test_wind_cf_applies_curve_per_point_before_weighting() -> None:
    locs = [
        Location("A", 51.0, 0.0, {"temp": 0.5, "wind": 0.5, "solar": 1.0}),
        Location("B", 55.0, -4.0, {"temp": 0.5, "wind": 0.5, "solar": 0.0}),
    ]
    t = ["2026-10-05T00:00"]
    payload = [om_payload(t, wind_speed_100m=[0.0]), om_payload(t, wind_speed_100m=[14.0])]
    nat = weather.national_weather(weather.parse_weather(payload, locs), locs)
    assert nat["wind100"].iloc[0] == pytest.approx(7.0)
    assert nat["wind_cf"].iloc[0] == pytest.approx(0.5)  # curve of the mean speed would be ~0.17


def test_parse_weather_missing_variable_raises() -> None:
    p = om_payload(["2026-10-05T00:00"])
    del p["hourly"]["wind_speed_100m"]
    with pytest.raises(KeyError, match="wind_speed_100m"):
        weather.parse_weather([p, p], LOCS)


# ---------------------------------------------------------------- live smoke (deselected in CI)


@pytest.mark.live
def test_live_fetch_30_days() -> None:
    end = pd.Timestamp.now(tz="UTC").floor("h")
    df = carbon.fetch_carbon_actuals(end - pd.Timedelta(days=31), end)
    assert df["ci_actual"].notna().sum() >= 30 * 48 * 0.95
