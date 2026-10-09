# Execution plan: GreenWindow Assistant

| | |
|---|---|
| Status | v1, agreed 2026-10-08 |
| Implements | [`docs/agent-prd.md`](agent-prd.md) v0.1 and [`docs/agent-design.md`](agent-design.md) v0.1, with the changes in §1 |
| Tracks | Who builds what, in which order, what the owner must set up, and when each setup item blocks work |

The PRD says what we build. The design doc says how. This document says **who does what, in what order**, and lists
every account, key and setting the owner has to provide, timed so the owner can set them up while the agents build.

---

## 1. Changes to the PRD/design agreed on 2026-10-08

These go into PRD/design v0.2 in task P0.3 and into `docs/decisions.md`.

| ID | Change | Why |
|----|--------|-----|
| X1 | **P1 is split.** P1a is a thin slice: one provider (Gemini), 3 core tools, a basic chat panel, a per-turn cost cap, persisted spend. P1b adds failover, the trace drawer, panel sync and limits. | Minimal working thing first (owner preference). |
| X2 | **Supabase now.** The project is created in P0 and used from P1a for `cost_ledger`, `usage_daily`, `turns` and `spans`. Auth, memory and cron still arrive in P3/P4. | Owner decision. The kill switch needs persisted spend. |
| X3 | **Jev becomes an adapter, not a dependency.** The gates are built on the typed `Gate` interface with rules plus a cheap LLM classifier (Gemini Flash-Lite, JSON mode). Jev is added behind the same interface only after spike S1 confirms access, request shape and price from primary sources. | Every Jev source so far is a third-party blog (AGENTS.md rule 1). P2 must not wait on it. |
| X4 | **The final answer is buffered, not streamed.** The client streams status, gate and tool events live. The answer text is sent once the deterministic grounding check passes. `text_reset` and `done.replace` are dropped. The deterministic grounding check moves from P2 to P1b. | The user never sees a number that gets withdrawn. Answers are short. |
| X5 | NFR-1 becomes: first visible event p50 < 1.5 s, full answer p50 < 6 s, p95 < 15 s. | Follows from X4. |
| X6 | **The fallback model is Claude Haiku 5.5** (`claude-haiku-5-5`; the gateway model ID is checked in spike S4), not Haiku 4.5. | Current model family. |
| X7 | **Evals run in two modes.** The *Replay* mode runs in CI on every agent PR with recorded model responses. It is free, deterministic and a required check. The *Live* mode uses real models with `EVAL_BUDGET_USD` and runs on demand (`workflow_dispatch`) and nightly while P2–P4 are active. | No flaky CI and no spend on every push. |
| X8 | **Fewer build agents.** The test-runner subagent is dropped (the orchestrator runs the suites). Parallel agents are used only where file ownership is disjoint (§3.2). | Reasonable token use. |
| X9 | **Integration branch.** Agent work merges into `assistant`, which Vercel deploys as a preview URL. `main` (production) receives `assistant` only at phase exits (P1b, P2, P3, P4). | Production never shows a half-built assistant. |
| X10 | **Gates: Jev first, rules fallback** (2026-10-08, after H12). Jev via the gateway answers every gate (~300 ms, ~$0.000017/decision); on timeout/error/low confidence the gate's deterministic rules decide. The Flash-Lite classifier is dropped from the hot path (flash-lite latency is erratic, 7–47 s, and Gemini free quotas are tight); the `ChoiceBackend` interface keeps an LLM classifier possible later. | Fast, cheap, typed decisions; nothing on the gate path waits on Gemini. |
| X11 | **Replay evals are recorded live by the orchestrator.** Agents build the runner, scenarios and a recording mode with no network; the orchestrator runs the live recording once with the owner's keys and commits the recordings. | Rule: agents never call paid APIs. |
| X12 | `done.trace.llm_calls` carry `ok` and `error`, so failed attempts (e.g. Gemini 429s) show as failed in the drawer. | Owner feedback on the release-1 drawer. |

