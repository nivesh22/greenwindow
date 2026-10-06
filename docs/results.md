# Backtest results

Generated 2026-10-06T01:43:20Z by `make backtest` in 10.8 min. 90 daily origins (00:00 UTC) from 2026-07-07 to 2026-10-04, 48-hour horizon.

> **Caveat.** Backtest weather comes from archived forecasts that are closer to reality than a true 1-2-day-ahead forecast, so models that use weather look better here than they will live. NESO rows are its forecast as published, with unknown lead time: not a fair head-to-head. The live leaderboard is the unbiased check.

Primary metrics: MASE (point; < 1 beats in-sample seasonal naive) and WQL (probabilistic). Coverage target for the P10-P90 band is 80%.

## All horizons

| Model | MASE | MAE | WQL | 80% coverage |
|---|---|---|---|---|
| NESO as published (lead time unknown) | 0.339 | 11.8 | – | – |
| Chronos-2 + weather | 0.518 | 18.1 | 0.094 | 83% |
| Prophet + weather | 0.713 | 24.8 | 0.131 | 65% |
| Chronos-2 | 0.767 | 26.9 | 0.138 | 78% |
| Structural model (UCM) + weather | 1.031 | 36.4 | 0.191 | 79% |
| ETS (daily season) | 1.059 | 37.0 | 0.199 | 65% |
| SARIMAX + weather | 1.093 | 38.1 | 0.185 | 80% |
| Seasonal naive (yesterday) | 1.185 | 41.6 | 0.219 | 80% |
| Seasonal naive (last week) | 1.300 | 45.7 | 0.241 | 78% |

## Horizon 1-6 h

| Model | MASE | MAE | WQL | 80% coverage |
|---|---|---|---|---|
| Chronos-2 + weather | 0.285 | 10.0 | 0.050 | 86% |
| Chronos-2 | 0.296 | 10.4 | 0.053 | 83% |
| ETS (daily season) | 0.339 | 11.9 | 0.062 | 79% |
| NESO as published (lead time unknown) | 0.358 | 12.3 | – | – |
| Structural model (UCM) + weather | 0.441 | 15.5 | 0.076 | 77% |
| SARIMAX + weather | 0.442 | 15.4 | 0.076 | 91% |
| Prophet + weather | 0.766 | 26.5 | 0.132 | 62% |
| Seasonal naive (yesterday) | 1.199 | 41.8 | 0.210 | 74% |
| Seasonal naive (last week) | 1.537 | 53.8 | 0.265 | 67% |

## Horizon 7-24 h

| Model | MASE | MAE | WQL | 80% coverage |
|---|---|---|---|---|
| NESO as published (lead time unknown) | 0.334 | 11.7 | – | – |
| Chronos-2 + weather | 0.454 | 15.8 | 0.085 | 84% |
| Prophet + weather | 0.653 | 22.7 | 0.123 | 69% |
| Chronos-2 | 0.704 | 24.7 | 0.132 | 77% |
| ETS (daily season) | 1.020 | 35.7 | 0.203 | 57% |
| Structural model (UCM) + weather | 1.026 | 36.2 | 0.199 | 72% |
| Seasonal naive (yesterday) | 1.064 | 37.5 | 0.205 | 78% |
| SARIMAX + weather | 1.153 | 40.2 | 0.198 | 79% |
| Seasonal naive (last week) | 1.220 | 43.0 | 0.233 | 82% |

## Horizon 25-48 h

| Model | MASE | MAE | WQL | 80% coverage |
|---|---|---|---|---|
| NESO as published (lead time unknown) | 0.339 | 11.8 | – | – |
| Chronos-2 + weather | 0.625 | 21.8 | 0.112 | 81% |
| Prophet + weather | 0.745 | 25.9 | 0.137 | 63% |
| Chronos-2 | 0.932 | 32.6 | 0.165 | 78% |
| Structural model (UCM) + weather | 1.183 | 41.7 | 0.215 | 85% |
| SARIMAX + weather | 1.211 | 42.2 | 0.204 | 78% |
| ETS (daily season) | 1.269 | 44.3 | 0.234 | 68% |
| Seasonal naive (yesterday) | 1.272 | 44.7 | 0.231 | 84% |
| Seasonal naive (last week) | 1.300 | 45.7 | 0.241 | 77% |

## Sensitivity (MASE, all horizons, every third origin)

**chronos_context_days**

| Model | 14 | 28 | 56 |
|---|---|---|---|
| Chronos-2 + weather | 0.566 | 0.512 | 0.513 |
| Chronos-2 | 0.875 | 0.847 | 0.867 |

**classical_window_days**

| Model | 28 | 56 | 84 |
|---|---|---|---|
| ETS (daily season) | 1.144 | 1.122 | 1.118 |
| Prophet + weather | 0.699 | 0.679 | 0.646 |
| SARIMAX + weather | 1.070 | 1.089 | 1.117 |
| Seasonal naive (last week) | nan | 1.292 | nan |
| Seasonal naive (yesterday) | nan | 1.173 | nan |
| Structural model (UCM) + weather | 1.088 | 1.039 | 1.066 |

## MAE by local hour of day (gCO₂/kWh)

| Model | 00-05 | 06-11 | 12-17 | 18-23 |
|---|---|---|---|---|
| Chronos-2 + weather | 18.2 | 17.4 | 15.9 | 20.9 |
| Chronos-2 | 25.2 | 23.8 | 25.1 | 33.4 |
| ETS (daily season) | 28.9 | 36.1 | 41.0 | 42.1 |
| NESO as published (lead time unknown) | 12.6 | 11.2 | 11.6 | 11.8 |
| Prophet + weather | 29.2 | 22.8 | 23.7 | 23.4 |
| SARIMAX + weather | 30.2 | 37.4 | 42.4 | 42.4 |
| Seasonal naive (last week) | 54.1 | 43.5 | 39.3 | 46.0 |
| Seasonal naive (yesterday) | 46.4 | 40.6 | 37.6 | 41.9 |
| Structural model (UCM) + weather | 30.6 | 36.1 | 37.9 | 40.9 |

## MAE by wind tercile (gCO₂/kWh)

| Model | high wind | low wind | mid wind |
|---|---|---|---|
| Chronos-2 + weather | 16.1 | 19.4 | 18.8 |
| Chronos-2 | 24.8 | 30.4 | 25.3 |
| ETS (daily season) | 33.9 | 38.6 | 38.6 |
| NESO as published (lead time unknown) | 11.6 | 12.2 | 11.6 |
| Prophet + weather | 22.0 | 27.7 | 24.6 |
| SARIMAX + weather | 39.9 | 40.0 | 34.5 |
| Seasonal naive (last week) | 43.8 | 52.9 | 40.4 |
| Seasonal naive (yesterday) | 40.1 | 43.8 | 40.9 |
| Structural model (UCM) + weather | 39.1 | 34.0 | 36.1 |

## MAE by day type (gCO₂/kWh)

| Model | weekday | weekend/holiday |
|---|---|---|
| Chronos-2 + weather | 18.3 | 17.6 |
| Chronos-2 | 27.0 | 26.5 |
| ETS (daily season) | 36.4 | 38.5 |
| NESO as published (lead time unknown) | 11.6 | 12.4 |
| Prophet + weather | 24.8 | 24.7 |
| SARIMAX + weather | 37.6 | 39.3 |
| Seasonal naive (last week) | 47.8 | 40.9 |
| Seasonal naive (yesterday) | 41.2 | 42.6 |
| Structural model (UCM) + weather | 36.3 | 36.5 |
