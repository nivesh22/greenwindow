import { z } from 'zod'
import { loadConfig } from '../config.js'
import type { ForecastSource } from '../data/types.js'
import { CircuitBreaker } from '../providers/breaker.js'
import { AllProvidersFailed, ModelRouter, type RouteEntry } from '../providers/router.js'
import { ev, providerError, ScriptedProvider, type ScriptStep } from '../providers/scripted.js'
import { MemoryStore } from '../store/types.js'
import { CO2_WORDING } from '../tools/estimate_co2.js'
import { defineTool, ToolRegistry, type ToolDef } from '../tools/registry.js'
import type { ChatRequest, SseEvent, StopReason, TraceSummary } from './events.js'
import { ANSWER_A, J1_TOOLS, J1_USER } from './grounding.fixtures.js'
import { checkGrounding } from './grounding.js'
import { buildRouter, createTurnRunner, NO_RELIABLE_ANSWER, STOP_MESSAGES, templatedAnswer } from './turn.js'

const NOW = Date.parse('2026-10-08T20:30:00Z')

const noData: ForecastSource = {
  meta: () => Promise.reject(new Error('no data in turn tests')),
  latest: () => Promise.reject(new Error('no data in turn tests')),
  observations: () => Promise.reject(new Error('no data in turn tests')),
  leaderboard: () => Promise.reject(new Error('no data in turn tests')),
  backtest: () => Promise.reject(new Error('no data in turn tests')),
}

/** Fake tools that return the J1 outputs, under the real tool names (the templated answer looks them up by name). */
function fixedTool(name: string, data: unknown, input: z.ZodType = z.strictObject({})): ToolDef {
  return defineTool({
    name, description: name, statusText: '…', auth: 'anon', sideEffect: false, phase: 'P1', intents: 'all',
    input, output: z.record(z.string(), z.unknown()),
    handler: async () => data as Record<string, unknown>,
  })
}
const dataOf = (tool: string): unknown => J1_TOOLS.find((t) => t.tool === tool)?.data
const hang = defineTool({
  name: 'hang', description: '', statusText: '…', auth: 'anon', sideEffect: false, phase: 'P1', intents: 'all',
  input: z.strictObject({}), output: z.object({}),
  handler: (ctx) => new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))),
})
const REGISTRY = new ToolRegistry([
  fixedTool('lookup_device', dataOf('lookup_device')),
  fixedTool('recommend_window', dataOf('recommend_window'), z.strictObject({ duration_h: z.number() })),
  fixedTool('estimate_co2', dataOf('estimate_co2')),
  hang,
])

const TOOL_STEP: ScriptStep = [
  ev.call('lookup_device', {}, 'c1'),
  ev.call('recommend_window', { duration_h: 6 }, 'c2'),
  ev.call('estimate_co2', {}, 'c3'),
  ev.finish('tool_calls'),
]
const say = (text: string): ScriptStep => [ev.text(text), ev.usage(500, 60), ev.finish()]

interface Run {
  events: SseEvent[]
  answer: string
  stop: StopReason
  trace: TraceSummary
  provider: ScriptedProvider
  store: MemoryStore
}

async function run(
  script: ScriptStep[],
  opts: { env?: Record<string, string>; message?: string; signal?: AbortSignal; model?: string; router?: ModelRouter } = {},
): Promise<Run> {
  const provider = new ScriptedProvider(script)
  const router =
    opts.router ??
    new ModelRouter([{ provider, model: opts.model ?? 'gemini-3.8-flash' }], {
      retry: { maxRetries: 0, random: () => 0.5, sleep: async () => undefined, now: () => 0 },
    })
  const store = new MemoryStore()
  let id = 0
  const runner = createTurnRunner({
    config: loadConfig({ TOOL_TIMEOUT_MS: '200', ...opts.env }),
    store, data: noData, registry: REGISTRY, router, newId: () => `id${++id}`,
  })
  const request: ChatRequest = {
    conversation_id: null, message: opts.message ?? J1_USER[0]!, history: [], panel_state: null, client_now_utc: '2026-10-08T20:30:00Z',
  }
  const events: SseEvent[] = []
  await runner({ request, ipHash: 'h', nowMs: NOW, signal: opts.signal ?? new AbortController().signal }, (e) => void events.push(e))
  const answer = events.find((e) => e.type === 'answer')
  const done = events.find((e) => e.type === 'done')
  if (answer?.type !== 'answer' || done?.type !== 'done') throw new Error('turn did not send answer and done')
  return { events, answer: answer.data.text, stop: done.data.stop_reason, trace: done.data.trace, provider, store }
}

