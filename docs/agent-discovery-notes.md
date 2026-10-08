# Agent overhaul: discovery notes (2026-10-08)

Input for the PRD ([`docs/agent-prd.md`](agent-prd.md), drafted 2026-10-08) and design doc (`docs/agent-design.md`). Not a spec.
`greenwindow-design-spec.md` v0.3 stays frozen as the forecasting spec.

## Goal
Show that I can build an agentic AI pipeline: a custom agent harness (the moat) with tools, a loop, a decision
layer, observability, and evals. The agent helps users pick a start time for flexible jobs and estimates the CO2
avoided. Zero cost apart from LLM usage (budget $5/month, enforced by a hard kill switch).

## Decisions
| Area | Decision |
|------|----------|
| Users | Households (appliances, EV), developers (compute/ML/CI jobs), small business (several machines) |
| Region | GB national only (existing forecasts). The agent says so plainly. |
| Architecture | Single tool-using agent with Jev decision gates around it |
| Harness | Hand-written loop in TypeScript (plan → tool → observe → repeat), budgets for steps/tokens/cost, retries, zod tool schemas, streaming. Provider SDKs used for transport only. |
| LLM | Provider-agnostic model interface. Default: Gemini Flash free tier, automatic failover to Claude Haiku 4.5. |
| Jev (TypeSafe AI) | Four gates: router/intent triage, input+output guardrail, ask-or-act, risk-mode choice (expected vs cautious + confidence). The optimizer stays the source of truth for the start time. |
| Backend | Vercel Functions (TS) in the existing Vercel project; reuses `optimizer.ts` directly |
| Auth + DB | Supabase free: Google OAuth, Postgres, RLS, anonymous sign-in. Reverses D6, so log it in decisions.md. |
| Gating | 3 user messages per anonymous session (anon auth + IP rate limit). On message 4: Google sign-in, conversation carries over. Signed-in users get a daily cap. |
| Tools v1 | Core: get_forecast, recommend_window, estimate_co2 (with range), explain_uncertainty. Insight: get_leaderboard, get_backtest, compare_models. Actions: .ics / Google Calendar link, web push reminder, save_job. Multi-job + recurring plans. |
| Memory | Profile/preferences (appliances/machines, default risk mode, quiet hours), chat history with a rolling summary, impact ledger (estimated vs realized CO2) |
| CO2 wording | "Estimated CO2 avoided: ~X g (range Y–Z g)" from q10/q90, with an average-vs-marginal caveat. Replaces rule 9 / spec 5.3, so log it in decisions.md. |
| Observability | Own trace schema in Supabase (runs, steps, Jev decisions, tool calls, tokens, cost, latency) plus an OTel export to Langfuse Cloud free |
| Ops dashboard | Admin only |
| Evals | Golden scenarios in CI (frozen forecast fixture; checks tool calls, window matches the optimizer, no banned claims), plus thumbs up/down feedback linked to traces |
| UX | Plan a job tab: chat on the left, live plan panel on the right (the existing form + chart, filled in by the agent and editable). A collapsible "How I got this" step trace on each answer. |
| MCP server, browser extension | Later. Design a shared tool registry now so both can reuse it. |
| Docs | New `docs/agent-prd.md` + `docs/agent-design.md`; update AGENTS.md/CLAUDE.md rules 6, 7, 9 and D6 with logged decisions |

## Phases
1. Backend + own loop + core tools + chat UI (anon, no login) + traces
2. Jev gates + guardrails + golden evals in CI
3. Supabase auth/gating + memory + impact ledger
4. Action tools, multi-job/recurring, Ops page, Langfuse
5. MCP server, extension

## Build orchestration (how we build it, not part of the product)
Build with several Claude Code subagents, each defined in `.claude/agents/*.md` with its own model, tools, and
scope, and run them in parallel where tasks don't depend on each other. Each parallel agent works in its own git
worktree (`isolation: worktree`) so edits don't collide. The main session plans, splits the work, reviews, and
merges.

Proposed roster (finalize in the design doc):
| Agent | Model | Scope |
|-------|-------|-------|
| orchestrator (main session) | Opus | Splits phases into tasks, writes interface contracts first, reviews and merges |
| harness-engineer | Opus | Agent loop, budgets, provider adapters, Jev gates: the core, hardest code |
| backend-engineer | Sonnet | Vercel Functions, Supabase schema/RLS/migrations, auth and gating, cron jobs |
| frontend-engineer | Sonnet | Chat UI, live plan panel, step-trace drawer, Ops page |
| tools-engineer | Sonnet | Tool registry and tools (forecast, optimizer wrapper, CO2 range, .ics, push) |
| eval-engineer | Sonnet | Golden scenarios, CI eval job, trace assertions |
| test-runner / reviewer | Haiku | Runs lint/tests/build, reports failures, checks rule violations (banned wording, `any`, secrets) |
| docs-researcher | Haiku | Verifies external APIs/limits (Jev, Gemini, Vercel, Supabase, Langfuse) against live docs |

Rules for parallel work:
- Shared contracts first (tool schema, trace schema, API routes, DB schema) by the orchestrator, then fan out.
- Only independent tasks run in parallel. Anything touching the same files or contracts runs one after another.
- Each agent finishes with tests passing in its worktree. The orchestrator merges and runs the full suite.
- Keep token use reasonable: no agent for small edits, and use Haiku for mechanical checks.

## Verify before designing (do not assume)
- Jev: API access, pricing/free tier, latency, rate limits, SDK. Four gates per message could cost more than the
  LLM. Fallback: the same typed gate interface backed by a cheap LLM call or rules.
- Gemini free tier: current rate limits; free-tier prompts may be used by Google for training (needs a privacy note).
- Vercel Hobby: function max duration, streaming support, non-commercial-use terms; cron is limited, so scheduled
  work (reminders, recurring plans, ledger scoring) may need Supabase pg_cron or GitHub Actions.
- Web push timing: GitHub Actions cron can run late; pg_cron + pg_net may be more precise.
- Supabase free: pauses after 7 days idle (add a keepalive), anonymous sign-in abuse (a free CAPTCHA such as Turnstile).
- Langfuse Cloud Hobby: current usage limits.
- Google OAuth consent screen: basic scopes only, privacy policy URL needed.
- Recurring plans vs the 48h forecast horizon: recompute each day; never promise beyond 48h.
