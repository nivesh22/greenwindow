// plan_batch (design §7.4, PRD FR-4.7, J4): up to 5 jobs, each planned independently with the unchanged optimizer.
// Every number the model may quote (per job and combined) is in the output so the grounding check can match it.
import { z } from 'zod'
import { MODES } from '../harness/events.js'
import { fmtMass } from '../../src/lib/format.js'
import { HOUR_MS, formatDateTime, toIso, toMs } from '../../src/lib/time.js'
import { CO2_WORDING, co2Range } from './estimate_co2.js'
import { loadForecast } from './forecast_hours.js'
import { resolveWindow, runOptimizer } from './job_window.js'
import { ToolUserError, defineTool } from './registry.js'

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:mm in UK local time')

const display = z.object({ point: z.string(), low: z.string(), high: z.string() })

const okJob = z.object({
  status: z.literal('ok'),
  label: z.string(),
  best_start_utc: z.string(),
  best_start_london: z.string(),
  best_end_london: z.string(),
  run_now_start_utc: z.string(),
  run_now_start_london: z.string(),
  avg_best: z.number(),
  avg_now: z.number(),
  reduction_pct: z.number(),
  energy_kwh: z.number(),
  robust: z.boolean(),
  grams_point: z.number(),
  grams_low: z.number(),
  grams_high: z.number(),
  display,
})
const failedJob = z.object({ status: z.literal('failed'), label: z.string(), error: z.string() })

const outputSchema = z.object({
  jobs: z.array(z.discriminatedUnion('status', [okJob, failedJob])),
  overlaps: z.array(z.tuple([z.string(), z.string()])),
  combined: z.object({ jobs_planned: z.number().int(), grams_point: z.number(), grams_low: z.number(), grams_high: z.number(), display }),
  model: z.string(),
  run_id: z.string(),
  mode: z.enum(MODES),
  note: z.string(),
  caveat: z.string(),
})
export type PlanBatchOutput = z.infer<typeof outputSchema>

const NOTE =
  'Each job was planned independently against the same forecast. There is no joint optimization of capacity or a shared power limit, ' +
  'so jobs listed in "overlaps" would run at the same time and their combined power draw has not been checked.'

export const planBatch = defineTool({
  name: 'plan_batch',
  description:
    'Plans up to 5 flexible jobs at once (e.g. dishwasher, washing machine, EV charge), each with its own duration, power and deadline. ' +
    'Times are UK local (Europe/London) as YYYY-MM-DDTHH:mm. Returns per job the best start, run-now start, average intensities, reduction, energy, robustness and the ' +
    'estimated emissions difference with a low-to-high range; plus "overlaps" (pairs of jobs whose best windows overlap) and combined totals. ' +
    'Jobs are planned independently: there is no joint capacity or power-limit optimization, say so if jobs overlap. ' +
    'A job that cannot fit before its deadline is reported as failed without failing the others. Do not use it for a single job.',
  input: z.strictObject({
    jobs: z
      .array(
        z.strictObject({
          label: z.string().trim().min(1).max(80),
          duration_h: z.number().int().min(1).max(12),
          power_kw: z.number().positive().max(10_000),
          earliest_local: localTime.optional().describe('Earliest start; defaults to the next whole hour.'),
          deadline_local: localTime.describe('The job must finish by this time.'),
        }),
      )
      .min(1)
      .max(5),
    mode: z.enum(MODES).optional().describe('Shared by all jobs. Omit to use the conversation default.'),
    model: z.string().optional(),
  }),
  output: outputSchema,
  auth: 'anon',
  sideEffect: false,
  phase: 'P4',
  intents: ['plan_batch'],
  statusText: 'Planning your jobs…',
  async handler(ctx, input) {
    const f = await loadForecast(ctx, input.model)
    const mode = input.mode ?? ctx.riskMode
    const seen = new Map<string, number>()
    const labelOf = (raw: string): string => {
      const n = (seen.get(raw) ?? 0) + 1
      seen.set(raw, n)
      return n === 1 ? raw : `${raw} (${n})`
    }

    const jobs: PlanBatchOutput['jobs'] = []
    const windows: { label: string; startMs: number; endMs: number }[] = []
    const sum = { point: 0, low: 0, high: 0, n: 0 }
    for (const j of input.jobs) {
      const label = labelOf(j.label)
      try {
        const { earliestMs, deadlineMs } = resolveWindow(f, ctx.nowMs, j.earliest_local, j.deadline_local)
        const rec = runOptimizer(f, { durationH: j.duration_h, powerKw: j.power_kw, earliestStart: toIso(earliestMs), deadline: toIso(deadlineMs) }, mode)
        const r = co2Range(rec)
        if (!r) throw new ToolUserError('no_recommendation', 'The optimizer returned no matching candidate windows.')
        const startMs = toMs(rec.bestStart)
        const endMs = startMs + j.duration_h * HOUR_MS
        windows.push({ label, startMs, endMs })
        sum.point += r.point
        sum.low += r.low
        sum.high += r.high
        sum.n++
        jobs.push({
          status: 'ok',
          label,
          best_start_utc: rec.bestStart,
          best_start_london: formatDateTime(rec.bestStart),
          best_end_london: formatDateTime(toIso(endMs)),
          run_now_start_utc: rec.runNowStart,
          run_now_start_london: formatDateTime(rec.runNowStart),
          avg_best: rec.avgIntensityBest,
          avg_now: rec.avgIntensityNow,
          reduction_pct: rec.intensityReductionPct,
          energy_kwh: rec.energyKwh,
          robust: rec.robust,
          grams_point: r.point,
          grams_low: r.low,
          grams_high: r.high,
          display: { point: fmtMass(r.point), low: fmtMass(r.low), high: fmtMass(r.high) },
        })
      } catch (e) {
        if (e instanceof ToolUserError) jobs.push({ status: 'failed', label, error: e.message })
        else throw e
      }
    }

    const overlaps: [string, string][] = []
    for (let i = 0; i < windows.length; i++) {
      for (let k = i + 1; k < windows.length; k++) {
        const a = windows[i]!
        const b = windows[k]!
        if (a.startMs < b.endMs && b.startMs < a.endMs) overlaps.push([a.label, b.label])
      }
    }

    return {
      jobs,
      overlaps,
      combined: {
        jobs_planned: sum.n,
        grams_point: sum.point,
        grams_low: sum.low,
        grams_high: sum.high,
        display: { point: fmtMass(sum.point), low: fmtMass(sum.low), high: fmtMass(sum.high) },
      },
      model: f.model,
      run_id: f.runId,
      mode,
      note: NOTE,
      caveat: CO2_WORDING.caveat,
    }
  },
})
