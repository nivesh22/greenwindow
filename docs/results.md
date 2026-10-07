# Backtest results

Generated 2026-10-07T21:41:16Z by `make backtest` in 13.9 min. 90 daily origins (00:00 UTC) from 2026-07-07 to 2026-10-04, 48-hour horizon.

> **Caveat.** Backtest weather comes from archived forecasts that are closer to reality than a true 1-2-day-ahead forecast, so models that use weather look better here than they will live. NESO rows are its forecast as published, with unknown lead time: not a fair head-to-head. The live leaderboard is the unbiased check.

Primary metrics: MASE (point; < 1 beats in-sample seasonal naive) and WQL (probabilistic). Coverage target for the P10-P90 band is 80%.

## All horizons

| Model | MASE | MAE | WQL | 80% coverage |
|---|---|---|---|---|
| NESO as published (lead time unknown) | 0.339 | 11.8 | – | – |
| Chronos-2 + weather | 0.484 | 16.9 | 0.089 | 83% |
| Prophet + weather | 0.655 | 22.8 | 0.122 | 67% |
| Chronos-2 | 0.767 | 26.9 | 0.138 | 78% |
| Structural model (UCM) + weather | 1.034 | 36.4 | 0.192 | 78% |
| ETS (daily season) | 1.059 | 37.0 | 0.199 | 65% |
| SARIMAX + weather | 1.103 | 38.5 | 0.187 | 80% |
| Seasonal naive (yesterday) | 1.185 | 41.6 | 0.219 | 80% |
| Seasonal naive (last week) | 1.300 | 45.7 | 0.241 | 78% |

## Horizon 1-6 h

| Model | MASE | MAE | WQL | 80% coverage |
|---|---|---|---|---|
| Chronos-2 + weather | 0.287 | 10.1 | 0.051 | 83% |
| Chronos-2 | 0.296 | 10.4 | 0.053 | 83% |
| ETS (daily season) | 0.339 | 11.9 | 0.062 | 79% |
| NESO as published (lead time unknown) | 0.358 | 12.3 | – | – |
| Structural model (UCM) + weather | 0.443 | 15.5 | 0.077 | 77% |
| SARIMAX + weather | 0.445 | 15.5 | 0.076 | 91% |
| Prophet + weather | 0.698 | 24.2 | 0.120 | 64% |
| Seasonal naive (yesterday) | 1.199 | 41.8 | 0.210 | 74% |
| Seasonal naive (last week) | 1.537 | 53.8 | 0.265 | 67% |

## Horizon 7-24 h

| Model | MASE | MAE | WQL | 80% coverage |
|---|---|---|---|---|
| NESO as published (lead time unknown) | 0.334 | 11.7 | – | – |
| Chronos-2 + weather | 0.420 | 14.7 | 0.080 | 84% |
| Prophet + weather | 0.605 | 21.1 | 0.115 | 70% |
| Chronos-2 | 0.704 | 24.7 | 0.132 | 77% |
| ETS (daily season) | 1.020 | 35.7 | 0.203 | 57% |
| Structural model (UCM) + weather | 1.025 | 36.2 | 0.199 | 72% |
| Seasonal naive (yesterday) | 1.064 | 37.5 | 0.205 | 78% |
| SARIMAX + weather | 1.159 | 40.4 | 0.201 | 80% |
| Seasonal naive (last week) | 1.220 | 43.0 | 0.233 | 82% |

## Horizon 25-48 h

| Model | MASE | MAE | WQL | 80% coverage |
|---|---|---|---|---|
| NESO as published (lead time unknown) | 0.339 | 11.8 | – | – |
| Chronos-2 + weather | 0.581 | 20.3 | 0.106 | 82% |
| Prophet + weather | 0.682 | 23.7 | 0.128 | 65% |
| Chronos-2 | 0.932 | 32.6 | 0.165 | 78% |
| Structural model (UCM) + weather | 1.188 | 41.9 | 0.217 | 83% |
| SARIMAX + weather | 1.226 | 42.7 | 0.208 | 77% |
| ETS (daily season) | 1.269 | 44.3 | 0.234 | 68% |
| Seasonal naive (yesterday) | 1.272 | 44.7 | 0.231 | 84% |
| Seasonal naive (last week) | 1.300 | 45.7 | 0.241 | 77% |

## Sensitivity (MASE, all horizons, every third origin)

**chronos_context_days**

| Model | 14 | 28 | 56 |
|---|---|---|---|
| Chronos-2 + weather | 0.544 | 0.487 | 0.492 |
| Chronos-2 | 0.875 | 0.847 | 0.867 |

**classical_window_days**

| Model | 28 | 56 | 84 |
|---|---|---|---|
| ETS (daily season) | 1.144 | 1.122 | 1.118 |
| Prophet + weather | 0.690 | 0.632 | 0.600 |
| SARIMAX + weather | 1.081 | 1.096 | 1.124 |
| Seasonal naive (last week) | nan | 1.292 | nan |
| Seasonal naive (yesterday) | nan | 1.173 | nan |
| Structural model (UCM) + weather | 1.063 | 1.047 | 1.068 |

## MAE by local hour of day (gCO₂/kWh)

| Model | 00-05 | 06-11 | 12-17 | 18-23 |
|---|---|---|---|---|
| Chronos-2 + weather | 17.6 | 16.6 | 14.4 | 19.1 |
| Chronos-2 | 25.2 | 23.8 | 25.1 | 33.4 |
| ETS (daily season) | 28.9 | 36.1 | 41.0 | 42.1 |
| NESO as published (lead time unknown) | 12.6 | 11.2 | 11.6 | 11.8 |
| Prophet + weather | 26.4 | 21.1 | 22.0 | 21.7 |
| SARIMAX + weather | 30.7 | 37.8 | 42.7 | 42.7 |
| Seasonal naive (last week) | 54.1 | 43.5 | 39.3 | 46.1 |
| Seasonal naive (yesterday) | 46.4 | 40.6 | 37.6 | 41.9 |
| Structural model (UCM) + weather | 30.7 | 36.0 | 38.1 | 41.0 |

## MAE by wind tercile (gCO₂/kWh)

| Model | high wind | low wind | mid wind |
|---|---|---|---|
| Chronos-2 + weather | 15.9 | 18.1 | 16.8 |
| Chronos-2 | 25.5 | 30.2 | 24.8 |
| ETS (daily season) | 35.0 | 38.9 | 37.1 |
| NESO as published (lead time unknown) | 11.7 | 12.4 | 11.3 |
| Prophet + weather | 22.1 | 25.7 | 20.6 |
| SARIMAX + weather | 40.0 | 40.7 | 34.7 |
| Seasonal naive (last week) | 44.9 | 53.9 | 38.4 |
| Seasonal naive (yesterday) | 40.5 | 44.4 | 39.9 |
| Structural model (UCM) + weather | 40.8 | 33.9 | 34.7 |

## MAE by day type (gCO₂/kWh)

| Model | weekday | weekend/holiday |
|---|---|---|
| Chronos-2 + weather | 16.6 | 17.8 |
| Chronos-2 | 27.0 | 26.5 |
| ETS (daily season) | 36.4 | 38.5 |
| NESO as published (lead time unknown) | 11.6 | 12.4 |
| Prophet + weather | 22.5 | 23.5 |
| SARIMAX + weather | 38.1 | 39.4 |
| Seasonal naive (last week) | 47.8 | 40.9 |
| Seasonal naive (yesterday) | 41.2 | 42.6 |
| Structural model (UCM) + weather | 36.3 | 36.7 |
