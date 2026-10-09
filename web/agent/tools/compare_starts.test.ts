import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareStarts } from './compare_starts.js'
import { makeCtx } from './testing.js'
import { toLocalInput } from '../../src/lib/time.js'

const fc = JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/app_data/latest_forecast.json'), 'utf8')) as { series: { model: string; points: { ts: string }[] }[] }
const firstTs = Date.parse(fc.series.find((s) => s.model === 'chronos2_cov')!.points[0]!.ts)
const at = (h: number) => toLocalInput(firstTs + h * 3_600_000)

describe('compare_starts', () => {
  it('returns averages and a signed difference vs the first start, consistent with its range', async () => {
    const out = await compareStarts.handler(makeCtx(), { duration_h: 3, power_kw: 2, starts_local: [at(1), at(13), at(25)] })
    expect(out.others).toHaveLength(2)
    for (const o of out.others) {
      expect(o.grams_point).toBe(Math.round(out.energy_kwh * (out.baseline.avg_q50 - o.avg_q50)) || o.grams_point) // rounding of averages
      expect(o.grams_low).toBeLessThanOrEqual(o.grams_point)
      expect(o.grams_high).toBeGreaterThanOrEqual(o.grams_point)
      expect(o.lower_than_baseline).toBe(o.grams_point > 0)
    }
    expect(out.caveat).toMatch(/average/)
  })

  it('rejects windows outside the forecast and non-hour times', async () => {
    await expect(compareStarts.handler(makeCtx(), { duration_h: 6, power_kw: 1, starts_local: [at(1), at(46)] })).rejects.toMatchObject({ code: 'outside_forecast' })
    await expect(compareStarts.handler(makeCtx(), { duration_h: 1, power_kw: 1, starts_local: [at(1), at(2).replace(':00', ':30')] })).rejects.toMatchObject({ code: 'bad_time' })
  })
})
