// Memory tools (design §7.4, PRD FR-4.11/4.12/FR-7.1/7.3): profile read/update and the impact ledger.
// All need a signed-in user (the loop already answers anonymous callers with sign_in_required; the handlers
// re-check so they are safe on their own). Realization is lazy (decision 2026-10-09): computed on read.
import { z } from 'zod'
import { HOUR_MS, toLocalInput } from '../../src/lib/time.js'
import type { Profile, UserStore } from '../store/user_types.js'
import { CO2_WORDING } from './estimate_co2.js'
import { defineTool, ToolUserError, type ToolCtx } from './registry.js'

const DAY_MS = 24 * HOUR_MS
const SETTLE_MS = 2 * HOUR_MS
const ACTUALS_WINDOW_MS = 7 * DAY_MS
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm, 24-hour, UK local time')

function need(ctx: ToolCtx): { users: UserStore; userId: string } {
  if (!ctx.users || !ctx.userId) throw new ToolUserError('sign_in_required', 'Sign in to use saved preferences and history.')
  return { users: ctx.users, userId: ctx.userId }
}

const profileOut = z.object({
  display_name: z.string().nullable(),
  risk_default: z.enum(['expected', 'cautious']),
  quiet_from: z.string().nullable(),
  quiet_to: z.string().nullable(),
  devices: z.array(z.object({ name: z.string(), kw: z.number(), typical_hours: z.number().nullable() })),
})

async function readProfile(users: UserStore, userId: string): Promise<z.infer<typeof profileOut>> {
  const [p, devs] = await Promise.all([users.getProfile(userId), users.listDevices(userId)])
  return {
    display_name: p?.displayName ?? null,
    risk_default: p?.riskDefault ?? 'expected',
    quiet_from: p?.quietFrom ?? null,
    quiet_to: p?.quietTo ?? null,
    devices: devs.map((d) => ({ name: d.name, kw: d.kw, typical_hours: d.typicalHours })),
  }
}

export const getProfile = defineTool({
  name: 'get_profile',
  description:
    "Returns the signed-in user's saved profile: display name, default risk mode (expected or cautious), quiet hours (UK local HH:mm) and saved devices " +
    '(name, kW, typical hours). Defaults are returned when nothing is saved. Use it to apply saved preferences or saved devices when planning.',
  input: z.strictObject({}),
  output: profileOut,
  auth: 'user',
  sideEffect: false,
  phase: 'P3',
  intents: ['profile_update', 'plan_job', 'plan_batch', 'recurring', 'impact_history'],
  statusText: 'Checking your saved settings…',
  async handler(ctx) {
    const { users, userId } = need(ctx)
    return readProfile(users, userId)
  },
})

export const updateProfile = defineTool({
  name: 'update_profile',
  description:
    "Changes the signed-in user's saved profile: display_name, risk_default (expected|cautious), quiet_from/quiet_to (HH:mm UK local), " +
    'save_device {name, kw, typical_hours?} (adds or updates a saved device by name) or delete_device (a saved device name). ' +
    'Only set confirm=true after the user has explicitly agreed to this exact change in the conversation; otherwise ask them first. ' +
    'Returns the updated profile.',
  input: z.strictObject({
    confirm: z.boolean(),
    display_name: z.string().trim().min(1).max(60).optional(),
    risk_default: z.enum(['expected', 'cautious']).optional(),
    quiet_from: hhmm.optional(),
    quiet_to: hhmm.optional(),
    save_device: z
      .strictObject({
        name: z.string().trim().min(1).max(60),
        kw: z.number().positive().max(1000),
        typical_hours: z.number().positive().max(48).optional(),
      })
      .optional(),
    delete_device: z.string().trim().min(1).max(60).optional(),
  }),
  output: profileOut,
  auth: 'user',
  sideEffect: true,
  phase: 'P3',
  intents: ['profile_update'],
  statusText: 'Saving your settings…',
  async handler(ctx, input) {
    const { users, userId } = need(ctx)
    if (input.confirm !== true) throw new ToolUserError('confirmation_required', 'Ask the user to confirm this change first.')
    let toDelete: string | null = null
    if (input.delete_device !== undefined) {
      const name = input.delete_device.toLowerCase()
      const found = (await users.listDevices(userId)).find((d) => d.name.toLowerCase() === name)
      if (!found) throw new ToolUserError('device_not_found', `No saved device named "${input.delete_device}".`)
      toDelete = found.id
    }
    if (input.display_name !== undefined || input.risk_default !== undefined || input.quiet_from !== undefined || input.quiet_to !== undefined) {
      const cur = await users.getProfile(userId)
      const next: Profile = {
        userId,
        displayName: input.display_name ?? cur?.displayName ?? null,
        riskDefault: input.risk_default ?? cur?.riskDefault ?? 'expected',
        quietFrom: input.quiet_from ?? cur?.quietFrom ?? null,
        quietTo: input.quiet_to ?? cur?.quietTo ?? null,
      }
      await users.upsertProfile(next)
    }
    const dev = input.save_device
    if (dev) {
      const existing = (await users.listDevices(userId)).find((d) => d.name === dev.name)
      await users.saveDevice({
        userId,
        name: dev.name,
        kw: dev.kw,
        typicalHours: dev.typical_hours ?? existing?.typicalHours ?? null,
        sourceDeviceId: existing?.sourceDeviceId ?? null,
      })
    }
    if (toDelete) await users.deleteDevice(userId, toDelete)
    return readProfile(users, userId)
  },
})

