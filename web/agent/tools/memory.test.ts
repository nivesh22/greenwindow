import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryUserStore, type NewImpactRow } from '../store/user_types.js'
import { buildRegistry } from './index.js'
import { getImpact, getProfile, updateProfile } from './memory.js'
import { ToolUserError } from './registry.js'
import { FIXTURE_DIR, makeCtx } from './testing.js'

const U = 'user-1'
const obs = JSON.parse(readFileSync(join(FIXTURE_DIR, 'recent_observations.json'), 'utf8')) as { points: { ts: string; ci_actual: number | null }[] }
const actual = (ts: string): number => obs.points.find((p) => p.ts === ts)!.ci_actual!
const avg = (start: string, h: number): number => {
  let s = 0
  for (let i = 0; i < h; i++) s += actual(new Date(Date.parse(start) + i * 3_600_000).toISOString().replace('.000Z', 'Z'))
  return s / h
}

function ctxFor(users = new MemoryUserStore()) {
  return { users, ctx: makeCtx({ users, userId: U, isAnonymous: false }) }
}

const row = (over: Partial<NewImpactRow>): NewImpactRow => ({
  userId: U, conversationId: null, turnId: null, windowStartUtc: '2026-10-05T10:00:00Z', runNowStartUtc: '2026-10-05T08:00:00Z',
  durationH: 2, energyKwh: 3, runId: 'r1', model: 'blend_wx', estPointG: 100.4, estLowG: -20.2, estHighG: 250.6, ...over,
})

describe('profile tools', () => {
  it('require users and userId', async () => {
    const c = makeCtx()
    await expect(getProfile.handler(c, {})).rejects.toMatchObject({ code: 'sign_in_required' })
    await expect(getImpact.handler(c, { limit: 20 })).rejects.toBeInstanceOf(ToolUserError)
    await expect(updateProfile.handler(c, { confirm: true })).rejects.toMatchObject({ code: 'sign_in_required' })
  })

  it('returns defaults, then updates only after confirm', async () => {
    const { users, ctx } = ctxFor()
    expect(await getProfile.handler(ctx, {})).toEqual({ display_name: null, risk_default: 'expected', quiet_from: null, quiet_to: null, devices: [] })
    await expect(updateProfile.handler(ctx, { confirm: false, risk_default: 'cautious' })).rejects.toMatchObject({ code: 'confirmation_required' })
    expect(users.profiles.size).toBe(0)
    const p = await updateProfile.handler(ctx, { confirm: true, risk_default: 'cautious', quiet_from: '23:00', quiet_to: '07:00', save_device: { name: 'EV', kw: 7, typical_hours: 6 } })
    expect(p).toMatchObject({ risk_default: 'cautious', quiet_from: '23:00', quiet_to: '07:00', devices: [{ name: 'EV', kw: 7, typical_hours: 6 }] })
    const p2 = await updateProfile.handler(ctx, { confirm: true, display_name: 'Sam' })
    expect(p2).toMatchObject({ display_name: 'Sam', risk_default: 'cautious', quiet_from: '23:00' })
    const p3 = await updateProfile.handler(ctx, { confirm: true, delete_device: 'ev' })
    expect(p3.devices).toEqual([])
    await expect(updateProfile.handler(ctx, { confirm: true, delete_device: 'nope' })).rejects.toMatchObject({ code: 'device_not_found' })
  })

  it('validates HH:mm and is user-scoped', async () => {
    expect(updateProfile.input.safeParse({ confirm: true, quiet_from: '25:00' }).success).toBe(false)
    expect(updateProfile.input.safeParse({ confirm: true, quiet_from: '7:00' }).success).toBe(false)
    const { users, ctx } = ctxFor()
    await users.saveDevice({ userId: 'other', name: 'Oven', kw: 2, typicalHours: null, sourceDeviceId: null })
    expect((await getProfile.handler(ctx, {})).devices).toEqual([])
  })
})

describe('get_impact', () => {
  it('lazily realizes finished windows, leaves recent ones pending, marks old ones unavailable', async () => {
    const { users, ctx } = ctxFor()
    const done = await users.addImpact(row({}))
    await users.addImpact(row({ windowStartUtc: '2026-10-05T22:00:00Z', runNowStartUtc: '2026-10-05T21:00:00Z', durationH: 1, energyKwh: 1 }))
    await users.addImpact(row({ windowStartUtc: '2026-09-20T10:00:00Z', runNowStartUtc: '2026-09-20T08:00:00Z' }))
    const out = await getImpact.handler(ctx, { limit: 20 })
    const expected = Math.round(3 * (avg('2026-10-05T08:00:00Z', 2) - avg('2026-10-05T10:00:00Z', 2)))
    const byStatus = Object.fromEntries(out.rows.map((r) => [r.status, r]))
    expect(byStatus.realized!.realized_g).toBe(expected)
    expect(byStatus.pending!.realized_g).toBeNull()
    expect(byStatus.unavailable).toMatchObject({ realized_g: null, note: 'no actuals' })
    expect(out.realized).toEqual({ count: 1, realized_g: expected, pending: 1, unavailable: 1 })
    expect(out.planned).toEqual({ count: 3, est_point_g: 301, est_low_g: -61, est_high_g: 752 })
    expect(byStatus.realized!.window_start_london).toBe('2026-10-05T11:00') // BST
    expect(users.impact.find((r) => r.id === done.id)!.realizedG).toBe(expected)
    expect(users.impact.find((r) => r.realizedNote === 'no actuals')).toBeTruthy()
    expect((await getImpact.handler(ctx, { limit: 20 })).realized.realized_g).toBe(expected)
  })

  it('uses the CO2 wording and never says saved', async () => {
    const { users, ctx } = ctxFor()
    await users.addImpact(row({}))
    const out = await getImpact.handler(ctx, { limit: 5 })
    expect(out.caveat).toContain('estimated difference')
    expect(out.caveat).toContain('marginal')
    expect(JSON.stringify(out)).not.toMatch(/saved|avoided/i)
    expect(getImpact.input.safeParse({ limit: 51 }).success).toBe(false)
    expect(getImpact.input.parse({}).limit).toBe(20)
  })

  it('registers with auth user and intents', () => {
    const reg = buildRegistry()
    expect(reg.get('update_profile')).toMatchObject({ auth: 'user', sideEffect: true, intents: ['profile_update'] })
    expect(reg.get('get_impact')).toMatchObject({ auth: 'user', intents: ['impact_history'] })
    expect(reg.forIntent('impact_history').map((t) => t.name)).toEqual(['get_forecast', 'lookup_device', 'get_profile', 'get_impact'])
  })
})
