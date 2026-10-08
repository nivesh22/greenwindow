import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { explainUncertainty } from './explain_uncertainty.js'
import { buildRegistry } from './index.js'
import { recommendWindow } from './recommend_window.js'
import { FIXTURE_DIR, makeCtx } from './testing.js'

interface Pt { ts: string; q10: number | null; q50: number; q90: number | null }
const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, 'latest_forecast.json'), 'utf8')) as {
  series: { model: string; points: Pt[] }[]
}
const input = { duration_h: 3, power_kw: 7, deadline_local: '2026-10-07T08:00' }
const r1 = (x: number): number => Math.round(x * 10) / 10

describe('explain_uncertainty', () => {
  it('errors without a recommendation', async () => {
    await expect(explainUncertainty.handler(makeCtx(), {})).rejects.toMatchObject({ code: 'no_recommendation' })
  })

  it('matches a hand computation from latest_forecast.json', async () => {
    const ctx = makeCtx()
    await recommendWindow.handler(ctx, input)
    const last = ctx.turn.lastRecommendation!
    const out = await explainUncertainty.handler(ctx, {})
    explainUncertainty.output.parse(out)
    expect(out.robust).toBe(last.rec.robust)

    const win = (model: string, start: string): Pt[] => {
      const pts = fixture.series.find((s) => s.model === model)!.points
      const i = pts.findIndex((p) => p.ts === start)
      return pts.slice(i, i + last.job.durationH)
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
    const width = (start: string): number => r1(mean(win('chronos2_cov', start).map((p) => p.q90! - p.q10!)))
    expect(out.band_width_best).toBe(width(last.rec.bestStart))
    expect(out.band_width_now).toBe(width(last.rec.runNowStart))

    const models = ['snaive_24', 'snaive_168', 'sarimax_wx', 'chronos2_uni', 'chronos2_cov']
    const means = models.map((m) => mean(win(m, last.rec.bestStart).map((p) => p.q50)))
    expect(out.model_spread_best).toBe(r1(Math.max(...means) - Math.min(...means)))
    expect(out.neso_avg_best).toBe(r1(mean(win('neso', last.rec.bestStart).map((p) => p.q50))))
    expect(out.plain.length).toBeGreaterThanOrEqual(2)
    expect(out.plain.length).toBeLessThanOrEqual(4)
    expect(out.plain.join(' ')).toContain(`${out.band_width_best} gCO2/kWh wide`)
    expect(out.plain.join(' ')).not.toMatch(/\bsav(e|ed|es|ing)\b|avoid/i)
  })

  it('reports null spread when only one model covers the window', async () => {
    const ctx = makeCtx()
    await recommendWindow.handler(ctx, input)
    const inner = ctx.data
    ctx.data = {
      meta: () => inner.meta(),
      latest: async () => {
        const l = await inner.latest()
        const series = l.data.series.filter((s) => s.model === 'neso' || s.model === 'chronos2_cov')
        return { ...l, data: { ...l.data, series } }
      },
      observations: () => inner.observations(),
      leaderboard: () => inner.leaderboard(),
      backtest: () => inner.backtest(),
    }
    const out = await explainUncertainty.handler(ctx, {})
    expect(out.model_spread_best).toBeNull()
    expect(out.plain.join(' ')).not.toContain('disagree')
  })

  it('has an empty strict JSON schema and is registered for the right intents', () => {
    const json = z.toJSONSchema(explainUncertainty.input) as { properties?: Record<string, unknown>; additionalProperties?: boolean }
    expect(Object.keys(json.properties ?? {})).toHaveLength(0)
    expect(json.additionalProperties).toBe(false)
    expect(buildRegistry().forIntent('explain_forecast').map((t) => t.name)).toContain('explain_uncertainty')
  })
})
