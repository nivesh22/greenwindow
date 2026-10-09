// Langfuse export (design §14, FR-8.2, plan P4.5). Supabase stays the source of truth; Langfuse receives a sampled copy
// of each turn for deep debugging. Built on the Langfuse JS/TS SDK v5 (@langfuse/tracing + @langfuse/otel), checked
// 2026-10-09 against https://langfuse.com/docs/observability/best-practices.md and the installed type definitions.
//
// Shape of one trace (one chat turn; the conversation is the Langfuse session):
//   chat-turn (agent)            input = user message, output = answer
//     ├─ check-input / route-intent / decide-ask-or-act / choose-risk-mode / check-grounding / check-output
//     │                          (guardrail for checks, chain for decisions; metadata = choice, confidence, source)
//     ├─ generate-step (generation, one per model call, incl. failed attempts)  OpenAI-format messages in/out
//     └─ <tool name> (tool)      input = validated args, output = tool result
// Tool calls are siblings of the generation that requested them (Langfuse best practice), so everything hangs off the
// root. Names are stable and verb-first; the model goes in the generation's `model` attribute, not the name.
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { context as otelContext } from '@opentelemetry/api'
import { BasicTracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace-base'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { LangfuseClient } from '@langfuse/client'
import {
  createTraceId,
  propagateAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseObservation,
  type LangfuseObservationAttributes,
  type LangfuseObservationType,
} from '@langfuse/tracing'
import type { SpanRecord, TurnRecord } from '../store/types.js'
import { ATTR, type SpanPayload } from './tracer.js'

/** Everything needed to export one finished turn. */
export interface TurnExport {
  turn: TurnRecord
  spans: readonly SpanRecord[]
  /** Export-only payloads (LLM messages, tool I/O) keyed by span id; empty when re-exported from Supabase. */
  payloads: ReadonlyMap<string, SpanPayload>
  userMessage: string
  answer: string
  isAnonymous: boolean | null
}

export interface TraceExporter {
  /** Exports the turn if it is sampled (or forced). Never throws. Returns whether it was exported. */
  exportTurn(t: TurnExport): Promise<boolean>
  /**
   * Attaches a thumbs up/down as a `user_feedback` score. A thumbs-down on a turn that was not sampled first exports
   * it (from `load`, i.e. the Supabase copy) so every complaint can be inspected. Never throws.
   */
  scoreFeedback(f: { turnId: string; rating: 1 | -1; comment: string | null; load: () => Promise<TurnExport | null> }): Promise<void>
}

/** No-op exporter when Langfuse is not configured (tests, local dev without keys). */
export const NOOP_EXPORTER: TraceExporter = {
  exportTurn: async () => false,
  scoreFeedback: async () => {},
}

export interface LangfuseConfig {
  publicKey: string
  secretKey: string
  baseUrl: string
  sampleRate: number // 0..1, for ordinary turns; problem turns are always exported
  environment: string // production / preview / development
  release: string | null // git sha
  /** Tests only: an in-memory span exporter instead of the OTLP exporter to Langfuse. */
  exporter?: SpanExporter
}

/** Message text is cut to this many characters before export (design §14). */
export const MAX_TEXT_CHARS = 500

// ---------- pure parts (unit-tested) ----------

/** Deterministic in [0, 1) from the turn id, so a re-check (e.g. on feedback) reaches the same decision. */
export function sampleFraction(turnId: string): number {
  let h = 2166136261
  for (let i = 0; i < turnId.length; i++) {
    h ^= turnId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 2 ** 32
}

/** Why a turn must be exported regardless of sampling, or null. */
export function forcedReason(turn: TurnRecord, spans: readonly SpanRecord[]): string | null {
  if (turn.stopReason !== 'final') return `stop:${turn.stopReason}`
  for (const s of spans) {
    if (s.status === 'error') return `error:${s.kind}:${s.name}`
    if (s.kind === 'llm' && s.attrs[ATTR.failover] === true) return 'failover'
    if (s.kind === 'gate') {
      const choice = s.attrs[ATTR.gateChoice]
      if (s.name === 'grounding' && choice !== 'pass') return `grounding:${String(choice)}`
      if ((s.name === 'guard_in' || s.name === 'guard_out') && choice !== 'allow' && choice !== 'pass') return `${s.name}:${String(choice)}`
    }
  }
  return null
}

export function shouldExport(turn: TurnRecord, spans: readonly SpanRecord[], sampleRate: number): boolean {
  return forcedReason(turn, spans) !== null || sampleFraction(turn.id) < sampleRate
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const LONG_DIGITS = /\b\d(?:[ -]?\d){9,}\b/g // phone and card-like numbers

/** Redacts e-mail addresses and long digit runs, then cuts to `max` characters. */
export function maskText(text: string, max = MAX_TEXT_CHARS): string {
  const masked = text.replace(EMAIL, '[email]').replace(LONG_DIGITS, '[number]')
  return masked.length > max ? `${masked.slice(0, max)}…` : masked
}

/** Applies maskText to every string inside a JSON-like value. */
export function maskDeep(v: unknown, max = MAX_TEXT_CHARS): unknown {
  if (typeof v === 'string') return maskText(v, max)
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, max))
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskDeep(x, max)]))
  return v
}

