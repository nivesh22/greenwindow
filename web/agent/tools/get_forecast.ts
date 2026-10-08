import { z } from 'zod'
import { toMs } from '../../src/lib/time.js'
import { floorHour, loadForecast } from './forecast_hours.js'
import { defineTool } from './registry.js'

const point = z.object({ ts: z.string(), q10: z.number(), q50: z.number(), q90: z.number() })

/**
 * Points whose q10 or q90 is null are omitted (same rule as Scheduler.tsx, so what the model sees is what
 * recommend_window optimizes over). NESO has no quantiles, so it is returned separately as q50 only.
 */
export const getForecast = defineTool({
  name: 'get_forecast',
  description:
    'Returns the latest GB grid carbon-intensity forecast (gCO2/kWh) for the next hours: a median (q50) with a 10-90% range per hour, ' +
    'plus the NESO official forecast for comparison. Use it to answer questions about when the grid will be cleaner. ' +
    'Check "stale" before quoting figures as current.',
  input: z.strictObject({
    model: z.string().optional().describe('Model name; omit for the default.'),
    hours: z.number().int().min(1).max(48).optional().describe('How many future hours to return (default 48).'),
  }),
  output: z.object({
    run_id: z.string(),
    issued_at_utc: z.string(),
    stale: z.boolean(),
    model: z.string(),
    points: z.array(point),
    neso: z.array(z.object({ ts: z.string(), q50: z.number() })).nullable(),
  }),
  auth: 'anon',
  sideEffect: false,
  phase: 'P1',
  intents: 'all',
  statusText: 'Checking the forecast…',
  async handler(ctx, input) {
    const f = await loadForecast(ctx, input.model)
    const fromMs = floorHour(ctx.nowMs)
    const limit = input.hours ?? 48
    const future = f.hours.filter((h) => toMs(h.ts) >= fromMs).slice(0, limit)
    const last = future[future.length - 1]
    const lastMs = last ? toMs(last.ts) : -Infinity
    return {
      run_id: f.runId,
      issued_at_utc: f.issuedAtUtc,
      stale: f.stale,
      model: f.model,
      points: future,
      neso: f.neso ? f.neso.filter((p) => toMs(p.ts) >= fromMs && toMs(p.ts) <= lastMs) : null,
    }
  },
})
