import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FixtureForecastSource } from '../../agent/data/forecast_source.js'
import { MemoryStore } from '../../agent/store/types.js'
import { buildRegistry } from '../../agent/tools/index.js'
import { optimizerRef } from '../assertions.js'
import { FIXTURE_DIR, SCENARIOS_DIR, loadScenarios } from '../runner.js'

const scenarios = loadScenarios()

describe('scenario files', () => {
  it('all parse, with unique ids matching their file names', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(48)
    const ids = scenarios.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json')).sort()).toEqual(ids.map((i) => `${i}.json`).sort())
  })

  it('has the planned mix of personas', () => {
    const n = (p: string) => scenarios.filter((s) => s.persona === p).length
    expect(n('household')).toBeGreaterThanOrEqual(14)
    expect(n('developer')).toBeGreaterThanOrEqual(9)
    expect(n('business')).toBeGreaterThanOrEqual(5)
    expect(n('accuracy')).toBeGreaterThanOrEqual(5)
    expect(n('injection')).toBeGreaterThanOrEqual(5)
    expect(n('offtopic')).toBeGreaterThanOrEqual(4)
    expect(n('edge')).toBeGreaterThanOrEqual(4)
  })

  it('only names tools that exist, or the insight tools being built in parallel', () => {
    const known = new Set([...buildRegistry().forIntent(null).map((t) => t.name), 'get_leaderboard', 'get_backtest', 'compare_models'])
    for (const s of scenarios) {
      for (const t of s.turns) {
        for (const n of [...(t.expect.tools_called ?? []), ...(t.expect.tool_not_called ?? [])]) expect(known.has(n), `${s.id}: ${n}`).toBe(true)
      }
    }
  })

  it('every window_equals_optimizer case is feasible on the fixture (so a failure means the agent is wrong)', async () => {
    const withWindow = scenarios.flatMap((s) => s.turns.map((t) => ({ s, w: t.expect.window_equals_optimizer }))).filter((x) => x.w)
    expect(withWindow.length).toBeGreaterThanOrEqual(15)
    for (const { s, w } of withWindow) {
      const nowMs = Date.parse(s.now_utc)
      const ref = optimizerRef(() => ({
        userId: null, isAnonymous: true, nowMs, store: new MemoryStore(), riskMode: 'expected', turn: { lastRecommendation: null },
        data: new FixtureForecastSource(FIXTURE_DIR, () => nowMs), signal: new AbortController().signal,
      }))
      if (!w) continue
      const out = await ref(w)
      expect(out.best_start_utc, s.id).toMatch(/Z$/)
    }
  })
})
