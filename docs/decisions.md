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

## 2026-10-09 — P4 follow-through: web-push, cron via pg_net, calendar
- **web-push 3.6.7** (+ `@types/web-push` 3.6.4, dev), exact pins: sends VAPID-signed Web Push from `/api/cron/reminders`. Mature, the standard Node implementation of RFC 8030/8291/8292; no paid service. Keys: `VITE_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (H9).
- **Cron:** Supabase `pg_cron` + `pg_net` call `/api/cron/{reminders,recurring,ledger}` with `x-cron-secret` read from Vault (`greenwindow_app_url`, `greenwindow_cron_secret`); jobs are no-ops until both secrets exist. The reminders job only calls the app when a reminder is due. Migration 0005.
- **Calendar:** `.ics` (RFC 5545) built in the browser/tool, plus a Google Calendar template link; the link format has no Google reference (spike S7), so the .ics is the dependable path.
- **Recurring plans** never promise a slot beyond the forecast horizon (48 h): `next_start_utc` is recomputed each morning after the 06:17 pipeline run.

## 2026-10-09 — Langfuse export (P4.5) and its dependencies
- **What:** each chat turn is exported to Langfuse Cloud (EU, Hobby, free) as one trace after it is saved to Supabase (`web/agent/telemetry/langfuse.ts`). Supabase stays the source of truth. Built with the Langfuse agent skill (github.com/langfuse/skills, installed at user level) and checked against https://langfuse.com/docs/observability/best-practices.md and the installed SDK types.
- **Trace shape:** `chat-turn` (`agent`, input = user message, output = answer); gates as `guardrail` (check-input, check-grounding, check-output) or `chain` (route-intent, decide-ask-or-act, choose-risk-mode); one `generate-step` `generation` per model call (OpenAI-format messages, model, tokens, cost; failed attempts at level ERROR); tools as `tool` with args and results, siblings of the generation that asked for them. Session = conversation id, user = Supabase user id, version = prompt version, tags = auth state + intent, environment = `VERCEL_ENV`, release = git sha. Recorded start/end times are kept.
- **Sampling:** deterministic per turn id at `LANGFUSE_SAMPLE_RATE` (default 0.2); always exported when the stop reason is not `final`, any span failed, a failover happened, grounding regenerated/templated, or a guard blocked. Thumbs feedback becomes a `user_feedback` score; a thumbs-down on an unsampled turn exports that turn first (from Supabase). Hobby quota is 50k units/month; at today's traffic this is far below it.
- **Privacy:** message text is cut to 500 characters, e-mails and long digit runs are redacted before export; LLM/tool payloads exist only in memory for the export and are never written to Supabase. The privacy page lists Langfuse.
- **Serverless:** `exportMode: 'immediate'` and `forceFlush()` before the function returns (Langfuse docs: short-lived apps must flush). An isolated tracer provider (`setLangfuseTracerProvider`) so nothing else is exported; an AsyncLocalStorage context manager so `propagateAttributes` works.
- **New dependencies (exact pins, rule 10):** `@langfuse/tracing`, `@langfuse/otel`, `@langfuse/client` 5.13.1 (latest; client is for scores); `@opentelemetry/api` 1.9.1, `@opentelemetry/core`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/context-async-hooks` 2.12.0, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/otlp-exporter-base` 0.223.0 (peer dependencies of `@langfuse/otel`). Server-side only; the browser bundle does not import them.
- **Env (Vercel, Preview + Production):** `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (`https://cloud.langfuse.com`), optional `LANGFUSE_SAMPLE_RATE`. Without the keys the exporter is a no-op.

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

## 2026-10-09 — P3 contracts: user data, auth, browser dependencies
- **Migration 0003** (`users_memory`): profiles, devices, conversations, messages, summaries, impact ledger, feedback, admins. Every user-owned row cascades from `auth.users`, and `turns.user_id` now references it too, so deleting the auth user deletes the user's data and traces (FR-7.4). RLS on all tables; owners may only SELECT their rows; all writes go through the server.
- **Server auth:** access tokens are verified with one call to Supabase Auth `GET /auth/v1/user` (design S5 fallback), cached briefly; no JWT library.
- **Impact ledger:** realized values are filled lazily when `get_impact` runs (from the published observations), so P3 needs no cron job or cron secret. Retention (90 days, idle anonymous users after 30 days) runs as a pg_cron SQL job if available on the free plan (verify), else in the 6-hourly pipeline.
- **New dependency `@supabase/supabase-js`** (browser only): anonymous sign-in, Google OAuth with PKCE, `linkIdentity`, session refresh. Hand-writing the OAuth/PKCE flow would be riskier.
- **Third-party script: Cloudflare Turnstile** (`challenges.cloudflare.com`) loads only when the chat is first used, before creating an anonymous session (H8). Exception to AGENTS.md rule 6, which covers data fetches; recorded here.

