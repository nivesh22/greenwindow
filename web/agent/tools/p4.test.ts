import { actionEventSchema } from '../harness/events.js'
import { MemoryPlanStore } from '../store/plan_types.js'
import { fmtMass } from '../../src/lib/format.js'
import { toAction, TOOLS } from './index.js'
import { makeCalendarEvent, scheduleReminder } from './follow_through.js'
import { planBatch } from './plan_batch.js'
import { cancelPlan, listPlansTool, saveRecurringPlan } from './plans.js'
import { recommendWindow } from './recommend_window.js'
import { co2Range } from './estimate_co2.js'
import { NOW_MS, makeCtx } from './testing.js'
import type { ToolCtx } from './registry.js'

const HOUR = 3_600_000
const J1 = { label: 'Dishwasher', duration_h: 2, power_kw: 1.5, deadline_local: '2026-10-07T07:00' }
const J2 = { label: 'EV charge', duration_h: 4, power_kw: 7, deadline_local: '2026-10-07T08:00' }

function userCtx(over: Partial<ToolCtx> = {}): { ctx: ToolCtx; plans: MemoryPlanStore } {
  const plans = new MemoryPlanStore({ now: () => NOW_MS })
  return { ctx: makeCtx({ userId: 'u1', isAnonymous: false, plans, ...over }), plans }
}

describe('plan_batch', () => {
  it('plans each job like recommend_window and sums the combined figures', async () => {
    const ctx = makeCtx()
    const out = await planBatch.handler(ctx, { jobs: [J1, J2, { ...J1, label: 'Washer', duration_h: 1 }] })
    planBatch.output.parse(out)
    expect(out.jobs).toHaveLength(3)
    const single = await recommendWindow.handler(makeCtx(), { duration_h: 4, power_kw: 7, deadline_local: J2.deadline_local })
    const ev = out.jobs[1]!
    if (ev.status !== 'ok') throw new Error('expected ok')
    expect(ev.best_start_utc).toBe(single.best_start_utc)
    expect(ev.avg_best).toBe(single.avg_best)
    expect(ev.energy_kwh).toBe(28)
    expect(ev.robust).toBe(single.robust)
    expect(ev.best_start_london).toMatch(/BST/)

    let p = 0
    let lo = 0
    let hi = 0
    for (const j of out.jobs) {
      if (j.status !== 'ok') throw new Error('expected ok')
      p += j.grams_point
      lo += j.grams_low
      hi += j.grams_high
      expect(j.display.point).toBe(fmtMass(j.grams_point))
    }
    expect(out.combined.jobs_planned).toBe(3)
    expect(out.combined.grams_point).toBeCloseTo(p, 9)
    expect(out.combined.grams_low).toBeCloseTo(lo, 9)
    expect(out.combined.grams_high).toBeCloseTo(hi, 9)
    expect(out.combined.display.high).toBe(fmtMass(out.combined.grams_high))
    expect(out.note).toMatch(/independently/)
    expect(out.note).toMatch(/no joint optimization/)
    expect(out.caveat).toContain('average carbon intensity')
    expect(ctx.turn.lastRecommendation).toBeNull() // no plan_update / last recommendation from a batch
    expect(planBatch.emitsPlan).toBeUndefined()
  })

  it('range invariant: low > 0 exactly when the job is robust', async () => {
    const out = await planBatch.handler(makeCtx(), { jobs: [J1, J2, { ...J1, label: 'Wash', deadline_local: '2026-10-06T20:00' }] })
    for (const j of out.jobs) {
      if (j.status !== 'ok') continue
      expect(j.grams_low <= j.grams_point && j.grams_point <= j.grams_high).toBe(true)
      if (j.grams_point !== 0) expect(j.grams_low > 0).toBe(j.robust)
    }
  })

  it('detects overlapping best windows', async () => {
    // Identical jobs have identical best windows.
    const out = await planBatch.handler(makeCtx(), { jobs: [J1, { ...J1, label: 'Dryer' }] })
    expect(out.overlaps).toEqual([['Dishwasher', 'Dryer']])
    const [a, b] = out.jobs
    if (a?.status !== 'ok' || b?.status !== 'ok') throw new Error('expected ok')
    expect(a.best_start_utc).toBe(b.best_start_utc)
  })

  it('reports no overlap for disjoint windows', async () => {
    const out = await planBatch.handler(makeCtx(), {
      jobs: [
        { label: 'A', duration_h: 1, power_kw: 1, earliest_local: '2026-10-06T08:00', deadline_local: '2026-10-06T09:00' },
        { label: 'B', duration_h: 1, power_kw: 1, earliest_local: '2026-10-06T12:00', deadline_local: '2026-10-06T13:00' },
      ],
    })
    expect(out.overlaps).toEqual([])
  })

  it('reports an infeasible job without failing the batch, and excludes it from the totals', async () => {
    const bad = { label: 'Too long', duration_h: 12, power_kw: 1, earliest_local: '2026-10-06T06:00', deadline_local: '2026-10-06T10:00' }
    const out = await planBatch.handler(makeCtx(), { jobs: [J1, bad, { ...J1, label: 'Late', deadline_local: '2026-10-12T08:00' }] })
    expect(out.jobs.map((j) => j.status)).toEqual(['ok', 'failed', 'failed'])
    const failed = out.jobs[1]
    expect(failed?.status === 'failed' && failed.error).toMatch(/fit before your deadline/)
    const ok = out.jobs[0]
    if (ok?.status !== 'ok') throw new Error('expected ok')
    expect(out.combined.jobs_planned).toBe(1)
    expect(out.combined.grams_point).toBe(ok.grams_point)
  })

  it('makes duplicate labels unique, uses the shared mode, and validates strictly', async () => {
    const out = await planBatch.handler(makeCtx({ riskMode: 'cautious' }), { jobs: [J1, J1] })
    expect(out.jobs.map((j) => j.label)).toEqual(['Dishwasher', 'Dishwasher (2)'])
    expect(out.mode).toBe('cautious')
    expect((await planBatch.handler(makeCtx(), { jobs: [J1], mode: 'expected' })).mode).toBe('expected')
    expect(planBatch.input.safeParse({ jobs: [] }).success).toBe(false)
    expect(planBatch.input.safeParse({ jobs: Array.from({ length: 6 }, () => J1) }).success).toBe(false)
    expect(planBatch.input.safeParse({ jobs: [{ ...J1, duration_h: 13 }] }).success).toBe(false)
    expect(planBatch.input.safeParse({ jobs: [{ ...J1, extra: 1 }] }).success).toBe(false)
    expect(planBatch.input.safeParse({ jobs: [J1], extra: 1 }).success).toBe(false)
  })
})

