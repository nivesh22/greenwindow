"""Backtest metrics tables, backtest_summary.json (spec 7.6) and docs/results.md (spec T9)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from greenwindow.export.app_json import SCHEMA_VERSION, iso, r1
from greenwindow.live.scorer import BUCKETS
from greenwindow.models import blend

CAVEAT = (
    "Backtest weather comes from archived forecasts that are closer to reality than a true 1-2-day-ahead "
    "forecast, so models that use weather look better here than they will live. NESO rows are its forecast "
    "as published, with unknown lead time: not a fair head-to-head. The live leaderboard is the unbiased check."
)
LABELS = {"neso_published": "NESO as published (lead time unknown)", blend.NAME: blend.LABEL}


def _scale_by_origin(obs: pd.DataFrame, origins: list[pd.Timestamp], window_days: int, m: int = 24) -> pd.Series:
    """In-sample seasonal-naive MAE of each origin's training window (MASE denominator)."""
    y = obs["ci_actual"]
    out = {}
    for o in origins:
        w = y[(y.index < o) & (y.index >= o - pd.Timedelta(days=window_days))].to_numpy()
        out[o] = float(np.nanmean(np.abs(w[m:] - w[:-m])))
    return pd.Series(out, name="scale")


def _metrics(g: pd.DataFrame) -> dict[str, float | None]:
    err = (g["q50"] - g["actual"]).abs()
    has_q = g["q10"].notna().all()
    out: dict[str, float | None] = {
        "mase": float((err / g["scale"]).mean()),
        "mae": float(err.mean()),
        "wql": None,
        "coverage80": None,
    }
    if has_q:
        denom = g["actual"].abs().sum()
        losses = []
        for tau, col in ((0.1, "q10"), (0.5, "q50"), (0.9, "q90")):
            d = g["actual"] - g[col]
            losses.append(2 * np.maximum(tau * d, (tau - 1) * d).sum() / denom)
        out["wql"] = float(np.mean(losses))
        out["coverage80"] = float(((g["actual"] >= g["q10"]) & (g["actual"] <= g["q90"])).mean())
    return out


def _bucket(h: pd.Series) -> pd.Series:
    return pd.cut(h, bins=[0, 6, 24, 48], labels=[b for b, _, _ in BUCKETS]).astype(str)


def summarize(
    res: pd.DataFrame, obs: pd.DataFrame, origins: list[pd.Timestamp], settings, seconds: float
) -> tuple[dict[str, Any], dict[str, pd.DataFrame]]:
    res = res[res["actual"].notna()].copy()
    res = res.join(_scale_by_origin(obs, origins, settings.classical_window_days), on="origin_utc")
    res["bucket"] = _bucket(res["horizon_h"])
    cw, cc = settings.classical_window_days, settings.chronos_context_days
    is_default = (
        (res["setting"] == "default")
        | ((res["setting"] == "classical_window_days") & (res["setting_value"] == cw))
        | ((res["setting"] == "chronos_context_days") & (res["setting_value"] == cc))
    )
    main = res[is_default]

    rows = []
    for (model, bucket), g in list(main.groupby(["model", "bucket"])) + [
        ((m, "all"), g) for m, g in main.groupby("model")
    ]:
        rows.append({"model": model, "horizon_bucket": bucket, **_metrics(g)})
    rows.sort(key=lambda r: (r["horizon_bucket"], r["mase"]))

    sens = []
    sens_rows = res[res["origin_utc"].isin(set(origins[::3])) & (res["setting"] != "default")]
    for (setting, value, model), g in sens_rows.groupby(["setting", "setting_value", "model"]):
        sens.append({"setting": setting, "value": int(value), "model": model, "mase": _metrics(g)["mase"]})

    # slices for docs/results.md (spec 6.5)
    main = main.assign(
        hour_block=(main["target_ts_utc"].dt.tz_convert("Europe/London").dt.hour // 6 * 6).map(
            lambda h: f"{h:02d}-{h + 5:02d}"
        ),
        wind_tercile=pd.qcut(main["wind100"], 3, labels=["low wind", "mid wind", "high wind"]).astype(str),
        day_type=np.where(
            main["is_bank_holiday"] | (main["target_ts_utc"].dt.tz_convert("Europe/London").dt.dayofweek >= 5),
            "weekend/holiday",
            "weekday",
        ),
    )
    tables = {
        name: main.groupby(["model", col]).apply(lambda g: (g["q50"] - g["actual"]).abs().mean()).unstack(col)
        for name, col in (
            ("MAE by local hour of day", "hour_block"),
            ("MAE by wind tercile", "wind_tercile"),
            ("MAE by day type", "day_type"),
        )
    }

    summary = {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": iso(pd.Timestamp(datetime.now(UTC))),
        "origins": {"start": iso(origins[0]), "end": iso(origins[-1]), "count": len(origins)},
        "caveat": CAVEAT,
        "rows": [
            {k: (r1(v) if k in ("mae",) else (round(v, 3) if isinstance(v, float) else v)) for k, v in r.items()}
            for r in rows
        ],
        "sensitivity": [{**s, "mase": round(s["mase"], 3)} for s in sens],
    }
    return summary, tables


