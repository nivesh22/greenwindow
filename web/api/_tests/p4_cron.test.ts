import { describe, expect, it } from 'vitest'
import type { NewPlan } from '../../agent/store/plan_types.js'
import { secretsEqual } from '../_lib/cron.js'
import { CRON_SECRET, cronReq, errCode, makeDeps, NOW, OTHER, USER } from '../_lib/p4_testing.js'
import { addDays, computeStarts, londonDate, weekdayOf } from '../_lib/recurring.js'
import { avgActual, NO_ACTUALS_NOTE, realize } from '../_lib/ledger.js'
import { createLedgerCronHandler } from '../_routes/cron_ledger.js'
import { createRecurringCronHandler } from '../_routes/cron_recurring.js'
import { BUDGET_MS, createRemindersCronHandler, processReminders } from '../_routes/cron_reminders.js'

const HOUR = 3_600_000
const payload = (startUtc: string) => ({ title: 'Time to run', body: 'Dishwasher', url: '/scheduler', startUtc })
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')

describe('cron secret (all three endpoints)', () => {
  const cases = [
    ['/api/cron/reminders', createRemindersCronHandler],
    ['/api/cron/recurring', createRecurringCronHandler],
    ['/api/cron/ledger', createLedgerCronHandler],
  ] as const

  for (const [path, create] of cases) {
    it(`${path}: 405 for GET, 503 when CRON_SECRET is unset, 401 on missing or wrong secret, 200 on match`, async () => {
      const { deps } = makeDeps()
      const h = create(deps)
      expect((await h(cronReq(path, CRON_SECRET, 'GET'))).status).toBe(405)
      const missing = await h(cronReq(path, null))
      expect(missing.status).toBe(401)
      expect(await errCode(missing)).toBe('unauthorized')
      expect((await h(cronReq(path, 'wrong'))).status).toBe(401)
      expect((await h(cronReq(path, CRON_SECRET + 'x'))).status).toBe(401)
      expect((await h(cronReq(path, CRON_SECRET.slice(0, -1)))).status).toBe(401)
      expect((await create({ ...deps, env: {} })(cronReq(path))).status).toBe(503)
      expect((await create({ ...deps, env: { CRON_SECRET: '' } })(cronReq(path, ''))).status).toBe(503)
      const ok = await h(cronReq(path))
      expect(ok.status).toBe(200)
      expect(((await ok.json()) as { ok: boolean }).ok).toBe(true)
    })
  }

  it('secretsEqual is exact', async () => {
    expect(await secretsEqual('abc', 'abc')).toBe(true)
    expect(await secretsEqual('abc', 'abd')).toBe(false)
    expect(await secretsEqual('abc', 'abcd')).toBe(false)
    expect(await secretsEqual('', 'a')).toBe(false)
  })
})

