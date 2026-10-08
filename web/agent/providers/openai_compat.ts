// Fetch-based OpenAI Chat Completions streaming client (design §5.1). One client, two configs (Gemini direct, AI
// Gateway). No SDKs.
//
// Tolerance (docs/spikes.md S3: Gemini's streaming of tool calls and `include_usage` are UNVERIFIED): a tool call
// may arrive whole in one chunk or fragmented by `index`; `index` or `id` may be missing (an id is generated);
// usage may be absent (nothing is emitted and the caller estimates); `finish_reason` 'stop' with tool calls is
// reported as 'tool_calls'.
import { z } from 'zod'
import { ProviderError } from '../harness/errors'
import type { FinishReason, ModelEvent, ModelProvider, ModelRequest, Msg, ProviderErrorInfo, ProviderId } from './types'

export interface OpenAICompatConfig {
  id: ProviderId
  baseUrl: string // e.g. https://generativelanguage.googleapis.com/v1beta/openai (no trailing /chat/completions)
  apiKey: string
  headers?: Record<string, string>
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch
  /** Generates ids for tool calls that arrive without one. */
  newId?: () => string
  /** Clock for parsing an HTTP-date Retry-After. */
  now?: () => number
}

// ---- request ----

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export function toWireMessage(m: Msg): WireMessage {
  switch (m.role) {
    case 'system':
    case 'user':
      return { role: m.role, content: m.content }
    case 'assistant': {
      const calls = m.toolCalls ?? []
      if (calls.length === 0) return { role: 'assistant', content: m.content }
      return {
        role: 'assistant',
        content: m.content.length > 0 ? m.content : null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.argsJson } })),
      }
    }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  }
}

export function buildRequestBody(req: ModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxOutputTokens,
    temperature: req.temperature,
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (req.toolChoice) body.tool_choice = req.toolChoice
  if (req.responseFormat === 'json') body.response_format = { type: 'json_object' }
  return body
}

// ---- errors ----

/** Retry-After is either delta-seconds or an HTTP-date. Returns ms from now, or null. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null
  const v = value.trim()
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000)
  const at = Date.parse(v)
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs)
}

export function kindForStatus(status: number): ProviderErrorInfo['kind'] {
  if (status === 429) return 'rate_limit'
  if (status === 408) return 'timeout'
  if (status >= 500) return 'server'
  return 'client'
}

// ---- stream chunks (validated loosely: only the fields we read) ----

const toolCallDelta = z.object({
  index: z.number().int().nonnegative().optional(),
  id: z.string().nullish(),
  function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
})

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({ content: z.string().nullish(), tool_calls: z.array(toolCallDelta).nullish() })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .object({
      prompt_tokens: z.number().nonnegative().nullish(),
      completion_tokens: z.number().nonnegative().nullish(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nonnegative().nullish() }).nullish(),
    })
    .nullish(),
  error: z.unknown().optional(),
})

function mapFinish(raw: string): FinishReason {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'length':
    case 'max_tokens':
      return 'length'
    case 'content_filter':
    case 'safety':
      return 'content_filter'
    default:
      return 'stop'
  }
}

interface PendingCall {
  id: string | null
  name: string
  args: string
}

/** Stateful parser: feed decoded text, get ModelEvents. Exported for unit tests. */
export class ChatStreamParser {
  private buf = ''
  private readonly calls = new Map<string, PendingCall>()
  private order: string[] = []
  private lastKey: string | null = null
  private finish: FinishReason | null = null
  private sawDone = false
  private sawAny = false
  private readonly malformed: (msg: string) => ProviderError
  private readonly newId: () => string

  constructor(malformed: (msg: string) => ProviderError, newId: () => string) {
    this.malformed = malformed
    this.newId = newId
  }

  get done(): boolean {
    return this.sawDone
  }

  /** Feeds raw text (may end mid-line). Returns the events completed by it. */
  push(text: string): ModelEvent[] {
    this.buf += text
    const out: ModelEvent[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      this.line(line, out)
    }
    return out
  }

  /** Call at end of stream. Flushes a final unterminated line and emits remaining tool calls and `finish`. */
  end(): ModelEvent[] {
    const out: ModelEvent[] = []
    if (this.buf.length > 0) {
      const line = this.buf.replace(/\r$/, '')
      this.buf = ''
      this.line(line, out)
    }
    if (!this.sawDone && this.finish === null) {
      throw this.malformed(this.sawAny ? 'stream ended without finish_reason or [DONE]' : 'empty stream')
    }
    this.flushCalls(out)
    const reason = this.order.length > 0 && this.finish !== 'length' && this.finish !== 'content_filter' ? 'tool_calls' : (this.finish ?? 'stop')
    out.push({ type: 'finish', reason })
    return out
  }

