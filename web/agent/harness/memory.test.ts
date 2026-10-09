import type { Msg } from '../providers/types.js'
import type { StoredMessage } from '../store/user_types.js'
import { estimateMessagesTokens } from './budget.js'
import { J1_TOOLS } from './grounding.fixtures.js'
import { clipWords, fitHistory, impactRow, profileBlock, resolveRiskMode, summaryPlan } from './memory.js'

const msgs = (n: number): StoredMessage[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, conversationId: 'c', role: i % 2 ? 'assistant' : 'user', content: `${i}`, turnId: null, createdAtUtc: '2026-10-08T20:00:00Z' }))

describe('summaryPlan', () => {
  it('nothing due at or below the trigger', () => {
    expect(summaryPlan(msgs(16), null, 16, 8)).toBeNull()
  })
  it('covers all but the last 8 once more than 16 are unsummarized', () => {
    const p = summaryPlan(msgs(18), null, 16, 8)
    expect(p?.cover.map((m) => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`))
    expect(p?.uptoMessageId).toBe('m9')
  })
  it('counts only messages after the newest summary', () => {
    expect(summaryPlan(msgs(26), { uptoMessageId: 'm9' }, 16, 8)).toBeNull() // 16 newer
    expect(summaryPlan(msgs(28), { uptoMessageId: 'm9' }, 16, 8)?.cover.map((m) => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 10}`))
  })
  it('a summary older than the scanned window counts as stale', () => {
    expect(summaryPlan(msgs(18), { uptoMessageId: 'gone' }, 16, 8)?.uptoMessageId).toBe('m9')
  })
})

describe('resolveRiskMode', () => {
  const panel = (mode: 'expected' | 'cautious', edited: boolean) => ({
    duration_h: null, power_kw: null, earliest_utc: null, deadline_utc: null, mode, model: null, edited_by_user: edited,
  })
  it('no profile: gate, then panel, then expected (pre-P3 behaviour)', () => {
    expect(resolveRiskMode({ message: 'x', panel: panel('cautious', true), profileDefault: null, gate: 'expected' }).source).toBe('gate')
    expect(resolveRiskMode({ message: 'x', panel: panel('cautious', false), profileDefault: null, gate: null }).mode).toBe('cautious')
    expect(resolveRiskMode({ message: 'x', panel: null, profileDefault: null, gate: null })).toEqual({ mode: 'expected', source: 'default' })
  })
  it('with a profile: explicit > edited panel > profile default > gate', () => {
    const base = { panel: panel('expected', true), profileDefault: 'cautious' as const, gate: 'expected' as const }
    expect(resolveRiskMode({ ...base, message: 'use cautious mode' })).toEqual({ mode: 'cautious', source: 'explicit' })
    expect(resolveRiskMode({ ...base, message: 'x' })).toEqual({ mode: 'expected', source: 'panel_edited' })
    expect(resolveRiskMode({ ...base, panel: panel('expected', false), message: 'x' })).toEqual({ mode: 'cautious', source: 'profile_default' })
  })
})

describe('fitHistory', () => {
  it('drops the oldest messages until the request fits, keeping system and user', () => {
    const system: Msg = { role: 'system', content: 's'.repeat(4000) }
    const user: Msg = { role: 'user', content: 'hi' }
    const history: Msg[] = Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `${i}`.repeat(4000) }))
    const kept = fitHistory(system, history, user, 5000)
    expect(estimateMessagesTokens([system, ...kept, user])).toBeLessThanOrEqual(5000)
    expect(kept).toEqual(history.slice(-3))
    expect(fitHistory(system, history, user, 100)).toEqual([])
  })
})

describe('profileBlock / impactRow / clipWords', () => {
  it('null when nothing is saved', () => {
    expect(profileBlock(null, [])).toBeNull()
  })
  it('devices only', () => {
    expect(profileBlock(null, [{ id: 'd', userId: 'u', name: 'Kiln', kw: 9, typicalHours: null, sourceDeviceId: null }])).toContain(
      '{"saved_devices":[{"name":"Kiln","kw":9,"typical_hours":null}]}',
    )
  })
  it('impact row from recommend_window followed by estimate_co2; none when the order is wrong', () => {
    const ids = { userId: 'u', conversationId: 'c', turnId: 't' }
    expect(impactRow(J1_TOOLS, ids)).toMatchObject({ windowStartUtc: '2026-10-09T00:00:00Z', estPointG: 185 })
    const [lookup, rec, co2] = J1_TOOLS
    expect(impactRow([lookup!, co2!, rec!], ids)).toBeNull()
    expect(impactRow([rec!, { ...co2!, ok: false }], ids)).toBeNull()
  })
  it('clipWords caps the summary length', () => {
    expect(clipWords('a b  c d', 2)).toBe('a b…')
    expect(clipWords('  a b ', 5)).toBe('a b')
  })
})
