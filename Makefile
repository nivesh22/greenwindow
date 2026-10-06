# Each target is a thin wrapper over a uv/npm command, so it can be run without make (see README).
.PHONY: setup test lint backtest pipeline export web-dev web-build web-test

setup:
	uv sync --extra chronos
	cd web && npm ci

test:
	uv run pytest -m "not live"

lint:
	uv run ruff check src tests scripts
	uv run ruff format --check src tests scripts

backtest:
	uv run python -m greenwindow.backtest.runner

pipeline:
	uv run python -m greenwindow.live.pipeline

export:
	uv run python -m greenwindow.export.app_json

web-dev:
	cd web && npm run dev

web-build:
	cd web && npm run build

web-test:
	cd web && npm test