## 2026-10-08 — Risk mode meaning; eval-driven fixes
- **Risk mode:** "cautious" plans on the high (q90) forecast so the lower-carbon benefit holds if the forecast is off. A deadline ("must be done by 7am") is a hard constraint in both modes and is no longer a cautious signal. Corrects PRD FR-3.4 / design §6.2 wording ("it really must finish" -> cautious), which conflated deadline urgency with forecast risk; the live evals showed it changing recommendations.
- **Prompt v3:** deadlines and job sizes belong to the user; never move, shorten or resize to make a job fit; say it does not fit and offer options.
- **Gates:** guard_in "off_topic" only ends the turn when the router also finds no domain intent. Grounding allows scope facts (48 h, 1-12 h, 80% band). Regeneration never mentions an earlier draft.
- **Evals:** recordings committed (`web/evals/recordings`, ~0.4 MB, scanned for secrets); CI replay requires them (`EVAL_REQUIRE_RECORDINGS=1`) and has no path filters so it can be a required check. Re-record after any prompt/tool/gate change: `EVAL_MODE=record` (~6 min, ~$0.07).

## 2026-10-08 — Release 1; P2 gate backend
- **Release 1:** `assistant` merged to `main` (5a89238); production `/api/health` and a live chat turn verified, CI green.
- **Gates (plan X10):** Jev (`typesafe-ai/jev` via AI Gateway, approved by the owner) is the primary backend for all decision gates; each gate has deterministic rules as fallback (timeout, error, low confidence). The design's Flash-Lite classifier is dropped from the hot path because of its erratic latency and Gemini free-tier quotas.
- **Evals (X11):** replay recordings are produced by one live run by the orchestrator and committed; CI replays them with no network or spend.

