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
