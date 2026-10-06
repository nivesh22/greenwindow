import golden from '../../../tests/golden/optimizer_cases.json'
import { InfeasibleJobError, InvalidJobError, recommend, type HourForecast, type JobSpec, type Mode } from './optimizer'

interface GoldenCase {
  name: string
  forecast: { start: string; q10: number[]; q50: number[]; q90: number[]; omit?: number[] }
  job: JobSpec
  mode: Mode
  alsoCautious?: { bestStart: string }
  expect: Partial<{
    bestStart: string
    avgIntensityBest: number
    avgIntensityNow: number
    gramsDifference: number
    intensityReductionPct: number
    robust: boolean
    nCandidates: number
    error: string
  }>
}

function expand(f: GoldenCase['forecast']): HourForecast[] {
  const t0 = Date.parse(f.start)
  return f.q50
    .map((q50, i) => ({
      ts: new Date(t0 + i * 3_600_000).toISOString().replace('.000Z', 'Z'),
      q10: f.q10[i]!,
      q50,
      q90: f.q90[i]!,
    }))
    .filter((_, i) => !(f.omit ?? []).includes(i))
}

describe('optimizer golden cases', () => {
  for (const c of golden.cases as GoldenCase[]) {
    it(c.name, () => {
      const fc = expand(c.forecast)
      if (c.expect.error) {
        expect(() => recommend(fc, c.job, c.mode)).toThrow(InfeasibleJobError)
        return
      }
      const r = recommend(fc, c.job, c.mode)
      const e = c.expect
      if (e.bestStart) expect(r.bestStart).toBe(e.bestStart)
      if (e.avgIntensityBest !== undefined) expect(r.avgIntensityBest).toBeCloseTo(e.avgIntensityBest)
      if (e.avgIntensityNow !== undefined) expect(r.avgIntensityNow).toBeCloseTo(e.avgIntensityNow)
      if (e.gramsDifference !== undefined) expect(r.gramsDifference).toBeCloseTo(e.gramsDifference)
      if (e.intensityReductionPct !== undefined) expect(r.intensityReductionPct).toBeCloseTo(e.intensityReductionPct)
      if (e.robust !== undefined) expect(r.robust).toBe(e.robust)
      if (e.nCandidates !== undefined) expect(r.candidates).toHaveLength(e.nCandidates)
      expect(r.intensityReductionPct).toBeGreaterThanOrEqual(0)
      expect(r.runNowStart).toBe(c.job.earliestStart)
      if (c.alsoCautious) expect(recommend(fc, c.job, 'cautious').bestStart).toBe(c.alsoCautious.bestStart)
    })
  }
})

describe('optimizer input checks', () => {
  const fc = expand({ start: '2026-10-05T00:00:00Z', q10: [1, 1, 1], q50: [2, 2, 2], q90: [3, 3, 3] })
  const job: JobSpec = { durationH: 1, powerKw: 1, earliestStart: '2026-10-05T00:00:00Z', deadline: '2026-10-05T03:00:00Z' }

  it.each([
    { durationH: 0 },
    { durationH: 13 },
    { durationH: 1.5 },
    { powerKw: 0 },
    { earliestStart: '2026-10-04T23:00:00Z' },
    { deadline: '2026-10-05T04:00:00Z' },
  ])('rejects %o', (patch) => {
    expect(() => recommend(fc, { ...job, ...patch }, 'expected')).toThrow(InvalidJobError)
  })

  it('runs in under 100 ms for a full 48h forecast', () => {
    const big = expand({
      start: '2026-10-05T00:00:00Z',
      q10: Array.from({ length: 48 }, (_, i) => 100 + (i % 7)),
      q50: Array.from({ length: 48 }, (_, i) => 120 + (i % 7)),
      q90: Array.from({ length: 48 }, (_, i) => 140 + (i % 7)),
    })
    const t0 = performance.now()
    recommend(big, { durationH: 12, powerKw: 7, earliestStart: big[0]!.ts, deadline: '2026-10-07T00:00:00Z' }, 'cautious')
    expect(performance.now() - t0).toBeLessThan(100)
  })
})
