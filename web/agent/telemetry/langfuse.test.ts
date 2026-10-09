import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { LangfuseOtelSpanAttributes as A } from '@langfuse/tracing'
import { describe, expect, it } from 'vitest'
import type { TurnRecord } from '../store/types.js'
import {
  exporterFromEnv,
  forcedReason,
  LangfuseExporter,
  maskText,
  NOOP_EXPORTER,
  planObservations,
  sampleFraction,
  shouldExport,
  traceIdForTurn,
  type TurnExport,
} from './langfuse.js'
import { ATTR, Tracer } from './tracer.js'

const T0 = Date.parse('2026-10-09T10:00:00Z')
const TURN_ID = '11111111-2222-4333-8444-555555555555'

function fixture(opts: { failover?: boolean; grounding?: string } = {}): TurnExport {
  let t = T0
  let n = 0
  const tracer = new Tracer({ turnId: TURN_ID, now: () => t, newId: () => `span-${++n}` })
  tracer.addSpan({ kind: 'gate', name: 'router', startedAtMs: T0, durationMs: 300, attrs: { [ATTR.gateChoice]: 'plan_job', [ATTR.gateConfidence]: 0.9, [ATTR.gateSource]: 'jev' } })
  const llm = tracer.addSpan({
    kind: 'llm',
    name: 'chat gemini-3.5-flash',
    startedAtMs: T0 + 400,
    durationMs: 2000,
    tokensIn: 1200,
    tokensOut: 80,
    costUsd: 0,
    attrs: { [ATTR.requestModel]: 'gemini-3.5-flash', [ATTR.system]: 'gemini', [ATTR.failover]: opts.failover ?? false, [ATTR.step]: 1 },
  })
  tracer.setPayload(llm.id, { input: { messages: [{ role: 'user', content: 'Charge my EV by 7am, mail me at a@b.co' }] }, output: { role: 'assistant', content: '', tool_calls: [] } })
  t = T0 + 2500
  const tool = tracer.startSpan('tool', 'recommend_window', null, { [ATTR.toolName]: 'recommend_window' })
  t = T0 + 2510
  tool.end({ status: 'ok', attrs: { [ATTR.toolArgs]: { duration_h: 6 }, [ATTR.toolSummary]: 'best 02:00' } })
  tracer.setPayload(tool.id, { input: { duration_h: 6 }, output: { best_start_london: '02:00' } })
  tracer.addSpan({ kind: 'gate', name: 'grounding', startedAtMs: T0 + 4000, durationMs: 1, attrs: { [ATTR.gateChoice]: opts.grounding ?? 'pass' } })
  const turn: TurnRecord = {
    id: TURN_ID,
    conversationId: '99999999-2222-4333-8444-555555555555',
    userId: 'aaaaaaaa-2222-4333-8444-555555555555',
    ipHash: 'h',
    intent: 'plan_job',
    stopReason: 'final',
    promptVersion: 'v5',
    modelFinal: 'gemini-3.5-flash',
    tokensIn: 1200,
    tokensOut: 80,
    costUsd: 0,
    latencyMs: 4100,
    createdAtUtc: '2026-10-09T10:00:00Z',
  }
  return { turn, spans: tracer.records(), payloads: tracer.payloads(), userMessage: 'Charge my EV by 7am', answer: 'Start at 02:00.', isAnonymous: false }
}

describe('sampling', () => {
  it('is deterministic per turn id and roughly uniform', () => {
    expect(sampleFraction(TURN_ID)).toBe(sampleFraction(TURN_ID))
    const ids = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const share = ids.filter((id) => sampleFraction(id) < 0.2).length / ids.length
    expect(share).toBeGreaterThan(0.15)
    expect(share).toBeLessThan(0.25)
  })

  it('forces export for failover, grounding replacement and non-final stops', () => {
    expect(forcedReason(fixture().turn, fixture().spans)).toBeNull()
    expect(forcedReason(fixture({ failover: true }).turn, fixture({ failover: true }).spans)).toBe('failover')
    const g = fixture({ grounding: 'regenerated' })
    expect(forcedReason(g.turn, g.spans)).toBe('grounding:regenerated')
    const f = fixture()
    expect(forcedReason({ ...f.turn, stopReason: 'max_steps' }, f.spans)).toBe('stop:max_steps')
    expect(shouldExport({ ...f.turn, stopReason: 'max_steps' }, f.spans, 0)).toBe(true)
    expect(shouldExport(f.turn, f.spans, 0)).toBe(false)
    expect(shouldExport(f.turn, f.spans, 1)).toBe(true)
  })
})

