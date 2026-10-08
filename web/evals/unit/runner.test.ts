import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../agent/config.js'
import { ModelRouter } from '../../agent/providers/router.js'
import { ev, ScriptedProvider, type ScriptStep } from '../../agent/providers/scripted.js'
import { STALE_MESSAGE, loadRecording, requestFingerprint } from '../recording.js'
import { markdownSummary, parseMode, runScenario, runSuite, verdictOf, type SuiteResult } from '../runner.js'
import { scenarioSchema, type Scenario, type ScenarioResult } from '../schema.js'

const dir = mkdtempSync(join(tmpdir(), 'gw-evals-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const config = loadConfig({})
const scenario = (over: Partial<Scenario> & { user?: string; expect?: Scenario['turns'][number]['expect'] } = {}): Scenario =>
  scenarioSchema.parse({
    id: over.id ?? 'unit-ev',
    persona: 'household',
    turns: [
      {
        user: over.user ?? 'Charge my EV, 7 kW for 4 hours, ready by 8am.',
        expect: over.expect ?? {
          tools_called: ['recommend_window', 'estimate_co2'],
          window_equals_optimizer: { duration_h: 4, power_kw: 7, deadline_local: '2026-10-06T08:00', mode: 'expected' },
          contains_caveat: true,
          no_banned_claim: true,
          max_steps: 4,
        },
      },
    ],
  })

const REC: ScriptStep = [ev.call('recommend_window', { duration_h: 4, power_kw: 7, deadline_local: '2026-10-06T08:00' }, 'c1'), ev.usage(900, 40), ev.finish('tool_calls')]
const CO2: ScriptStep = [ev.call('estimate_co2', {}, 'c2'), ev.usage(1000, 10), ev.finish('tool_calls')]

/** Router whose last step reads the London time out of the tool message, like a real model would. */
function scriptedRouter(): ModelRouter {
  const provider = new (class extends ScriptedProvider {
    override async *complete(req: Parameters<ScriptedProvider['complete']>[0], signal: AbortSignal) {
      if (this.calls === 0) this.push(REC)
      else if (this.calls === 1) this.push(CO2)
      else {
        const rec = req.messages.filter((m) => m.role === 'tool').map((m) => m.content).find((c) => c.includes('best_start_london'))
        const london = (JSON.parse(rec ?? '{}') as { data?: { best_start_london?: string } }).data?.best_start_london ?? 'unknown'
        this.push([ev.text(`The best time to start is ${london}. This is an estimate based on average grid intensity.`), ev.usage(1200, 40), ev.finish()])
      }
      yield* super.complete(req, signal)
    }
  })()
  return new ModelRouter([{ provider, model: 'gemini-3.5-flash' }])
}

describe('runner modes', () => {
  it('record then replay passes with identical results; recordings are written per scenario', async () => {
    const s = scenario()
    const rec = await runScenario(s, { mode: 'record', recordingsDir: dir, config, makeRouter: scriptedRouter })
    expect(rec.note).toBe('')
    expect(rec.status).toBe('passed')
    const saved = loadRecording(dir, s.id)
    expect(saved?.turns[0]?.model_calls).toHaveLength(3)

    const replay = await runScenario(s, { mode: 'replay', recordingsDir: dir })
    expect(replay.status, replay.note).toBe('passed')
    expect(replay.turns[0]?.answer).toBe(rec.turns[0]?.answer)
    expect(replay.turns[0]?.assertions.every((a) => a.status === 'pass')).toBe(true)
  })

  it('replay with no recording is skipped, not passed', async () => {
    const r = await runScenario(scenario({ id: 'unit-missing' }), { mode: 'replay', recordingsDir: dir })
    expect(r.status).toBe('skipped')
    expect(r.note).toBe('skipped (no recording)')
  })

  it('replay fails with "recording stale" when the request changed', async () => {
    await runScenario(scenario({ id: 'unit-stale' }), { mode: 'record', recordingsDir: dir, config, makeRouter: scriptedRouter })
    const changed = scenario({ id: 'unit-stale', user: 'Charge my EV, 7 kW for 4 hours, ready by 9am.' })
    const r = await runScenario(changed, { mode: 'replay', recordingsDir: dir })
    expect(r.status).toBe('failed')
    expect(r.note).toContain(STALE_MESSAGE)
    expect(r.note).toContain('re-record with EVAL_MODE=record')
  })

  it('replay fails when the recording has a different number of turns', async () => {
    const two = scenarioSchema.parse({ ...scenario({ id: 'unit-ev' }), turns: [...scenario().turns, ...scenario().turns] })
    const r = await runScenario(two, { mode: 'replay', recordingsDir: dir })
    expect(r.status).toBe('failed')
    expect(r.note).toContain(STALE_MESSAGE)
  })

  it('a wrong answer fails its assertions (a broken prompt would fail the suite)', async () => {
    const s = scenario({ id: 'unit-wrong', expect: { stop_reason: 'final', no_banned_claim: true } })
    const wrongRouter = (): ModelRouter => {
      const p = new ScriptedProvider([REC, CO2, [ev.text('You saved CO2 by charging at 3:17 am.'), ev.usage(1000, 20), ev.finish()]])
      return new ModelRouter([{ provider: p, model: 'gemini-3.5-flash' }])
    }
    const r = await runScenario(s, { mode: 'record', recordingsDir: dir, config, makeRouter: wrongRouter })
    expect(r.status).toBe('failed')
    // The harness's grounding gate replaces the banned wording with a templated answer, so the stop reason is the tell.
    expect(r.note).toContain('stop_reason')
  })

  it('live mode stops at the spend cap', async () => {
    const spend = { limitUsd: 0, spentUsd: 0 }
    const r = await runScenario(scenario({ id: 'unit-live' }), { mode: 'live', config, makeRouter: scriptedRouter, spend })
    expect(r.status).toBe('skipped')
    expect(r.note).toContain('EVAL_BUDGET_USD')
    expect(verdictOf({ mode: 'live', results: [r] }).ok).toBe(false)
  })
})

describe('verdict and report', () => {
  const res = (id: string, status: ScenarioResult['status'], extra: Partial<ScenarioResult> = {}): ScenarioResult => ({
    id, persona: 'household', status, note: '', cost_usd: 0, turns: [], ...extra,
  })
  const turn = (name: string, status: 'pass' | 'fail', banned = 0) => ({
    user: '', answer: '', stop_reason: 'final', cost_usd: 0, steps: 1, tools: [], banned_claims: banned, trace: null,
    assertions: [{ name, status, detail: '' }],
  })

  it('passes at >= 90% with perfect windows and no banned claims', () => {
    const results = [...Array.from({ length: 9 }, (_, i) => res(`p${i}`, 'passed')), res('f', 'failed'), res('s', 'skipped')]
    const v = verdictOf({ mode: 'replay', results })
    expect(v).toMatchObject({ ok: true, passed: 9, failed: 1, skipped: 1, overall: 0.9 })
  })

  it('fails below 90%, on a wrong window, or on any banned claim', () => {
    const low = verdictOf({ mode: 'replay', results: [res('a', 'passed'), res('b', 'failed')] })
    expect(low.ok).toBe(false)
    const win = verdictOf({ mode: 'replay', results: [res('a', 'passed', { turns: [turn('window_equals_optimizer', 'fail')] })] })
    expect(win.reasons.join()).toContain('window correctness')
    const banned = verdictOf({ mode: 'replay', results: [res('a', 'passed', { turns: [turn('x', 'pass', 1)] })] })
    expect(banned.reasons.join()).toContain('banned claim')
  })

  it('nothing ran: ok by default (all skipped), failing when recordings are required', () => {
    const suite: SuiteResult = { mode: 'replay', results: [res('a', 'skipped')] }
    expect(verdictOf(suite).ok).toBe(true)
    expect(verdictOf(suite, { requireRecordings: true }).ok).toBe(false)
  })

  it('summary lists every scenario', async () => {
    const suite = await runSuite([scenario({ id: 'unit-none' })], { mode: 'replay', recordingsDir: dir })
    expect(markdownSummary(suite, verdictOf(suite))).toContain('| unit-none | household | skipped |')
  })

  it('parses EVAL_MODE', () => {
    expect(parseMode(undefined)).toBe('replay')
    expect(parseMode('record')).toBe('record')
    expect(() => parseMode('nope')).toThrow()
  })

  it('fingerprints ignore the model id but not the messages', () => {
    const base = { messages: [{ role: 'user' as const, content: 'a' }] }
    expect(requestFingerprint(base)).toBe(requestFingerprint({ ...base }))
    expect(requestFingerprint(base)).not.toBe(requestFingerprint({ messages: [{ role: 'user', content: 'b' }] }))
  })
})
