import { recommendWindow } from '../tools/recommend_window.js'
import { estimateCo2 } from '../tools/estimate_co2.js'
import { makeCtx } from '../tools/testing.js'
import { formatDateTime, toLocalInput } from '../../src/lib/time.js'
import { ANSWER_A, ANSWER_B, J1_TOOLS, J1_USER } from './grounding.fixtures.js'
import { checkGrounding, extractFigures, regenerateInstruction, type ToolResultLike } from './grounding.js'

const check = (text: string, tools = J1_TOOLS, user = J1_USER) => checkGrounding({ text, toolResults: tools, userTexts: user })
const numbers = (text: string) => check(text).violations.filter((v) => v.kind === 'ungrounded_number').map((v) => v.match)

describe('extractFigures', () => {
  it('finds clock times in 24 h, 12 h and dotted forms with zones', () => {
    const f = extractFigures('Start 01:00 BST, or 1am, or 7 pm, or 07:00 GMT, or 7.30pm, or 23:00 UTC.')
    expect(f.map((x) => x.kind === 'time' && [x.match, x.zone, x.minutes])).toEqual([
      ['01:00 BST', 'london', [60]],
      ['07:00 GMT', 'london', [420]],
      ['23:00 UTC', 'utc', [1380]],
      ['7.30pm', 'london', [1170]],
      ['1am', 'london', [60]],
      ['7 pm', 'london', [1140]],
    ])
  })

  it('treats 12am as midnight and 12pm as noon; "7:00" may also mean 19:00', () => {
    const f = extractFigures('12am 12pm 7:00')
    expect(f.map((x) => x.kind === 'time' && x.minutes)).toEqual([[420, 1140], [0], [720]])
  })

  it('finds masses with sign, units, CO2 suffix and thousands separators', () => {
    const f = extractFigures('185 g, -2.6 kg, 2.9 kg CO₂, 1.2 t, 1,200 g, 3 kilograms, −1.5 kg, 185-200 g')
    expect(f.map((x) => x.kind === 'mass' && [x.match, x.grams, x.tol])).toEqual([
      ['185 g', 185, 1],
      ['-2.6 kg', -2600, 100],
      ['2.9 kg CO2', 2900, 100],
      ['1.2 t', 1_200_000, 100_000],
      ['1,200 g', 1200, 1],
      ['3 kilograms', 3000, 1000],
      ['-1.5 kg', -1500, 100],
      ['200 g', 200, 1],
    ])
  })

  it('reads intensities before masses, and percentages, kW and kWh', () => {
    const f = extractFigures('51.2 gCO2/kWh vs 55.7 g CO2/kWh, 60 g/kWh, 8.1% lower, 12 per cent, 7 kW for 42 kWh')
    expect(f.map((x) => x.kind === 'number' && [x.unit, x.value, x.tol])).toEqual([
      ['intensity', 51.2, expect.closeTo(0.1)],
      ['intensity', 55.7, expect.closeTo(0.1)],
      ['intensity', 60, 1],
      ['percent', 8.1, expect.closeTo(0.1)],
      ['percent', 12, 1],
      ['power', 7, 1],
      ['energy', 42, 1],
    ])
  })

  it('ignores dates, weekday words, ISO timestamps, bare counts and durations', () => {
    expect(extractFigures('Fri 9 Oct, 2 options, 6 hours, 48-hour horizon, 2026-10-09T00:00:00Z, version 3.2')).toEqual([])
  })
})

describe('checkGrounding: the live J1 answers', () => {
  it('answer A passes', () => expect(check(ANSWER_A)).toEqual({ ok: true, violations: [] }))
  it('answer B passes', () => expect(check(ANSWER_B)).toEqual({ ok: true, violations: [] }))

  it.each([
    ['A start time', ANSWER_A.replace('01:00 BST', '02:00 BST'), '02:00 BST'],
    ['A finish time', ANSWER_A.replace('by 7:00', 'by 8:00'), '8:00'],
    ['A point mass', ANSWER_A.replace('185 g', '190 g'), '190 g'],
    ['A low mass', ANSWER_A.replace('-2.6 kg', '-3.6 kg'), '-3.6 kg'],
    ['A high mass in grams', ANSWER_A.replace('2.9 kg', '2950 g'), '2950 g'],
    ['A power', ANSWER_A.replace('7 kW', '22 kW'), '22 kW'],
    ['B start time 12 h', ANSWER_B.replace('01:00 BST', '3am'), '3am'],
    ['B intensity', ANSWER_B.replace('51.2 gCO2', '45.2 gCO2'), '45.2 gCO2/kWh'],
    ['B mass', ANSWER_B.replace('185 g CO2', '1.85 kg CO2'), '1.85 kg CO2'],
    ['B percentage', `${ANSWER_B} That is 12% lower.`, '12%'],
  ])('mutated %s fails', (_name, text, bad) => {
    const r = check(text)
    expect(r.ok).toBe(false)
    expect(r.violations).toContainEqual({ kind: 'ungrounded_number', match: bad })
  })

  it('allows the derived end time (start + duration) even when the user gave no deadline', () => {
    expect(check(ANSWER_A, J1_TOOLS, ['When should I charge my EV?']).ok).toBe(true)
  })

  it('allows a user number (kW) that no tool returned', () => {
    const text = 'With your 22 kW charger, start at 01:00 BST.'
    expect(check(text).ok).toBe(false)
    expect(check(text, J1_TOOLS, ['I have a 22 kW charger']).ok).toBe(true)
  })
})