  private line(line: string, out: ModelEvent[]): void {
    // SSE: one JSON payload per `data:` line (the OpenAI convention). Comments, event:, id:, retry: are ignored.
    if (!line.startsWith('data:')) return
    if (this.sawDone) return
    const payload = line.slice(5).trim()
    if (payload.length === 0) return
    if (payload === '[DONE]') {
      this.sawDone = true
      return
    }
    let json: unknown
    try {
      json = JSON.parse(payload)
    } catch {
      throw this.malformed(`invalid JSON in stream: ${payload.slice(0, 120)}`)
    }
    const parsed = chunkSchema.safeParse(json)
    if (!parsed.success) throw this.malformed(`unexpected chunk shape: ${parsed.error.issues[0]?.message ?? ''}`)
    const chunk = parsed.data
    if (chunk.error !== undefined && chunk.error !== null) {
      throw this.malformed(`error in stream: ${JSON.stringify(chunk.error).slice(0, 200)}`)
    }
    this.sawAny = true
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta
      if (d?.content) out.push({ type: 'text', delta: d.content })
      d?.tool_calls?.forEach((tc, pos) => this.toolDelta(tc, pos))
      if (choice.finish_reason) this.finish = mapFinish(choice.finish_reason)
    }
    const u = chunk.usage
    if (u && (typeof u.prompt_tokens === 'number' || typeof u.completion_tokens === 'number')) {
      out.push({
        type: 'usage',
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      })
    }
  }

  private toolDelta(tc: z.infer<typeof toolCallDelta>, pos: number): void {
    let key: string
    if (tc.index !== undefined) key = `i${tc.index}`
    else if (tc.id) key = `id:${tc.id}`
    else if (this.lastKey !== null && pos === 0) key = this.lastKey
    else key = `p${this.order.length}`
    let c = this.calls.get(key)
    if (!c) {
      c = { id: null, name: '', args: '' }
      this.calls.set(key, c)
      this.order.push(key)
    }
    if (tc.id) c.id = tc.id
    if (tc.function?.name) c.name = c.name.length === 0 ? tc.function.name : c.name
    if (tc.function?.arguments) c.args += tc.function.arguments
    this.lastKey = key
  }

  /** Tool calls are emitted only at the end of the stream, when their arguments are complete. */
  private flushCalls(out: ModelEvent[]): void {
    for (const key of this.order) {
      const c = this.calls.get(key)
      if (!c) continue
      if (c.name.length === 0) throw this.malformed('tool call without a function name')
      out.push({ type: 'tool_call', call: { id: c.id ?? this.newId(), name: c.name, argsJson: c.args } })
    }
  }
}

export class OpenAICompatProvider implements ModelProvider {
  readonly id: ProviderId
  private readonly cfg: OpenAICompatConfig

  constructor(cfg: OpenAICompatConfig) {
    this.id = cfg.id
    this.cfg = cfg
  }

  private err(kind: ProviderErrorInfo['kind'], message: string, status: number | null = null, retryAfterMs: number | null = null): ProviderError {
    return new ProviderError({ provider: this.id, status, retryAfterMs, kind }, `${this.id}: ${message}`)
  }

  async *complete(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    const doFetch = this.cfg.fetch ?? globalThis.fetch
    const now = this.cfg.now ?? Date.now
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...this.cfg.headers,
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(req)),
        signal,
      })
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? e
      throw this.err('network', `request failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch {
        // ignore: the status is what matters
      }
      throw this.err(
        kindForStatus(res.status),
        `HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after'), now()),
      )
    }
    if (!res.body) throw this.err('malformed', 'response has no body', res.status)

    let n = 0
    const parser = new ChatStreamParser(
      (m) => this.err('malformed', m, res.status),
      this.cfg.newId ?? (() => `call_${crypto.randomUUID()}_${n++}`),
    )
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>
        try {
          chunk = await reader.read()
        } catch (e) {
          if (signal.aborted) throw signal.reason ?? e
          throw this.err('network', `stream read failed: ${e instanceof Error ? e.message : String(e)}`, res.status)
        }
        if (chunk.done) break
        for (const e of parser.push(chunk.value)) yield e
        if (parser.done) break
      }
      for (const e of parser.end()) yield e
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }
}
