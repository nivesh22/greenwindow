// In-memory tracer for one turn (design §14). Spans are collected here and written in one insert at the end of the
// turn; summary() builds the `done.trace` payload. Clock and id generator are injectable for tests.
import type { TraceSummary } from '../harness/events.js'
import type { SpanKind, SpanRecord } from '../store/types.js'

/** Attribute names (OTel GenAI where they exist, gw.* otherwise). The summary reads these. */
export const ATTR = {
  system: 'gen_ai.system',
  requestModel: 'gen_ai.request.model',
  operation: 'gen_ai.operation.name',
  toolName: 'gen_ai.tool.name',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  failover: 'gw.failover',
  failoverReason: 'gw.failover_reason',
  stopReason: 'gw.stop_reason',
  promptVersion: 'gw.prompt_version',
  costUsd: 'gw.cost_usd',
  gateChoice: 'gw.gate.choice',
  gateConfidence: 'gw.gate.confidence',
  gateSource: 'gw.gate.source',
  toolArgs: 'gw.tool.args',
  toolSummary: 'gw.tool.summary',
  toolErrorCode: 'gw.tool.error_code',
  usageEstimated: 'gw.usage_estimated',
  step: 'gw.step',
  error: 'gw.error',
} as const

export interface SpanEnd {
  status?: 'ok' | 'error'
  attrs?: Record<string, unknown>
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

export interface SpanHandle {
  readonly id: string
  /** Ends the span once; later calls return the first record unchanged. */
  end(r?: SpanEnd): SpanRecord
}

export interface TracerOptions {
  turnId: string
  now?: () => number
  newId?: () => string
}

const iso = (ms: number): string => new Date(ms).toISOString() // UTC with milliseconds

export class Tracer {
  readonly turnId: string
  private readonly now: () => number
  private readonly newId: () => string
  private readonly startedAtMs: number
  private readonly spans: SpanRecord[] = []

  constructor(opts: TracerOptions) {
    this.turnId = opts.turnId
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? (() => crypto.randomUUID())
    this.startedAtMs = this.now()
  }

  startSpan(kind: SpanKind, name: string, parentId: string | null = null, attrs: Record<string, unknown> = {}): SpanHandle {
    const id = this.newId()
    const start = this.now()
    let done: SpanRecord | null = null
    return {
      id,
      end: (r: SpanEnd = {}): SpanRecord => {
        if (done) return done
        done = this.push({
          id,
          parentId,
          kind,
          name,
          startedAtMs: start,
          durationMs: Math.max(0, this.now() - start),
          ...r,
          attrs: { ...attrs, ...r.attrs },
        })
        return done
      },
    }
  }

  /** Adds a span measured elsewhere (e.g. a router attempt that already finished). */
  addSpan(s: { kind: SpanKind; name: string; parentId?: string | null; startedAtMs: number; durationMs: number } & SpanEnd): SpanRecord {
    return this.push({ id: this.newId(), parentId: s.parentId ?? null, ...s, attrs: s.attrs ?? {} })
  }

  records(): SpanRecord[] {
    return [...this.spans]
  }

  summary(opts: { promptVersion: string; steps: number }): TraceSummary {
    const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const tokens = (n: number): number => Math.max(0, Math.round(n))
    const gates: TraceSummary['gates'] = []
    const tools: TraceSummary['tools'] = []
    const llm: TraceSummary['llm_calls'] = []
    for (const s of this.spans) {
      const a = s.attrs
      if (s.kind === 'gate') {
        const source = a[ATTR.gateSource]
        gates.push({
          gate: s.name,
          choice: str(a[ATTR.gateChoice]),
          confidence: Math.min(1, Math.max(0, num(a[ATTR.gateConfidence]))),
          source: source === 'jev' || source === 'llm' ? source : 'rules',
          latency_ms: s.durationMs,
        })
      } else if (s.kind === 'tool') {
        tools.push({ name: s.name, args: a[ATTR.toolArgs] ?? null, ok: s.status === 'ok', ms: s.durationMs, summary: str(a[ATTR.toolSummary]) })
      } else if (s.kind === 'llm') {
        llm.push({
          model: str(a[ATTR.requestModel], s.name),
          provider: str(a[ATTR.system], 'unknown'),
          failover: a[ATTR.failover] === true,
          failover_reason: typeof a[ATTR.failoverReason] === 'string' ? (a[ATTR.failoverReason] as string) : null,
          finish_reason: Array.isArray(a['gen_ai.response.finish_reasons']) ? String(a['gen_ai.response.finish_reasons'][0]) : null,
          tokens_in: tokens(s.tokensIn),
          tokens_out: tokens(s.tokensOut),
          cost_usd: Math.max(0, s.costUsd),
          ms: s.durationMs,
        })
      }
    }
    return {
      gates,
      tools,
      llm_calls: llm,
      totals: {
        steps: Math.max(0, Math.round(opts.steps)),
        tokens_in: llm.reduce((t, c) => t + c.tokens_in, 0),
        tokens_out: llm.reduce((t, c) => t + c.tokens_out, 0),
        cost_usd: this.spans.reduce((t, s) => t + Math.max(0, s.costUsd), 0),
        ms: Math.max(0, this.now() - this.startedAtMs),
      },
      prompt_version: opts.promptVersion,
    }
  }

  private push(
    s: { id: string; parentId: string | null; kind: SpanKind; name: string; startedAtMs: number; durationMs: number; attrs: Record<string, unknown> } & SpanEnd,
  ): SpanRecord {
    const rec: SpanRecord = {
      id: s.id,
      turnId: this.turnId,
      parentId: s.parentId,
      kind: s.kind,
      name: s.name,
      startedAtUtc: iso(s.startedAtMs),
      durationMs: Math.max(0, s.durationMs),
      status: s.status ?? 'ok',
      attrs: s.attrs,
      tokensIn: s.tokensIn ?? 0,
      tokensOut: s.tokensOut ?? 0,
      costUsd: s.costUsd ?? 0,
    }
    this.spans.push(rec)
    return rec
  }
}
