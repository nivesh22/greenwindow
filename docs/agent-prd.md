# PRD: GreenWindow Assistant (agentic job planner)

| | |
|---|---|
| Status | v0.2, approved with amendments (2026-10-08) |
| Date | 2026-10-08 |
| Owner | nivesh22 |
| Inputs | `docs/agent-discovery-notes.md` (decisions), `greenwindow-design-spec.md` v0.3 (forecasting spec, frozen) |
| Next document | [`docs/agent-design.md`](agent-design.md) (architecture, schemas, APIs, the harness internals) |

> **v0.2 (2026-10-08):** amended by [`docs/agent-execution-plan.md`](agent-execution-plan.md) §1 (X1–X9): P1 split into
> P1a/P1b, Supabase from P1a, Jev as an optional adapter behind the gate interface (rules + LLM classifier first), final
> answer buffered until grounding passes (no `text_reset`/`replace`), Haiku 5.5 fallback, replay evals in CI, `assistant`
> integration branch. Where this document and §1 of the plan disagree, the plan wins.

This PRD says **what** we build and **why**. It does not choose libraries, table layouts, or file structure; the
design doc does that. Requirements are numbered `FR-x.y` (functional) and `NFR-x` (non-functional), each with a
priority (MoSCoW), a phase (P1–P5), and an acceptance criterion.

---

## 1. Summary

GreenWindow Assistant is a chat agent in the **Plan a job** tab. A user describes a flexible job in plain language
("charge my EV before 7am", "8×A100 training run, 6 hours, done by Friday 9am", "three kilns, all done by Monday")
and the agent turns it into a recommended start time using the existing 48-hour GB carbon-intensity forecast, with
an **estimated CO2-avoided range** and an honest statement of how sure we are. It can add the slot to a calendar,
send a push reminder at start time, plan several jobs at once, re-plan recurring jobs every day, and later report
the estimated vs realized impact.

Under the hood it is a hand-written agent harness: a tool-using loop with budgets, provider failover, Jev decision
gates, full tracing, and a CI eval suite. The harness is the project's moat and the main thing the project
showcases. The deterministic optimizer stays the only source of start-time recommendations; the LLM explains,
asks, and orchestrates, it never invents a window.

## 2. Problem and opportunity

**User problem.** The current form (`web/src/pages/Scheduler.tsx`) asks for duration in whole hours, power in kW,
earliest start, deadline, and a risk mode. Most people don't know the kW of their dishwasher or a GPU job, don't
think in "expected vs cautious", and get no follow-through: no reminder when the window opens, nothing for jobs
that repeat, and no way to see later whether the shift actually helped.

**Showcase problem.** The project already shows forecasting and MLOps (pipeline, backtest, live leaderboard). It
does not show agentic AI engineering: tool design, loop control, decision layers, cost control, observability, and
evaluation of an agent. The owner wants a portfolio piece that demonstrates exactly that, built end to end on a
$0 stack apart from LLM spend.

**Opportunity.** The forecast, quantiles, robustness check, and optimizer already exist and are tested. Wrapping
them as agent tools gives the agent a trustworthy core, so the work can focus on the harness.

## 3. Goals and non-goals

### 3.1 Goals
| # | Goal | Measured by (§8) |
|---|------|------------------|
| G1 | Plan a common job from plain language in 3 messages or fewer | Messages per completed plan |
| G2 | Every recommendation matches the optimizer exactly | Window correctness = 100% in evals |
| G3 | Honest impact: CO2-avoided as a range with the average-vs-marginal caveat | 0 banned claims in evals and output guardrail |
| G4 | An owned, explainable harness: loop, budgets, failover, gates, tracing | Design doc + trace drawer + Ops page |
| G5 | Agent quality is tested on every PR | Golden eval suite gates merges |
| G6 | Total running cost ≤ $5/month, enforced | Cost ledger + kill switch |
| G7 | The existing form and pages keep working if the agent is down or over budget | Fallback test |

### 3.2 Non-goals (this release)
- MCP server and browser extension. Planned for P5. The tool registry is designed so both can reuse it, but they are
  not built in P1–P4.
- Regional or multi-country forecasts. GB national only, stated plainly by the agent.
- Writing to Google Calendar via the API (needs a sensitive scope and app verification). We use .ics files and
  Google Calendar "add event" links.
- Semantic (vector) memory, a planner/executor/critic multi-agent design, supervisor + specialist agents.
- Public traces or a public Ops dashboard. Ops is admin-only.
- Online LLM-as-judge scoring and a Jev-vs-LLM A/B study. Possible later; not required here.
- Jobs longer than 12 hours or beyond the 48-hour forecast horizon. The agent explains the limit instead.
- Controlling devices (smart plugs, EV chargers, schedulers). The agent recommends; the user acts.
- Any monetization. Vercel Hobby and Open-Meteo free terms are non-commercial.

