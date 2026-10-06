# AGENTS.md — GreenWindow

## Mission
Build exactly what greenwindow-design-spec.md specifies. When the spec and your assumptions disagree, the spec wins. When the spec is silent or marked "Verify", check the docs or ask. Do not guess.

## Hard rules
1. Never invent API endpoints, parameters, or library signatures. Verify against live docs or `help()` of the installed version.
2. All timestamps are UTC, hour-beginning, timezone-aware (ISO-8601 with Z in JSON). Convert to Europe/London only at render time in the web app.
3. Never use ERA5/archive weather as model input (Decision D3).
4. A model must never see data at or after its forecast origin. The leakage test must pass.
5. forecast_snapshots is append-only except same-run_id replacement. Never edit history.
6. The web app performs no model inference and fetches nothing except the published JSON files (spec 7.6), using plain GET requests with no custom headers.
7. No paid services, no secrets in the repo. The only credential in the default stack is the workflow's default GITHUB_TOKEN. The web app has no secrets (any `VITE_*` variable is public by design). Never create paid resources, connect databases, add secrets, or change the stack without asking.
8. Never commit raw API payloads or model weights.
9. UI copy must not say "CO2 saved". Use "estimated difference in average grid intensity" (spec 5.3).
10. No new dependencies without recording the reason in `docs/decisions.md`.
11. Front end: TypeScript strict mode, no `any`. Validate every fetched JSON with zod. Never assume a field exists.
12. Never change the JSON contract (spec 7.6) on one side only. Update the schemas, the exporter, and the shared fixtures together, and bump `schema_version` for breaking changes.
13. Pipeline commits go to the `data` branch only. Never push data files to `main`.

## Working method
- One task at a time (spec Section 11). Write the tests first or alongside. Don't move on until acceptance criteria pass.
- Small functions with type hints. Pandas operations must keep timezone-aware indexes.
- Set random seeds. Results must be reproducible.
- Record every deviation from the spec in `docs/decisions.md` with a reason.
- If a verification item (V1–V8) turns out differently than the spec assumes, update the spec section and note it.

## Definition of done (per task)
Tests pass, ruff clean, acceptance criteria met, docs updated, committed.
