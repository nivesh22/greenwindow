import { traceSummarySchema } from '../harness/events.js'
import { ATTR, Tracer } from './tracer.js'

describe('Tracer', () => {
  it('records spans with parent ids, durations and a valid summary', () => {
    let t = Date.parse('2026-10-06T00:30:00Z')
    let id = 0
    const tr = new Tracer({ turnId: 'turn1', now: () => t, newId: () => `s${++id}` })

    const root = tr.startSpan('stage', 'loop')
    const gate = tr.startSpan('gate', 'router', root.id)
    t += 40
    gate.end({ attrs: { [ATTR.gateChoice]: 'plan_job', [ATTR.gateConfidence]: 0.9, [ATTR.gateSource]: 'llm' } })
    const tool = tr.startSpan('tool', 'get_forecast', root.id, { [ATTR.toolName]: 'get_forecast' })
    t += 10
    const rec = tool.end({ status: 'error', attrs: { [ATTR.toolArgs]: { h: 1 }, [ATTR.toolSummary]: 'timeout' } })
    expect(tool.end({ status: 'ok' })).toBe(rec) // second end is a no-op
    tr.addSpan({
      kind: 'llm', name: 'chat m', parentId: root.id, startedAtMs: t, durationMs: 300,
      tokensIn: 120.4, tokensOut: 30, costUsd: 0.001,
      attrs: { [ATTR.system]: 'ai-gateway', [ATTR.requestModel]: 'm', [ATTR.failover]: true },
    })
    t += 300
    root.end()

    const spans = tr.records()
    expect(spans.map((s) => [s.id, s.parentId, s.kind])).toEqual([
      ['s2', 's1', 'gate'],
      ['s3', 's1', 'tool'],
      ['s4', 's1', 'llm'],
      ['s1', null, 'stage'],
    ])
    expect(spans[0]).toMatchObject({ turnId: 'turn1', durationMs: 40, startedAtUtc: '2026-10-06T00:30:00.000Z', status: 'ok' })
    expect(spans[1]?.attrs).toMatchObject({ [ATTR.toolName]: 'get_forecast', [ATTR.toolSummary]: 'timeout' })

    const sum = tr.summary({ promptVersion: 'v1', steps: 2 })
    expect(traceSummarySchema.parse(sum)).toEqual(sum)
    expect(sum.gates).toEqual([{ gate: 'router', choice: 'plan_job', confidence: 0.9, source: 'llm', latency_ms: 40 }])
    expect(sum.tools).toEqual([{ name: 'get_forecast', args: { h: 1 }, ok: false, ms: 10, summary: 'timeout' }])
    expect(sum.llm_calls).toEqual([
      { model: 'm', provider: 'ai-gateway', ok: true, error: null, failover: true, failover_reason: null, finish_reason: null, tokens_in: 120, tokens_out: 30, cost_usd: 0.001, ms: 300 },
    ])
    expect(sum.totals).toEqual({ steps: 2, tokens_in: 120, tokens_out: 30, cost_usd: 0.001, ms: 350 })
  })
})
