# Decisions log

Deviations from `greenwindow-design-spec.md`, new dependencies, and resolved verification items (V1–V11). Newest first.

Format:

```
## YYYY-MM-DD — <short title>
- Context:
- Decision:
- Reason:
- Spec sections affected:
```

---

## 2026-10-05 — Project setup
- Context: Claude Code project initialized with `CLAUDE.md`, `AGENTS.md` (spec Section 12 verbatim), and MCP config.
- Decision: Configure GitHub and Vercel MCPs only. Supabase is not configured, per spec D6 and 15.1.
- Reason: The plan uses no database; connecting one adds risk and a pausing free tier.
- Spec sections affected: none.

## 2026-10-05 — GitHub access via gh CLI instead of GitHub MCP
- Context: Spec H6 suggests a fine-grained PAT scoped to one repo for the GitHub MCP.
- Decision: Use `git` + `gh` CLI with the owner's existing login. GitHub MCP removed from `.mcp.json`.
- Reason: Owner's choice; simpler. Risk: the login has `repo`/`workflow` scope on all the owner's repos, so the agent rule is to touch only `nivesh22/greenwindow`.
- Spec sections affected: 15.2 H6, 15.3.

## 2026-10-05 — T-1 feasibility script written in-repo; V1, V3, V4, V9 resolved
- Context: Spec 14 refers to `scripts/feasibility_check.py` "delivered alongside this spec", but it was not provided.
- Decision: Wrote it from spec 14.3. Weather points/weights in it are provisional (equal weights; London, Birmingham, Glasgow, Aberdeen); T1 sets the real ones. SARIMAX(2,0,1)+Fourier and UCM specs in the gate are placeholders until course specs are confirmed.
- Findings: V1 — Carbon API accepts up to 30 days per request (31 rejected), not ~14; chunk at 30 days. V3/V4 — host and variable names as spec assumed; request `wind_speed_unit=ms`. V9 — raw host sends `Access-Control-Allow-Origin: *`, `Cache-Control: max-age=300`.
- Spec sections affected: 2.2 (V1, V3, V4 annotated).

## 2026-10-05 — Feasibility verdict GO; torch pinned to 2.8.0 (CPU)
- Context: torch 2.14.1+cpu fails to import on this Windows build (WinError 1114, `c10.dll` init) despite a current VC++ runtime.
- Decision: Pin `torch==2.8.0` (CPU wheel). chronos-forecasting 2.3.2 works with it.
- Findings: V5 signature and V8 timing recorded in spec 2.2 and `docs/feasibility_report.md`. Chronos-2 is cheap on CPU (~0.1 s per 48h forecast after an 11 s load), so it can run in every pipeline run.
- Spec sections affected: 2.2 (V5, V8), 4.3.

## 2026-10-05 — Course-aligned model set (FPP 2nd ed. course outline)
- Context: Course covers Prophet (wk 2), ARIMA/SARIMA (wk 3), structural time-series models and dynamic regression (wk 4), VAR/ECM and dynamic factor models (wk 5).
- Decision: Registry = `snaive_24`, `snaive_168`, `ets`, `sarimax_wx` (dynamic harmonic regression: ARMA errors + Fourier 24h/168h + weather + holiday), `chronos2_uni`, `chronos2_cov`; then `ucm_wx` (UnobservedComponents with weather regressors) and `prophet_wx` (Prophet with regressors) as course models; `lgbm_wx` (R10) stays optional. VAR / dynamic factor are out of scope for v1.
- Reason: Owner asked to pick from the course outline; these map one-to-one to course weeks. Changeable later.
- Spec sections affected: 6.2 (adds `ucm_wx`, `prophet_wx`).