const gates = (r: Run) => r.trace.gates.map((g) => [g.gate, g.choice, g.source])
const groundingSpan = (r: Run) => r.store.spans.find((s) => s.kind === 'gate' && s.name === 'grounding')

describe('turn: grounding gate', () => {
  it('pass: a grounded answer is sent as is', async () => {
    const r = await run([TOOL_STEP, say(ANSWER_A)])
    expect(r.answer).toBe(ANSWER_A)
    expect(r.stop).toBe('final')
    expect(gates(r)).toEqual([['grounding', 'pass', 'rules']])
    expect(r.events.filter((e) => e.type === 'answer')).toHaveLength(1)
    expect(r.store.turns[0]?.stopReason).toBe('final')
  })

  it('regenerated: a wrong time triggers one rewrite with toolChoice none; the fixed answer is sent', async () => {
    const wrong = ANSWER_A.replace('01:00 BST', '02:00 BST')
    const r = await run([TOOL_STEP, say(wrong), say(ANSWER_A)])
    expect(r.answer).toBe(ANSWER_A)
    expect(r.stop).toBe('final')
    expect(gates(r)).toEqual([['grounding', 'regenerated', 'rules']])
    expect(r.provider.calls).toBe(3)
    const rewrite = r.provider.requests[2]!
    expect(rewrite.toolChoice).toBe('none')
    const last = rewrite.messages.at(-1)!
    expect(last.role).toBe('user')
    expect(last.content).toContain('not in the tool results: "02:00 BST"')
    expect(last.content).toContain('keeping the required caveat')
    expect(rewrite.messages.at(-2)).toEqual({ role: 'assistant', content: wrong })
    expect(groundingSpan(r)?.attrs['gw.gate.violations']).toEqual([{ kind: 'ungrounded_number', match: '02:00 BST' }])
    expect(r.trace.totals.steps).toBe(3)
    expect(r.trace.llm_calls).toHaveLength(3)
  })

  it('templated: the rewrite still fails, so the answer is built from the tool outputs and the stop is guard_blocked', async () => {
    const r = await run([TOOL_STEP, say(ANSWER_A.replace('185 g', '190 g')), say('You saved 185 g of CO2!')])
    expect(r.stop).toBe('guard_blocked')
    expect(gates(r)).toEqual([['grounding', 'templated', 'rules']])
    expect(r.answer).toBe(templatedAnswer(J1_TOOLS))
    expect(r.answer).toContain('Fri 9 Oct, 01:00 BST')
    expect(r.answer).toContain('not robust to forecast error')
    expect(r.answer).toContain('185 g (range -2.6 kg to 2.9 kg)')
    expect(r.answer).toContain(CO2_WORDING.caveat)
    expect(checkGrounding({ text: r.answer, toolResults: J1_TOOLS, userTexts: [] })).toEqual({ ok: true, violations: [] })
    expect(groundingSpan(r)?.attrs['gw.gate.violations_retry']).toContainEqual({ kind: 'banned_claim', match: 'You saved' })
    expect(r.store.turns[0]?.stopReason).toBe('guard_blocked')
  })

  it('templated without a recommendation: the generic message', async () => {
    const r = await run([say('Run it at 3am.'), say('Run it at 4am.')], { message: 'When should I run my dishwasher?' })
    expect(r.stop).toBe('guard_blocked')
    expect(r.answer).toBe(NO_RELIABLE_ANSWER)
  })

  it('templated when the budget leaves no step for the rewrite', async () => {
    const r = await run([TOOL_STEP, say(ANSWER_A.replace('01:00 BST', '05:00 BST'))], { env: { MAX_STEPS: '2' } })
    expect(r.provider.calls).toBe(2)
    expect(r.stop).toBe('guard_blocked')
    expect(r.answer).toBe(templatedAnswer(J1_TOOLS))
  })

  it('numbers the user wrote are allowed (current message and history)', async () => {
    const r = await run([say('With 22 kW done by 06:30, I need to check the forecast first.')], { message: 'I have a 22 kW charger, done by 06:30' })
    expect(gates(r)).toEqual([['grounding', 'pass', 'rules']])
  })

  it('templatedAnswer: robust wording and no CO2 part without estimate_co2', () => {
    const rec = { tool: 'recommend_window', ok: true, data: { ...(dataOf('recommend_window') as object), robust: true } }
    expect(templatedAnswer([rec])).toBe('The best time to start is Fri 9 Oct, 01:00 BST. This recommendation is robust to forecast error.')
    expect(templatedAnswer([{ ...rec, ok: false }])).toBe(NO_RELIABLE_ANSWER)
  })
})

