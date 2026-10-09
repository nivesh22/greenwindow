import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../agent/config.js'
import { ModelRouter } from '../../agent/providers/router.js'
import { ev, ScriptedProvider } from '../../agent/providers/scripted.js'
import { EVAL_USER_ID, loadScenarios, runScenario, seedWorld } from '../runner.js'
import { scenarioSchema, userBlockSchema } from '../schema.js'

const dir = mkdtempSync(join(tmpdir(), 'gw-evals-world-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const config = loadConfig({})
const NOW = Date.parse('2026-10-06T00:30:00Z')

describe('seedWorld', () => {
  it('anonymous (no user block) has no world', async () => {
    expect(await seedWorld(undefined, NOW)).toBeNull()
  })

  it('seeds profile, devices, push, plans and a realized ledger row', async () => {
    const user = userBlockSchema.parse({
      signed_in: true,
      profile: { risk_default: 'cautious', quiet_from: '23:00', quiet_to: '07:00' },
      devices: [{ name: 'dishwasher', kw: 1.2, typical_hours: 2 }],
      push_subscription: true,
      plans: [{ label: 'Compressor', days: ['mon'], window_from: '09:00', window_to: '17:00', duration_h: 3, power_kw: 5 }],
      impact: [{ window_start_utc: '2026-10-04T02:00:00Z', run_now_start_utc: '2026-10-03T18:00:00Z', duration_h: 4, energy_kwh: 28, est_point_g: 520, est_low_g: 300, est_high_g: 700, realized_g: 480 }],
    })
    const w = await seedWorld(user, NOW)
    expect(w?.auth).toEqual({ userId: EVAL_USER_ID, isAnonymous: false, email: null })
    expect(await w?.users.getProfile(EVAL_USER_ID)).toMatchObject({ riskDefault: 'cautious', quietFrom: '23:00' })
    expect(await w?.users.listDevices(EVAL_USER_ID)).toMatchObject([{ name: 'dishwasher', kw: 1.2, typicalHours: 2 }])
    expect(await w?.plans.listPushSubscriptions(EVAL_USER_ID)).toHaveLength(1)
    expect(await w?.plans.listPlans(EVAL_USER_ID, { activeOnly: true })).toMatchObject([{ label: 'Compressor', kind: 'recurring' }])
    expect(await w?.users.listImpact(EVAL_USER_ID, 10)).toMatchObject([{ estPointG: 520, realizedG: 480 }])
  })
})

describe('signed-in scenario run', () => {
  it('a scripted save_recurring_plan call reaches the seeded plan store and emits plan_saved', async () => {
    const s = scenarioSchema.parse({
      id: 'unit-recurring',
      persona: 'business',
      user: { signed_in: true },
      turns: [
        {
          user: 'Yes, save it: every weekday, 3 hours for my 5 kW compressor done by 5pm.',
          expect: {
            tools_called: ['save_recurring_plan'],
            tool_args: { save_recurring_plan: { confirm: true } },
            actions_emitted: ['plan_saved'],
            plans_saved: 1,
            reminders_created: 0,
          },
        },
      ],
    })
    const args = { label: 'Compressor', days: ['mon', 'tue', 'wed', 'thu', 'fri'], window_from: '09:00', window_to: '17:00', duration_h: 3, power_kw: 5, remind: false, confirm: true }
    const makeRouter = (): ModelRouter => {
      const p = new ScriptedProvider([
        [ev.call('save_recurring_plan', args, 'c1'), ev.usage(900, 40), ev.finish('tool_calls')],
        [ev.text('Saved your compressor plan for weekdays between 09:00 and 17:00.'), ev.usage(1000, 20), ev.finish()],
      ])
      return new ModelRouter([{ provider: p, model: 'gemini-3.5-flash' }])
    }
    const r = await runScenario(s, { mode: 'record', recordingsDir: dir, config, makeRouter })
    expect(r.status, r.note).toBe('passed')
  })

  it('the same scenario fails when the plan is not saved (anonymous caller)', async () => {
    const s = scenarioSchema.parse({
      id: 'unit-recurring-anon',
      persona: 'business',
      turns: [{ user: 'Save it: every weekday, 3 hours for my 5 kW compressor between 9am and 5pm.', expect: { plans_saved: 1 } }],
    })
    const makeRouter = (): ModelRouter => new ModelRouter([{ provider: new ScriptedProvider([[ev.text('Please sign in to save plans.'), ev.usage(900, 20), ev.finish()]]), model: 'gemini-3.5-flash' }])
    const r = await runScenario(s, { mode: 'record', recordingsDir: dir, config, makeRouter })
    expect(r.status).toBe('failed')
    expect(r.note).toContain('plans_saved')
  })
})

describe('P3/P4 scenario files', () => {
  const all = loadScenarios()
  it('cover J3-J7 and use only known user-block shapes', () => {
    const ids = all.map((s) => s.id)
    for (const id of [
      'business-three-kilns', 'business-batch-infeasible-member', 'user-recurring-confirm-then-save', 'user-recurring-anonymous', 'user-cancel-plan',
      'user-calendar-anonymous', 'user-reminder-with-push', 'user-reminder-no-push', 'user-profile-dishwasher', 'user-impact-ledger', 'user-profile-update-confirm',
    ]) expect(ids, id).toContain(id)
    expect(all.find((s) => s.id === 'business-three-cnc')?.turns[0]?.expect.tools_called).toEqual(['plan_batch'])
  })
})