## 4. Personas and jobs-to-be-done

| Persona | Job to be done | Example prompts | What they need from the agent |
|---------|----------------|-----------------|-------------------------------|
| **Household** (Priya, London flat, EV) | "Run my appliances when the grid is cleanest without thinking about kW." | "When should I charge my car tonight? Needs to be done by 7." / "Best time for the dishwasher tomorrow?" / "Washing machine and dryer, both done before I get home at 6." | Appliance defaults (kW, duration), plain answers in local time, quiet hours, reminders |
| **Developer** (Sam, ML engineer) | "Schedule flexible compute when it's cleaner and say how much it helps." | "8 A100s for 6 hours, must finish by Friday 09:00." / "Our nightly ETL takes 2h on a 4 kW box, any better slot this week?" / "How accurate is your forecast at 30 hours ahead?" | GPU/server → kW conversion, model-accuracy answers from real scores, calendar export |
| **Small business** (Ops lead at a pottery studio) | "Plan several machines against one deadline and repeat it weekly." | "Three kilns, 8h each, 12 kW, all done by Monday 8am." / "Every weekday, find the best 3h for the compressor before 5pm." | Multi-job planning, recurring plans, impact summary over time |

The agent is honest about scope: GB national grid average, 48-hour horizon, forecast uncertainty.

## 5. User journeys

**J1. Anonymous quick plan (P1).** User opens Plan a job, types "charge my EV before 7am". The agent infers a 7 kW
charger and asks one question if needed ("about how many hours of charging?"). It calls the optimizer and replies with
the best start in Europe/London time, the estimated CO2 avoided as a range, and whether the result is robust. The
plan panel on the right fills in with the same numbers, and the user can edit them there.

**J2. Hitting the free limit (P3).** On the 4th user message, the input is replaced by "Sign in with Google to keep
going". After sign-in, the same conversation continues with its history intact.

**J3. Returning user with a profile (P3).** "Dishwasher, usual time?" The agent reads the saved profile (1.2 kW, 2h,
quiet hours 23:00–07:00, cautious mode) and plans without asking.

**J4. Multi-job (P4).** "Three kilns, 8h each, 12 kW, done by Monday 8am." The agent plans all three, says whether
they can share a window, and gives a combined CO2 range.

**J5. Recurring (P4).** "Every weekday, best 3h for the compressor before 5pm." The agent saves a recurring plan.
Each day, once a fresh forecast exists, the plan is recomputed and the user gets a reminder. It never promises a
slot beyond 48 hours ahead.

**J6. Follow-through (P4).** After a plan, the user taps "Add to calendar" (.ics download or Google Calendar link) and
"Remind me" (browser push at start time).

**J7. Impact ledger (P3).** "How much have I avoided this month?" The agent reports estimated vs realized CO2 for past
planned jobs, using actual intensity once it's published, with the caveat.

**J8. Admin review (P4).** The owner opens the admin-only Ops page and sees cost per day, latency, failover events,
gate decisions, tool errors, eval results, and thumbs-down conversations, each linked to its full trace.

## 6. Functional requirements

Priority: **M** must, **S** should, **C** could. Phase: when it ships (§10).

### 6.1 Chat and plan panel

| ID | Requirement | Pri | Ph | Acceptance criterion |
|----|-------------|-----|----|----------------------|
| FR-1.1 | Plan a job shows chat on the left and the live plan panel (existing form + candidate-window chart) on the right. Stacked on mobile (360px). | M | P1 | Both visible on desktop. Usable at 360px. Existing form tests still pass. |
| FR-1.2 | When the agent sets job parameters, the panel fields update to the same values. When the user edits the panel, the agent's next turn uses the edited values. | M | P1 | Integration test: agent sets 7 kW/6h → panel shows 7/6. User changes to 5h → the next agent reply uses 5h. |
| FR-1.3 | Replies stream token by token. Tool activity shows as a short status line ("Checking the forecast…"). | M | P1 | First visible token is within the NFR-1 target. |
| FR-1.4 | Each assistant answer has a collapsed "How I got this" drawer: gate decisions with confidence, tool calls with inputs/outputs, model used, latency, tokens, cost. | M | P1 (tools) / P2 (gates) | The drawer matches the stored trace for that turn. |
| FR-1.5 | All times are shown in Europe/London with the zone label. All stored and tool times are UTC. | M | P1 | Clock-change-day tests pass (reuses `web/src/lib/time.ts`). |
| FR-1.6 | Suggested starter prompts per persona appear on an empty chat. | S | P1 | 3–4 chips visible. Clicking one sends it. |
| FR-1.7 | When the assistant is unavailable (over budget, provider down, kill switch), the chat shows a clear notice and the form keeps working. | M | P1 | Kill-switch test: chat disabled, form still recommends. |