describe('POST /api/cron/reminders', () => {
  async function seed(opts: { subs?: string[]; startOffsetMs?: number } = {}) {
    const ctx = makeDeps()
    for (const e of opts.subs ?? ['https://push.example/1']) await ctx.plans.savePushSubscription({ userId: USER, endpoint: e, p256dh: 'k', auth: 'a' })
    const r = await ctx.plans.addReminder({
      userId: USER,
      planId: null,
      sendAtUtc: iso(NOW - 60_000),
      payload: payload(iso(NOW + (opts.startOffsetMs ?? 10 * 60_000))),
    })
    return { ...ctx, reminderId: r.id }
  }

  it('503 when VAPID is not configured', async () => {
    const { deps } = makeDeps({ push: null })
    const r = await createRemindersCronHandler(deps)(cronReq('/api/cron/reminders'))
    expect(r.status).toBe(503)
    expect(await errCode(r)).toBe('not_configured')
  })

  it('sends the payload to every subscription of the reminder owner and marks it sent', async () => {
    const { deps, plans, pushCalls } = await seed({ subs: ['https://push.example/1', 'https://push.example/2'] })
    await plans.savePushSubscription({ userId: OTHER, endpoint: 'https://push.example/other', p256dh: 'k', auth: 'a' })
    const r = await createRemindersCronHandler(deps)(cronReq('/api/cron/reminders'))
    expect(await r.json()).toMatchObject({ ok: true, due: 1, sent: 1, failed: 0 })
    expect(pushCalls.map((c) => c.target.endpoint)).toEqual(['https://push.example/1', 'https://push.example/2'])
    expect(pushCalls[0]!.target.keys).toEqual({ p256dh: 'k', auth: 'a' })
    expect(JSON.parse(pushCalls[0]!.payload)).toEqual(payload(iso(NOW + 10 * 60_000)))
    expect(plans.reminders[0]).toMatchObject({ status: 'sent', attempts: 1, sentAtUtc: iso(NOW) })
    // Nothing is due any more: a second tick sends nothing.
    pushCalls.length = 0
    expect(await (await createRemindersCronHandler(deps)(cronReq('/api/cron/reminders'))).json()).toMatchObject({ due: 0, sent: 0 })
    expect(pushCalls).toHaveLength(0)
  })

  it('404 and 410 remove the subscription; no working subscription marks the reminder failed', async () => {
    const gone = { statusCode: 410 }
    const missing = { statusCode: 404 }
    const { deps, plans } = await seed({ subs: ['https://push.example/1', 'https://push.example/2'] })
    const ctx = makeDeps({ pushErrors: { 'https://push.example/1': gone, 'https://push.example/2': missing } })
    // Reuse the seeded stores with the failing sender.
    const sum = await processReminders({ plans, now: deps.now }, ctx.deps.push!)
    expect(sum).toMatchObject({ due: 1, sent: 0, failed: 1, subscriptionsRemoved: 2 })
    expect(plans.subs).toHaveLength(0)
    expect(plans.reminders[0]!.status).toBe('failed')
  })

  it('a transient error keeps the subscription; one good subscription is enough to count as sent', async () => {
    const seeded = await seed({ subs: ['https://push.example/1', 'https://push.example/2'] })
    const flaky = makeDeps({ pushErrors: { 'https://push.example/1': { statusCode: 500 } } })
    const sum = await processReminders({ plans: seeded.plans, now: seeded.deps.now }, flaky.deps.push!)
    expect(sum).toMatchObject({ sent: 1, failed: 0, subscriptionsRemoved: 0 })
    expect(seeded.plans.subs).toHaveLength(2)

    const allBad = await seed()
    const bad = makeDeps({ pushErrors: { 'https://push.example/1': new Error('network') } })
    const s2 = await processReminders({ plans: allBad.plans, now: allBad.deps.now }, bad.deps.push!)
    expect(s2).toMatchObject({ sent: 0, failed: 1, subscriptionsRemoved: 0 })
    expect(allBad.plans.subs).toHaveLength(1)
  })

  it('a reminder whose start has passed is cancelled, not sent; a user without subscriptions fails', async () => {
    const stale = await seed({ startOffsetMs: -60_000 })
    expect(await processReminders({ plans: stale.plans, now: stale.deps.now }, stale.deps.push!)).toMatchObject({ cancelled: 1, sent: 0 })
    expect(stale.pushCalls).toHaveLength(0)
    expect(stale.plans.reminders[0]!.status).toBe('cancelled')

    const nosub = await seed({ subs: [] })
    expect(await processReminders({ plans: nosub.plans, now: nosub.deps.now }, nosub.deps.push!)).toMatchObject({ failed: 1 })
    expect(nosub.plans.reminders[0]!.status).toBe('failed')
  })

  it('does not process reminders that are not yet due', async () => {
    const { deps, plans, pushCalls } = makeDeps()
    await plans.savePushSubscription({ userId: USER, endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' })
    await plans.addReminder({ userId: USER, planId: null, sendAtUtc: iso(NOW + 5 * 60_000), payload: payload(iso(NOW + 15 * 60_000)) })
    expect(await (await createRemindersCronHandler(deps)(cronReq('/api/cron/reminders'))).json()).toMatchObject({ due: 0 })
    expect(pushCalls).toHaveLength(0)
  })

  it('stops starting new sends after the time budget and leaves the rest pending', async () => {
    const { plans, pushCalls } = makeDeps()
    await plans.savePushSubscription({ userId: USER, endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' })
    for (let i = 0; i < 3; i++) {
      await plans.addReminder({ userId: USER, planId: null, sendAtUtc: iso(NOW - (3 - i) * 60_000), payload: payload(iso(NOW + 3_600_000 + i)) })
    }
    let t = NOW
    const clock = () => {
      const v = t
      t += BUDGET_MS / 2 + 1 // each clock read advances time
      return v
    }
    const sum = await processReminders({ plans, now: clock }, async (target, p) => void pushCalls.push({ target, payload: p }))
    expect(sum.due).toBe(3)
    expect(sum.sent).toBeLessThan(3)
    expect(sum.deferred).toBeGreaterThan(0)
    expect(plans.reminders.filter((r) => r.status === 'pending')).toHaveLength(sum.deferred)
  })
})

describe('recurring helpers', () => {
  const hours = (fromIso: string, n: number, f: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => {
      const v = f(i)
      return { ts: iso(Date.parse(fromIso) + i * HOUR), q10: v - 10, q50: v, q90: v + 10 }
    })

  it('date helpers', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(weekdayOf('2026-10-06')).toBe('tue')
    expect(weekdayOf('2026-10-11')).toBe('sun')
    expect(londonDate(Date.UTC(2026, 9, 6, 23, 30))).toBe('2026-10-07') // 00:30 BST next day
    expect(londonDate(Date.UTC(2026, 10, 6, 23, 30))).toBe('2026-11-06') // GMT
  })

  const job = { durationH: 2, powerKw: 1, mode: 'expected' as const }
  const rule = (days: ('mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun')[], from = '20:00', to = '23:00') => ({ days, windowLocal: { from, to }, remind: true })
  // Forecast 2026-10-06T00:00Z .. 2026-10-07T23:00Z (48 h). Cheapest hours are 21:00-22:00Z each day.
  const fc = hours('2026-10-06T00:00:00Z', 48, (i) => (i % 24 === 21 || i % 24 === 22 ? 50 : 200))

  it('picks the cheapest start inside the London window for each matching day, ascending', () => {
    const starts = computeStarts({ job, rule: rule(['tue', 'wed']) }, fc, NOW)
    // Window 20:00-23:00 BST = 19:00-22:00Z; a 2 h job: starts 19:00, 20:00 (21:00Z-22:00Z is only 1 h inside, so not 21:00).
    expect(starts).toEqual(['2026-10-06T20:00:00Z', '2026-10-07T20:00:00Z'])
  })

  it('weekday filter: only matching days; none when nothing matches', () => {
    expect(computeStarts({ job, rule: rule(['wed']) }, fc, NOW)).toEqual(['2026-10-07T20:00:00Z'])
    expect(computeStarts({ job, rule: rule(['thu', 'sat']) }, fc, NOW)).toEqual([])
  })

  it('never schedules a window that ends beyond the forecast horizon', () => {
    // Now = Wed 10:00Z; tomorrow (Thu) is outside the 48 h forecast.
    const now = Date.UTC(2026, 9, 7, 10)
    expect(computeStarts({ job, rule: rule(['thu']) }, fc, now)).toEqual([])
    expect(computeStarts({ job, rule: rule(['wed', 'thu']) }, fc, now)).toEqual(['2026-10-07T20:00:00Z'])
    // Window reaching past the last forecast hour (2026-10-08T00:00Z exclusive) is skipped entirely.
    expect(computeStarts({ job, rule: rule(['wed'], '22:00', '23:59') }, hours('2026-10-06T00:00:00Z', 47, () => 100), now)).toEqual([])
  })

  it('a window already under way is clipped to the next whole hour; a finished window is skipped', () => {
    const now = Date.UTC(2026, 9, 6, 19, 20) // Tue 20:20 BST, inside the window
    expect(computeStarts({ job, rule: rule(['tue']) }, fc, now)).toEqual(['2026-10-06T20:00:00Z'])
    const late = Date.UTC(2026, 9, 6, 21, 30) // 30 minutes of window left, the job needs 2 h
    expect(computeStarts({ job, rule: rule(['tue']) }, fc, late)).toEqual([])
    expect(computeStarts({ job, rule: rule(['tue']) }, fc, Date.UTC(2026, 9, 6, 22, 30))).toEqual([])
  })

  it('a job longer than the window, a missing rule or an empty forecast give no start', () => {
    expect(computeStarts({ job: { ...job, durationH: 4 }, rule: rule(['tue']) }, fc, NOW)).toEqual([])
    expect(computeStarts({ job, rule: null }, fc, NOW)).toEqual([])
    expect(computeStarts({ job, rule: rule(['tue']) }, [], NOW)).toEqual([])
  })

  it('cautious mode compares q90, expected compares q50', () => {
    // q50 lowest at 19:00Z, but q90 spike there; cautious avoids it.
    const f = hours('2026-10-06T00:00:00Z', 48, () => 200).map((h, i) => (i === 19 || i === 20 ? { ...h, q50: 50, q90: 400 } : i === 21 ? { ...h, q50: 80, q90: 90 } : h))
    expect(computeStarts({ job: { ...job, durationH: 1 }, rule: rule(['tue']) }, f, NOW)).toEqual(['2026-10-06T19:00:00Z'])
    expect(computeStarts({ job: { ...job, durationH: 1, mode: 'cautious' }, rule: rule(['tue']) }, f, NOW)).toEqual(['2026-10-06T21:00:00Z'])
  })
})

describe('POST /api/cron/recurring', () => {
  const plan = (over: Partial<NewPlan> = {}): NewPlan => ({
    userId: USER,
    label: 'Washing',
    kind: 'recurring',
    job: { durationH: 2, powerKw: 2, mode: 'expected' },
    rule: { days: ['tue', 'wed'], windowLocal: { from: '20:00', to: '23:00' }, remind: true },
    nextStartUtc: null,
    nextRunId: null,
    ...over,
  })

  it('sets next_start from the newest forecast and adds one idempotent reminder at start - 10 min', async () => {
    const { deps, plans } = makeDeps()
    await plans.savePushSubscription({ userId: USER, endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' })
    const p = await plans.createPlan(plan())
    const h = createRecurringCronHandler(deps)
    const r = await h(cronReq('/api/cron/recurring'))
    const body = (await r.json()) as Record<string, unknown>
    expect(body).toMatchObject({ ok: true, plans: 1, updated: 1, withStart: 1, remindersAdded: 1, errors: 0 })
    const stored = plans.plans.find((x) => x.id === p.id)!
    expect(stored.nextStartUtc).not.toBeNull()
    expect(stored.nextRunId).toBe('20261006T00')
    const start = Date.parse(stored.nextStartUtc!)
    expect(start).toBeGreaterThanOrEqual(NOW)
    expect(plans.reminders).toHaveLength(1)
    expect(plans.reminders[0]).toMatchObject({ planId: p.id, userId: USER, status: 'pending', sendAtUtc: iso(start - 10 * 60_000), payload: { startUtc: stored.nextStartUtc, url: '/scheduler' } })
    // Running again changes nothing.
    expect(await (await h(cronReq('/api/cron/recurring'))).json()).toMatchObject({ remindersAdded: 0 })
    expect(plans.reminders).toHaveLength(1)
  })

  it('no reminder without remind=true or without a push subscription; still sets next_start', async () => {
    const { deps, plans } = makeDeps()
    await plans.createPlan(plan({ userId: OTHER })) // remind but no subscription
    await plans.savePushSubscription({ userId: USER, endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' })
    await plans.createPlan(plan({ rule: { days: ['tue'], windowLocal: { from: '20:00', to: '23:00' }, remind: false } }))
    const r = await createRecurringCronHandler(deps)(cronReq('/api/cron/recurring'))
    expect(await r.json()).toMatchObject({ plans: 2, withStart: 2, remindersAdded: 0 })
    expect(plans.reminders).toHaveLength(0)
    expect(plans.plans.every((p) => p.nextStartUtc !== null)).toBe(true)
  })

  it('clears next_start when no day qualifies and ignores once and cancelled plans', async () => {
    const { deps, plans } = makeDeps()
    const stale = await plans.createPlan(plan({ rule: { days: ['sat'], windowLocal: { from: '20:00', to: '23:00' }, remind: true }, nextStartUtc: '2026-10-01T20:00:00Z', nextRunId: 'old' }))
    const cancelled = await plans.createPlan(plan())
    await plans.cancelPlan(USER, cancelled.id)
    await plans.createPlan({ ...plan(), kind: 'once', rule: null })
    expect(await (await createRecurringCronHandler(deps)(cronReq('/api/cron/recurring'))).json()).toMatchObject({ plans: 1, updated: 1, withStart: 0 })
    expect(plans.plans.find((p) => p.id === stale.id)).toMatchObject({ nextStartUtc: null, nextRunId: null })
    expect(plans.plans.find((p) => p.id === cancelled.id)!.nextStartUtc).toBeNull()
  })

  it('one reminder per plan and London day even if the forecast moves the start', async () => {
    const { deps, plans } = makeDeps()
    const p = await plans.createPlan(plan())
    await plans.savePushSubscription({ userId: USER, endpoint: 'https://push.example/1', p256dh: 'k', auth: 'a' })
    await plans.addReminder({ userId: USER, planId: p.id, sendAtUtc: '2026-10-06T21:00:00Z', payload: payload('2026-10-06T21:10:00Z') })
    const sum = await createRecurringCronHandler(deps)(cronReq('/api/cron/recurring'))
    expect(await sum.json()).toMatchObject({ remindersAdded: 0 })
    expect(plans.reminders).toHaveLength(1)
  })

  it('no plans: 200 without touching the forecast; failing forecast: 503', async () => {
    const empty = makeDeps()
    expect(await (await createRecurringCronHandler(empty.deps)(cronReq('/api/cron/recurring'))).json()).toMatchObject({ plans: 0, forecastRun: null })
    const { deps, plans } = makeDeps()
    await plans.createPlan(plan())
    deps.data.latest = async () => {
      throw new Error('github down')
    }
    const r = await createRecurringCronHandler(deps)(cronReq('/api/cron/recurring'))
    expect(r.status).toBe(503)
    expect(await errCode(r)).toBe('upstream_unavailable')
  })
})

describe('ledger realization', () => {
  const row = (over: Partial<Parameters<typeof realize>[0]> = {}) => ({
    id: 'i1',
    userId: USER,
    windowStartUtc: '2026-10-05T02:00:00Z',
    runNowStartUtc: '2026-10-05T00:00:00Z',
    durationH: 2,
    energyKwh: 2,
    ...over,
  })
  const byTs = (entries: [string, number | null][]) => new Map(entries.map(([t, v]) => [Date.parse(t), v]))
  const actuals = byTs([
    ['2026-10-05T00:00:00Z', 200],
    ['2026-10-05T01:00:00Z', 180],
    ['2026-10-05T02:00:00Z', 100],
    ['2026-10-05T03:00:00Z', 80],
  ])

  it('avgActual needs every hour', () => {
    expect(avgActual(actuals, Date.parse('2026-10-05T00:00:00Z'), 2)).toBe(190)
    expect(avgActual(actuals, Date.parse('2026-10-05T03:00:00Z'), 2)).toBeNull()
    expect(avgActual(byTs([['2026-10-05T00:00:00Z', null]]), Date.parse('2026-10-05T00:00:00Z'), 1)).toBeNull()
  })

  it('realized = energy x (run-now actual avg - chosen actual avg), after a 2 h settle time', () => {
    const end = Date.parse('2026-10-05T04:00:00Z')
    expect(realize(row(), actuals, end + 2 * HOUR)).toEqual({ kind: 'realized', grams: Math.round(2 * (190 - 90)) })
    expect(realize(row(), actuals, end + 2 * HOUR - 1)).toEqual({ kind: 'pending' })
  })

  it('missing actuals stay pending for 7 days, then become unavailable', () => {
    const end = Date.parse('2026-10-05T04:00:00Z')
    const none = new Map<number, number | null>()
    expect(realize(row(), none, end + 3 * HOUR)).toEqual({ kind: 'pending' })
    expect(realize(row(), none, end + 7 * 24 * HOUR)).toEqual({ kind: 'pending' })
    expect(realize(row(), none, end + 7 * 24 * HOUR + 1)).toEqual({ kind: 'unavailable' })
  })

  it('a negative difference is kept (the run-now window was cleaner)', () => {
    const flipped = byTs([
      ['2026-10-05T00:00:00Z', 50],
      ['2026-10-05T01:00:00Z', 50],
      ['2026-10-05T02:00:00Z', 100],
      ['2026-10-05T03:00:00Z', 100],
    ])
    expect(realize(row(), flipped, Date.parse('2026-10-05T07:00:00Z'))).toEqual({ kind: 'realized', grams: -100 })
  })
})

describe('POST /api/cron/ledger', () => {
  // Fixture observations: hourly actuals 2026-09-29T00:00Z .. 2026-10-05T23:00Z. NOW is 2026-10-06T00:30Z.
  const add = (ledger: ReturnType<typeof makeDeps>['ledger'], id: string, windowStartUtc: string, runNowStartUtc: string, userId = USER) =>
    ledger.rows.push({ id, userId, windowStartUtc, runNowStartUtc, durationH: 2, energyKwh: 1.5, realizedG: null, note: null })

  it('realizes finished windows with actuals, leaves recent ones, and notes old rows without actuals', async () => {
    const { deps, ledger } = makeDeps()
    add(ledger, 'done', '2026-10-05T10:00:00Z', '2026-10-05T08:00:00Z')
    add(ledger, 'recent', '2026-10-05T22:00:00Z', '2026-10-05T20:00:00Z') // started < 3 h ago: not even listed
    add(ledger, 'future', '2026-10-06T05:00:00Z', '2026-10-06T03:00:00Z')
    add(ledger, 'ancient', '2026-09-01T10:00:00Z', '2026-09-01T08:00:00Z') // no actuals in the file, > 7 days
    add(ledger, 'young-noactuals', '2026-09-29T00:00:00Z', '2026-09-28T22:00:00Z') // run-now hours precede the file; window ended < 7 days ago
    const r = await createLedgerCronHandler(deps)(cronReq('/api/cron/ledger'))
    expect(await r.json()).toMatchObject({ ok: true, checked: 3, realized: 1, unavailable: 1, pending: 1, errors: 0 })
    const by = Object.fromEntries(ledger.rows.map((x) => [x.id, x]))
    expect(typeof by.done!.realizedG).toBe('number')
    expect(by.done!.note).toBeNull()
    expect(by.recent).toMatchObject({ realizedG: null, note: null })
    expect(by.future).toMatchObject({ realizedG: null, note: null })
    expect(by.ancient).toMatchObject({ realizedG: null, note: NO_ACTUALS_NOTE })
    expect(by['young-noactuals']).toMatchObject({ realizedG: null, note: null })
    // Idempotent: the realized and noted rows are not picked up again.
    expect(await (await createLedgerCronHandler(deps)(cronReq('/api/cron/ledger'))).json()).toMatchObject({ checked: 1, realized: 0, unavailable: 0 })
  })

  it('nothing pending: 200 and no forecast fetch; failing observations file: 503', async () => {
    const { deps, ledger } = makeDeps()
    deps.data.observations = async () => {
      throw new Error('should not be called')
    }
    expect(await (await createLedgerCronHandler(deps)(cronReq('/api/cron/ledger'))).json()).toMatchObject({ checked: 0 })
    add(ledger, 'done', '2026-10-05T10:00:00Z', '2026-10-05T08:00:00Z')
    const r = await createLedgerCronHandler(deps)(cronReq('/api/cron/ledger'))
    expect(r.status).toBe(503)
  })
})
