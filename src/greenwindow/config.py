"""Load config/settings.yaml and config/locations.yaml."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT / "config"
WEIGHT_KEYS = ("temp", "wind", "solar")


@dataclass(frozen=True)
class Settings:
    horizon_h: int
    quantiles: tuple[float, ...]
    classical_window_days: int
    chronos_context_days: int
    retention_days: int
    recent_refresh_days: int
    bootstrap_days: int
    carbon_chunk_days: int
    max_interp_gap_h: int
    wind_unit: str
    cron_minute: int


@dataclass(frozen=True)
class Location:
    name: str
    lat: float
    lon: float
    weights: dict[str, float]


def load_settings(path: Path = CONFIG_DIR / "settings.yaml") -> Settings:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    raw["quantiles"] = tuple(raw["quantiles"])
    return Settings(**raw)


def load_locations(path: Path = CONFIG_DIR / "locations.yaml") -> list[Location]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    locs = [Location(p["name"], float(p["lat"]), float(p["lon"]), dict(p["weights"])) for p in raw["points"]]
    for key in WEIGHT_KEYS:
        total = sum(loc.weights[key] for loc in locs)
        if abs(total - 1.0) > 1e-9:
            raise ValueError(f"locations.yaml: '{key}' weights sum to {total}, expected 1")
    return locs