def write_results_md(
    path: Path, summary: dict[str, Any], tables: dict[str, pd.DataFrame], failures: list[str], seconds: float
) -> None:
    from greenwindow.config import load_settings
    from greenwindow.models.registry import live_models

    names = {m.name: m.label for m in live_models(load_settings())} | LABELS

    def label(m: str) -> str:
        return names.get(m, m)

    rows = pd.DataFrame(summary["rows"])
    lines = [
        "# Backtest results",
        "",
        f"Generated {summary['generated_at_utc']} by `make backtest` in {seconds / 60:.1f} min. "
        f"{summary['origins']['count']} daily origins (00:00 UTC) from {summary['origins']['start'][:10]} "
        f"to {summary['origins']['end'][:10]}, 48-hour horizon.",
        "",
        f"> **Caveat.** {summary['caveat']}",
        "",
        "Primary metrics: MASE (point; < 1 beats in-sample seasonal naive) and WQL (probabilistic). "
        "Coverage target for the P10-P90 band is 80%.",
        "",
    ]
    for bucket in ["all", "1-6", "7-24", "25-48"]:
        sub = rows[rows["horizon_bucket"] == bucket].sort_values("mase")
        lines += [f"## Horizon {bucket} h" if bucket != "all" else "## All horizons", ""]
        lines += ["| Model | MASE | MAE | WQL | 80% coverage |", "|---|---|---|---|---|"]
        for r in sub.itertuples():
            wql = "–" if pd.isna(r.wql) else f"{r.wql:.3f}"
            cov = "–" if pd.isna(r.coverage80) else f"{r.coverage80:.0%}"
            lines.append(f"| {label(r.model)} | {r.mase:.3f} | {r.mae:.1f} | {wql} | {cov} |")
        lines.append("")
    lines += ["## Sensitivity (MASE, all horizons, every third origin)", ""]
    sens = pd.DataFrame(summary["sensitivity"])
    if not sens.empty:
        for setting, g in sens.groupby("setting"):
            piv = g.pivot(index="model", columns="value", values="mase")
            lines += [
                f"**{setting}**",
                "",
                "| Model | " + " | ".join(str(c) for c in piv.columns) + " |",
                "|---|" + "---|" * len(piv.columns),
            ]
            for model, r in piv.iterrows():
                lines.append(f"| {label(model)} | " + " | ".join(f"{v:.3f}" for v in r) + " |")
            lines.append("")
    for name, t in tables.items():
        lines += [
            f"## {name} (gCO₂/kWh)",
            "",
            "| Model | " + " | ".join(t.columns) + " |",
            "|---|" + "---|" * len(t.columns),
        ]
        for model, r in t.iterrows():
            lines.append(f"| {label(model)} | " + " | ".join(f"{v:.1f}" for v in r) + " |")
        lines.append("")
    if failures:
        lines += [f"## Failed model runs ({len(failures)})", ""] + [f"- {f}" for f in failures[:50]] + [""]
    path.write_text("\n".join(lines), encoding="utf-8")
