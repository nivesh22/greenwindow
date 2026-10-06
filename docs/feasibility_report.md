# GreenWindow feasibility report

- Generated: 2026-10-06T00:17:33Z
- Verdict: **GO**
- Model checks on synthetic data: False
- Flags: (none)
- Platform: Windows-10-10.0.26300-SP0

| ID | Check | Blocking | Status | Detail | Seconds |
|----|-------|----------|--------|--------|---------|
| A1 | Python version | yes | PASS | Python 3.11.5 | 0.0 |
| A2 | Packages importable | yes | PASS | pandas 3.0.6, numpy 2.4.6, statsmodels 0.15.0, pyarrow 25.0.1, requests 2.34.2, torch 2.8.0+cpu, chronos 2.3.2, psutil 7.2.2 | 3.22 |
| A3 | Machine size | no | PASS | RAM 16.9 GB, free disk 34.3 GB | 0.0 |
| B1 | Carbon API reachable, schema | yes | PASS | fields from, to, forecast, actual, index present | 0.93 |
| B2 | 48h forward view | yes | PASS | 96 half-hours, future actuals non-null: 0 | 0.7 |
| B3 | Max date range per request | yes | PASS | largest accepted range tested: 30 days | 5.43 |
| B4 | History 1 and 2 years back | yes | PASS | 1y back: 49 actuals, 2y back: 49 actuals | 1.11 |
| B5 | Last 28 days complete and fresh | yes | PASS | missing actuals 0.00% of last 28 days; latest actual 0.8 h old | 2.28 |
| B6 | NESO vs seasonal naive (info) | no | INFO | last 28 days hourly MAE: NESO as published 10.6, seasonal naive 24h 48.9 (NESO lead time unknown, V2) | 0.01 |
| C1 | Weather forecast next 48h | yes | PASS | 48 future hours, 0 nulls in next 48h | 0.82 |
| C2 | Historical Forecast API | yes | PASS | 1464/1464 complete hours over 61 days, 0.00% rows with nulls | 1.03 |
| C3 | Hindcast 12 months back | no | PASS | 168 rows a year back, 0.00% with nulls | 0.22 |
| C4 | Carbon and weather align | yes | PASS | 100.0% of carbon hours have weather | 0.01 |
| D1 | SARIMAX with covariates | yes | PASS | fit+forecast 4.2 s on 1344 h, 48h MAE 35.4 | 4.82 |
| D2 | Structural model (UCM) | no | PASS | 0.7 s, 48h MAE 42.3 | 0.72 |
| D3 | Prophet with regressors | no | SKIP | prophet not installed (optional course model) | 0.0 |
| D4 | Chronos-2 on CPU | yes | PASS | univariate: 48 rows, warm 0.07 s, MAE 22.64; covariates: 48 rows, warm 0.13 s, MAE 14.99 | 11.62 |
| E1 | git present | no | PASS | git version 2.44.0.windows.1 | 0.05 |
| E2 | gh present and logged in | no | PASS | logged in as nivesh22 | 0.52 |
| E3 | GitHub, raw host, Hugging Face reachable | yes | PASS | github_api 200, raw 200, huggingface 200 | 0.97 |
| E4 | Raw host CORS for browser reads | yes | PASS | Access-Control-Allow-Origin: *; Cache-Control: max-age=300 | 0.26 |
| E5 | Node 20+ and npm | yes | PASS | node v22.21.0, npm 10.9.4 | 1.37 |
| E6 | npm registry reachable | yes | PASS | HTTP 200 | 0.34 |
| E7 | Vercel CLI (optional) | no | INFO | not installed (optional; Vercel MCP or web UI can deploy) | 0.01 |

## Evidence (for spec Section 2.2)

- **V1 (Carbon API range):** `/intensity/{from}/{to}` and `/intensity/{from}/fw48h` both respond. Range test by days: `{32: 'The date range you have specified is greater than 31 days. Please select a smaller date range.', 31: 'The date range you have specified is greater than 31 days. Please select a smaller date range.', 30: True, 28: True, 14: True, 7: True, 1: True}`. Largest accepted: 30 days.
- **V2 (NESO forecast vintage):** not answerable from one run. Last-28-day MAE as published: NESO 10.59, seasonal naive 24h 48.88. Stored snapshots will settle it.
- **V3 (Historical Forecast API):** host `https://historical-forecast-api.open-meteo.com/v1/forecast`, params `latitude`, `longitude` (comma lists), `hourly`, `start_date`, `end_date`, `timezone=UTC`, `wind_speed_unit=ms`. 1464/1464 complete hours.
- **V4 (variables and units):** `temperature_2m, wind_speed_100m, shortwave_radiation`; units returned: `{'time': 'iso8601', 'temperature_2m': '°C', 'wind_speed_100m': 'm/s', 'shortwave_radiation': 'W/m²'}`.
- **V5 (Chronos-2 predict_df):** `(self, df: pandas.DataFrame, future_df: pandas.DataFrame | None = None, id_column: str = 'item_id', timestamp_column: str = 'timestamp', target: str | list[str] = 'target', prediction_length: int | None = None, quantile_levels: list[float] = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], batch_size: int = 256, context_length: int | None = None, cross_learning: bool = False, validate_inputs: bool = True, freq: str | None = None, **predict_kwargs) -> pandas.DataFrame`
- **V8 (Chronos-2 CPU cost):** load 11.1 s, RSS increase 513 MB, runs `{'univariate': {'rows': 48, 'columns': ['id', 'timestamp', 'target_name', 'predictions', '0.1', '0.5', '0.9'], 'warm_seconds': 0.07, 'quantiles_monotone': True, 'mae_48h': 22.64}, 'covariates': {'rows': 48, 'columns': ['id', 'timestamp', 'target_name', 'predictions', '0.1', '0.5', '0.9'], 'warm_seconds': 0.13, 'quantiles_monotone': True, 'mae_48h': 14.99}}`
- **V9 (raw host CORS):** `*`, `max-age=300`

## Notes

- Weather points and equal weights here are provisional for the gate; T1 sets the real ones.
- The single-origin MAE numbers are smoke tests, not evidence about which model is better (spec 14.6).
- The SARIMAX/UCM specifications here are placeholders until the course specifications are confirmed (spec 13.1 Q3).
