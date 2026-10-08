"""Chronos-2 + Prophet blend (models/blend.py)."""

import pandas as pd

from greenwindow.models import blend

H = 48


def run_rows(run_id: str, model: str, value: float, n: int = H) -> pd.DataFrame:
    origin = pd.Timestamp("2026-10-06T00:00Z") + pd.Timedelta(hours=6 * int(run_id[-1]))
    return pd.DataFrame(
        {
            "run_id": run_id,
            "issued_at_utc": origin,
            "model": model,
            "target_ts_utc": pd.date_range(origin, periods=n, freq="h"),
            "horizon_h": range(1, n + 1),
            "mean": value,
            "q10": value - 10,
            "q50": value,
            "q90": value + 10,
        }
    )


def test_copies_chronos_short_and_weights_long() -> None:
    snaps = pd.concat([run_rows("r1", blend.CHRONOS, 100.0), run_rows("r1", blend.PROPHET, 200.0)])
    rows = blend.blend_rows(snaps, H)
    assert list(rows.columns) == list(snaps.columns)
    b = rows.set_index("horizon_h")
    assert len(b) == H and (b["model"] == blend.NAME).all()
    assert (b.loc[1:24, "mean"] == 100.0).all()
    assert (b.loc[25:48, "mean"] == 130.0).all()  # 0.7 * 100 + 0.3 * 200
    assert (b.loc[25:48, "q10"] == 120.0).all() and (b.loc[25:48, "q90"] == 140.0).all()


def test_backfills_only_complete_runs_without_a_blend() -> None:
    snaps = pd.concat(
        [
            run_rows("r1", blend.CHRONOS, 100.0),
            run_rows("r1", blend.PROPHET, 200.0),
            run_rows("r2", blend.CHRONOS, 100.0),  # Prophet failed in r2
            run_rows("r3", blend.CHRONOS, 100.0),
            run_rows("r3", blend.PROPHET, 200.0, n=40),  # partial
            run_rows("r4", blend.CHRONOS, 100.0),
            run_rows("r4", blend.PROPHET, 200.0),
        ]
    )
    first = blend.blend_rows(snaps, H)
    assert set(first["run_id"]) == {"r1", "r4"}
    assert blend.blend_rows(pd.concat([snaps, first]), H).empty  # idempotent: existing blends are kept as is