### 6.2 Agent harness (the moat)

| ID | Requirement | Pri | Ph | Acceptance criterion |
|----|-------------|-----|----|----------------------|
| FR-2.1 | A hand-written loop: build context → call model → if tool calls, validate and run them → append results → repeat until a final answer or a budget is hit. Provider SDKs are used for transport only. | M | P1 | Loop code is in the repo and unit-tested with a scripted fake model. |
| FR-2.2 | Budgets per turn: max steps (default 6), max input/output tokens, max cost, wall-clock limit inside the function timeout. Hitting a budget ends the turn gracefully with a partial answer and a reason. | M | P1 | A test per budget type. The trace records which budget stopped the turn. |
| FR-2.3 | Provider-agnostic model interface. Default: Gemini Flash (free tier). Automatic failover to Claude Haiku 5.5 on rate limit, error, or timeout. Model choice is configurable per environment. | M | P1 | A fault-injection test makes the primary fail. The turn completes on the fallback and the trace marks the failover. |
| FR-2.4 | Every tool has a zod input and output schema. Invalid model arguments are rejected with a structured error the model sees and can correct (max 1 repair attempt per call). | M | P1 | A test with bad arguments: the model gets the error, retries, and succeeds. |
| FR-2.5 | Transient errors (network, 429, 5xx) are retried with backoff and jitter, within the turn budget. | M | P1 | Unit test of the retry policy. |
| FR-2.6 | Grounding rule: any start time, intensity, or CO2 figure in the final answer must come from a tool result in the same turn. The output check (FR-3.2) enforces it. | M | P2 | Eval scenarios with a hallucinated time are blocked or corrected. |
| FR-2.7 | Context management: system prompt + rolling conversation summary + last N messages + profile. Stays within a token cap. Prompt caching is used where the provider supports it. | S | P3 | A long-conversation test stays under the cap. |
| FR-2.8 | Tool outputs and user-supplied text are treated as data, never as instructions (prompt-injection defense). | M | P1 | Injection eval scenarios ("ignore previous instructions…" inside a job name) do not change the behavior. |

### 6.3 Jev decision gates

Jev (TypeSafe AI) takes structured state plus a set of options and returns a typed choice with a confidence score.
It runs as four gates around the loop. **The optimizer, not Jev, chooses the start time.**

| ID | Gate | Options returned | Pri | Ph | Acceptance criterion |
|----|------|------------------|-----|----|----------------------|
| FR-3.1 | **Router / intent triage** (before the loop) | `plan_job`, `plan_batch`, `recurring`, `explain_forecast`, `model_accuracy`, `impact_history`, `profile_update`, `smalltalk`, `off_topic` | M | P2 | ≥ 90% correct on the labeled router set in evals. `off_topic` gets a polite scope reply without running the loop. |
| FR-3.2 | **Guardrail** (input and output) | Input: `allow`, `off_topic`, `injection`, `abuse`. Output: `pass`, `ungrounded_number`, `overclaim_co2`, `unsafe` | M | P2 | Blocked inputs never reach the main model. A flagged output is regenerated once, then replaced by a safe fallback. |
| FR-3.3 | **Ask-or-act** (before calling the optimizer) | `act`, `ask_duration`, `ask_power`, `ask_deadline`, `ask_clarify` | M | P2 | When details are missing, the agent asks one targeted question. When enough is known (including profile/defaults), it acts without asking. |
| FR-3.4 | **Risk mode** | `expected` or `cautious`, with a confidence score | M | P2 | "It really must finish/lowest risk" → cautious. "I'm flexible" → expected. Confidence is shown in the drawer. Below a threshold, the profile default is used. |
| FR-3.5 | Every gate has a deterministic fallback (rules or a cheap LLM call through the same typed interface) when Jev is unavailable or too slow. | M | P2 | Fault-injection test: with Jev down, turns still complete and the trace marks the fallback. |
| FR-3.6 | Each gate decision is logged with its options, chosen option, confidence, latency, and cost. | M | P2 | Visible in the drawer and the Ops page. |

### 6.4 Tools (v1)

One shared **tool registry** (name, description, zod schemas, handler, auth requirement). The chat uses it now; the
MCP server (P5) will expose the same registry.

