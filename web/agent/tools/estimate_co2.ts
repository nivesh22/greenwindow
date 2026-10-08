import { z } from 'zod'
import { fmtMass } from '../../src/lib/format.js'
import { ToolUserError, defineTool } from './registry.js'

/**
 * All user-facing CO2 wording lives here so it can be switched in one place (owner decision O1 is pending).
 * AGENTS.md rule 9 applies today: say "estimated difference" in emissions based on average grid intensity.
 */
export const CO2_WORDING = {
  noun: 'estimated difference in emissions, based on average grid intensity',
  caveat:
    'This is an estimated difference in emissions based on the grid\'s average carbon intensity, not a measured or guaranteed change. ' +
    'Shifting a job does not necessarily change the grid\'s marginal emissions by the same amount, and the forecast can be wrong; ' +
    'the low-to-high range uses the forecast\'s 10-90% bands.',
  noChange: 'The recommendation is to run at the earliest start, so there is no estimated difference.',
} as const

const outputSchema = z.object({
  grams_point: z.number(),
  grams_low: z.number(),
  grams_high: z.number(),
  could_be_worse: z.boolean(),
  caveat: z.string(),
  display: z.object({ point: z.string(), low: z.string(), high: z.string() }),
})

export const estimateCo2 = defineTool({
  name: 'estimate_co2',
  description:
    'Estimates the difference in emissions (grams CO2, based on average grid intensity) between the recommended window and running at the earliest start, ' +
    'as a point estimate with a low-to-high range. Uses the last recommend_window result only; call recommend_window first. ' +
    'Describe it as an "estimated difference", never as saved or avoided emissions. "could_be_worse" means the range includes the recommendation being worse than running now.',
  input: z.strictObject({}), // no arguments: it always uses this turn's last recommend_window result
  output: outputSchema,
  auth: 'anon',
  sideEffect: false,
  phase: 'P1',
  intents: ['plan_job', 'plan_batch', 'recurring'],
  statusText: 'Estimating the difference…',
  async handler(ctx) {
    const last = ctx.turn.lastRecommendation
    if (!last) throw new ToolUserError('no_recommendation', 'No recommendation yet. Call recommend_window first.')
    const { rec } = last
    const best = rec.candidates.find((c) => c.start === rec.bestStart)
    const now = rec.candidates.find((c) => c.start === rec.runNowStart)
    if (!best || !now) throw new ToolUserError('no_recommendation', 'The last recommendation has no matching candidate windows.')

    // Best window is the run-now window: nothing shifts, so there is no range to report.
    if (rec.bestStart === rec.runNowStart) {
      return {
        grams_point: 0,
        grams_low: 0,
        grams_high: 0,
        could_be_worse: false,
        caveat: `${CO2_WORDING.noChange} ${CO2_WORDING.caveat}`,
        display: { point: fmtMass(0), low: fmtMass(0), high: fmtMass(0) },
      }
    }
    const e = rec.energyKwh
    const low = e * (now.avgQ10 - best.avgQ90) // pessimistic: best window comes in high, run-now comes in low
    const high = e * (now.avgQ90 - best.avgQ10)
    const point = rec.gramsDifference
    return {
      grams_point: point,
      grams_low: low,
      grams_high: high,
      could_be_worse: low < 0,
      caveat: CO2_WORDING.caveat,
      display: { point: fmtMass(point), low: fmtMass(low), high: fmtMass(high) },
    }
  },
})
