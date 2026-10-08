// The model ↔ tools loop (design §5.2, amended by X4: the answer text is buffered and returned, never emitted
// here; turn.ts sends it as one `answer` event after grounding).
import { z } from 'zod'
import { AllProvidersFailed, type LlmCallRecord, type ModelRouter } from '../providers/router'
import type { Msg, ToolCall } from '../providers/types'
import { ATTR, type Tracer } from '../telemetry/tracer'
import type { ToolCtx, ToolDef, ToolRegistry } from '../tools/registry'
import { ToolUserError } from '../tools/registry'
import { type Budget, estimateMessagesTokens, estimateTokens } from './budget'
import { BudgetExceeded, ProvidersDown } from './errors'
import { planUpdateSchema, type PlanUpdate, type SseEvent, type StopReason } from './events'

export interface LoopOptions {
  router: ModelRouter
  registry: ToolRegistry
  /** Tools offered to the model this turn (e.g. registry.forIntent(intent)). Calls to others get unknown_tool. */
  tools: readonly ToolDef[]
  /** Per-turn tool context. Its `signal` is replaced per call by one that also aborts on the tool timeout. */
  ctx: ToolCtx
  budget: Budget
  tracer: Tracer
  emit: (ev: SseEvent) => void
  toolTimeoutMs: number
  temperature?: number
  toolChoice?: 'auto' | 'none'
  responseFormat?: 'json'
  /** Parent span for llm/tool spans (e.g. the turn's "loop" stage span). */
  parentSpanId?: string | null
  /**
   * Maps a validated output of a tool with `emitsPlan` to a plan_update payload. The ToolDef contract has no field
   * for this, so turn.ts supplies it. Return null to skip. The result is validated against planUpdateSchema.
   */
  toPlanUpdate?: (toolName: string, output: unknown) => PlanUpdate | null
  /** One-line summary for tool_end and the trace. Default: "ok" or the error code. */
  summarize?: (toolName: string, output: unknown) => string
  /** Clock for tool latency. Default Date.now. */
  now?: () => number
}

export interface LoopResult {
  /** Buffered answer text of the last model call (partial on non-final stops). */
  text: string
  stopReason: StopReason
  /** The input messages plus every assistant and tool message appended by the loop. */
  messages: Msg[]
  steps: number
  /** Set for non-final stops: what went wrong, for logs and the trace (never shown to the user verbatim). */
  detail: string | null
}

/**
 * Loop error codes: unknown_tool, sign_in_required, invalid_arguments, timeout, invalid_output, tool_failed,
 * aborted. A ToolUserError carries its own code.
 */
export type ToolErrorCode = string

export type ToolOutcome =
  | { ok: true; tool: string; data: unknown }
  | { ok: false; tool: string; error: { code: ToolErrorCode; message: string; issues?: unknown } }

/** The JSON sent back to the model in the `tool` message. */
export function toolMessageContent(o: ToolOutcome): string {
  return o.ok
    ? JSON.stringify({ tool: o.tool, ok: true, data: o.data })
    : JSON.stringify({ tool: o.tool, ok: false, error: o.error })
}

class ToolTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, ctrl: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      const e = new ToolTimeout(`tool timed out after ${ms} ms`)
      ctrl.abort(e)
      reject(e)
    }, ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function parseArgs(argsJson: string): { ok: true; value: unknown } | { ok: false; message: string } {
  if (argsJson.trim().length === 0) return { ok: true, value: {} } // some providers send "" for no-arg calls
  try {
    return { ok: true, value: JSON.parse(argsJson) as unknown }
  } catch (e) {
    return { ok: false, message: `arguments are not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
}

const stopFor = (err: unknown): { stop: StopReason; detail: string } | null => {
  if (err instanceof BudgetExceeded) return { stop: err.reason, detail: err.message }
  if (err instanceof ProvidersDown) return { stop: 'provider_down', detail: err.message }
  return null
}

export async function runLoop(input: readonly Msg[], opts: LoopOptions): Promise<LoopResult> {
  const { router, budget, tracer } = opts
  const messages: Msg[] = [...input]
  const specs = opts.registry.specs(opts.tools)
  const invalidStreak = new Map<string, number>() // tool name → consecutive invalid calls this turn
  let lastText = ''
  let steps = 0

  const result = (stopReason: StopReason, detail: string | null): LoopResult => ({
    text: lastText,
    stopReason,
    messages,
    steps,
    detail,
  })

  try {
    for (;;) {
      const est = estimateMessagesTokens(messages) + estimateTokens(JSON.stringify(specs))
      budget.assertCanStart(router.models, est)
      steps = budget.steps

      let routed
      try {
        routed = await router.complete(
          {
            messages,
            ...(specs.length > 0 ? { tools: specs, toolChoice: opts.toolChoice ?? 'auto' } : {}),
            maxOutputTokens: budget.maxOutputTokens,
            temperature: opts.temperature ?? 0.2,
            ...(opts.responseFormat ? { responseFormat: opts.responseFormat } : {}),
          },
          budget.signal,
          budget.deadlineMs,
        )
      } catch (err) {
        if (err instanceof AllProvidersFailed) traceFailedCalls(tracer, err.calls, steps, opts.parentSpanId ?? null)
        throw err
      }

      let text = ''
      const calls: ToolCall[] = []
      let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null = null
      for (const e of routed.events) {
        if (e.type === 'text') text += e.delta
        else if (e.type === 'tool_call') calls.push(e.call)
        else if (e.type === 'usage') usage = e
      }
      const estimated = usage === null
      const u = usage ?? {
        inputTokens: est,
        outputTokens: estimateTokens(text + calls.map((c) => c.name + c.argsJson).join('')),
        cachedInputTokens: 0,
      }
      const cost = budget.charge(routed.model, u.inputTokens, u.outputTokens, u.cachedInputTokens)
      traceFailedCalls(tracer, routed.calls.slice(0, -1), steps, opts.parentSpanId ?? null)
      const ok = routed.calls[routed.calls.length - 1]
      if (ok) {
        tracer.addSpan({
          kind: 'llm',
          name: `chat ${routed.model}`,
          parentId: opts.parentSpanId ?? null,
          startedAtMs: ok.startedAtMs,
          durationMs: ok.ms,
          status: 'ok',
          tokensIn: u.inputTokens,
          tokensOut: u.outputTokens,
          costUsd: cost,
          attrs: {
            ...llmAttrs(ok, steps),
            [ATTR.inputTokens]: u.inputTokens,
            [ATTR.outputTokens]: u.outputTokens,
            [ATTR.costUsd]: cost,
            [ATTR.usageEstimated]: estimated,
          },
        })
      }

      lastText = text
      messages.push(calls.length > 0 ? { role: 'assistant', content: text, toolCalls: calls } : { role: 'assistant', content: text })
      if (calls.length === 0) return result('final', null)

      budget.assertWithinTotals()
      budget.assertTime()
      const outcomes = await Promise.all(calls.map((c) => runTool(c, opts)))
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]
        const out = outcomes[i]
        if (!call || !out) continue
        messages.push({ role: 'tool', content: toolMessageContent(out), toolCallId: call.id })
      }
      budget.assertTime()

      // Repair rule: the second consecutive invalid call to the same tool in this turn ends the loop.
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]
        const out = outcomes[i]
        if (!call || !out) continue
        if (!out.ok && out.error.code === 'invalid_arguments') {
          const n = (invalidStreak.get(call.name) ?? 0) + 1
          invalidStreak.set(call.name, n)
          if (n >= 2) return result('tool_error', `repeated invalid arguments for ${call.name}`)
        } else {
          invalidStreak.set(call.name, 0)
        }
      }
    }
  } catch (err) {
    const s = stopFor(err) ?? (budget.signal.aborted ? stopFor(budget.signal.reason) ?? { stop: 'wall_clock' as const, detail: 'aborted' } : null)
    if (s) return result(s.stop, s.detail)
    throw err
  }
}

function llmAttrs(c: LlmCallRecord, step: number): Record<string, unknown> {
  return {
    [ATTR.operation]: 'chat',
    [ATTR.system]: c.provider,
    [ATTR.requestModel]: c.model,
    [ATTR.failover]: c.failover,
    [ATTR.failoverReason]: c.failoverReason,
    [ATTR.step]: step,
    'gw.attempts': c.attempts,
  }
}

function traceFailedCalls(tracer: Tracer, calls: readonly LlmCallRecord[], step: number, parentId: string | null): void {
  for (const c of calls) {
    if (c.attempts === 0) continue // skipped (breaker open): nothing was sent
    tracer.addSpan({
      kind: 'llm',
      name: `chat ${c.model}`,
      parentId,
      startedAtMs: c.startedAtMs,
      durationMs: c.ms,
      status: 'error',
      attrs: { ...llmAttrs(c, step), [ATTR.error]: c.errorKind },
    })
  }
}

async function runTool(call: ToolCall, opts: LoopOptions): Promise<ToolOutcome> {
  const { tracer, budget } = opts
  const span = tracer.startSpan('tool', call.name, opts.parentSpanId ?? null, {
    [ATTR.operation]: 'execute_tool',
    [ATTR.toolName]: call.name,
  })
  const fail = (code: ToolErrorCode, message: string, args: unknown, issues?: unknown): ToolOutcome => {
    span.end({
      status: 'error',
      attrs: { [ATTR.toolArgs]: args, [ATTR.toolErrorCode]: code, [ATTR.toolSummary]: code },
    })
    return { ok: false, tool: call.name, error: issues === undefined ? { code, message } : { code, message, issues } }
  }

  const def = opts.tools.find((t) => t.name === call.name)
  if (!def) return fail('unknown_tool', `There is no tool called "${call.name}".`, call.argsJson)
  if (def.auth === 'user' && opts.ctx.isAnonymous) {
    return fail('sign_in_required', 'This needs the user to sign in first.', call.argsJson)
  }
  const raw = parseArgs(call.argsJson)
  if (!raw.ok) return fail('invalid_arguments', raw.message, call.argsJson)
  const parsed = def.input.safeParse(raw.value)
  if (!parsed.success) {
    return fail(
      'invalid_arguments',
      'The arguments do not match the tool schema. Fix them and call the tool again.',
      raw.value,
      z.treeifyError(parsed.error),
    )
  }

  opts.emit({ type: 'tool_start', data: { call_id: call.id, tool: call.name, status_text: def.statusText } })
  const now = opts.now ?? Date.now
  const started = now()
  const ctrl = new AbortController()
  const signal = AbortSignal.any([budget.signal, ctrl.signal])
  const end = (ok: boolean, summary: string): void => {
    opts.emit({ type: 'tool_end', data: { call_id: call.id, tool: call.name, ok, latency_ms: Math.max(0, now() - started), summary } })
  }

  let out: unknown
  try {
    const handlerOut = def.handler({ ...opts.ctx, signal }, parsed.data)
    out = await withTimeout(Promise.resolve(handlerOut), opts.toolTimeoutMs, ctrl)
  } catch (err) {
    const [code, message] =
      err instanceof ToolUserError
        ? [err.code, err.message]
        : err instanceof ToolTimeout
          ? ['timeout', 'The tool took too long to answer.']
          : budget.signal.aborted
            ? ['aborted', 'The turn ran out of time.']
            : ['tool_failed', 'The tool failed unexpectedly.']
    end(false, code)
    return fail(code, message, parsed.data)
  }

  const valid = def.output.safeParse(out)
  if (!valid.success) {
    end(false, 'invalid_output')
    return fail('invalid_output', 'The tool returned an unexpected result.', parsed.data)
  }
  const summary = opts.summarize?.(call.name, valid.data) ?? 'ok'
  span.end({ status: 'ok', attrs: { [ATTR.toolArgs]: parsed.data, [ATTR.toolSummary]: summary } })
  end(true, summary)
  if (def.emitsPlan && opts.toPlanUpdate) {
    const plan = planUpdateSchema.safeParse(opts.toPlanUpdate(call.name, valid.data))
    if (plan.success) opts.emit({ type: 'plan_update', data: plan.data })
  }
  return { ok: true, tool: call.name, data: valid.data }
}