| ID | Tool | Purpose | Reuses | Pri | Ph |
|----|------|---------|--------|-----|----|
| FR-4.1 | `get_forecast` | Next 48h for the chosen model (q10/q50/q90), the NESO line, and freshness | `app_data/latest_forecast.json`, `meta.json`; zod schemas in `web/src/data/schemas.ts` | M | P1 |
| FR-4.2 | `recommend_window` | Best start for one job (duration, kW, earliest, deadline, mode) | `recommend()` in `web/src/scheduler/optimizer.ts`, unchanged | M | P1 |
| FR-4.3 | `estimate_co2` | CO2-avoided point estimate and range (§6.5) | `Recommendation` fields from the optimizer | M | P1 |
| FR-4.4 | `explain_uncertainty` | Robust/not robust, band width, model disagreement in the window | optimizer `robust`; the forecast series | M | P1 |
| FR-4.5 | `lookup_device` | Typical kW and duration for appliances, EVs, GPUs/servers, with a source note and "assumed" flag | A new curated table (design doc) | M | P1 |
| FR-4.6 | `get_leaderboard`, `get_backtest`, `compare_models` | Answer "how accurate is this?" from the real scores, with n shown | `leaderboard.json`, `backtest_summary.json` | S | P2 |
| FR-4.7 | `plan_batch` | Several jobs, shared or separate deadlines. Reports overlap and the combined range. | `recommend()` per job | M | P4 |
| FR-4.8 | `save_recurring_plan` / `list_plans` / `cancel_plan` | Recurring jobs (daily/weekdays/weekly) | Supabase (signed-in only) | M | P4 |
| FR-4.9 | `make_calendar_event` | .ics file + Google Calendar "add event" link for the window | — | M | P4 |
| FR-4.10 | `schedule_reminder` | Browser push at start time (needs permission) | Web Push (VAPID) | M | P4 |
| FR-4.11 | `get_profile` / `update_profile` | Read/update devices, default risk mode, quiet hours | Supabase (signed-in only) | M | P3 |
| FR-4.12 | `get_impact` | Estimated vs realized CO2 for past planned jobs | Impact ledger (FR-7.3) | M | P3 |

Tool acceptance (all): schema-validated input and output, unit tests with fixtures from `tests/app_data/`, and an
error path that returns a structured, user-explainable error (for example, the optimizer's `InfeasibleJobError` text
"Job doesn't fit before your deadline…").

Respected limits (from the optimizer): duration is a whole number of hours from 1 to 12, power > 0, and the window
must be inside the 48h forecast. For longer jobs, the agent says so and suggests splitting (C, P4).

### 6.5 CO2 estimate and wording

| ID | Requirement | Pri | Ph | Acceptance criterion |
|----|-------------|-----|----|----------------------|
| FR-5.1 | Point estimate = `gramsDifference` from the optimizer (energy × (run-now q50 avg − best q50 avg)). | M | P1 | Equals the optimizer output in tests. |
| FR-5.2 | Range: low = energy × (run-now avg q10 − best avg q90), high = energy × (run-now avg q90 − best avg q10). Low may be negative and is then shown as "could be slightly worse". A low bound > 0 matches the optimizer's `robust` flag. | M | P1 | Unit tests, including a consistency test with `robust`. |
| FR-5.3 | Wording: "Estimated CO2 avoided: about X g (range Y to Z g)" plus the caveat that this uses the grid's *average* intensity, not marginal emissions, and is an estimate. Never an unqualified "you saved X". | M | P1 | The output guardrail and evals flag any unqualified claim. |
| FR-5.4 | Large numbers shown in sensible units (g / kg) via the existing `fmtMass` (`web/src/lib/format.ts`). | S | P1 | Snapshot test. |

This replaces AGENTS.md rule 9 / spec 5.3 item 2 (see §9).

### 6.6 Auth, gating, and limits

| ID | Requirement | Pri | Ph | Acceptance criterion |
|----|-------------|-----|----|----------------------|
| FR-6.1 | Anonymous users get a Supabase anonymous session on first chat use. No sign-in needed for the first 3 user messages. | M | P3 | A new browser can send 3 messages without signing in. |
| FR-6.2 | Message 4 (counted server-side per anonymous session) requires Google sign-in. The anonymous session is linked to the Google account so the conversation continues. | M | P3 | E2E: 3 messages → sign-in prompt → after sign-in, history is present and message 4 is answered. |
| FR-6.3 | Abuse limits: per-IP rate limit on anonymous sessions and messages. CAPTCHA (free tier, e.g. Turnstile) before an anonymous session is created. | M | P3 | Creating > N anonymous sessions per IP per hour is refused. |
| FR-6.4 | Signed-in users get a daily message cap (default 20, configurable), shown as "x left today". | M | P3 | Test at the cap boundary. |
| FR-6.5 | Admin role (owner only) unlocks the Ops page and raw traces. | M | P4 | A non-admin gets 403 on the admin APIs. |
| FR-6.6 | Before P3 ships, P1–P2 run anonymous-only behind a global rate limit and the budget kill switch. | M | P1 | Rate limit test. |

