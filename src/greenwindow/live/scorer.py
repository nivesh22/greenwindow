"""Score snapshots against actuals, apply retention, and build the leaderboard (spec 6.6, 7.3)."""

from __future__ import annotations

import numpy as np
import pandas as pd

from greenwindow.backtest.metrics import pinball_values

BUCKETS = [("1-6", 1, 6), ("7-24", 7, 24), ("25-48", 25, 48)]
SCORE_KEY = ["run_id", "model", "target_ts_utc", "horizon_h"]


def score_snapshots(snapshots: pd.DataFrame, observations: pd.DataFrame) -> pd.DataFrame:
    """Every snapshot row whose target hour has an actual. Recomputed from scratch, so idempotent."""
    actual = observations["ci_actual"].dropna().rename("actual")
    df = snapshots.join(actual, on="target_ts_utc", how="inner")
    point = df["q50"].fillna(df["mean"])
    out = df[SCORE_KEY + ["issued_at_utc", "actual"]].copy()
    out["abs_err"] = (point - df["actual"]).abs()
    out["sq_err"] = (df["mean"] - df["actual"]) ** 2
    for tau, col in ((0.1, "q10"), (0.5, "q50"), (0.9, "q90")):
        has_q = df["q10"].notna()
        out[f"pin{col[1:]}"] = np.where(has_q, pinball_values(df["actual"], df[col], tau), np.nan)
    in80 = (df["actual"] >= df["q10"]) & (df["actual"] <= df["q90"])
    out["in_80"] = in80.astype("boolean").where(df["q10"].notna())
    return out.reset_index(drop=True)


def apply_retention(df: pd.DataFrame, now: pd.Timestamp, days: int) -> pd.DataFrame:
    return df[df["issued_at_utc"] >= now - pd.Timedelta(days=days)].reset_index(drop=True)


def leaderboard(scores: pd.DataFrame, now: pd.Timestamp, window_days: int = 14) -> tuple[list[dict], int]:
    """Rolling-window rows {model, horizon_bucket, n_scored, mae, rmse, wql, coverage80} and the run count."""
    s = scores[scores["issued_at_utc"] >= now - pd.Timedelta(days=window_days)]
    rows = []
    for (model,), g in s.groupby(["model"]):
        for bucket, lo, hi in BUCKETS:
            b = g[(g["horizon_h"] >= lo) & (g["horizon_h"] <= hi)]
            if b.empty:
                continue
            is_neso = b["pin10"].isna().all()
            denom = b["actual"].abs().sum()
            wql = None if is_neso else float(2 * b[["pin10", "pin50", "pin90"]].sum().mean() / denom)
            rows.append(
                {
                    "model": model,
                    "horizon_bucket": bucket,
                    "n_scored": int(len(b)),
                    "mae": float(b["abs_err"].mean()),
                    "rmse": float(np.sqrt(b["sq_err"].mean())),
                    "wql": wql,
                    "coverage80": None if is_neso else float(b["in_80"].astype(float).mean()),
                }
            )
    return rows, int(s["run_id"].nunique())
