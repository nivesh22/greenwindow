import { z } from 'zod'
import type { ForecastSource } from '../data/types.js'
import { ModelRouter } from '../providers/router.js'
import { ev, providerError, ScriptedProvider, type ScriptStep } from '../providers/scripted.js'
import type { Msg } from '../providers/types.js'
import { MemoryStore } from '../store/types.js'
import { ATTR, Tracer } from '../telemetry/tracer.js'
import { defineTool, ToolRegistry, ToolUserError, type ToolCtx, type ToolDef } from '../tools/registry.js'
import { Budget, type BudgetLimits } from './budget.js'
import type { PlanUpdate, SseEvent } from './events.js'
import { runLoop, type LoopOptions } from './loop.js'

const NOW = Date.parse('2026-10-06T00:30:00Z')

const noData: ForecastSource = {
  meta: () => Promise.reject(new Error('no data in loop tests')),
  latest: () => Promise.reject(new Error('no data in loop tests')),
  observations: () => Promise.reject(new Error('no data in loop tests')),
  leaderboard: () => Promise.reject(new Error('no data in loop tests')),
  backtest: () => Promise.reject(new Error('no data in loop tests')),
}

const base = { sideEffect: false, phase: 'P1' as const, intents: 'all' as const }
const echo = defineTool({
  ...base, name: 'echo', description: 'echo', statusText: 'Echoing…', auth: 'anon',
  input: z.strictObject({ x: z.number() }), output: z.object({ x: z.number() }),
  handler: async (_c, i) => {
    await new Promise((r) => setTimeout(r, 20))
    return { x: i.x }
  },
})
const order: string[] = []
const slowA = defineTool({
  ...base, name: 'slow_a', description: '', statusText: 'A…', auth: 'anon', input: z.strictObject({}), output: z.object({ v: z.string() }),
  handler: async () => {
    order.push('a:start')
    await new Promise((r) => setTimeout(r, 30))
    order.push('a:end')
    return { v: 'a' }
  },
})
const slowB = defineTool({
  ...base, name: 'slow_b', description: '', statusText: 'B…', auth: 'anon', input: z.strictObject({}), output: z.object({ v: z.string() }),
  handler: async () => {
    order.push('b:start')
    await new Promise((r) => setTimeout(r, 5))
    order.push('b:end')
    return { v: 'b' }
  },
})
const secret = defineTool({
  ...base, name: 'secret', description: '', statusText: '…', auth: 'user', input: z.strictObject({}), output: z.object({}),
  handler: async () => ({}),
})
const hang = defineTool({
  ...base, name: 'hang', description: '', statusText: '…', auth: 'anon', input: z.strictObject({}), output: z.object({}),
  handler: (ctx) => new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))),
})
const boom = defineTool({
  ...base, name: 'boom', description: '', statusText: '…', auth: 'anon', input: z.strictObject({}), output: z.object({}),
  handler: async () => {
    throw new Error('internal secret detail')
  },
})
const infeasible = defineTool({
  ...base, name: 'infeasible', description: '', statusText: '…', auth: 'anon', input: z.strictObject({}), output: z.object({}),
  handler: async () => {
    throw new ToolUserError('infeasible', 'The window is shorter than the job.')
  },
})
const badOut = defineTool({
  ...base, name: 'bad_out', description: '', statusText: '…', auth: 'anon', input: z.strictObject({}), output: z.object({ n: z.number() }),
  handler: async () => ({ n: 'not a number' }) as unknown as { n: number },
})
const PLAN: PlanUpdate = {
  duration_h: 3, power_kw: 7, earliest_utc: '2026-10-06T01:00:00Z', deadline_utc: '2026-10-06T12:00:00Z',
  mode: 'expected', model: 'blend_wx', best_start_utc: '2026-10-06T03:00:00Z', run_id: 'r1',
}
const recommend = defineTool({
  ...base, name: 'recommend', description: '', statusText: 'Planning…', auth: 'anon', emitsPlan: true,
  input: z.strictObject({}), output: z.object({ best: z.string() }),
  handler: async () => ({ best: PLAN.best_start_utc }),
})

const ALL: ToolDef[] = [echo, slowA, slowB, secret, hang, boom, infeasible, badOut, recommend]

interface Harness {
  opts: LoopOptions
  events: SseEvent[]
  provider: ScriptedProvider
  tracer: Tracer
  budget: Budget
}