const RULE = {
  label: 'Dishwasher',
  days: ['tue', 'wed'] as ('tue' | 'wed')[],
  window_from: '09:00',
  window_to: '17:00',
  duration_h: 2,
  power_kw: 1.5,
  remind: false,
  confirm: true,
}

describe('save_recurring_plan', () => {
  it('requires confirmation, a signed-in user and a plan store', async () => {
    const { ctx, plans } = userCtx()
    await expect(saveRecurringPlan.handler(ctx, { ...RULE, confirm: false })).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(plans.plans).toHaveLength(0)
    await expect(saveRecurringPlan.handler(makeCtx({ plans }), RULE)).rejects.toMatchObject({ code: 'sign_in_required' })
    await expect(saveRecurringPlan.handler(makeCtx({ userId: 'u1', isAnonymous: true, plans }), RULE)).rejects.toMatchObject({ code: 'sign_in_required' })
    await expect(saveRecurringPlan.handler(makeCtx({ userId: 'u1', isAnonymous: false }), RULE)).rejects.toMatchObject({ code: 'not_available' })
    expect(plans.plans).toHaveLength(0)
  })

  it('validates the window against the duration', async () => {
    const { ctx } = userCtx()
    await expect(saveRecurringPlan.handler(ctx, { ...RULE, window_from: '17:00', window_to: '09:00' })).rejects.toMatchObject({ code: 'bad_window' })
    await expect(saveRecurringPlan.handler(ctx, { ...RULE, window_from: '09:00', window_to: '09:00' })).rejects.toMatchObject({ code: 'bad_window' })
    await expect(saveRecurringPlan.handler(ctx, { ...RULE, window_from: '09:00', window_to: '10:30' })).rejects.toMatchObject({ code: 'window_too_short' })
    expect(saveRecurringPlan.input.safeParse({ ...RULE, window_from: '9:00' }).success).toBe(false)
    expect(saveRecurringPlan.input.safeParse({ ...RULE, days: [] }).success).toBe(false)
    expect(saveRecurringPlan.input.safeParse({ ...RULE, days: ['funday'] }).success).toBe(false)
  })

  it('stores the plan and gives a next start only when that day is inside the forecast', async () => {
    const { ctx, plans } = userCtx()
    const out = await saveRecurringPlan.handler(ctx, RULE)
    saveRecurringPlan.output.parse(out)
    expect(plans.plans).toHaveLength(1)
    expect(plans.plans[0]).toMatchObject({ userId: 'u1', kind: 'recurring', nextStartUtc: out.next_start_utc })
    // Tuesday 2026-10-06 09:00-17:00 BST = 08:00Z-16:00Z, inside the forecast (to 2026-10-08T00:00Z).
    expect(out.next_start_utc).not.toBeNull()
    const s = Date.parse(out.next_start_utc!)
    expect(s).toBeGreaterThanOrEqual(Date.parse('2026-10-06T08:00:00Z'))
    expect(s + 2 * HOUR).toBeLessThanOrEqual(Date.parse('2026-10-06T16:00:00Z'))
    expect(out.next_note).toBeNull()
    expect(out.push_needed).toBe(false)
  })

  it('never promises a start beyond the forecast horizon', async () => {
    const { ctx, plans } = userCtx()
    for (const days of [['sat'], ['thu'], ['sun']] as const) {
      const out = await saveRecurringPlan.handler(ctx, { ...RULE, days: [...days] })
      expect(out.next_start_utc).toBeNull()
      expect(out.next_start_london).toBeNull()
      expect(out.next_note).toMatch(/each morning/)
    }
    expect(plans.plans.every((p) => p.nextStartUtc === null)).toBe(true)
  })

  it('skips today when the window has already passed', async () => {
    // Tue 2026-10-06 00:30Z; a 00:00-01:00 BST window is gone (earliest start 01:00Z), so the next Tuesday is beyond the horizon.
    const { ctx } = userCtx()
    const out = await saveRecurringPlan.handler(ctx, { ...RULE, days: ['tue'], window_from: '00:00', window_to: '01:30', duration_h: 1 })
    expect(out.next_start_utc).toBeNull()
  })

  it('flags push_needed when a reminder is wanted but there is no subscription', async () => {
    const { ctx, plans } = userCtx()
    expect((await saveRecurringPlan.handler(ctx, { ...RULE, remind: true })).push_needed).toBe(true)
    await plans.savePushSubscription({ userId: 'u1', endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' })
    expect((await saveRecurringPlan.handler(ctx, { ...RULE, remind: true })).push_needed).toBe(false)
    expect(plans.plans[1]?.rule?.remind).toBe(true)
  })

  it('emits a plan_saved action', async () => {
    const { ctx } = userCtx()
    const out = await saveRecurringPlan.handler(ctx, RULE)
    const a = toAction('save_recurring_plan', out)
    expect(actionEventSchema.parse(a)).toEqual({ kind: 'plan_saved', plan_id: out.plan.id, label: 'Dishwasher', recurring: true })
    expect(saveRecurringPlan.emitsAction).toBe(true)
  })
})

describe('list_plans and cancel_plan', () => {
  it('lists only the caller\'s active plans', async () => {
    const { ctx, plans } = userCtx()
    await saveRecurringPlan.handler(ctx, RULE)
    await saveRecurringPlan.handler(userCtx({ userId: 'u2', plans }).ctx, { ...RULE, label: 'Other' })
    const out = await listPlansTool.handler(ctx, {})
    listPlansTool.output.parse(out)
    expect(out.count).toBe(1)
    expect(out.plans[0]).toMatchObject({ label: 'Dishwasher', days: ['tue', 'wed'], window_local: '09:00-17:00', duration_h: 2 })
    await expect(listPlansTool.handler(makeCtx({ plans }), {})).rejects.toMatchObject({ code: 'sign_in_required' })
  })

  it('cancel requires confirmation, scopes to the user and cancels reminders', async () => {
    const { ctx, plans } = userCtx()
    const saved = await saveRecurringPlan.handler(ctx, RULE)
    const id = saved.plan.id
    await plans.addReminder({ userId: 'u1', planId: id, sendAtUtc: '2026-10-06T07:50:00Z', payload: { title: 't', body: 'b', url: '/scheduler', startUtc: '2026-10-06T08:00:00Z' } })
    await expect(cancelPlan.handler(ctx, { plan_id: id, confirm: false })).rejects.toMatchObject({ code: 'confirmation_required' })
    await expect(cancelPlan.handler(userCtx({ userId: 'u2', plans }).ctx, { plan_id: id, confirm: true })).rejects.toMatchObject({ code: 'plan_not_found' })
    expect(plans.plans[0]?.active).toBe(true)
    await expect(cancelPlan.handler(makeCtx({ plans }), { plan_id: id, confirm: true })).rejects.toMatchObject({ code: 'sign_in_required' })
    expect(await cancelPlan.handler(ctx, { plan_id: id, confirm: true })).toMatchObject({ cancelled: true, plan_id: id })
    expect(plans.plans[0]?.active).toBe(false)
    expect(plans.reminders[0]?.status).toBe('cancelled')
    expect((await listPlansTool.handler(ctx, {})).count).toBe(0)
  })
})

const REC_INPUT = { duration_h: 3, power_kw: 7, deadline_local: '2026-10-07T08:00' }

describe('make_calendar_event', () => {
  it('needs a recommendation and takes no free times', async () => {
    await expect(makeCalendarEvent.handler(makeCtx(), { from: 'last_recommendation' })).rejects.toMatchObject({ code: 'no_recommendation' })
    expect(makeCalendarEvent.input.safeParse({ from: 'last_recommendation', start: '2026-10-06T10:00:00Z' }).success).toBe(false)
    expect(makeCalendarEvent.input.safeParse({ from: 'now' }).success).toBe(false)
    expect(makeCalendarEvent.input.safeParse({}).success).toBe(false)
  })

  it('builds an .ics and Google link for the recommended window, allowed for anonymous users', async () => {
    const ctx = makeCtx()
    const rec = await recommendWindow.handler(ctx, REC_INPUT)
    const out = await makeCalendarEvent.handler(ctx, { from: 'last_recommendation', label: 'EV charge' })
    makeCalendarEvent.output.parse(out)
    const compact = (iso: string): string => iso.replace(/[-:]/g, '')
    expect(out.start_utc).toBe(rec.best_start_utc)
    expect(Date.parse(out.end_utc) - Date.parse(out.start_utc)).toBe(3 * HOUR)
    expect(out.ics).toContain(`DTSTART:${compact(rec.best_start_utc)}`)
    expect(out.ics).toContain(`DTEND:${compact(out.end_utc)}`)
    expect(out.ics).toContain('SUMMARY:EV charge')
    expect(out.ics).toContain('BEGIN:VEVENT')
    expect(out.ics.replace(/\r\n /g, '')).toMatch(/estimated emissions difference/i)
    expect(out.ics.replace(/\r\n /g, '')).toMatch(/average \(not marginal\)/)
    expect(out.ics).not.toMatch(/saved|avoided/i)
    expect(out.google_url).toContain(`dates=${compact(rec.best_start_utc)}%2F${compact(out.end_utc)}`)
    expect(out.start_london).toMatch(/BST/)
    const again = await makeCalendarEvent.handler(ctx, { from: 'last_recommendation', label: 'EV charge' })
    expect(again.ics).toBe(out.ics) // stable uid
    const a = toAction('make_calendar_event', out)
    expect(actionEventSchema.parse(a)).toMatchObject({ kind: 'calendar', start_utc: out.start_utc, ics: out.ics })
    expect(makeCalendarEvent.auth).toBe('anon')
  })

  it('states the grams from the same range estimate_co2 uses', async () => {
    const ctx = makeCtx()
    await recommendWindow.handler(ctx, REC_INPUT)
    const r = co2Range(ctx.turn.lastRecommendation!.rec)!
    const out = await makeCalendarEvent.handler(ctx, { from: 'last_recommendation' })
    const text = out.ics.replace(/\r\n /g, '')
    if (r.point === 0) expect(text).toMatch(/no estimated emissions difference/)
    else expect(text).toContain(fmtMass(r.point))
  })
})

describe('schedule_reminder', () => {
  const sub = { userId: 'u1', endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' }

  it('refuses anonymous callers and missing recommendations', async () => {
    const { plans } = userCtx()
    await expect(scheduleReminder.handler(makeCtx({ plans }), { from: 'last_recommendation', lead_min: 10 })).rejects.toMatchObject({ code: 'sign_in_required' })
    await expect(scheduleReminder.handler(userCtx().ctx, { from: 'last_recommendation', lead_min: 10 })).rejects.toMatchObject({ code: 'no_recommendation' })
  })

  it('returns push_needed (not an error) without a subscription', async () => {
    const { ctx, plans } = userCtx()
    await recommendWindow.handler(ctx, REC_INPUT)
    const out = await scheduleReminder.handler(ctx, { from: 'last_recommendation', lead_min: 10 })
    expect(out.status).toBe('push_needed')
    expect(plans.reminders).toHaveLength(0)
    expect(toAction('schedule_reminder', out)).toEqual({ kind: 'push_needed' })
  })

  it('adds a reminder lead_min before the start', async () => {
    const { ctx, plans } = userCtx()
    await plans.savePushSubscription(sub)
    const rec = await recommendWindow.handler(ctx, { ...REC_INPUT, earliest_local: '2026-10-06T06:00' })
    const out = await scheduleReminder.handler(ctx, { from: 'last_recommendation', lead_min: 30 })
    scheduleReminder.output.parse(out)
    expect(out.status).toBe('set')
    expect(plans.reminders).toHaveLength(1)
    const r = plans.reminders[0]!
    expect(Date.parse(r.sendAtUtc)).toBe(Date.parse(rec.best_start_utc) - 30 * 60_000)
    expect(r.payload).toMatchObject({ url: '/scheduler', startUtc: rec.best_start_utc })
    expect(r.userId).toBe('u1')
    const a = toAction('schedule_reminder', out)
    expect(actionEventSchema.parse(a)).toEqual({ kind: 'reminder_set', reminder_id: r.id, send_at_utc: r.sendAtUtc, start_utc: rec.best_start_utc })
  })

  it('refuses a start in the past and bad lead times', async () => {
    const { ctx, plans } = userCtx()
    await plans.savePushSubscription(sub)
    await recommendWindow.handler(ctx, REC_INPUT)
    const late = { ...ctx, nowMs: Date.parse(ctx.turn.lastRecommendation!.rec.bestStart) + HOUR }
    await expect(scheduleReminder.handler(late, { from: 'last_recommendation', lead_min: 10 })).rejects.toMatchObject({ code: 'start_in_past' })
    expect(scheduleReminder.input.safeParse({ from: 'last_recommendation', lead_min: 121 }).success).toBe(false)
    expect(scheduleReminder.input.safeParse({ from: 'last_recommendation', lead_min: -1 }).success).toBe(false)
    expect(scheduleReminder.input.safeParse({ from: 'last_recommendation' }).success).toBe(true)
  })
})

describe('registration', () => {
  it('registers the P4 tools with the right auth, flags and intents', () => {
    const by = new Map(TOOLS.map((t) => [t.name, t]))
    for (const n of ['plan_batch', 'save_recurring_plan', 'list_plans', 'cancel_plan', 'make_calendar_event', 'schedule_reminder']) {
      const t = by.get(n)
      expect(t?.phase).toBe('P4')
      expect(t?.statusText.length).toBeGreaterThan(5)
    }
    expect(by.get('plan_batch')).toMatchObject({ auth: 'anon', sideEffect: false, intents: ['plan_batch'] })
    expect(by.get('save_recurring_plan')).toMatchObject({ auth: 'user', sideEffect: true, emitsAction: true, intents: ['recurring'] })
    expect(by.get('list_plans')).toMatchObject({ auth: 'user', intents: ['recurring', 'plan_job'] })
    expect(by.get('cancel_plan')).toMatchObject({ auth: 'user', sideEffect: true })
    expect(by.get('make_calendar_event')).toMatchObject({ auth: 'anon', emitsAction: true, intents: ['plan_job', 'plan_batch', 'recurring'] })
    expect(by.get('schedule_reminder')).toMatchObject({ auth: 'user', sideEffect: true, emitsAction: true, intents: ['plan_job', 'recurring'] })
  })

  it('toAction ignores other tools and malformed outputs', () => {
    expect(toAction('recommend_window', {})).toBeNull()
    expect(toAction('make_calendar_event', { nope: 1 })).toBeNull()
  })
})
