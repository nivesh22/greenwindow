"""Chronos-2 + Prophet blend for long horizons (docs/decisions.md, 2026-10-07).

Derived from stored forecasts, so it never refits anything: hours 1-24 copy Chronos-2 + weather;
hours 25-48 are 0.7 x Chronos-2 + 0.3 x Prophet, applied to the mean and to each quantile
(averaging quantiles keeps them ordered). Because the inputs are forecasts as issued, blend rows
for a past run use only what was known at that run's origin.
"""

from __future__ import annotations

import pandas as pd

NAME = "blend_wx"
LABEL = "Chronos-2 + Prophet blend"
CHRONOS, PROPHET = "chronos2_cov", "prophet_wx"
BLEND_FROM_H = 25
W_CHRONOS = 0.7
VALUES = ["mean", "q10", "q50", "q90"]
META = {"name": NAME, "label": LABEL, "family": "ensemble", "uses_covariates": True}


def blend_rows(rows: pd.DataFrame, horizon: int, key: str = "run_id") -> pd.DataFrame:
    """Blend rows for every `key` group that has complete Chronos and Prophet forecasts and no blend yet."""
    have_blend = set(rows.loc[rows["model"] == NAME, key])
    out = []
    for _, g in rows[rows["model"].isin([CHRONOS, PROPHET]) & ~rows[key].isin(have_blend)].groupby(key):
        c = g[g["model"] == CHRONOS].set_index("horizon_h").sort_index()
        p = g[g["model"] == PROPHET].set_index("horizon_h").sort_index()
        if len(c) != horizon or len(p) != horizon or not c.index.equals(p.index):
            continue  # a component failed or is partial in this run: no blend
        b = c.copy()
        long = b.index >= BLEND_FROM_H
        b.loc[long, VALUES] = W_CHRONOS * c.loc[long, VALUES] + (1 - W_CHRONOS) * p.loc[long, VALUES]
        b["model"] = NAME
        out.append(b.reset_index()[rows.columns])
    return pd.concat(out, ignore_index=True) if out else rows.iloc[0:0]
