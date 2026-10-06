"""Calendar features. Bank holidays: England (documented choice in the Data Card)."""

from __future__ import annotations

import holidays
import pandas as pd


def bank_holiday_flag(index: pd.DatetimeIndex) -> pd.Series:
    """True for hours on an England bank holiday, judged by the Europe/London local date."""
    local_dates = index.tz_convert("Europe/London").date
    years = sorted({d.year for d in local_dates})
    cal = holidays.country_holidays("GB", subdiv="ENG", years=years)
    return pd.Series([d in cal for d in local_dates], index=index, name="is_bank_holiday", dtype=bool)