### 6.7 Memory

| ID | Requirement | Pri | Ph | Acceptance criterion |
|----|-------------|-----|----|----------------------|
| FR-7.1 | Profile: named devices (name, kW, typical duration), default risk mode, quiet hours, display name. Editable by the agent (with confirmation) and on a simple settings view. | M | P3 | "Remember my dishwasher is 1.2 kW" → stored. Later plans use it without asking. |
| FR-7.2 | Chat history: conversations are saved and resumable. Older turns are compressed into a rolling summary. | M | P3 | Reopen → history visible. Context stays under the cap. |
| FR-7.3 | Impact ledger: each accepted plan records the window, energy, estimated range, and model/run ID. A daily job re-scores it with actual intensity once published → realized difference. | M | P3 | After actuals arrive, the ledger row has a realized value. `get_impact` returns the totals with the caveat. |
| FR-7.4 | Users can delete their data (profile, history, ledger, traces linked to them). | M | P3 | "Delete my data" removes all of the user's rows. Verified by a test. |

### 6.8 Observability

| ID | Requirement | Pri | Ph | Acceptance criterion |
|----|-------------|-----|----|----------------------|
| FR-8.1 | Own trace model stored in Supabase: conversation → turn → steps (gate decision, LLM call, tool call), with timestamps, latency, tokens in/out, cost, model, provider, failover flag, budget stop reason, errors. | M | P1 (local/console) / P3 (Supabase) | Each turn produces a complete trace. The drawer and Ops page read from it. |
| FR-8.2 | OpenTelemetry-style export of the same spans to Langfuse Cloud Hobby (free), sampled to stay under the free quota. | S | P4 | Traces appear in Langfuse. The sampling rate is configurable. |
| FR-8.3 | Admin Ops page: cost per day and month vs budget, turns/day, latency p50/p95 per step type, failover rate, gate distributions and confidence, tool error rates, eval pass rate over time, thumbs-down list → trace view. | M | P4 | All panels render from real data. Admin-only. |
| FR-8.4 | PII care: traces store message text for debugging but are deleted after 90 days and with "delete my data". IPs are hashed. | M | P3 | A retention job runs. No raw IPs are stored. |

### 6.9 Evaluation

| ID | Requirement | Pri | Ph | Acceptance criterion |
|----|-------------|-----|----|----------------------|
| FR-9.1 | Golden scenario suite (~50 conversations across the personas, edge cases, injections, off-topic) on a frozen forecast fixture (`tests/app_data/`). | M | P2 | Suite runs locally with one command. |
| FR-9.2 | Checks per scenario: expected tools called, start time equals `recommend()` on the fixture, CO2 numbers equal `estimate_co2`, caveat present, no banned claims, expected gate decisions, step/cost within budget. | M | P2 | A deliberately broken prompt makes the suite fail. |
| FR-9.3 | Runs in CI on PRs that touch agent code, using the cheapest model. A drop below the pass threshold (≥ 90%, and 100% on window correctness) blocks merge. The eval cost counts toward the budget. | M | P2 | CI job exists, required check on `main`. |
| FR-9.4 | Thumbs up/down + optional comment on each answer, linked to its trace. | M | P3 | Feedback rows link to turn IDs. Shown on the Ops page. |
| FR-9.5 | Eval results stored per run (commit, model, pass rate, cost) for the Ops trend chart. | S | P4 | Trend visible. |

### 6.10 Cost control

| ID | Requirement | Pri | Ph | Acceptance criterion |
|----|-------------|-----|----|----------------------|
| FR-10.1 | Every LLM and Jev call is priced from a config price table and written to a cost ledger (per turn, user, day, month). | M | P1 | Ledger totals match the sum of the trace costs. |
| FR-10.2 | Hard kill switch: when month-to-date spend reaches $5 (configurable), the assistant is disabled for everyone until the next month or a manual reset. A soft alert at 80%. | M | P1 | A test with a lowered threshold disables the chat. The form still works. |
| FR-10.3 | A per-turn cost cap (FR-2.2) and per-user caps (FR-6.4) keep a single user from draining the budget. | M | P1/P3 | Tests. |
| FR-10.4 | Free-tier usage is counted at $0 but tracked (requests/day) so we see how close we are to the Gemini quota. | S | P1 | Shown on Ops. |