**Still open (owner decision, needed before P1a tools ship):** O1, the CO2 wording. Option (a) is the PRD proposal:
"Estimated CO2 avoided: about X g (range Y to Z g)" with the average-vs-marginal caveat, which reverses rule 9 and
spec 5.3. Option (b) keeps the current rule: "estimated difference in average grid intensity", with a range. Until
you decide, the tools emit (b).

## 2. Phase overview

```
Phase:    P0 ──► P1a ──► P1b ──► P2 ──► P3 ──► P4 ──► (P5: separate addendum)
Release:  -      -       prod 1  prod 2  prod 3  prod 4
Owner:    H1-H3  H4, O1  H5      H6-H8,  H9-H11
                                 H12
```

| Phase | Goal | Exit criteria | Goes to production |
|-------|------|---------------|--------------------|
| P0 | Docs, rules, contracts and agent definitions in place. Supabase project exists. | Contracts compile. `npm test` and `npm run typecheck` green. `.claude/agents/*.md` committed. Migration 0001 applied. | No (docs/rules commit to `main` only) |
| P1a | One chat turn works end to end on the `assistant` preview URL. | J1 ("charge my EV before 7am") answered with an optimizer-exact start time. Spend written to `cost_ledger`. Harness unit tests green. | No |
| P1b | ✅ done 2026-10-08, **release 1** (`assistant` → `main`) | Grounding check (pass / one rewrite / template) + circuit breaker; plan panel two-way sync, two-column layout, "How I got this" drawer; migration 0002 (80% alert, `reset_budget`, `budget_status`) applied live; health keepalive; `explain_uncertainty`; functions in `dub1`; `recommend_window` returns London-time fields (prompt v2); route Gemini 3.5-flash → Haiku 5.5 → flash-lite → 3.8-flash. Turns ~10–13 s, ~$0.002 when Haiku answers. 269 web tests + Python suite green. |
| P2 | ✅ done 2026-10-09, **release 2** (`main` 2918ba0; production verified: Jev gates ~250–365 ms, honest infeasible answer, insight tools) | ✅ P2.2 gates (Jev first, rules fallback; guard_in ∥ router, ask_or_act ∥ risk_mode, guard_out after grounding; live `gate` events; injection rules override a Jev allow). ✅ P2.3 insight tools (benchmark always included). ✅ P2.4 eval suite: 50 scenarios, replay/record/live, CI `agent-evals (replay)`. **Live recording 2026-10-08: first run 70% found 4 real bugs** (deadline read as cautious risk mode, deadline silently moved, our model names screened off-topic, rewrite text leaking); fixed (prompt v3, risk_mode = carbon-forecast risk only); second run **replay 50/50, window correctness 100%, banned claims 0, $0.069 per full live run**. Tools in one step now run sequentially. Known limitation: injected text in a device name/label blocks the whole request (safe, less helpful than FR-2.8). |
| P3 | Users, memory, impact ledger. | J2, J3 and J7 work end to end. pgTAP RLS tests pass. Delete-my-data test passes. | Yes |
| P4 | Follow-through and ops. | J4, J5, J6 and J8 work. The Ops page shows real data. README showcase done. | Yes |

## 3. Who works on what

### 3.1 Roster

Subagents are defined in `.claude/agents/<name>.md` (task P0.4). Each one reads `AGENTS.md`, its own design sections
and this plan. It works only inside its owned paths, writes tests first, and finishes with `npm test`, `npm run
typecheck` and `npm run lint` green in its worktree. It reports changed files, open issues and anything that blocks
it on the owner.