## 2026-10-08 — Function region dub1
- Vercel Functions run in Dublin (`"regions": ["dub1"]` in `web/vercel.json`; Hobby allows a single region, https://vercel.com/docs/functions/configuring-functions/region). The default `iad1` was ~80 ms per Supabase round trip from eu-west-1 (Ireland); a turn makes 2–4 database calls. Static files still come from the CDN edge.

## 2026-10-08 — CO2 wording for the assistant (O1); paid gateway credit
- **Wording:** the assistant reports grams as an "estimated emissions difference: about X g (range Y–Z)" with the caveat that it uses average (not marginal) grid intensity and a forecast. "Saved" and "avoided" stay banned: they claim a causal effect the average-intensity method does not support. Forecast pages keep the spec 5.3 wording. AGENTS.md rule 9 rewritten.
- **Gateway:** owner bought a small paid AI Gateway top-up (auto-reload off) so Haiku 5.5 can be the cross-provider failover and Jev is callable. All spend still counts toward `MONTHLY_BUDGET_USD` ($5) and the kill switch.
- **Model route:** `gemini-3.5-flash` -> `gemini-3.5-flash-lite` -> `gemini-3.8-flash` -> `anthropic/claude-haiku-5.5` (live latency/quota checks in `docs/spikes.md`).

## 2026-10-08 — Agent overhaul: backend, Supabase, models, rule changes
- **Context:** the owner wants an agentic showcase (`docs/agent-prd.md`, `docs/agent-design.md`, `docs/agent-execution-plan.md`). It conflicts with rules written for the static app.
- **Backend:** Vercel Functions inside `web/` (`web/api/`, server code in `web/agent/`), so the agent imports `optimizer.ts` directly. Forecast pages still read only the published JSON; the JSON contract (7.6) is unchanged.
- **Supabase adopted (reverses D6):** free tier, project `sndukjnxdvhrnbtazrlu` (eu-west-1). From P1a: spend ledger, usage counters, turns, spans. From P3: auth (anonymous + Google), memory. From P4: pg_cron jobs. CLI pinned at `supabase@2.120.0`.
- **Models:** Gemini Flash (free tier, direct OpenAI-compatible endpoint) as primary; Claude Haiku 5.5 via Vercel AI Gateway as fallback. Plain `fetch` adapter, no provider SDKs (keeps the transport visible, no new dependencies).
- **Jev:** optional adapter behind the typed gate interface, only after spike S1 confirms it from primary sources and the owner approves the spend. Gates ship first on rules + a Flash-Lite classifier.
- **Answers are buffered** until the deterministic grounding check passes (plan X4). Evals: replay mode in CI, live mode on demand (X7).
- **Rules changed:** AGENTS.md 6 (own `/api/*` allowed for the assistant), 7 (LLM spend capped at $5/month with a kill switch, server secrets in Vercel/GitHub only), new 14 (numbers come from tools) and 15 (evals, `assistant` branch). Rule 9 (CO2 wording) is unchanged until the owner decides O1.
- **Secrets (names only):** `GEMINI_API_KEY`, `AI_GATEWAY_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `IP_SALT`; public `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. Later phases add the rest of design §16.
- **Spec sections affected:** 1 (scope), 4.4 (layout), D6, 15.1. The forecasting spec v0.3 is otherwise frozen.

## 2026-10-07 — Wind power feature (`wind_cf`) and more wind points
- **Why:** at 25-48 h ahead our best model (Chronos-2 + weather, MASE 0.625) is well behind NESO (0.339), and errors are largest at low wind. Turbine output is not linear in wind speed, and averaging speeds across sites before converting hides that.
- **`wind_cf`:** generic normalised power curve at 100 m: 0 below 3 m/s, cubic ramp to 1 at 12 m/s, 1 up to 25 m/s, 0 at and above 25 m/s (storm cut-out). Applied per point, then weighted. A simplification: real fleet curves are smoother (mixed turbines, wake losses, curtailment) and are not fitted here.
- **Models:** `COVARIATES` uses `wind_cf` instead of `wind100`. `wind100` stays in observations and in `recent_observations.json` (JSON contract unchanged).
- **Points:** added East Anglia offshore (52.6N, 2.4E), Moray Firth offshore (58.2N, 2.9W) and Irish Sea (54.0N, 3.5W), with wind weight only. Wind weights now roughly follow installed capacity: Glasgow 0.25, North Sea 0.30, East Anglia 0.15, Moray 0.10, Irish Sea 0.10, London 0.05, Birmingham 0.05. Temperature and solar weights are unchanged.
- **Migration:** if stored observations lack a column in `OBSERVATION_COLUMNS`, the pipeline re-bootstraps them from the APIs (400 days) instead of leaving history half-filled. Snapshots are untouched.
- **Result** (backtest pinned to `--end 2026-10-06T01:00`, same 90 origins as before): Chronos-2 + weather MASE 0.518 -> 0.484 overall, 0.625 -> 0.581 at 25-48 h, 0.454 -> 0.420 at 7-24 h, unchanged at 1-6 h. Prophet + weather 0.713 -> 0.655. SARIMAX and UCM unchanged (±0.01). Weather-input caveat (D3/5.3) still applies; the live leaderboard is the check.
- **SARIMAX fallback:** with the new inputs, L-BFGS stopped at a unit-root boundary at one origin (2026-08-03; log-likelihood 0, non-finite forecast variance). If the forecast variance is not finite, the model refits with Powell.

## 2026-10-07 — Chronos-2 + Prophet blend (`blend_wx`)
- **What:** hours 1-24 copy `chronos2_cov`; hours 25-48 are 0.7 x `chronos2_cov` + 0.3 x `prophet_wx` (mean and each quantile). Derived from stored snapshots, no refit (`models/blend.py`).
- **Weight choice:** 0.7 picked on the same 90-origin backtest (in-sample choice; mild optimism). The gain held in both halves of the period (25-48 h MAE 19.5 -> 18.9 and 21.0 -> 19.6). Blending did not help at 1-24 h, so those hours stay Chronos-only.
- **Result:** 25-48 h MASE 0.581 -> 0.553, all horizons 0.484 -> 0.470, 80% coverage 83%.
- **Leaderboard continuity:** a new model row; existing models and their history are untouched. Blend rows are backfilled for any stored run that has both components, because those inputs were issued at that run's origin (no leakage). Rows for runs before 2026-10-08 were derived after the fact, not issued live. No existing snapshot row is edited (D5 holds).
- **JSON contract (7.6):** `family` gains `"ensemble"`. Additive; `schema_version` stays 1 because the web app deploys on push to `main`, before the next cron pipeline run writes it.