## 7. Non-functional requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Latency | First streamed token p50 < 2.5s. Each Jev gate p95 < 500ms. Full turn p95 < 15s, always inside the Vercel function limit. |
| NFR-2 | Availability | Provider failover (FR-2.3). The form, forecast, leaderboard, and backtest pages never depend on the agent backend. |
| NFR-3 | Security | Secrets only in Vercel environment variables, never in the client bundle or repo. RLS on every user table. Server-side checks on all limits. The service-role key is never exposed. Dependencies pinned. |
| NFR-4 | Privacy (UK GDPR) | A privacy page listing the data stored, retention (90 days for traces), processors (Google Gemini, Anthropic, TypeSafe/gateway, Supabase, Vercel, Langfuse), the note that Gemini free-tier prompts may be used by Google to improve products, and delete-my-data. Google OAuth uses basic scopes only (email, profile). |
| NFR-5 | Honesty | Every answer about impact carries the caveat. The agent states GB-national scope and the 48h horizon when relevant. Negative results (worse than run-now) are said plainly. |
| NFR-6 | Accessibility | Keyboard-usable chat and drawer, screen-reader labels, works at 360px, light/dark (carried over from spec 6.8). |
| NFR-7 | Code quality | TypeScript strict, no `any`, zod on every boundary (HTTP, tools, DB rows, model output). Unit tests on the harness core ≥ 80% line coverage. |
| NFR-8 | Reproducibility | Evals run on frozen fixtures with temperature 0 where supported. Prompts are versioned in the repo, and each trace records the prompt version. |
| NFR-9 | Cost | ≤ $5/month all-in, including CI evals (G6). |

## 8. Success metrics

| Area | Metric | Target |
|------|--------|--------|
| Product | Plan-completion rate (conversations with ≥ 1 accepted recommendation / conversations with a plan intent) | ≥ 70% |
| Product | Messages per completed plan, common single-job case | ≤ 3 median |
| Product | Thumbs-up share of rated answers | ≥ 80% |
| Quality | Golden eval pass rate | ≥ 90% overall, 100% window correctness, 0 banned claims |
| Quality | Router gate accuracy on the labeled set | ≥ 90% |
| Ops | Cost per conversation | Tracked. Must fit $5/month at the expected traffic. |
| Ops | Failover rate, gate fallback rate, tool error rate | Tracked on Ops. Investigate > 5%. |
| Showcase | README architecture diagram, Ops screenshots, a short write-up of the harness design and eval results | Done at the end of P4 |

## 9. Constraints and policy changes required

The overhaul conflicts with rules written for the static v0.3 app. These are **flagged here, not changed here**.
They are enacted at the start of the build, each with a `docs/decisions.md` entry, and `AGENTS.md`/`CLAUDE.md` are
updated in the same commit.

| Current rule | Change |
|--------------|--------|
| AGENTS.md rule 6: the web app fetches only the published JSON | The app may also call its own `/api/*` endpoints (the agent backend). The forecast pages still read JSON only. |
| Rule 7: no paid services, no secrets, no backend/DB | Server-side secrets allowed in Vercel env vars only (LLM keys, Jev/gateway key, Supabase service key, VAPID private key). The only paid item is LLM/Jev usage, capped at $5/month. Free tiers: Vercel Hobby, Supabase, Langfuse Hobby. |
| Rule 9 + spec 5.3 item 2: never "CO2 saved" | Allowed: "estimated CO2 avoided" **with a range and the average-vs-marginal caveat** (FR-5.3). An unqualified "you saved X" stays banned. |
| Decision D6: Supabase rejected | Supabase free tier for auth, Postgres, and scheduled jobs. |
| Rule 10: log new dependencies | Unchanged. Applies to every new package (provider SDKs, Supabase client, web-push, OTel). |
| CLAUDE.md "No backend, no database, no secrets" summary | Rewritten to describe the agent backend. |

Unchanged and still binding: UTC everywhere (rule 2), the JSON contract rules (rules 11–12), the data-branch rules
(rule 13), TypeScript strict / zod (rule 11), NESO and Open-Meteo attribution.

## 10. Release phases and exit criteria