describe('masking', () => {
  it('redacts e-mails and long numbers and cuts to 500 chars', () => {
    expect(maskText('mail a.b@c.co or call 07700 900123')).toBe('mail [email] or call [number]')
    expect(maskText('x'.repeat(600))).toHaveLength(501)
  })
})

describe('planObservations', () => {
  it('maps spans to typed, verb-first observations with payloads', () => {
    const plans = planObservations(fixture())
    expect(plans.map((p) => [p.name, p.type])).toEqual([
      ['route-intent', 'chain'],
      ['generate-step', 'generation'],
      ['recommend_window', 'tool'],
      ['check-grounding', 'guardrail'],
    ])
    const gen = plans[1]!
    expect(gen.attributes.model).toBe('gemini-3.5-flash')
    expect(gen.attributes.usageDetails).toEqual({ input: 1200, output: 80 })
    expect(JSON.stringify(gen.attributes.input)).toContain('[email]')
    expect(plans[2]!.attributes.output).toEqual({ best_start_london: '02:00' })
    expect(plans[2]!.endMs - plans[2]!.startMs).toBe(10)
  })

  it('falls back to the stored attrs when there are no payloads (re-export from Supabase)', () => {
    const f = fixture()
    const plans = planObservations({ ...f, payloads: new Map() })
    expect(plans[1]!.attributes.input).toBeUndefined()
    expect(plans[2]!.attributes.input).toEqual({ duration_h: 6 })
    expect(plans[2]!.attributes.output).toBe('best 02:00')
  })
})

describe('LangfuseExporter (SDK, in-memory exporter, no network)', () => {
  it('exports one trace per turn: agent root with session/user/tags, typed children nested under it', async () => {
    const mem = new InMemorySpanExporter()
    const ex = new LangfuseExporter({
      publicKey: 'pk-lf-test',
      secretKey: 'sk-lf-test',
      baseUrl: 'https://cloud.langfuse.com',
      sampleRate: 1,
      environment: 'test',
      release: null,
      exporter: mem,
    })
    expect(await ex.exportTurn(fixture())).toBe(true)
    const spans = mem.getFinishedSpans()
    expect(spans).toHaveLength(5)
    const traceId = await traceIdForTurn(TURN_ID)
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]))
    const root = spans.find((s) => s.name === 'chat-turn')!
    expect(root.attributes[A.OBSERVATION_TYPE]).toBe('agent')
    expect(root.attributes[A.TRACE_SESSION_ID]).toBe('99999999-2222-4333-8444-555555555555')
    expect(root.attributes[A.TRACE_USER_ID]).toBe('aaaaaaaa-2222-4333-8444-555555555555')
    expect(root.attributes[A.TRACE_NAME]).toBe('chat-turn')
    expect(root.attributes[A.TRACE_TAGS]).toEqual(expect.arrayContaining(['assistant', 'signed-in', 'intent:plan_job']))
    expect(root.attributes[A.OBSERVATION_INPUT]).toBe('Charge my EV by 7am')
    const gen = spans.find((s) => s.name === 'generate-step')!
    expect(gen.attributes[A.OBSERVATION_TYPE]).toBe('generation')
    expect(gen.attributes[A.OBSERVATION_MODEL]).toBe('gemini-3.5-flash')
    expect(gen.parentSpanContext?.spanId).toBe(root.spanContext().spanId)
    // recorded timing is kept (startTime/endTime), not the export time
    const tool = spans.find((s) => s.name === 'recommend_window')!
    expect(tool.attributes[A.OBSERVATION_TYPE]).toBe('tool')
    expect(tool.startTime[0]).toBe(Math.floor((T0 + 2500) / 1000))
  })

  it('skips unsampled ordinary turns', async () => {
    const mem = new InMemorySpanExporter()
    const ex = new LangfuseExporter({ publicKey: 'p', secretKey: 's', baseUrl: 'https://x.invalid', sampleRate: 0, environment: 'test', release: null, exporter: mem })
    expect(await ex.exportTurn(fixture())).toBe(false)
    expect(mem.getFinishedSpans()).toHaveLength(0)
  })
})

describe('exporterFromEnv', () => {
  it('is a no-op without keys', () => {
    expect(exporterFromEnv({})).toBe(NOOP_EXPORTER)
    expect(exporterFromEnv({ LANGFUSE_PUBLIC_KEY: 'p', LANGFUSE_SECRET_KEY: 's' })).toBeInstanceOf(LangfuseExporter)
  })
})
