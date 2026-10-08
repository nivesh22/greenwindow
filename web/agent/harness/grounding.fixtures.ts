// Fixtures for grounding and turn tests: hand-built tool outputs matching the live J1 answers (2026-10-08) and
// the two answers the live models gave. Not a test file, so importing it does not re-register tests.
import { CO2_WORDING } from '../tools/estimate_co2.js'
import type { ToolResultLike } from './grounding.js'

export const J1_TOOLS: ToolResultLike[] = [
  {
    tool: 'lookup_device',
    ok: true,
    data: { matches: [{ id: 'ev_home_7kw', name: 'Home EV charger (7 kW)', kw: 7, typical_hours: 6, assumed: true }] },
  },
  {
    tool: 'recommend_window',
    ok: true,
    data: {
      best_start_utc: '2026-10-09T00:00:00Z',
      best_start_london: 'Fri 9 Oct, 01:00 BST',
      run_now_start_utc: '2026-10-08T21:00:00Z',
      avg_best: 51.2,
      avg_now: 55.7,
      reduction_pct: 8.1,
      energy_kwh: 42,
      robust: false,
      model: 'blend_wx',
      run_id: '2026-10-08T18',
      earliest_utc: '2026-10-08T21:00:00Z',
      deadline_utc: '2026-10-09T06:00:00Z',
      mode: 'expected',
      duration_h: 6,
      power_kw: 7,
    },
  },
  {
    tool: 'estimate_co2',
    ok: true,
    data: {
      grams_point: 185,
      grams_low: -2600,
      grams_high: 2900,
      could_be_worse: true,
      caveat: CO2_WORDING.caveat,
      display: { point: '185 g', low: '-2.6 kg', high: '2.9 kg' },
    },
  },
]
export const J1_USER = ['When should I charge my EV? It needs to be done by 7am.']

export const ANSWER_A =
  'Assuming a typical 7 kW home EV charger for 6 hours, the best time to start is **Fri 9 Oct, 01:00 BST** to finish by 7:00. ' +
  'This recommendation is not robust to forecast error. The estimated difference in emissions between running then and running now is 185 g ' +
  '(range -2.6 kg to 2.9 kg). This is an estimated difference in emissions based on the grid\'s average carbon intensity, not a measured or guaranteed change.'
export const ANSWER_B =
  'Assuming a typical 7 kW home EV charger running for 6 hours (which you can adjust), the best time to start charging is **Fri 9 Oct at 01:00 BST** ' +
  '(average intensity of 51.2 gCO2/kWh), compared to starting now (55.7 gCO2/kWh). This recommendation is not robust to forecast error. ' +
  'The estimated difference in emissions is 185 g CO2 (with a range of -2.6 kg to 2.9 kg); this is an estimated difference based on the grid\'s ' +
  'average carbon intensity, not a measured or guaranteed change, and the forecast could be wrong.'
