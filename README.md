# GreenWindow

*When is the cleanest time to run my electricity-hungry job in the next 48 hours, and how sure are we?*

GreenWindow forecasts Great Britain's grid carbon intensity hourly for the next 48 hours with classical
time-series models and the Chronos-2 foundation model, turns the forecast into a start-time recommendation
for a flexible job, and scores itself against actuals and the grid operator's own forecast.

Status: early build. Design: [`greenwindow-design-spec.md`](greenwindow-design-spec.md). Decisions: [`docs/decisions.md`](docs/decisions.md).

## Development

Requires Python 3.11 (via [uv](https://docs.astral.sh/uv/)) and Node 20+. `make` targets wrap these commands;
on Windows without `make`, run the commands directly:

| make | command |
|------|---------|
| `make setup` | `uv sync --extra chronos` |
| `make test` | `uv run pytest -m "not live"` |
| `make lint` | `uv run ruff check src tests scripts && uv run ruff format --check src tests scripts` |
| `make pipeline` | `uv run python -m greenwindow.live.pipeline` |

## Data and attribution

Carbon intensity data: NESO Carbon Intensity API, CC BY 4.0. Weather data: Open-Meteo.com, CC BY 4.0.