function setup(script: ScriptStep[], over: Partial<LoopOptions> = {}, limits: Partial<BudgetLimits> = {}, model = 'gemini-3.8-flash'): Harness {
  const provider = new ScriptedProvider(script)
  const router = new ModelRouter([{ provider, model }], {
    retry: { maxRetries: 2, random: () => 0.5, sleep: async () => undefined, now: () => 0 },
  })
  const budget = new Budget({ maxSteps: 6, maxInputTokens: 40_000, maxOutputTokens: 800, maxCostUsd: 0.01, wallMs: 45_000, ...limits })
  let id = 0
  const tracer = new Tracer({ turnId: 't1', newId: () => `s${++id}` })
  const events: SseEvent[] = []
  const registry = new ToolRegistry(ALL)
  const ctx: ToolCtx = {
    userId: null, isAnonymous: true, nowMs: NOW, data: noData, store: new MemoryStore(), riskMode: 'expected',
    turn: { lastRecommendation: null }, signal: budget.signal,
  }
  const opts: LoopOptions = {
    router, registry, tools: ALL, ctx, budget, tracer, emit: (e) => void events.push(e), toolTimeoutMs: 50, ...over,
  }
  return { opts, events, provider, tracer, budget }
}

const user: Msg[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }]
const toolMsgs = (msgs: Msg[]): unknown[] => msgs.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))