const status = z.enum(['realized', 'pending', 'unavailable'])
const impactOut = z.object({
  count: z.number(),
  planned: z.object({ count: z.number(), est_point_g: z.number(), est_low_g: z.number(), est_high_g: z.number() }),
  realized: z.object({ count: z.number(), realized_g: z.number(), pending: z.number(), unavailable: z.number() }),
  rows: z.array(
    z.object({
      window_start_london: z.string(),
      duration_h: z.number(),
      energy_kwh: z.number(),
      est_point_g: z.number(),
      realized_g: z.number().nullable(),
      status,
      note: z.string().nullable(),
    }),
  ),
  caveat: z.string(),
})

const IMPACT_CAVEAT =
  `${CO2_WORDING.caveat} "Realized" is computed from actual average (not marginal) grid intensity and assumes the user ran the job in the suggested window.`

/** Mean of ci_actual over `durationH` hours from `startMs`; null unless every hour has an actual. */
function avgActual(byTs: Map<number, number | null>, startMs: number, durationH: number): number | null {
  const n = Math.max(1, Math.ceil(durationH))
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = byTs.get(startMs + i * HOUR_MS)
    if (v === null || v === undefined) return null
    sum += v
  }
  return sum / n
}

export const getImpact = defineTool({
  name: 'get_impact',
  description:
    "Returns the signed-in user's history of recommendations they were given: the estimated difference in emissions (based on average grid intensity) " +
    'summed over their planned jobs with a low-to-high range, and, for windows that have finished, the realized difference from actual grid intensity. ' +
    'Rows show status realized, pending (window not finished or actuals not published yet) or unavailable (no actuals). ' +
    'Describe figures as "estimated difference", never as saved or avoided emissions, and mention the caveat.',
  input: z.strictObject({ limit: z.number().int().min(1).max(50).default(20) }),
  output: impactOut,
  auth: 'user',
  sideEffect: false,
  phase: 'P3',
  intents: ['impact_history'],
  statusText: 'Looking at your history…',
  async handler(ctx, input) {
    const { users, userId } = need(ctx)
    const rows = await users.listImpact(userId, input.limit)
    const endOf = (r: { windowStartUtc: string; durationH: number }): number => Date.parse(r.windowStartUtc) + r.durationH * HOUR_MS
    let byTs: Map<number, number | null> | null = null
    if (rows.some((r) => r.realizedG === null && r.realizedNote === null && endOf(r) + SETTLE_MS <= ctx.nowMs)) {
      const obs = await ctx.data.observations()
      byTs = new Map(obs.data.points.map((p) => [Date.parse(p.ts), p.ci_actual]))
    }
    const out: z.infer<typeof impactOut>['rows'] = []
    const sums = { point: 0, low: 0, high: 0, realized: 0, nReal: 0, pending: 0, unavailable: 0 }
    for (const r of rows) {
      let realizedG = r.realizedG
      let note = r.realizedNote
      const endMs = endOf(r)
      if (realizedG === null && note === null && byTs && endMs + SETTLE_MS <= ctx.nowMs) {
        const chosen = avgActual(byTs, Date.parse(r.windowStartUtc), r.durationH)
        const now = avgActual(byTs, Date.parse(r.runNowStartUtc), r.durationH)
        if (chosen !== null && now !== null) {
          realizedG = Math.round(r.energyKwh * (now - chosen))
          await users.setRealized(userId, r.id, realizedG, null, ctx.nowMs)
        } else if (ctx.nowMs - endMs > ACTUALS_WINDOW_MS) {
          note = 'no actuals'
          await users.setRealized(userId, r.id, null, note, ctx.nowMs)
        }
      }
      const st: z.infer<typeof status> = realizedG !== null ? 'realized' : note !== null ? 'unavailable' : 'pending'
      if (st === 'realized') {
        sums.realized += realizedG ?? 0
        sums.nReal++
      } else if (st === 'pending') sums.pending++
      else sums.unavailable++
      sums.point += r.estPointG
      sums.low += r.estLowG
      sums.high += r.estHighG
      out.push({
        window_start_london: toLocalInput(Date.parse(r.windowStartUtc)),
        duration_h: r.durationH,
        energy_kwh: r.energyKwh,
        est_point_g: Math.round(r.estPointG),
        realized_g: realizedG,
        status: st,
        note,
      })
    }
    return {
      count: rows.length,
      planned: { count: rows.length, est_point_g: Math.round(sums.point), est_low_g: Math.round(sums.low), est_high_g: Math.round(sums.high) },
      realized: { count: sums.nReal, realized_g: Math.round(sums.realized), pending: sums.pending, unavailable: sums.unavailable },
      rows: out,
      caveat: IMPACT_CAVEAT,
    }
  },
})