const GATE_NAMES: Record<string, { name: string; type: LangfuseObservationType }> = {
  guard_in: { name: 'check-input', type: 'guardrail' },
  router: { name: 'route-intent', type: 'chain' },
  ask_or_act: { name: 'decide-ask-or-act', type: 'chain' },
  risk_mode: { name: 'choose-risk-mode', type: 'chain' },
  grounding: { name: 'check-grounding', type: 'guardrail' },
  guard_out: { name: 'check-output', type: 'guardrail' },
}

/** One observation to create, in a form independent of the SDK. */
export interface ObservationPlan {
  spanId: string
  parentSpanId: string | null // null: child of the root
  name: string
  type: LangfuseObservationType
  startMs: number
  endMs: number
  attributes: {
    input?: unknown
    output?: unknown
    metadata: Record<string, unknown>
    level?: 'DEFAULT' | 'WARNING' | 'ERROR'
    statusMessage?: string
    model?: string
    usageDetails?: Record<string, number>
    costDetails?: Record<string, number>
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Maps the turn's spans to Langfuse observations (sorted by start time). */
export function planObservations(t: TurnExport): ObservationPlan[] {
  const ids = new Set(t.spans.map((s) => s.id))
  return [...t.spans]
    .sort((a, b) => Date.parse(a.startedAtUtc) - Date.parse(b.startedAtUtc))
    .map((s): ObservationPlan => {
      const startMs = Date.parse(s.startedAtUtc)
      const p = t.payloads.get(s.id)
      const a = s.attrs
      const parentSpanId = s.parentId !== null && ids.has(s.parentId) ? s.parentId : null
      const base = { spanId: s.id, parentSpanId, startMs, endMs: startMs + s.durationMs }
      const level = s.status === 'error' ? ('ERROR' as const) : undefined
      if (s.kind === 'llm') {
        const model = str(a[ATTR.requestModel])
        return {
          ...base,
          name: 'generate-step',
          type: 'generation',
          attributes: {
            ...(p?.input !== undefined ? { input: maskDeep(p.input) } : {}),
            ...(p?.output !== undefined ? { output: maskDeep(p.output) } : {}),
            ...(model ? { model } : {}),
            usageDetails: { input: s.tokensIn, output: s.tokensOut },
            costDetails: { total: s.costUsd },
            metadata: {
              provider: a[ATTR.system],
              step: a[ATTR.step],
              failover: a[ATTR.failover],
              failover_reason: a[ATTR.failoverReason],
              finish_reasons: a['gen_ai.response.finish_reasons'],
              usage_estimated: a[ATTR.usageEstimated],
              attempts: a['gw.attempts'],
            },
            ...(level ? { level, statusMessage: str(a[ATTR.error]) ?? 'model call failed' } : {}),
          },
        }
      }
      if (s.kind === 'tool') {
        return {
          ...base,
          name: s.name,
          type: 'tool',
          attributes: {
            input: maskDeep(p?.input ?? a[ATTR.toolArgs] ?? null),
            ...(p?.output !== undefined ? { output: maskDeep(p.output) } : { output: str(a[ATTR.toolSummary]) ?? null }),
            metadata: { summary: a[ATTR.toolSummary] },
            ...(level ? { level, statusMessage: str(a[ATTR.toolErrorCode]) ?? 'tool failed' } : {}),
          },
        }
      }
      if (s.kind === 'gate') {
        const g = GATE_NAMES[s.name] ?? { name: s.name, type: 'span' as const }
        const choice = a[ATTR.gateChoice]
        const extra = Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith('gw.gate.') && k !== ATTR.gateChoice))
        return {
          ...base,
          name: g.name,
          type: g.type,
          attributes: {
            output: { choice, confidence: a[ATTR.gateConfidence], source: a[ATTR.gateSource] },
            metadata: maskDeep(extra) as Record<string, unknown>,
            ...(level ? { level: 'WARNING' as const, statusMessage: `choice ${String(choice)}` } : {}),
          },
        }
      }
      return { ...base, name: s.name, type: 'span', attributes: { metadata: maskDeep(a) as Record<string, unknown>, ...(level ? { level } : {}) } }
    })
}