| Agent | Model | Owns (may edit) | Phases |
|-------|-------|-----------------|--------|
| **orchestrator** (the main session) | Opus 5.5 | Contracts (`agent/harness/events.ts`, `providers/types.ts`, `tools/registry.ts` types, `gates/types.ts`, `store/types.ts`, `config.ts`), `turn.ts` integration, prompts, docs, rule files, migrations' review, merges | All |
| **harness-engineer** | opus | `web/agent/harness/**` (except contracts), `web/agent/providers/**`, `web/agent/gates/**`, `web/agent/telemetry/**` | P1a, P1b, P2, P3 (context), P4 (Langfuse) |
| **tools-engineer** | sonnet | `web/agent/tools/**`, `web/agent/data/**` | P1a, P2, P3, P4 |
| **frontend-engineer** | sonnet | `web/src/assistant/**`, `web/src/pages/{Scheduler,Ops,Privacy,Settings}.tsx`, `web/public/sw.js` | P1a, P1b, P3, P4 |
| **backend-engineer** | sonnet | `web/api/**`, `web/agent/store/**`, `supabase/**`, the keepalive step in `.github/workflows/pipeline.yml` | P1a, P1b, P3, P4 |
| **eval-engineer** | sonnet | `evals/**`, `.github/workflows/agent-evals.yml` | P2, P4 |
| **docs-researcher** | haiku | `docs/spikes.md` only (read-only elsewhere) | P0–P2 (spikes) |

The orchestrator writes the contracts **before** any fan-out. If an agent needs a contract change, it stops and
reports instead of editing the contract.

### 3.2 Parallel-work rules

- Each parallel agent runs with `isolation: worktree` on a branch `agent/<task-id>` cut from `assistant`.
- Parallel lanes must have disjoint "Owns" paths (table above). Shared files (`package.json`, `App.tsx`,
  `vercel.json`, `tsconfig*.json`) are edited only by the orchestrator. Agents list the changes they need in their
  report.
- Merge order follows the task table. The orchestrator merges `agent/<task-id>` → `assistant`, runs the full
  suite (`uv run pytest`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, plus replay evals from
  P2), then pushes. Vercel builds a preview of `assistant`.
- No agent touches `main`, the `data` branch, the forecasting pipeline (`src/greenwindow/**`) or the JSON contract
  (spec 7.6).
- No subagent is used for small edits.

## 4. Task plan

∥ marks tasks that run in parallel. "Needs" lists task or owner (H/O) dependencies. **Owner, meanwhile** shows what you
and I set up together while the agents run.

### P0: Kickoff (the orchestrator, sequential, today)

| ID | Task | Agent | Needs |
|----|------|-------|-------|
| P0.1 | Merge `agent-overhaul` into `main` | orchestrator | ✅ done 2026-10-08 |
| P0.2 ✅ | Rule changes: AGENTS.md rules 6, 7, 14, 15 (rule 9 waits for O1), CLAUDE.md summary, Supabase line, `docs/decisions.md` entries (§17 of the design + X1–X9). Add the `Read(./web/.env*)` deny to `.claude/settings.json`. | orchestrator | — |
| P0.3 ✅ | PRD and design → v0.2 with X1–X9 | orchestrator | — |
| P0.4 ✅ | `.claude/agents/*.md` for the 6 subagents | orchestrator | — |
| P0.5 ✅ | Refactors: `src/data/parse.ts`, `src/data/models.ts` (re-exported, existing tests unchanged), `tsconfig.agent.json`, and the typecheck script covering both projects | orchestrator | — |
| P0.6 ✅ | Contracts: `events.ts`, `providers/types.ts`, `tools/registry.ts` (types), `gates/types.ts` (interface), `store/types.ts` (Store interface + in-memory fake), `ChatRequest`, the `config.ts` skeleton, and the SQL of `supabase/migrations/0001_init.sql` | orchestrator | — |
| P0.7 ✅ | Spikes S2–S5 from docs (desk research) → `docs/spikes.md`. S1 (Jev) from primary sources only. | docs-researcher (background) | — |
| P0.8 ✅ | Create the `assistant` branch and confirm Vercel builds a preview for it | orchestrator | — |
| P0.9 | Apply migration 0001 to the Supabase project (`npx supabase link` + `db push`) | orchestrator, with you | **H1** |