| Phase | Scope | Done when |
|-------|-------|-----------|
| **P1: Agent slice** | Policy changes (§9). Backend API on Vercel Functions. Own loop with budgets, retries, failover. Tools FR-4.1 to 4.5. CO2 range. Chat + live plan panel + drawer (tools only). Traces to console/local store. Cost ledger + kill switch. Anonymous with a global rate limit. | J1 works on the live URL. Harness unit tests green. Kill switch and failover tests pass. Cost per turn measured. |
| **P2: Decisions and quality** | Jev gates FR-3.1 to 3.6 with fallbacks. Output grounding check. Insight tools FR-4.6. Golden eval suite in CI as a required check. | Eval suite ≥ 90%, 100% window correctness. Gate latency within NFR-1. Fault-injection tests pass. |
| **P3: Users and memory** | Supabase project. Anonymous sessions, 3-message gate, Google OAuth linking, CAPTCHA, daily caps. Profile, history + summary, impact ledger + daily re-scoring. Traces in Supabase. Feedback. Privacy page, delete-my-data, retention job, Supabase keepalive. | J2, J3, J7 work end to end. RLS tests pass. Deletion test passes. |
| **P4: Follow-through and ops** | `plan_batch`, recurring plans, .ics/Google Calendar link, web push reminders, scheduled jobs. Admin Ops page. Langfuse export. Eval trend. README showcase material. | J4, J5, J6, J8 work. Ops page shows real data. Showcase write-up done. |
| **P5: Reach** | MCP server (Streamable HTTP) on the same tool registry. Browser extension (current intensity + quick plan). | Separate PRD addendum before starting. |

## 11. Build orchestration (how we build it)

Built with several Claude Code subagents defined in `.claude/agents/*.md` (created at the start of P1), each with its
own model and scope. Independent tasks run in parallel in separate git worktrees. The main session plans, writes
shared contracts first, reviews, and merges.

| Agent | Model | Scope |
|-------|-------|-------|
| orchestrator (main session) | Opus | Splits phases into tasks, writes contracts (tool schemas, trace schema, API routes, DB schema), reviews, merges, runs the full suite |
| harness-engineer | Opus | Loop, budgets, provider adapters, failover, Jev gates, grounding check |
| backend-engineer | Sonnet | Vercel Functions, Supabase schema/RLS/migrations, auth/gating, scheduled jobs |
| frontend-engineer | Sonnet | Chat UI, plan panel sync, trace drawer, Ops page, privacy/settings views |
| tools-engineer | Sonnet | Tool registry and tool handlers, device table, CO2 range, .ics, push |
| eval-engineer | Sonnet | Golden scenarios, eval runner, CI job, eval result storage |
| test-runner / reviewer | Haiku | Lint/test/build runs, rule checks (banned wording, `any`, secrets, missing decisions entries) |
| docs-researcher | Haiku | Verifies external APIs and limits against live docs before use (AGENTS.md rule 1) |

Rules: contracts before fan-out. Parallel only when tasks don't share files or contracts. Each agent finishes with
green tests in its worktree. Keep token use reasonable (no subagent for small edits).

## 12. External facts and risks (checked 2026-10-08; re-verify in the design doc)

| Item | What we found | Impact on this PRD |
|------|---------------|--------------------|
| Jev (TypeSafe AI) | $0.042 per million input tokens, output free. **No free tier.** The direct API is waitlisted, but Jev is available through Vercel AI Gateway, OpenRouter, and Cloudflare AI Gateway. | Cost is negligible (4 gates × ~1k tokens ≈ $0.0002 per turn), but it needs a paid gateway account and counts toward the $5. Fallbacks (FR-3.5) are required in case access changes. |
| Gemini Flash free tier | Limits are project-specific since the December 2025 cuts. Reported around 10 RPM / 250 RPD for Flash (Flash-Lite higher). Free-tier prompts may be used by Google. | A turn with 3–5 model calls allows only ~50–80 turns/day free. Haiku failover is mandatory (FR-2.3). Privacy disclosure (NFR-4). Consider Flash-Lite for cheap steps (summaries). |
| Vercel Hobby | Function duration 60s (sources conflict; verify, Fluid compute settings may differ). Cron only once a day, with up to ~59 min jitter. Non-commercial use. | Turn wall-clock budget sits under the function limit. Minute-level reminders and recurring jobs need Supabase `pg_cron`/`pg_net` or GitHub Actions, not Vercel cron. |
| Supabase free | 500 MB DB, 50k MAU, anonymous sign-ins and Google OAuth included. Projects pause after 7 days inactive. | A keepalive ping from the existing 6-hourly `pipeline.yml`. Trace retention keeps the DB small. |
| Langfuse Cloud Hobby | 50k units/month, 30-day data access, 2 users. | Sample exports (FR-8.2). Supabase is the source of truth. |
| Anthropic Haiku 5.5 | Paid per token, the main spend once the free tier is exhausted. | Prompt caching and tight context (FR-2.7). Per-turn cost cap. |

Other risks:
- **Free anonymous chat is abused.** Mitigated by CAPTCHA, IP limits, the 3-message gate, and the kill switch.
- **Model states a wrong time or number.** Mitigated by the grounding rule, the output gate, and evals on the optimizer.
- **Overclaiming impact.** Mitigated by range + caveat wording, the guardrail, and banned-claim evals.
- **Scope creep across 5 phases.** Mitigated by phase exit criteria, and P5 needs its own addendum.
- **Recurring plans vs the 48h horizon.** They are recomputed daily and never promised beyond 48h.