describe('runLoop', () => {
  let h: Harness
  afterEach(() => h.budget.dispose())

  it('final: buffers the text and emits no answer event', async () => {
    h = setup([[ev.text('Run it '), ev.text('at 03:00.'), ev.usage(100, 5), ev.finish()]])
    const r = await runLoop(user, h.opts)
    expect(r).toMatchObject({ text: 'Run it at 03:00.', stopReason: 'final', steps: 1, detail: null })
    expect(r.messages.at(-1)).toEqual({ role: 'assistant', content: 'Run it at 03:00.' })
    expect(h.events).toEqual([])
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).toContain('echo')
    expect(h.provider.requests[0]?.maxOutputTokens).toBe(800)
    const llm = h.tracer.records().filter((s) => s.kind === 'llm')
    expect(llm).toHaveLength(1)
    expect(llm[0]).toMatchObject({ tokensIn: 100, tokensOut: 5, status: 'ok' })
    expect(llm[0]?.attrs[ATTR.usageEstimated]).toBe(false)
  })

  it('runs a tool and sends the wrapped result back to the model', async () => {
    h = setup([
      [ev.call('echo', { x: 7 }, 'c1'), ev.finish('tool_calls')],
      [ev.text('done'), ev.finish()],
    ])
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('final')
    expect(r.steps).toBe(2)
    expect(h.events.map((e) => e.type)).toEqual(['tool_start', 'tool_end'])
    expect(h.events[0]).toEqual({ type: 'tool_start', data: { call_id: 'c1', tool: 'echo', status_text: 'Echoing…' } })
    expect(h.events[1]).toMatchObject({ type: 'tool_end', data: { call_id: 'c1', tool: 'echo', ok: true, summary: 'ok' } })
    const second = h.provider.requests[1]?.messages ?? []
    expect(second.at(-2)).toEqual({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'echo', argsJson: '{"x":7}' }] })
    expect(second.at(-1)).toEqual({ role: 'tool', toolCallId: 'c1', content: '{"tool":"echo","ok":true,"data":{"x":7}}' })
  })

  it('runs the tool calls of one step in parallel, results in call order', async () => {
    order.length = 0
    h = setup([[ev.call('slow_a', {}, 'a'), ev.call('slow_b', {}, 'b'), ev.finish('tool_calls')], [ev.text('ok'), ev.finish()]])
    const r = await runLoop(user, h.opts)
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end'])
    expect(toolMsgs(r.messages)).toEqual([
      { tool: 'slow_a', ok: true, data: { v: 'a' } },
      { tool: 'slow_b', ok: true, data: { v: 'b' } },
    ])
  })

  it('unknown and not-offered tools get unknown_tool', async () => {
    h = setup([[ev.call('nope', {}), ev.call('boom', {}), ev.finish('tool_calls')], [ev.text('sorry'), ev.finish()]], { tools: [echo] })
    const r = await runLoop(user, h.opts)
    expect(toolMsgs(r.messages)).toEqual([
      { tool: 'nope', ok: false, error: { code: 'unknown_tool', message: 'There is no tool called "nope".' } },
      { tool: 'boom', ok: false, error: { code: 'unknown_tool', message: 'There is no tool called "boom".' } },
    ])
    expect(h.provider.requests[0]?.tools?.map((t) => t.name)).toEqual(['echo'])
  })

  it('auth: user tools return sign_in_required for anonymous users, without running', async () => {
    h = setup([[ev.call('secret', {}), ev.finish('tool_calls')], [ev.text('Please sign in.'), ev.finish()]])
    const r = await runLoop(user, h.opts)
    expect(toolMsgs(r.messages)).toEqual([{ tool: 'secret', ok: false, error: { code: 'sign_in_required', message: 'This needs the user to sign in first.' } }])
    expect(h.events).toEqual([])
    expect(r.stopReason).toBe('final')
  })

  it('repair: one invalid call is sent back with issues; the corrected call runs', async () => {
    h = setup([
      [ev.call('echo', { x: 'seven' }), ev.finish('tool_calls')],
      [ev.call('echo', { x: 7 }), ev.finish('tool_calls')],
      [ev.text('ok'), ev.finish()],
    ])
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('final')
    const [first, second] = toolMsgs(r.messages) as { ok: boolean; error?: { code: string; issues?: unknown } }[]
    expect(first).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    expect(first?.error?.issues).toBeDefined()
    expect(second).toMatchObject({ ok: true })
  })

  it('repair: invalid JSON counts as invalid_arguments', async () => {
    h = setup([[ev.call('echo', '{"x":'), ev.finish('tool_calls')], [ev.text('ok'), ev.finish()]])
    const r = await runLoop(user, h.opts)
    expect(toolMsgs(r.messages)[0]).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
  })

  it('tool_error: a second consecutive invalid call to the same tool stops the loop', async () => {
    h = setup([
      [ev.call('echo', { x: 'a' }), ev.finish('tool_calls')],
      [ev.call('echo', { y: 1 }), ev.finish('tool_calls')],
      [ev.text('never'), ev.finish()],
    ])
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('tool_error')
    expect(r.detail).toMatch(/echo/)
    expect(h.provider.calls).toBe(2)
  })

  it('empty arguments are treated as {}', async () => {
    h = setup([[ev.call('slow_b', ''), ev.finish('tool_calls')], [ev.text('ok'), ev.finish()]])
    const r = await runLoop(user, h.opts)
    expect(toolMsgs(r.messages)[0]).toMatchObject({ ok: true })
  })

  it('maps handler failures: ToolUserError message, generic error, timeout, invalid output', async () => {
    h = setup([
      [ev.call('infeasible', {}, 'i'), ev.call('boom', {}, 'b'), ev.call('hang', {}, 'h'), ev.call('bad_out', {}, 'o'), ev.finish('tool_calls')],
      [ev.text('ok'), ev.finish()],
    ])
    const r = await runLoop(user, h.opts)
    expect(toolMsgs(r.messages)).toEqual([
      { tool: 'infeasible', ok: false, error: { code: 'infeasible', message: 'The window is shorter than the job.' } },
      { tool: 'boom', ok: false, error: { code: 'tool_failed', message: 'The tool failed unexpectedly.' } },
      { tool: 'hang', ok: false, error: { code: 'timeout', message: 'The tool took too long to answer.' } },
      { tool: 'bad_out', ok: false, error: { code: 'invalid_output', message: 'The tool returned an unexpected result.' } },
    ])
    expect(JSON.stringify(r.messages)).not.toContain('internal secret detail')
    const ends = h.events.filter((e) => e.type === 'tool_end').map((e) => (e.type === 'tool_end' ? [e.data.tool, e.data.ok, e.data.summary] : null))
    expect(ends).toEqual(expect.arrayContaining([['boom', false, 'tool_failed'], ['hang', false, 'timeout']]))
    const toolSpans = h.tracer.records().filter((s) => s.kind === 'tool')
    expect(toolSpans.every((s) => s.status === 'error')).toBe(true)
  })

  it('emits plan_update for emitsPlan tools via toPlanUpdate, after tool_end', async () => {
    h = setup([[ev.call('recommend', {}), ev.finish('tool_calls')], [ev.text('ok'), ev.finish()]], {
      toPlanUpdate: (name, out) => (name === 'recommend' && (out as { best: string }).best === PLAN.best_start_utc ? PLAN : null),
      summarize: () => 'best 03:00',
    })
    await runLoop(user, h.opts)
    expect(h.events.map((e) => e.type)).toEqual(['tool_start', 'tool_end', 'plan_update'])
    expect(h.events[1]).toMatchObject({ data: { summary: 'best 03:00' } })
    expect(h.events[2]).toEqual({ type: 'plan_update', data: PLAN })
  })

  it('max_steps: stops before the step that would exceed the cap, returning the last text', async () => {
    h = setup(
      [
        [ev.text('thinking'), ev.call('echo', { x: 1 }), ev.finish('tool_calls')],
        [ev.call('echo', { x: 2 }), ev.finish('tool_calls')],
      ],
      {},
      { maxSteps: 2 },
    )
    const r = await runLoop(user, h.opts)
    expect(r).toMatchObject({ stopReason: 'max_steps', steps: 2, text: '' })
    expect(h.provider.calls).toBe(2)
  })

  it('token_budget: checked before the call, nothing is sent', async () => {
    h = setup([[ev.finish()]], {}, { maxInputTokens: 5 })
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('token_budget')
    expect(h.provider.calls).toBe(0)
  })

  it('a cut-off final answer (finish length) stops with token_budget, keeping the partial text', async () => {
    h = setup([[ev.text('Start at 01:00 because'), ev.finish('length')]])
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('token_budget')
    expect(r.text).toBe('Start at 01:00 because')
  })

  it('cost_budget: pre-call worst case on a paid model, nothing is sent', async () => {
    // 800 output tokens × $5/M = $0.004 > $0.003
    h = setup([[ev.finish()]], {}, { maxCostUsd: 0.003 }, 'test/worst-case-priced')
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('cost_budget')
    expect(h.provider.calls).toBe(0)
  })

  it('cost_budget: post-call actual stops before running tools', async () => {
    h = setup([[ev.call('echo', { x: 1 }), ev.usage(100, 900), ev.finish('tool_calls')]], {}, { maxCostUsd: 0.0045, maxOutputTokens: 100 }, 'test/worst-case-priced')
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('cost_budget')
    expect(h.events).toEqual([])
  })

  it('estimates usage when the provider sends none', async () => {
    h = setup([[ev.text('x'.repeat(40)), ev.finish()]])
    await runLoop(user, h.opts)
    const llm = h.tracer.records().find((s) => s.kind === 'llm')
    expect(llm?.attrs[ATTR.usageEstimated]).toBe(true)
    expect(llm?.tokensOut).toBe(10)
    expect(llm?.tokensIn).toBeGreaterThan(0)
    expect(h.budget.inputTokens).toBe(llm?.tokensIn)
  })

  it('wall_clock: a tool that hangs past the deadline ends the turn', async () => {
    h = setup([[ev.call('hang', {}), ev.finish('tool_calls')], [ev.finish()]], { toolTimeoutMs: 10_000 }, { wallMs: 30 })
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('wall_clock')
    expect(h.provider.calls).toBe(1)
  })

  it('provider_down: all entries failed; failed attempts are traced', async () => {
    h = setup([providerError('client', { status: 400 })])
    const r = await runLoop(user, h.opts)
    expect(r.stopReason).toBe('provider_down')
    const llm = h.tracer.records().filter((s) => s.kind === 'llm')
    expect(llm).toHaveLength(1)
    expect(llm[0]).toMatchObject({ status: 'error' })
  })

  it('failover inside a step is visible in the llm spans and the trace summary', async () => {
    const a = new ScriptedProvider([providerError('rate_limit', { status: 429 })], 'gemini-direct')
    const b = new ScriptedProvider([[ev.text('from fallback'), ev.usage(50, 5), ev.finish()]], 'ai-gateway')
    h = setup([])
    h.opts = { ...h.opts, router: new ModelRouter([{ provider: a, model: 'gemini-3.8-flash' }, { provider: b, model: 'anthropic/claude-haiku-5.5' }]) }
    const r = await runLoop(user, h.opts)
    expect(r).toMatchObject({ stopReason: 'final', text: 'from fallback' })
    const sum = h.tracer.summary({ promptVersion: 'v1', steps: r.steps })
    expect(sum.llm_calls.map((c) => [c.provider, c.failover])).toEqual([
      ['gemini-direct', false],
      ['ai-gateway', true],
    ])
    expect(h.tracer.records().find((s) => s.attrs[ATTR.failover] === true)?.attrs[ATTR.failoverReason]).toBe('rate_limit')
    expect(sum.totals.cost_usd).toBeGreaterThan(0)
  })

  it('does not mutate the input messages', async () => {
    h = setup([[ev.text('hi'), ev.finish()]])
    const input = [...user]
    await runLoop(input, h.opts)
    expect(input).toEqual(user)
  })

  it("toolChoice 'none': sends the tools with choice none and drops any tool call instead of running it", async () => {
    h = setup([[ev.text('Start at 03:00.'), ev.call('echo', { x: 1 }), ev.finish('tool_calls')]], { toolChoice: 'none' })
    const r = await runLoop(user, h.opts)
    expect(r).toMatchObject({ stopReason: 'final', text: 'Start at 03:00.', steps: 1 })
    expect(r.messages.at(-1)).toEqual({ role: 'assistant', content: 'Start at 03:00.' })
    expect(h.provider.requests[0]?.toolChoice).toBe('none')
    expect(h.events).toEqual([])
  })
})
