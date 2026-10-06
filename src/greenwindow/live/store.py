"""Where pipeline files live. CI points GREENWINDOW_DATA_DIR at a checkout of the `data` branch."""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd

from greenwindow.config import ROOT

SNAPSHOT_COLUMNS = ["run_id", "issued_at_utc", "model", "target_ts_utc", "horizon_h", "mean", "q10", "q50", "q90"]


def data_dir() -> Path:
    return Path(os.environ.get("GREENWINDOW_DATA_DIR", ROOT / "data_local"))


def parquet_path(name: str) -> Path:
    return data_dir() / "parquet" / f"{name}.parquet"


def app_data_dir() -> Path:
    return data_dir() / "app_data"


def read_table(name: str) -> pd.DataFrame | None:
    p = parquet_path(name)
    return pd.read_parquet(p) if p.exists() else None


def write_table(name: str, df: pd.DataFrame) -> None:
    p = parquet_path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    df.to_parquet(tmp)
    tmp.replace(p)