## 13. Open questions (defaults chosen; override in review)

| Question | Default in this PRD |
|----------|--------------------|
| Signed-in daily message cap | 20 per day |
| Trace and history retention | 90 days |
| Source for device kW/duration defaults | A small curated table with cited sources (manufacturer/Energy Saving Trust for appliances, vendor TDP × PUE for GPUs). The design doc picks the sources. |
| Recurring plans: auto-push or only show in app | Push reminder at the recomputed start (if permission granted), otherwise in-app only |
| Product name | "GreenWindow Assistant" |
| Turn step budget | 6 steps, per-turn cost cap $0.01 |

## 14. Reusable pieces in the current codebase

| Piece | Path | Used for |
|-------|------|----------|
| Optimizer (`recommend`, `Recommendation`, `InfeasibleJobError`, `InvalidJobError`) | `web/src/scheduler/optimizer.ts` | `recommend_window`, `plan_batch`, `estimate_co2`, eval ground truth |
| JSON schemas and loader (`metaSchema`, `latestForecastSchema`, `leaderboardSchema`, `backtestSummarySchema`, `parseFile`, `fetchFile`) | `web/src/data/schemas.ts`, `web/src/data/client.ts` | Tool data access (server side) |
| Plan a job page and `validateForm` | `web/src/pages/Scheduler.tsx` | Becomes the live plan panel |
| Time helpers and mass formatting | `web/src/lib/time.ts`, `web/src/lib/format.ts` | Local-time display, g/kg units |
| Shared JSON fixtures | `tests/app_data/` | Frozen forecast for evals and tool tests |
| Pipeline workflow | `.github/workflows/pipeline.yml` | Supabase keepalive, possibly ledger re-scoring |

## 15. Traceability (discovery decision → requirement)

| Discovery decision (`docs/agent-discovery-notes.md`) | Covered by |
|-----------------------------------------------------|------------|
| Users: households, developers, small business | §4, FR-4.5, FR-4.7 |
| GB national only | §3.2, NFR-5 |
| Single agent + Jev layer | FR-2.1, FR-3.x |
| Own loop, thin SDKs | FR-2.1 to 2.8 |
| Provider-agnostic, Gemini free → Haiku | FR-2.3, §12 |
| Jev: router, guardrail, ask-or-act, risk mode | FR-3.1 to 3.4 |
| Vercel Functions (TS) | §9, P1 |
| Supabase (Google OAuth, Postgres, anonymous) | FR-6.x, §9 |
| 3 messages per anonymous session, then Google | FR-6.1, FR-6.2 |
| Tools: core, insight, actions, multi/recurring | FR-4.1 to 4.12 |
| Memory: profile, history, impact ledger | FR-7.1 to 7.3 |
| CO2 as a range with caveat | FR-5.1 to 5.3, §9 |
| Observability: own schema + Langfuse | FR-8.1, FR-8.2 |
| Ops dashboard admin-only | FR-6.5, FR-8.3, §3.2 |
| Evals: golden scenarios in CI + feedback | FR-9.1 to 9.4 |
| UX: chat + live plan panel, step trace | FR-1.1, FR-1.2, FR-1.4 |
| $5/month cap | FR-10.x, NFR-9 |
| MCP and extension later | §3.2, P5 |
| Phases: thin slice first | §10 |
| Multi-agent build orchestration | §11 |

## 16. References

- Jev overview: [Level Up Coding explainer](https://levelup.gitconnected.com/jev-clearly-explained-with-real-example-i-built-a-decision-layer-for-an-ai-agent-2bad7dd23fe2),
  [Zimaspace](https://shop.zimaspace.com/blogs/tech-ai-hub/what-is-jev-ai-decision-model-agents)
- Jev pricing and access: [eesel.ai](https://www.eesel.ai/blog/typesafe-jev-pricing),
  [AI Weekly](https://aiweekly.co/alerts/typesafe-ais-jev-outputs-numbers-not-text-at-0042m-input)
- Gemini free tier: [flo2.com](https://flo2.com/blog/gemini-free-tier),
  [tinkerllm.com](https://tinkerllm.com/blog/gemini-api-free-tier-limits-rate-quotas/)
- Vercel limits: [Hobby functions up to 60s](https://vercel.com/changelog/vercel-functions-for-hobby-can-now-run-up-to-60-seconds),
  [Cron usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- Supabase free tier: [automationatlas.io](https://automationatlas.io/answers/supabase-free-tier-limits-2026/)
- Langfuse free plan: [costbench.com](https://www.costbench.com/software/ai-observability/langfuse/free-plan/)