**Owner, meanwhile:** H1 (Supabase), H2 (Gemini key), H3 (AI Gateway). See §5.

### P1a: Thin slice

| ID | Task | Agent | Needs |
|----|------|-------|-------|
| P1a.1 ∥ ✅ | `openai_compat.ts` (streaming parser, fragmented tool calls, usage), single-provider `router.ts`, `loop.ts`, `budget.ts` (steps, tokens, cost, wall clock), `retry.ts`, in-memory tracer. `ScriptedProvider` tests. | harness-engineer | P0.6 |
| P1a.2 ∥ ✅ | `ForecastSource` (HTTP + fixture), `get_forecast`, `recommend_window`, `estimate_co2` (range + O1 wording behind a constant), `lookup_device` + `devices.json` with cited sources | tools-engineer | P0.6 |
| P1a.3 ∥ ✅ | `sse.ts`, `useChat`, a basic `ChatPanel` with status lines and a final answer, a Stop button, tested against a mock SSE stream built from `events.ts`. Scheduler page: chat above/beside the existing form (no sync yet). | frontend-engineer | P0.6 |
| P1a.4 ∥ ✅ | `store/supabase.ts` implementing `Store` (usage, cost_ledger, turns, spans), the `consume_message()` SQL function, `api/health.ts`, the `api/chat.ts` skeleton (SSE, body parsing, IP hash, cost-ledger check). Hello-SSE preview deploy (spike S2, live). | backend-engineer | P0.6, P0.9 (H1) |
| P1a.5 ✅ | Recorded Gemini fixtures for the parser tests (spike S3, live): stream with text, tool calls, usage | orchestrator | **H2** ✅ |
| P1a.6 ✅ | Integration: `turn.ts` (no gates), system prompt v1, wiring, preview deploy, manual J1 check on the preview URL, cost per turn measured | orchestrator | P1a.1–5, **H4** |

**Owner, meanwhile:** H4 (env vars in Vercel + `web/.env.local`). Decide O1. Optionally start H6 (Google OAuth), which
takes a while.

### P1b: Harden (then release to production)

| ID | Task | Agent | Needs |
|----|------|-------|-------|
| P1b.1 ∥ ✅ | Gateway provider config, failover + circuit breaker, `provider_down`, deterministic `grounding.ts` (moved from P2), all stop reasons tested. Recorded gateway fixtures (spike S4, live). | harness-engineer | P1a, **H3** |
| P1b.2 ∥ ✅ | `PlanPanel` refactor with two-way sync (`plan_update` ↔ `panel_state`), `TraceDrawer` (tools + LLM calls), unavailable/limit notice, starter chips, 360 px layout, keyboard and screen-reader labels | frontend-engineer | P1a |
| P1b.3 ∥ ✅ | Per-IP and global rate limits via `consume_message`, kill switch end to end (80% flag, 100% pause, manual reset SQL), span persistence via `waitUntil`, keepalive step in `pipeline.yml` | backend-engineer | P1a |
| P1b.4 ∥ ✅ | `explain_uncertainty` | tools-engineer | P1a |
| P1b.5 ✅ | Integration, the full suite, preview check, then merge `assistant` → `main` (**production release 1**). Update CLAUDE.md status. | orchestrator | P1b.1–4 |

**Owner, meanwhile:** review the preview before release 1 (about 10 min). Optionally H5 (GitHub Actions secrets).

### P2: Decisions and quality