describe('turn: stop reasons', () => {
  it('final with no text: the generic message, no gate span', async () => {
    const r = await run([[ev.finish()]])
    expect(r.stop).toBe('final')
    expect(r.answer).toBe(STOP_MESSAGES.tool_error)
    expect(r.trace.gates).toEqual([])
  })

  it('provider_down: every provider failed', async () => {
    const r = await run([providerError('server', { status: 503 })])
    expect(r.stop).toBe('provider_down')
    expect(r.answer).toBe('The assistant is unavailable right now. The planner form on this page still works.')
    expect(r.store.turns[0]?.stopReason).toBe('provider_down')
  })

  it('provider_down: the breaker is open for every entry, so nothing is sent', async () => {
    const provider = new ScriptedProvider([])
    const entry: RouteEntry = { provider, model: 'gemini-3.8-flash' }
    const breaker = new CircuitBreaker({ threshold: 1 })
    breaker.onFailure(entry)
    const router = new ModelRouter([entry], { hooks: breaker })
    const r = await run([], { router })
    expect(r.stop).toBe('provider_down')
    expect(provider.calls).toBe(0)
    expect(r.trace.llm_calls).toEqual([])
  })

  it('max_steps', async () => {
    const r = await run([TOOL_STEP], { env: { MAX_STEPS: '1' } })
    expect(r.stop).toBe('max_steps')
    expect(r.answer).toBe(STOP_MESSAGES.max_steps)
  })

  it('token_budget: a cut-off answer keeps grounded partial text and adds the stop line', async () => {
    const r = await run([TOOL_STEP, [ev.text('The best time to start is Fri 9 Oct, 01:00 BST and'), ev.finish('length')]])
    expect(r.stop).toBe('token_budget')
    expect(r.answer).toBe(`The best time to start is Fri 9 Oct, 01:00 BST and\n\n${STOP_MESSAGES.token_budget}`)
    expect(gates(r)).toEqual([['grounding', 'pass', 'rules']])
  })

  it('token_budget: ungrounded partial text is dropped, never shown', async () => {
    const r = await run([TOOL_STEP, [ev.text('Start at 05:00 BST, which'), ev.finish('length')]])
    expect(r.stop).toBe('token_budget')
    expect(r.answer).toBe(STOP_MESSAGES.token_budget)
    expect(gates(r)).toEqual([['grounding', 'templated', 'rules']])
  })

  it('cost_budget', async () => {
    const r = await run([say('hi')], { model: 'unpriced-model', env: { MAX_TURN_COST_USD: '0.000001' } })
    expect(r.stop).toBe('cost_budget')
    expect(r.answer).toBe(STOP_MESSAGES.cost_budget)
  })

  it('wall_clock: the request was aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await run([say('hi')], { signal: ctrl.signal })
    expect(r.stop).toBe('wall_clock')
    expect(r.answer).toBe(STOP_MESSAGES.wall_clock)
  })

  it('wall_clock: a tool hangs past the turn deadline', async () => {
    const r = await run([[ev.call('hang', {}), ev.finish('tool_calls')]], { env: { TURN_WALL_MS: '50', TOOL_TIMEOUT_MS: '1000' } })
    expect(r.stop).toBe('wall_clock')
  })

  it('tool_error: two invalid calls to the same tool', async () => {
    const bad = (): ScriptStep => [ev.call('recommend_window', { duration_h: 'six' }), ev.finish('tool_calls')]
    const r = await run([bad(), bad()])
    expect(r.stop).toBe('tool_error')
    expect(r.answer).toBe(STOP_MESSAGES.tool_error)
  })
})

describe('buildRouter', () => {
  it('wires the breaker: with every entry open, no request is sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'))
    try {
      const breaker = new CircuitBreaker({ threshold: 1 })
      const router = buildRouter(loadConfig({ GEMINI_API_KEY: 'test-key', MODEL_ROUTE: 'gemini-direct:m1,gemini-direct:m2' }), breaker)
      for (const e of router.entries) breaker.onFailure(e)
      const err = await router.complete({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10, temperature: 0 }, new AbortController().signal).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AllProvidersFailed)
      expect((err as AllProvidersFailed).calls.map((c) => [c.model, c.attempts])).toEqual([['m1', 0], ['m2', 0]])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('skips entries whose provider has no key', () => {
    const router = buildRouter(loadConfig({ GEMINI_API_KEY: 'k', MODEL_ROUTE: 'gemini-direct:m1,ai-gateway:m2' }), new CircuitBreaker())
    expect(router.models).toEqual(['m1'])
  })
})