## 2026-10-05 — Build order: thin end-to-end slice first
- Context: Spec Section 11 builds the offline core (T0–T9) before anything live. Owner wants "a minimal working thing first, then improve".
- Decision: After T0, build one vertical slice: ingest → observations → a few models (`snaive_24`, `sarimax_wx`, `chronos2_cov`) + NESO → snapshots → JSON export → scheduled workflow to `data` branch → web Home + Scheduler on Vercel. Then add remaining models, scorer/leaderboard, backtest, and the other pages. This also covers T-1b (skeleton walk).
- Reason: Owner's priority; proves the plumbing early. All spec acceptance criteria still apply per task.
- Spec sections affected: 11 (order only).

## 2026-10-05 — Slice build choices (T1–T11 minimal versions)
- **Forecast origin = hour after the latest actual**, not the wall-clock hour. Actuals lag ~1–2 h; this avoids imputing trailing values. `run_id`/`issued_at_utc` are that origin hour, so the first forecast hour or two may already be in the past when published. Spec 6.6 assumed the issue hour.
- **Weather for history:** bootstrap uses the Historical Forecast API; each run then overlays the Forecast API's `past_days=7` (also a forecast product, so D3 holds). Future covariates come from the same Forecast API call.
- **Weather points/weights (T1):** London, Birmingham, Glasgow, North Sea (54.0N, 1.5E) with per-variable weights (temp/solar follow population and the solar fleet; wind follows Scotland and offshore). In `config/locations.yaml`; documented simplification.
- **Bank holidays:** England (`holidays.country_holidays("GB", subdiv="ENG")`), judged on the Europe/London local date.
- **Validation:** plain pandas validators in `schemas.py` and `export/app_json.py` instead of pandera (spec allows either; avoids a heavy dependency for now).
- **New direct dependencies:** `pyyaml` (config), `holidays` (spec 4.3), `scipy` (normal quantiles for SARIMAX intervals; already a statsmodels dependency).
- **snaive intervals:** empirical quantiles of lag-m differences, scaled by sqrt(k) for k seasons ahead (seasonal random walk). Spec only said "empirical residual quantiles".
- **SARIMAX spec (placeholder until course week 3–4):** SARIMAX(2,0,1) + constant, exog = weather + bank-holiday dummy + Fourier(24h, K=3) + Fourier(168h, K=2). Constant exog columns are dropped per fit.
- **Keepalive (V6):** the workflow runs `gh workflow enable` each run. Unverified whether this resets the 60-day timer; calendar check (H12) remains the real safeguard.
- **Rerunning the same run_id** without Chronos drops that run's Chronos rows (same-run replacement, as spec 6.6 defines it).