| ID | Task | Agent | Needs |
|----|------|-------|-------|
| P2.1 ✅ | Gate contracts finalized, eval scenario schema (`evals/schema.ts`), replay recording format | orchestrator | P1b |
| P2.2 ∥ ✅ | The 5 gates on rules + Flash-Lite JSON classifier (`fallbacks.ts`, `router_gate.ts`, `guard_in.ts`, `ask_or_act.ts`, `risk_mode.ts`, `guard_out.ts`), `turn.ts` stages 4/5/7, gate spans in the drawer | harness-engineer | P2.1 |
| P2.3 ∥ ✅ | Insight tools: `get_leaderboard`, `get_backtest`, `compare_models` (always with `n_scored` and the seasonal-naive row) | tools-engineer | P2.1 |
| P2.4 ∥ ✅ | Eval runner (replay + live), assertions, ~50 scenarios, `agent-evals.yml` (replay on PRs; live on dispatch/nightly) | eval-engineer | P2.1 |
| P2.5 ✅ | *If S1 passes and you approve the spend:* `gates/jev.ts` adapter, plus a Jev-vs-fallback comparison in the live evals (a good showcase result) | harness-engineer | S1, **H12** |
| P2.6 ✅ | Integration, record replay fixtures from a live run, make replay evals a required check, release 2 | orchestrator | P2.2–2.4, **H5** |

**Owner, meanwhile:** H5 (GitHub secrets for live evals), H6 (Google OAuth client), H7 (Supabase Auth settings), H8
(Turnstile), and decide H12 (Jev) after S1.

### P3: Users and memory

| ID | Task | Agent | Needs |
|----|------|-------|-------|
| P3.1 | Migration 0002 (profiles, devices, conversations, messages, summaries, impact_ledger, feedback, admins) + RLS | orchestrator | P2 |
| P3.2 ∥ | JWT verification (S5), `/api/session` + Turnstile, `consume_message` anonymous cap and daily cap, `/api/feedback`, `/api/profile`, `/api/me/delete`, cron `retention` + `ledger` via pg_cron/pg_net, pgTAP tests | backend-engineer | P3.1, **H6, H7, H8** |
| P3.3 ∥ | `get_profile`/`update_profile` (confirm flag), `get_impact`, memory store | tools-engineer | P3.1 |
| P3.4 ∥ | Supabase auth UI (anonymous → `linkIdentity` Google), `LimitNotice`, Settings, Privacy page, thumbs up/down | frontend-engineer | P3.1, **H6, H7** |
| P3.5 | Context builder with profile + rolling summary (FR-2.7) | harness-engineer | P3.3 |
| P3.6 | P3 eval scenarios, Playwright e2e for J2/J3/J7 | eval-engineer | P3.2–3.5 |
| P3.7 | Integration, release 3 | orchestrator | P3.2–3.6 |

**Owner, meanwhile:** H9 (VAPID keys), H10 (Langfuse). Sign in once on production so we can do H11.

### P4: Follow-through and ops

| ID | Task | Agent | Needs |
|----|------|-------|-------|
| P4.1 | Migration 0003 (plans, push_subscriptions, reminders, eval_runs) + cron SQL | orchestrator | P3 |
| P4.2 ∥ | `plan_batch`, recurring plans, `make_calendar_event` (S7), `schedule_reminder` | tools-engineer | P4.1 |
| P4.3 ∥ | Cron reminders/recurring (S8), push subscribe, admin APIs | backend-engineer | P4.1, **H9, H11** |
| P4.4 ∥ | Ops page, push opt-in + `sw.js`, calendar download | frontend-engineer | P4.1 |
| P4.5 ∥ | Langfuse OTel exporter + sampling | harness-engineer | **H10** |
| P4.6 | P4 eval scenarios, eval trend rows | eval-engineer | P4.2–4.4 |
| P4.7 | Integration, release 4, README showcase (architecture diagram, Ops screenshots, harness and eval write-up) | orchestrator | all |

P5 (MCP server, extension) needs its own addendum before it starts.

## 5. Owner setup checklist (your dependencies)

