# CLAUDE.md — GreenWindow (carbon-aware job scheduler)

The source of truth is `greenwindow-design-spec.md` (v0.3). The agent rules live in `AGENTS.md` and apply to Claude too:

@AGENTS.md

## What we're building (one paragraph)
A GitHub Actions pipeline (Python 3.11, every 6h at minute :17) fetches GB carbon intensity (NESO API) and Open-Meteo weather, runs forecasting models (seasonal naive, ETS, SARIMAX+weather, Chronos-2 uni/cov, optional LightGBM), stores immutable snapshots as parquet on an orphan `data` branch, scores them against actuals, and exports small JSON files (`app_data/*.json`, spec 7.6). A static Vite + React + TypeScript app on Vercel reads those JSON files from `raw.githubusercontent.com` and renders the forecast, an in-browser scheduler optimizer, a live leaderboard, backtest results, and an About/Limits page. No backend, no database, no secrets.

## How to read the spec
- Sections 2–12 in order for the build. Section 11 is the task list (T-1 … T15) — do tasks in order, one at a time.
- Section 2.2 lists "Verify during build" items (V1–V11). Verify against live docs / installed packages before use; never assume.
- Section 7.6 is the pipeline↔app JSON contract. Change it only on both sides at once (rule 12).
- Section 15 lists human-only prerequisites (accounts, tokens, settings). Don't try to do these for the user; remind them when a task depends on one.

## Current status
- Phase: project setup. No code yet. Next task: **T-1 feasibility gate** (`scripts/feasibility_check.py` — referenced by the spec but not yet in this folder; ask the user for it or write it from spec 14.3).
- Open questions for the user: spec 13.1 (instructor OK for Chronos-2, name, course models, hosting, time budget).
- Proposed but NOT applied: course-alignment changes (Prophet, UCM, factor covariates). Don't build them unless the user confirms.

## Layout (target, spec 4.4)
- `src/greenwindow/` Python pipeline (`ingest/`, `features/`, `models/`, `backtest/`, `live/`, `export/`, `schemas.py`)
- `web/` Vite React app (`src/data`, `src/scheduler/optimizer.ts`, `src/components`, `src/pages`, `src/lib`)
- `config/` `settings.yaml`, `locations.yaml`
- `tests/` Python tests, `tests/app_data/` shared JSON fixtures, `tests/golden/` optimizer cases
- `docs/` decisions, data card, evaluation plan, feasibility report, perf, results
- `.github/workflows/` `pipeline.yml`, `ci.yml`

## Commands (once scaffolded in T0)
- Python: `uv` with lockfile. `make setup`, `make test`, `make backtest`, `make pipeline`, `make export`
- Web: `make web-dev`, `make web-build` (Vitest for tests, ESLint)
- Lint: `ruff` (Python), ESLint (web)

## Environment notes
- Windows 11 dev machine; Git Bash and PowerShell both available. Makefile targets must also be runnable without `make` (document the underlying commands) or note that `make` must be installed.
- Installed: Python 3.12 (spec wants 3.11 — pin via `uv python`), Node 22, uv, git, `gh` (logged in as `nivesh22`; may need `C:\Program Files\GitHub CLI` on PATH). **Not installed:** Vercel CLI (optional).

## Integrations (MCP)
- **GitHub** — via `git` + `gh` CLI (user's login, not the GitHub MCP; user chose this over the scoped PAT in spec H6). Repo: https://github.com/nivesh22/greenwindow. The login can reach all the user's repos — **only ever touch `nivesh22/greenwindow`**.
- **Vercel MCP** — connected (`.mcp.json`); inspect deployments/build logs. Root Directory = `web`; must not build on `data` branch pushes (V11/H9).
- **Supabase** — the spec explicitly rejects it for v1 (D6, 15.1). Do not use it unless the user changes the decision and it's recorded in `docs/decisions.md`.

## Wording rules worth repeating
- Never "CO2 saved". Say "estimated difference in average grid intensity".
- Always attribute NESO and Open-Meteo (CC BY 4.0).
- Report negative results; always show the seasonal-naive benchmark.