## 2026-10-05 — Web app choices (T12–T13 minimal versions)
- **Toolchain (V10), pinned exactly:** Vite 8.3.2, React 19.3.0, TypeScript 6.0.3 (TypeScript 7 is out but the Vite template pins 6), Recharts 3.10.1 (range-area support confirmed via `Area` `isRange`), TanStack Query 5.104.1, zod 4.6.5, react-router-dom 7.18.4, Tailwind 4.3.3, Vitest 5.0.3, Testing Library 16.3.3, jsdom 29.
- **Lint:** oxlint (the current Vite template's default) instead of ESLint. Same purpose, much faster; no extra config.
- **Optimizer additions to spec 6.7:** an `InvalidJobError` for out-of-range inputs (spec only defined `InfeasibleJobError`); `gramsDifference` is clamped at 0 like `intensityReductionPct` (in cautious mode the best-by-P90 window can have a higher median); `robust` is false when no change is recommended.
- **Pages in the slice:** Forecast (Home), Plan a job (Scheduler), Leaderboard, About & limits. Backtest page waits for T9.
- **Not yet done from spec 10.4:** axe accessibility check, Playwright end-to-end test. Initial JS is 234 KB gzipped (budget 400 KB).
- **V11 (no Vercel builds from `data`):** `web/vercel.json` sets `git.deploymentEnabled.data = false`. Because Vercel reads `vercel.json` from the commit being deployed, the same file is also committed on the `data` branch at `web/vercel.json`, and the project has an Ignored Build Step command that exits 0 on the `data` branch as a backstop.

## 2026-10-06 — ETS, course models (UCM, Prophet), backtest
- **`ets`:** ETS(A,N,A), 24h season, analytic intervals. ETS(A,Ad,A) was tried first: the damped trend still drifted over 48h (MASE ≈ 2 on a 6-origin trial, worse than seasonal naive), so the trend was dropped. Spec 6.2 only says "additive ETS with 24h seasonality".
- statsmodels 0.15 `ETSResults.get_prediction` crashes when endog is an ndarray; the model passes a RangeIndex Series.
- **`ucm_wx`** (course week 4): local level + trigonometric seasonals (24h K=3, 168h K=2) + AR(1) + weather and holiday regressors.
- **`prophet_wx`** (course week 2): daily + weekly seasonality, no yearly (56-day window), weather and holiday regressors, `interval_width=0.8`, seeded fit and uncertainty simulation. New dependency `prophet` (course model; ships a precompiled Stan model, installs cleanly on Windows and Linux).
- **Backtest (spec 6.4):** observations rebuilt from the APIs with hindcast weather only, so it runs from a clean clone; daily 00:00 UTC origins over 90 days; classical models parallelised across processes (deterministic per job), Chronos in the main process. `--end` pins the period for reproducibility.
- **Sensitivity (spec 8.2):** run on every third origin to fit the 30-minute budget. Classical window {28, 56, 84} days, Chronos context {14, 28, 56} days. Benchmarks have no sensitivity runs.
- **MASE scale:** in-sample seasonal-naive (m=24) MAE of each origin's 56-day window, shared by all models at that origin.
- **NESO in the backtest:** included as `neso_published` (forecast as returned by the API, lead time unknown), labelled as not a fair comparison (spec 5.3 item 7).
- **backtest_summary.json:** `horizon_bucket` also takes `"all"`. Served from the site itself (`web/public`), so the web client fetches it same-origin.

## 2026-10-07 — Wind power feature (`wind_cf`) and more wind points
- **Why:** at 25-48 h ahead our best model (Chronos-2 + weather, MASE 0.625) is well behind NESO (0.339), and errors are largest at low wind. Turbine output is not linear in wind speed, and averaging speeds across sites before converting hides that.
- **`wind_cf`:** generic normalised power curve at 100 m: 0 below 3 m/s, cubic ramp to 1 at 12 m/s, 1 up to 25 m/s, 0 at and above 25 m/s (storm cut-out). Applied per point, then weighted. A simplification: real fleet curves are smoother (mixed turbines, wake losses, curtailment) and are not fitted here.
- **Models:** `COVARIATES` uses `wind_cf` instead of `wind100`. `wind100` stays in observations and in `recent_observations.json` (JSON contract unchanged).
- **Points:** added East Anglia offshore (52.6N, 2.4E), Moray Firth offshore (58.2N, 2.9W) and Irish Sea (54.0N, 3.5W), with wind weight only. Wind weights now roughly follow installed capacity: Glasgow 0.25, North Sea 0.30, East Anglia 0.15, Moray 0.10, Irish Sea 0.10, London 0.05, Birmingham 0.05. Temperature and solar weights are unchanged.
- **Migration:** if stored observations lack a column in `OBSERVATION_COLUMNS`, the pipeline re-bootstraps them from the APIs (400 days) instead of leaving history half-filled. Snapshots are untouched.
- **Result** (backtest pinned to `--end 2026-10-06T01:00`, same 90 origins as before): Chronos-2 + weather MASE 0.518 -> 0.484 overall, 0.625 -> 0.581 at 25-48 h, 0.454 -> 0.420 at 7-24 h, unchanged at 1-6 h. Prophet + weather 0.713 -> 0.655. SARIMAX and UCM unchanged (±0.01). Weather-input caveat (D3/5.3) still applies; the live leaderboard is the check.
- **SARIMAX fallback:** with the new inputs, L-BFGS stopped at a unit-root boundary at one origin (2026-08-03; log-likelihood 0, non-finite forecast variance). If the forecast variance is not finite, the model refits with Powell.