describe('checkGrounding: tolerance and units', () => {
  it('accepts one rounding unit of the written precision, in either g or kg', () => {
    expect(numbers('About 0.2 kg (estimate, average intensity).')).toEqual([]) // 185 g within 100 g
    expect(numbers('About 186 g (estimate, average intensity).')).toEqual([])
    expect(numbers('About 187 g (estimate, average intensity).')).toEqual(['187 g'])
    expect(numbers('Up to 2,900 g (estimate, average intensity).')).toEqual([])
    expect(numbers('Intensity 51 gCO2/kWh.')).toEqual([])
    expect(numbers('Intensity 51.4 gCO2/kWh.')).toEqual(['51.4 gCO2/kWh'])
    expect(numbers('8% lower.')).toEqual([])
  })

  it('compares masses by magnitude (a range end may be written without its sign)', () => {
    expect(numbers('It could be up to 2.6 kg worse (estimate, average intensity).')).toEqual([])
  })

  it('checks UTC times against UTC and London times against London', () => {
    expect(numbers('Start at 00:00 UTC.')).toEqual([])
    expect(numbers('Start at 01:00 UTC.')).toEqual(['01:00 UTC'])
    expect(numbers('Start at 00:00 BST.')).toEqual(['00:00 BST'])
  })

  it('accepts times quoted in tool error messages', () => {
    const tools: ToolResultLike[] = [{ tool: 'recommend_window', ok: false, data: { code: 'earliest_in_past', message: 'The earliest start must be Mon 5 Oct, 18:00 BST or later.' } }]
    expect(checkGrounding({ text: 'The earliest start is 18:00 BST.', toolResults: tools, userTexts: [] }).ok).toBe(true)
  })

  it('with no tool results, any time or mass is ungrounded', () => {
    const r = checkGrounding({ text: 'Run it at 3am to save about 200 g, an estimate based on average intensity.', toolResults: [], userTexts: ['hi'] })
    expect(r.violations.filter((v) => v.kind === 'ungrounded_number').map((v) => v.match)).toEqual(['200 g', '3am'])
  })

  it('passes plain text with no figures', () => {
    expect(checkGrounding({ text: 'How long does the job run, and by when must it finish?', toolResults: [], userTexts: [] }).ok).toBe(true)
  })
})

describe('checkGrounding: banned claims and caveat', () => {
  it.each([
    ['You saved 185 g.', 'You saved'],
    ["You've saved 185 g.", "You've saved"],
    ['You have saved 185 g!', 'You have saved'],
    ['That is 185 g CO2 saved.', 'CO2 saved'],
    ['That is 185 g of CO₂ saved.', 'CO2 saved'],
    ['This avoided 185 g of CO2 emissions.', 'avoided'],
    ['A saving of 185 g CO2.', 'saving'],
    ['Carbon savings of 185 g.', 'savings'],
  ])('%s', (text, match) => {
    const banned = check(`${text} This is an estimate based on average grid intensity.`).violations.filter((v) => v.kind === 'banned_claim')
    if (match === null) expect(banned).toEqual([])
    else expect(banned).toContainEqual({ kind: 'banned_claim', match })
  })

  it('does not ban "avoid" or "saving" far from emissions words', () => {
    expect(check('Saving the job for tonight is fine; avoided peak hours are listed below.').violations).toEqual([])
  })

  it('requires "average" and "estimate" when a mass appears', () => {
    expect(check('The difference is 185 g.').violations).toEqual([
      { kind: 'missing_caveat', match: 'average' },
      { kind: 'missing_caveat', match: 'estimate' },
    ])
    expect(check('The estimated difference is 185 g.').violations).toEqual([{ kind: 'missing_caveat', match: 'average' }])
    expect(check('Start at 01:00 BST.').violations).toEqual([])
  })

  it('the regenerate instruction names the bad figures and the rules', () => {
    const r = check('You saved 190 g at 02:00 BST.')
    const msg = regenerateInstruction(r.violations)
    expect(msg).toContain('not in the tool results: "190 g", "02:00 BST"')
    expect(msg).toContain('"You saved"')
    expect(msg).toContain('caveat')
    expect(msg).toContain('using only figures from the tool results')
    expect(msg).toContain('do not mention an earlier draft')
  })
})

describe('checkGrounding: real tool handlers on the fixture forecast', () => {
  it('an answer quoting recommend_window and estimate_co2 verbatim passes; a shifted hour fails', async () => {
    const ctx = makeCtx()
    const rec = await recommendWindow.handler(ctx, { duration_h: 3, power_kw: 7, deadline_local: toLocalInput(Math.floor(ctx.nowMs / 3_600_000) * 3_600_000 + 30 * 3_600_000) })
    const co2 = await estimateCo2.handler(ctx, {})
    const tools: ToolResultLike[] = [
      { tool: 'recommend_window', ok: true, data: rec },
      { tool: 'estimate_co2', ok: true, data: co2 },
    ]
    const text =
      `Start at ${rec.best_start_london} (${rec.avg_best.toFixed(1)} gCO2/kWh vs ${rec.avg_now.toFixed(1)} now, ${rec.reduction_pct.toFixed(0)}% lower). ` +
      `Estimated difference: ${co2.display.point} (range ${co2.display.low} to ${co2.display.high}). ${co2.caveat}`
    expect(checkGrounding({ text, toolResults: tools, userTexts: [] })).toEqual({ ok: true, violations: [] })
    const shifted = formatDateTime(new Date(Date.parse(rec.best_start_utc) + 3_600_000).toISOString())
    const bad = text.replace(rec.best_start_london, shifted)
    expect(checkGrounding({ text: bad, toolResults: tools, userTexts: [] }).ok).toBe(false)
  })
})
