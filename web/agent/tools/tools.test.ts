import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FixtureForecastSource } from '../data/forecast_source'
import type { Fetched, ForecastSource } from '../data/types'
import { planUpdateSchema } from '../harness/events'
import { recommend, type HourForecast, type Mode } from '../../src/scheduler/optimizer'
import { CO2_WORDING, estimateCo2 } from './estimate_co2'
import { getForecast } from './get_forecast'
import { buildRegistry, P1_TOOLS } from './index'
import { DEVICES, lookupDevice, tokens } from './lookup_device'
import { recommendWindow, toPlanUpdate } from './recommend_window'
import { ToolUserError, type LastRecommendation } from './registry'
import { FIXTURE_DIR, NOW_MS, makeCtx } from './testing'

const HOUR = 3_600_000

describe('get_forecast', () => {
  it('returns the default model future hours with NESO alongside', async () => {
    const out = await getForecast.handler(makeCtx(), {})
    getForecast.output.parse(out)
    expect(out.model).toBe('chronos2_cov')
    expect(out.stale).toBe(false)
    expect(out.run_id).toBe('20261006T00')
    expect(out.points).toHaveLength(48)
    expect(out.points[0]?.ts).toBe('2026-10-06T00:00:00Z') // current hour (00:30 floored)
    expect(out.neso).toHaveLength(48)
  })

  it('limits hours and drops the past', async () => {
    const out = await getForecast.handler(makeCtx({ nowMs: Date.parse('2026-10-06T05:10:00Z') }), { hours: 6 })
    expect(out.points.map((p) => p.ts)[0]).toBe('2026-10-06T05:00:00Z')
    expect(out.points).toHaveLength(6)
    expect(out.neso).toHaveLength(6)
  })

  it('lists available models for an unknown one', async () => {
    const err = await getForecast.handler(makeCtx(), { model: 'nope' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolUserError)
    expect((err as ToolUserError).message).toContain('chronos2_cov')
    expect((err as ToolUserError).message).not.toContain('neso')
  })

  it('is stale when the data is older than 12 hours', async () => {
    const out = await getForecast.handler(makeCtx({ nowMs: NOW_MS + 13 * HOUR }), {})
    expect(out.stale).toBe(true)
  })

  it('is stale when the source says so', async () => {
    const inner = new FixtureForecastSource(FIXTURE_DIR)
    const data: ForecastSource = {
      meta: () => inner.meta(),
      latest: async (): Promise<Fetched<Awaited<ReturnType<ForecastSource['latest']>>['data']>> => ({ ...(await inner.latest()), stale: true }),
      observations: () => inner.observations(),
      leaderboard: () => inner.leaderboard(),
      backtest: () => inner.backtest(),
    }
    expect((await getForecast.handler(makeCtx({ data }), {})).stale).toBe(true)
  })

  it('drops points with a null q10 or q90 (as Scheduler.tsx does)', async () => {
    const inner = new FixtureForecastSource(FIXTURE_DIR)
    const data: ForecastSource = {
      meta: () => inner.meta(),
      latest: async () => {
        const l = await inner.latest()
        const series = l.data.series.map((s) =>
          s.model === 'chronos2_cov' ? { ...s, points: s.points.map((p, i) => (i === 3 ? { ...p, q10: null } : p)) } : s,
        )
        return { ...l, data: { ...l.data, series } }
      },
      observations: () => inner.observations(),
      leaderboard: () => inner.leaderboard(),
      backtest: () => inner.backtest(),
    }
    const out = await getForecast.handler(makeCtx({ data }), {})
    expect(out.points).toHaveLength(47)
    expect(out.points.some((p) => p.ts === '2026-10-06T03:00:00Z')).toBe(false)
  })
})

const baseInput = { duration_h: 3, power_kw: 7, deadline_local: '2026-10-07T08:00' }

describe('recommend_window', () => {
  it('matches the optimizer for the same inputs and sets lastRecommendation', async () => {
    const ctx = makeCtx()
    const out = await recommendWindow.handler(ctx, baseInput)
    recommendWindow.output.parse(out)
    // London is BST on this date: 08:00 local = 07:00Z; default earliest = next whole hour after 00:30Z.
    expect(out.earliest_utc).toBe('2026-10-06T01:00:00Z')
    expect(out.deadline_utc).toBe('2026-10-07T07:00:00Z')
    const fc = (await ctx.data.latest()).data.series.find((s) => s.model === 'chronos2_cov')!
    const hours: HourForecast[] = fc.points.map((p) => ({ ts: p.ts, q10: p.q10!, q50: p.q50, q90: p.q90! }))
    const rec = recommend(hours, { durationH: 3, powerKw: 7, earliestStart: out.earliest_utc, deadline: out.deadline_utc }, 'expected')
    expect(out.best_start_utc).toBe(rec.bestStart)
    expect(out.avg_best).toBe(rec.avgIntensityBest)
    expect(out.avg_now).toBe(rec.avgIntensityNow)
    expect(out.energy_kwh).toBe(21)
    expect(out.robust).toBe(rec.robust)
    expect(out.mode).toBe('expected')
    expect(out.model).toBe('chronos2_cov')
    expect(out.best_start_london).toMatch(/BST/)
    expect(ctx.turn.lastRecommendation?.rec.bestStart).toBe(rec.bestStart)
    expect(ctx.turn.lastRecommendation?.runId).toBe('20261006T00')
  })

  it('uses ctx.riskMode unless the input sets a mode', async () => {
    expect((await recommendWindow.handler(makeCtx({ riskMode: 'cautious' }), baseInput)).mode).toBe('cautious')
    expect((await recommendWindow.handler(makeCtx({ riskMode: 'cautious' }), { ...baseInput, mode: 'expected' })).mode).toBe('expected')
  })

  it('converts an explicit local earliest time', async () => {
    const out = await recommendWindow.handler(makeCtx(), { ...baseInput, earliest_local: '2026-10-06T06:00' })
    expect(out.earliest_utc).toBe('2026-10-06T05:00:00Z')
  })

  it('maps optimizer errors and bad windows to ToolUserError', async () => {
    const ctx = makeCtx()
    const infeasible = recommendWindow.handler(ctx, { duration_h: 12, power_kw: 1, earliest_local: '2026-10-06T06:00', deadline_local: '2026-10-06T10:00' })
    await expect(infeasible).rejects.toThrow(ToolUserError)
    await expect(infeasible).rejects.toThrow(/fit before your deadline/)
    await expect(recommendWindow.handler(ctx, { ...baseInput, earliest_local: '2026-10-05T10:00' })).rejects.toMatchObject({ code: 'earliest_in_past' })
    await expect(recommendWindow.handler(ctx, { ...baseInput, deadline_local: '2026-10-06T00:00' })).rejects.toMatchObject({ code: 'bad_deadline' })
    await expect(recommendWindow.handler(ctx, { ...baseInput, deadline_local: '2026-10-09T08:00' })).rejects.toMatchObject({ code: 'deadline_too_late' })
    await expect(recommendWindow.handler(ctx, { ...baseInput, model: 'neso' })).rejects.toMatchObject({ code: 'unknown_model' })
    expect(ctx.turn.lastRecommendation).toBeNull()
  })

  it('validates input strictly', () => {
    expect(recommendWindow.input.safeParse(baseInput).success).toBe(true)
    expect(recommendWindow.input.safeParse({ ...baseInput, extra: 1 }).success).toBe(false)
    expect(recommendWindow.input.safeParse({ ...baseInput, duration_h: 13 }).success).toBe(false)
    expect(recommendWindow.input.safeParse({ ...baseInput, power_kw: 10_001 }).success).toBe(false)
    expect(recommendWindow.input.safeParse({ ...baseInput, deadline_local: '2026-10-07 08:00' }).success).toBe(false)
    expect(recommendWindow.input.safeParse({ ...baseInput, label: 'x'.repeat(81) }).success).toBe(false)
  })

  it('toPlanUpdate produces a valid PlanUpdate', async () => {
    const out = await recommendWindow.handler(makeCtx(), baseInput)
    const pu = toPlanUpdate(out)
    expect(planUpdateSchema.parse(pu)).toEqual(pu)
    expect(pu.best_start_utc).toBe(out.best_start_utc)
    expect(recommendWindow.emitsPlan).toBe(true)
  })
})

describe('estimate_co2', () => {
  it('errors without a recommendation', async () => {
    await expect(estimateCo2.handler(makeCtx(), { from: 'last_recommendation' })).rejects.toMatchObject({ code: 'no_recommendation' })
  })

  it('computes the range from the candidates and keeps the wording to "estimated difference"', async () => {
    const ctx = makeCtx()
    await recommendWindow.handler(ctx, baseInput)
    const rec = ctx.turn.lastRecommendation!.rec
    const out = await estimateCo2.handler(ctx, { from: 'last_recommendation' })
    estimateCo2.output.parse(out)
    const best = rec.candidates.find((c) => c.start === rec.bestStart)!
    const now = rec.candidates.find((c) => c.start === rec.runNowStart)!
    expect(out.grams_point).toBe(rec.gramsDifference)
    if (rec.bestStart !== rec.runNowStart) {
      expect(out.grams_low).toBeCloseTo(rec.energyKwh * (now.avgQ10 - best.avgQ90))
      expect(out.grams_high).toBeCloseTo(rec.energyKwh * (now.avgQ90 - best.avgQ10))
    }
    expect(out.could_be_worse).toBe(out.grams_low < 0)
    expect(out.caveat).toContain('estimated difference')
    expect(out.caveat).not.toMatch(/\bsav(e|ed|es|ing|ings)\b|avoid/i)
    expect(CO2_WORDING.caveat).toBe(out.caveat)
    expect(out.display.point).toMatch(/\d/)
  })

  it('reports zeros when the best window is the run-now window', async () => {
    const ctx = makeCtx()
    const hours: HourForecast[] = [0, 1, 2, 3].map((i) => ({ ts: `2026-10-06T0${i}:00:00Z`, q10: 90, q50: 100, q90: 110 }))
    const rec = recommend(hours, { durationH: 1, powerKw: 1, earliestStart: hours[0]!.ts, deadline: '2026-10-06T04:00:00Z' }, 'expected')
    ctx.turn.lastRecommendation = lastRec(rec, hours, 'expected')
    const out = await estimateCo2.handler(ctx, { from: 'last_recommendation' })
    expect(out).toMatchObject({ grams_point: 0, grams_low: 0, grams_high: 0, could_be_worse: false })
  })

  it('takes no free numbers', () => {
    expect(estimateCo2.input.safeParse({ from: 'last_recommendation', grams: 5 }).success).toBe(false)
    expect(estimateCo2.input.safeParse({ from: 'something' }).success).toBe(false)
  })

  async function lowPositiveIffRobust(hours: HourForecast[], durationH: number, mode: Mode, earliest: string, deadline: string) {
    const rec = recommend(hours, { durationH, powerKw: 2, earliestStart: earliest, deadline }, mode)
    const ctx = makeCtx()
    ctx.turn.lastRecommendation = lastRec(rec, hours, mode)
    const out = await estimateCo2.handler(ctx, { from: 'last_recommendation' })
    expect(out.grams_low > 0).toBe(rec.robust)
  }

  it('invariant: low > 0 iff robust (fixture models, durations, modes)', async () => {
    const src = new FixtureForecastSource(FIXTURE_DIR)
    const latest = (await src.latest()).data
    for (const s of latest.series.filter((x) => x.model !== 'neso')) {
      const hours: HourForecast[] = s.points.map((p) => ({ ts: p.ts, q10: p.q10!, q50: p.q50, q90: p.q90! }))
      for (const durationH of [1, 3, 6, 12]) {
        for (const mode of ['expected', 'cautious'] as const) {
          await lowPositiveIffRobust(hours, durationH, mode, hours[1]!.ts, '2026-10-07T23:00:00Z')
        }
      }
    }
  })

  it('invariant: low > 0 iff robust (golden optimizer cases)', async () => {
    interface Case {
      forecast: { start: string; q10: number[]; q50: number[]; q90: number[]; omit?: number[] }
      job: { durationH: number; powerKw: number; earliestStart: string; deadline: string }
      mode: Mode
      expect: { error?: string }
    }
    const golden = JSON.parse(readFileSync(join(FIXTURE_DIR, '../golden/optimizer_cases.json'), 'utf8')) as { cases: Case[] }
    let checked = 0
    for (const c of golden.cases) {
      if (c.expect.error) continue
      const omit = new Set(c.forecast.omit ?? [])
      const hours: HourForecast[] = c.forecast.q50.flatMap((q50, i) =>
        omit.has(i)
          ? []
          : [{ ts: new Date(Date.parse(c.forecast.start) + i * HOUR).toISOString().replace('.000Z', 'Z'), q10: c.forecast.q10[i]!, q50, q90: c.forecast.q90[i]! }],
      )
      const rec = recommend(hours, c.job, c.mode)
      const ctx = makeCtx()
      ctx.turn.lastRecommendation = lastRec(rec, hours, c.mode)
      const out = await estimateCo2.handler(ctx, { from: 'last_recommendation' })
      expect(out.grams_low > 0).toBe(rec.robust)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

function lastRec(rec: ReturnType<typeof recommend>, hours: HourForecast[], mode: Mode): LastRecommendation {
  return {
    rec,
    job: { durationH: 1, powerKw: 1, earliestUtc: rec.runNowStart, deadlineUtc: rec.runNowStart, mode },
    model: 'test',
    runId: 'r',
    hours,
  }
}

describe('lookup_device', () => {
  it('devices.json is valid, has ~25 entries and a source for each', () => {
    expect(DEVICES.devices.length).toBeGreaterThanOrEqual(24)
    for (const d of DEVICES.devices) {
      expect(d.assumed).toBe(true)
      expect(d.source.length).toBeGreaterThan(10)
      expect(d.kw !== undefined || d.tdp_w !== undefined).toBe(true)
      expect(d.source).not.toMatch(/https?:/)
    }
    expect(new Set(DEVICES.devices.map((d) => d.id)).size).toBe(DEVICES.devices.length)
  })

  it('tokenizes numbers and units', () => {
    expect(tokens('Home EV charger (7 kW)')).toEqual(['home', 'ev', 'charger', '7', 'kw'])
    expect(tokens('7kW')).toEqual(['7', 'kw'])
  })

  it('finds devices by name and alias', async () => {
    const ctx = makeCtx()
    const ev = await lookupDevice.handler(ctx, { query: 'charge my car' })
    expect(ev.matches[0]).toMatchObject({ id: 'ev_7kw', kw: 7, typical_hours: 6, assumed: true })
    const dw = await lookupDevice.handler(ctx, { query: 'dishwasher' })
    expect(dw.matches[0]?.id).toBe('dishwasher')
    const slow = await lookupDevice.handler(ctx, { query: '3.7 kW EV charger' })
    expect(slow.matches[0]?.id).toBe('ev_3_7kw')
    expect((await lookupDevice.handler(ctx, { query: 'zxqv unicorn' })).matches).toEqual([])
    lookupDevice.output.parse(dw)
  })

  it('computes GPU power: count x TDP x PUE plus 0.3 kW host per 8 GPUs', async () => {
    const ctx = makeCtx()
    const h = await lookupDevice.handler(ctx, { gpu: { type: 'H100 SXM', count: 8 } })
    expect(h.matches[0]?.id).toBe('gpu_h100_sxm')
    expect(h.matches[0]?.kw).toBeCloseTo((8 * 700 * 1.2) / 1000 + 0.3)
    expect(h.matches[0]?.typical_hours).toBeNull()
    expect(h.matches[0]?.source).toContain('assumed')
    const nine = await lookupDevice.handler(ctx, { gpu: { type: 'a100 80gb', count: 9 } })
    expect(nine.matches[0]?.id).toBe('gpu_a100_80')
    expect(nine.matches[0]?.kw).toBeCloseTo((9 * 400 * 1.2) / 1000 + 0.6)
    expect((await lookupDevice.handler(ctx, { gpu: { type: 'pcie h100', count: 1 } })).matches[0]?.id).toBe('gpu_h100_pcie')
    expect((await lookupDevice.handler(ctx, { gpu: { type: 'quantum abacus', count: 1 } })).matches).toEqual([])
  })

  it('requires exactly one of query and gpu, strictly', () => {
    expect(lookupDevice.input.safeParse({}).success).toBe(false)
    expect(lookupDevice.input.safeParse({ query: 'x', gpu: { type: 'a100', count: 1 } }).success).toBe(false)
    expect(lookupDevice.input.safeParse({ gpu: { type: 'a100', count: 0 } }).success).toBe(false)
    expect(lookupDevice.input.safeParse({ gpu: { type: 'a100', count: 2, extra: 1 } }).success).toBe(false)
    expect(lookupDevice.input.safeParse({ query: 'oven' }).success).toBe(true)
  })
})

describe('registry', () => {
  it('registers the four P1 tools with strict JSON Schemas and the right intents', () => {
    const reg = buildRegistry()
    expect(P1_TOOLS.map((t) => t.name)).toEqual(['get_forecast', 'recommend_window', 'estimate_co2', 'lookup_device'])
    for (const spec of reg.specs(P1_TOOLS)) {
      expect(spec.parameters).toMatchObject({ type: 'object', additionalProperties: false })
      expect(spec.parameters).not.toHaveProperty('$schema')
    }
    const names = (i: Parameters<typeof reg.forIntent>[0]) => reg.forIntent(i).map((t) => t.name)
    expect(names('smalltalk')).toEqual(['get_forecast', 'lookup_device'])
    expect(names('plan_job')).toEqual(['get_forecast', 'recommend_window', 'estimate_co2', 'lookup_device'])
    expect(names('explain_forecast')).toEqual(['get_forecast', 'lookup_device'])
  })
})