**Secret handling, every time:** never paste a key into the chat. You put it in two places: the Vercel dashboard
(Project `greenwindow` → Settings → Environment Variables, with *Preview* and *Production* ticked) and, for local runs,
`web/.env.local` (gitignored; Claude is denied read access to it). I only ever check that a variable *name* exists. I
never print or decrypt values.

| ID | What | When needed (blocks) | Steps | Gives us (env var names) | Your time |
|----|------|----------------------|-------|--------------------------|-----------|
| **H1** ✅ | Supabase project (free): `Greenwindow`, ref `sndukjnxdvhrnbtazrlu`, eu-west-1 (Ireland; London not chosen, no impact). CLI logged in 2026-10-08. Still needed: API keys into Vercel/`.env.local` (H4) and the DB password for `supabase link`. | **Now** (P0.9, P1a.4) | supabase.com → New project → name `greenwindow`, region **London (eu-west-2)**, free plan, save the DB password in your password manager. Then run `npx supabase login` in **your own terminal** (it needs a TTY; `!` in Claude Code has none). | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server; newer projects call it the *secret* key), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the *publishable* key; public by design) | 10 min |
| **H2** | Gemini API key | **Now** (P1a.5 fixtures, P1a.6) | aistudio.google.com → Get API key → create in a new project. **Do not enable billing** (we stay on the free tier). | `GEMINI_API_KEY` | 5 min |
| **H3** ✅ | Vercel AI Gateway key | P1b.1 (Haiku failover, S4) | Vercel dashboard → AI Gateway → enable → API keys → create. If it asks for a card or a paid plan, **stop and tell me** (rule 7). | `AI_GATEWAY_API_KEY` | 5 min |
| **H4** ✅ | Env vars in Vercel + `web/.env.local` | P1a.6 | Add H1–H3 values. I'll give you the exact list, including generated non-secret config such as `IP_SALT` (you generate it with `openssl rand -hex 32`). | — | 10 min |
| **O1** | CO2 wording decision | P1a.2 merge | Choose (a) or (b) in §1 | — | 1 min |
| **H5** ✅ | GitHub Actions secrets | P2.6 (live evals) | github.com/nivesh22/greenwindow → Settings → Secrets → Actions: `GEMINI_API_KEY`, `AI_GATEWAY_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | — | 5 min |
| **H4b** ✅ | Public Supabase values in Vercel + `.env.local` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` = publishable key, type Config) | P3.4 | — | — | 2 min |
| **H6** ✅ | Google OAuth client | P3.2, P3.4 | console.cloud.google.com → new project → OAuth consent screen (External, scopes `email` + `profile` only, privacy URL `https://greenwindow-one.vercel.app/privacy`) → Credentials → OAuth client (Web) with redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`. Paste the client ID/secret into Supabase (H7), not into Vercel. | (stored in Supabase) | 20 min |
| **H7** ✅ | Supabase Auth settings | P3.2, P3.4 | Authentication → Providers: enable **Anonymous**, enable **Google** (H6 values), enable **Manual linking**. URL config: site URL = production URL, add the preview URL pattern. | — | 5 min |
| **H8** ✅ | Cloudflare Turnstile (free) | P3.2 | dash.cloudflare.com → Turnstile → add site (production + `*.vercel.app` preview hostnames) | `VITE_TURNSTILE_SITEKEY`, `TURNSTILE_SECRET` | 5 min |
| **H9** 🟡 | VAPID key pair (in Vercel 2026-10-09; `VITE_VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` still need the Preview target) | P4.3 | `npx web-push generate-vapid-keys` locally. Put the private key straight into Vercel. | `VITE_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` your address) | 5 min |
| **H10** ✅ | Langfuse Cloud Hobby (keys in Vercel, Preview + Production, 2026-10-09) | P4.5 | cloud.langfuse.com (EU region) → project → API keys | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | 5 min |
| **H11** | Make yourself admin | P4.3 | Sign in on production once. I insert your user ID into `admins` with a migration seed you approve. | — | 2 min |
| **H12** ✅ | Jev decision | P2.5 | After S1: approve (or not) Jev via the gateway, with its cost counted toward the $5 | — | 2 min |
| **H14** | Make `agent-evals` a required check on `main` | P2.6 | GitHub → Settings → Branches → rule for `main` → Require status checks → add `agent-evals (replay)` after its first run. | — | 2 min |
| H13 | (Optional) Mac git identity | any | On the Mac: `git config --global user.name nivesh22` and `git config --global user.email nivesh@g.ucla.edu` | — | 1 min |

Also generated by the owner, server-only: `CRON_SECRET` (P3, also stored in Supabase Vault), `IP_SALT` (P1a).

**P4 additions (2026-10-09):**
- **H15 `CRON_SECRET`:** generate (`openssl rand -hex 32`), add to Vercel (Preview + Production, sensitive), and in the Supabase SQL editor run `select vault.create_secret('<value>', 'greenwindow_cron_secret');` and `select vault.create_secret('https://greenwindow-one.vercel.app', 'greenwindow_app_url');`. Until then the cron jobs do nothing.
- **H16 calendar link check (S7):** open one generated Google Calendar link and confirm the time.

## 6. Spikes

| ID | Question | Who | When | Blocks |
|----|----------|-----|------|--------|
| S1 | Jev: real API access, request shape, model ID, price, latency from **primary** sources (vendor docs, gateway model list) | docs-researcher → orchestrator for a live call | P0.7 → P2 | P2.5 only |
| S2 | Vercel Hobby `maxDuration` and SSE streaming for `/api` in a Vite project | backend-engineer (preview deploy) | P1a.4 | P1a.6 |
| S3 | Gemini OpenAI-compat streaming tool calls, `include_usage`, model IDs, our project's free-tier RPM/RPD | docs-researcher + orchestrator (live, H2) | P0.7, P1a.5 | P1a.6 |
| S4 | Haiku 5.5 on AI Gateway: model ID, usage reporting, price | docs-researcher + orchestrator (live, H3) | P0.7, P1b.1 | P1b.1 |
| S5 | Supabase JWT verification (JWKS vs legacy secret) | docs-researcher | P0.7 | P3.2 |
| S6 | `linkIdentity` when the Google account already exists | backend-engineer | P3.2 | P3.2 |
| S7 | Google Calendar template URL parameters | tools-engineer | P4.2 | P4.2 |
| S8 | `pg_net` → Vercel at a 1-minute cadence (24 h test) | backend-engineer | P4.3 | P4.3 |

## 7. Guardrails during the build

- Spend: until the kill switch is live (P1b), live LLM calls are only made by the orchestrator, by hand. Agents use
  `ScriptedProvider` and recorded fixtures. `npm test` stays network-free.
- Any new dependency gets a `docs/decisions.md` entry in the same commit (rule 10).
- Rules still binding: UTC everywhere, the JSON contract unchanged, data-branch rules, TypeScript strict with no `any`,
  zod on every boundary, NESO/Open-Meteo attribution.
- If Supabase pauses (7 days idle) before the keepalive ships, the assistant shows "unavailable" and the rest of the
  site is unaffected (NFR-2).

## 8. Status

Last updated 2026-10-08 (late evening). Integration branch `assistant`; preview: https://greenwindow-git-assistant-niveshs-projects-b8d725ac.vercel.app/scheduler (Vercel login required).

| Phase | State | Notes |
|-------|-------|-------|
| P0 | ✅ done | Rules/docs v0.2, subagents, contracts, Supabase project, migration 0001 applied. |
| P1a | ✅ done 2026-10-08 | Harness core, core tools, chat UI, API + Supabase store, `turn.ts` + system prompt. Owner verified J1 on the preview. |
| P1b | 🟡 in progress | ✅ P1b.2 plan panel two-way sync, two-column layout, "How I got this" drawer. ✅ P1b.3 migration 0002 (80% alert, `reset_budget`, `budget_status`) **applied and checked live**; limit tests; health keepalive in `pipeline.yml`; `sse-test` removed. ✅ P1b.4 `explain_uncertainty`. ✅ Functions in `dub1`. 🟡 P1b.1 grounding check + circuit breaker (harness agent running). Then P1b.5: integration (`messages_left` in `turn_start`), live check, owner review, **release 1** (`assistant` → `main`). 206 tests green. |
| P2 | 🟡 in progress (agents started 2026-10-08) | Gates on rules + Gemini classifier first, then Jev adapter (approved, H12). Live evals can use the GitHub secrets (H5). |
| P3 | 🟡 code complete on `assistant` (2026-10-09), live testing | Migrations 0003 (users, memory, RLS) and 0004 (merge/session/anon-count functions, retention) applied. Auth via `/auth/v1/user`; Turnstile → anonymous session → 3 free messages → Google `linkIdentity` (merge fallback); server history, profile in context, rolling summary, impact ledger (lazy realization); Settings, Privacy, feedback. 543 tests. |
| P4 | 🟡 code complete on `assistant` (2026-10-09), live testing | P4.1 migration 0005 applied; P4.2 tools (`plan_batch`, recurring plans, `make_calendar_event`, `schedule_reminder`), P4.3 APIs + cron + admin ops/trace, P4.4 chat actions, plan-panel calendar/reminder, push opt-in + `sw.js`, Settings plans, Ops pages; P4.5 Langfuse export; P4.6 13 new scenarios (J3-J7) + `eval_runs` trend rows. Live recording found 6 real issues (plan management asked first; router misrouted 'make X my default' and 'my plans'; saved devices ignored by lookup_device; guests not told saving needs sign-in; failed gate calls not replayable), all fixed: **replay 63/63**, ~$0.24 of live eval spend. Next: owner items (H9 Preview, H11, H15), live checks of push/cron/Langfuse on the preview, P4.7 README, release 4. |

**Owner items closed:** H1, H2, H3 (+ paid gateway top-up, auto-reload off), H4 (env vars on Preview), H5 (GitHub Actions secrets), O1 (wording: "estimated emissions difference" with range + caveat; rule 9 rewritten), H12 (Jev approved for P2.5), H6 + H7 (Google OAuth client in Supabase only; anonymous sign-ins + manual linking on; verified live 2026-10-08: anonymous signup 200, Google authorize 302 to accounts.google.com; manual linking to be tested in P3). H8 (Turnstile widget for both hostnames; secret verified live against siteverify 2026-10-08). **Next owner items:** H14 (make `agent-evals (replay)` a required check on `main` — ready now), then H9 (VAPID) and H10 (Langfuse) for P4.

**Live facts (details in `docs/spikes.md`):** model route `gemini-3.5-flash` → `gemini-3.5-flash-lite` → `gemini-3.8-flash` → `anthropic/claude-haiku-5.5` (paid, $0.10/$0.50 per 1M). Jev via gateway: 5/5 router intents, ~300 ms, ~$0.000017/decision. Turn: 4 model steps, ~5–6 s, $0 on Gemini.

**Known issues / fixes (2026-10-08):**
- Fixed: Vercel 500 (Node ESM needs `.js` extensions on relative imports; guard test `agent/imports.test.ts`).
- Fixed: answers cut off mid-sentence (Gemini reasoning tokens count against `max_tokens`). Cap 2048, `reasoning_effort: low`, reasoning tokens billed as output, `finish_reason: length` → `token_budget` stop; finish reason recorded on every LLM span.
- Fixed: `estimate_co2` (and `explain_uncertainty`) take no arguments; one step fewer per turn.
- Open: free-tier rate limits (`gemini-3.5-flash` per-minute 429s, `gemini-3.8-flash` tiny daily quota). Haiku is the paid backstop. Watch the failover rate once Ops exists (P4).
