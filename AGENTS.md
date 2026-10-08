# AGENTS.md — GreenWindow

## Mission
Build exactly what greenwindow-design-spec.md specifies (forecasting pipeline, JSON contract, existing pages). The
assistant (agent backend + chat) follows `docs/agent-prd.md`, `docs/agent-design.md` and `docs/agent-execution-plan.md`;
the plan's §1 amendments win over the PRD/design. When the spec and your assumptions disagree, the spec wins. When the spec is silent or marked "Verify", check the docs or ask. Do not guess.

## Hard rules
1. Never invent API endpoints, parameters, or library signatures. Verify against live docs or `help()` of the installed version.
2. All timestamps are UTC, hour-beginning, timezone-aware (ISO-8601 with Z in JSON). Convert to Europe/London only at render time in the web app.
3. Never use ERA5/archive weather as model input (Decision D3).
4. A model must never see data at or after its forecast origin. The leakage test must pass.
5. forecast_snapshots is append-only except same-run_id replacement. Never edit history.
6. The forecast pages fetch only the published JSON files (spec 7.6) with plain GETs and no custom headers. The assistant UI may also call the app's own `/api/*` endpoints. No page performs model inference in the browser.
7. Only LLM (and, if approved, Jev) usage may cost money, capped by `MONTHLY_BUDGET_USD` (default $5) with a kill switch. Everything else stays on free tiers (Vercel Hobby, Supabase, Langfuse Hobby, Turnstile). Server secrets live only in Vercel env vars and GitHub Actions secrets, never in the repo, in `VITE_*` variables, or in chat. Never read `.env*` files. Never create paid resources or change the stack without asking.
8. Never commit raw API payloads or model weights.
9. Never say CO2 was "saved" or "avoided". Forecast pages say "estimated difference in average grid intensity" (spec 5.3). The assistant may give grams only as an "estimated emissions difference" with its q10–q90 range and the caveat that it uses average (not marginal) grid intensity and a forecast (decision 2026-10-08, O1).
10. No new dependencies without recording the reason in `docs/decisions.md`.
11. Front end: TypeScript strict mode, no `any`. Validate every fetched JSON with zod. Never assume a field exists.
12. Never change the JSON contract (spec 7.6) on one side only. Update the schemas, the exporter, and the shared fixtures together, and bump `schema_version` for breaking changes.
13. Pipeline commits go to the `data` branch only. Never push data files to `main`.
14. Agent numbers come from tools. The LLM never computes start times, intensities or CO2 figures; the grounding check enforces it.
15. Agent changes must pass the replay eval suite (agent-design §15) once it exists (P2). Agent work merges into `assistant`; only phase exits go to `main`.

## Working method
- One task at a time (spec Section 11). Write the tests first or alongside. Don't move on until acceptance criteria pass.
- Small functions with type hints. Pandas operations must keep timezone-aware indexes.
- Set random seeds. Results must be reproducible.
- Record every deviation from the spec in `docs/decisions.md` with a reason.
- If a verification item (V1–V8) turns out differently than the spec assumes, update the spec section and note it.

## Definition of done (per task)
Tests pass, ruff clean, acceptance criteria met, docs updated, committed.