// ---------- SDK wiring ----------

/** startObservation without its per-type overloads, so the type can be chosen at run time. */
const startTyped = startObservation as unknown as (
  name: string,
  attributes: Partial<LangfuseObservationAttributes>,
  options: { asType: LangfuseObservationType; startTime: Date; parentSpanContext: ReturnType<LangfuseObservation['otelSpan']['spanContext']> },
) => LangfuseObservation

const PARENT_SPAN_PLACEHOLDER = '0123456789abcdef' // docs: any valid 16-hex id; only used to inherit the trace id

/** The Langfuse trace id of a turn (same seed → same id, so feedback can be attached later). */
export function traceIdForTurn(turnId: string): Promise<string> {
  return createTraceId(turnId)
}

export class LangfuseExporter implements TraceExporter {
  private readonly cfg: LangfuseConfig
  private processor: LangfuseSpanProcessor | null = null
  private client: LangfuseClient | null = null

  constructor(cfg: LangfuseConfig) {
    this.cfg = cfg
  }

  private init(): LangfuseSpanProcessor {
    if (this.processor) return this.processor
    // propagateAttributes stores trace attributes in the OTel context, which needs a real context manager.
    otelContext.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
    const processor = new LangfuseSpanProcessor({
      publicKey: this.cfg.publicKey,
      secretKey: this.cfg.secretKey,
      baseUrl: this.cfg.baseUrl,
      environment: this.cfg.environment,
      ...(this.cfg.release ? { release: this.cfg.release } : {}),
      exportMode: 'immediate', // serverless: export as spans end, then forceFlush before the function returns
      ...(this.cfg.exporter ? { exporter: this.cfg.exporter } : {}),
    })
    // An isolated provider: we never register a global OTel tracer, so nothing else gets exported by accident.
    setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }))
    this.processor = processor
    return processor
  }

  async exportTurn(t: TurnExport): Promise<boolean> {
    if (!shouldExport(t.turn, t.spans, this.cfg.sampleRate)) return false
    return this.send(t)
  }

  private async send(t: TurnExport): Promise<boolean> {
    try {
      const processor = this.init()
      const traceId = await traceIdForTurn(t.turn.id)
      const plans = planObservations(t)
      const startMs = Date.parse(t.turn.createdAtUtc)
      const endMs = Math.max(startMs + t.turn.latencyMs, ...plans.map((p) => p.endMs))
      const forced = forcedReason(t.turn, t.spans)
      const tags = ['assistant', t.isAnonymous === null ? 'no-auth' : t.isAnonymous ? 'anonymous' : 'signed-in']
      if (t.turn.intent) tags.push(`intent:${t.turn.intent}`)
      if (forced) tags.push('forced-export')

      propagateAttributes(
        {
          traceName: 'chat-turn',
          sessionId: t.turn.conversationId,
          ...(t.turn.userId ? { userId: t.turn.userId } : {}),
          version: t.turn.promptVersion,
          tags,
        },
        () => {
          const root = startTyped(
            'chat-turn',
            {
              input: maskText(t.userMessage),
              output: maskText(t.answer),
              metadata: {
                turn_id: t.turn.id,
                intent: t.turn.intent,
                stop_reason: t.turn.stopReason,
                model_final: t.turn.modelFinal,
                cost_usd: t.turn.costUsd,
                tokens_in: t.turn.tokensIn,
                tokens_out: t.turn.tokensOut,
                forced_reason: forced,
              },
              ...(t.turn.stopReason !== 'final' ? { level: 'WARNING' as const, statusMessage: `stop ${t.turn.stopReason}` } : {}),
            },
            { asType: 'agent', startTime: new Date(startMs), parentSpanContext: { traceId, spanId: PARENT_SPAN_PLACEHOLDER, traceFlags: 1 } },
          )
          const created = new Map<string, LangfuseObservation>()
          for (const p of plans) {
            const parent = (p.parentSpanId && created.get(p.parentSpanId)) || root
            const obs = startTyped(p.name, p.attributes, {
              asType: p.type,
              startTime: new Date(p.startMs),
              parentSpanContext: parent.otelSpan.spanContext(),
            })
            created.set(p.spanId, obs)
          }
          // End children before the root, each at its recorded time.
          for (const p of [...plans].reverse()) created.get(p.spanId)?.end(new Date(p.endMs))
          root.end(new Date(endMs))
        },
      )
      await processor.forceFlush()
      return true
    } catch (err) {
      console.error('langfuse export failed', t.turn.id, err instanceof Error ? err.message : 'unknown')
      return false
    }
  }

  async scoreFeedback(f: { turnId: string; rating: 1 | -1; comment: string | null; load: () => Promise<TurnExport | null> }): Promise<void> {
    try {
      const t = await f.load()
      if (!t) return
      const sampled = shouldExport(t.turn, t.spans, this.cfg.sampleRate)
      if (!sampled) {
        if (f.rating === 1) return // an unsampled thumbs-up has no trace to attach to; Supabase keeps it
        if (!(await this.send(t))) return
      }
      this.client ??= new LangfuseClient({ publicKey: this.cfg.publicKey, secretKey: this.cfg.secretKey, baseUrl: this.cfg.baseUrl })
      this.client.score.create({
        traceId: await traceIdForTurn(f.turnId),
        name: 'user_feedback',
        value: f.rating,
        dataType: 'NUMERIC',
        environment: this.cfg.environment,
        ...(f.comment ? { comment: maskText(f.comment, 1000) } : {}),
      })
      await this.client.score.flush()
    } catch (err) {
      console.error('langfuse feedback failed', f.turnId, err instanceof Error ? err.message : 'unknown')
    }
  }
}

/** Builds the exporter from env; NOOP when the keys are missing. */
export function exporterFromEnv(env: Record<string, string | undefined> = process.env): TraceExporter {
  const publicKey = env.LANGFUSE_PUBLIC_KEY
  const secretKey = env.LANGFUSE_SECRET_KEY
  if (!publicKey || !secretKey) return NOOP_EXPORTER
  const rate = Number(env.LANGFUSE_SAMPLE_RATE ?? '0.2')
  return new LangfuseExporter({
    publicKey,
    secretKey,
    baseUrl: env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
    sampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0.2,
    environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? env.VERCEL_ENV ?? 'development',
    release: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null,
  })
}
