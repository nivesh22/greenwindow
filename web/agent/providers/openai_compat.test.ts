// Hand-written SSE fixtures in the OpenAI Chat Completions stream format. Recorded Gemini/gateway fixtures replace
// or extend these in P1a.5 (spike S3) and P1b (S4).
import { ProviderError } from '../harness/errors'
import { buildRequestBody, OpenAICompatProvider, parseRetryAfter } from './openai_compat'
import type { ModelEvent, ModelRequest } from './types'

const req: ModelRequest = {
  model: 'gemini-3.8-flash',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'when?' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_forecast', argsJson: '{"h":24}' }] },
    { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' },
  ],
  tools: [{ name: 'get_forecast', description: 'd', parameters: { type: 'object', properties: {} } }],
  toolChoice: 'auto',
  maxOutputTokens: 800,
  temperature: 0.2,
}

const data = (o: unknown): string => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`
const delta = (d: Record<string, unknown>, finish: string | null = null): string =>
  data({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] })
const usage = (p: number, c: number, cached?: number): string =>
  data({ choices: [], usage: { prompt_tokens: p, completion_tokens: c, ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}) } })
const DONE = 'data: [DONE]\n\n'

interface Captured {
  url: string
  init: RequestInit
}

/** A fetch stub that streams `parts` as separate body chunks (so tests can split mid-line). */
function stubFetch(parts: string[] | { status: number; body?: string; headers?: Record<string, string> }, captured: Captured[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    if (!Array.isArray(parts)) return new Response(parts.body ?? '', { status: parts.status, headers: parts.headers })
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p))
        c.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
}

function provider(f: typeof fetch): OpenAICompatProvider {
  let n = 0
  return new OpenAICompatProvider({
    id: 'gemini-direct',
    baseUrl: 'https://example.test/v1beta/openai/',
    apiKey: 'k',
    headers: { 'x-extra': '1' },
    fetch: f,
    newId: () => `gen_${++n}`,
    now: () => Date.parse('2026-10-08T12:00:00Z'),
  })
}

async function run(parts: Parameters<typeof stubFetch>[0], captured?: Captured[]): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const e of provider(stubFetch(parts, captured)).complete(req, new AbortController().signal)) out.push(e)
  return out
}

async function runErr(parts: Parameters<typeof stubFetch>[0]): Promise<ProviderError> {
  try {
    await run(parts)
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError)
    return e as ProviderError
  }
  throw new Error('expected a ProviderError')
}

describe('buildRequestBody', () => {
  it('maps messages, tools and options to the OpenAI wire format', () => {
    const b = buildRequestBody({ ...req, responseFormat: 'json' })
    expect(b).toMatchObject({
      model: 'gemini-3.8-flash',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 800,
      temperature: 0.2,
      tool_choice: 'auto',
      response_format: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'get_forecast', description: 'd', parameters: { type: 'object', properties: {} } } }],
    })
    expect(b.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'when?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_forecast', arguments: '{"h":24}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    ])
  })

  it('omits tools, tool_choice and response_format when not asked', () => {
    const b = buildRequestBody({ model: 'm', messages: [], maxOutputTokens: 1, temperature: 0 })
    expect(b).not.toHaveProperty('tools')
    expect(b).not.toHaveProperty('tool_choice')
    expect(b).not.toHaveProperty('response_format')
  })
})

describe('OpenAICompatProvider stream parsing', () => {
  it('posts to {baseUrl}/chat/completions with bearer auth and extra headers', async () => {
    const cap: Captured[] = []
    await run([delta({ content: 'hi' }, 'stop'), DONE], cap)
    expect(cap[0]?.url).toBe('https://example.test/v1beta/openai/chat/completions')
    const h = cap[0]?.init.headers as Record<string, string>
    expect(h.authorization).toBe('Bearer k')
    expect(h['x-extra']).toBe('1')
    expect(JSON.parse(String(cap[0]?.init.body))).toMatchObject({ stream: true })
  })

  it('text only, split mid-line across body chunks, CRLF line endings', async () => {
    const wire = (delta({ role: 'assistant', content: 'Run it ' }) + delta({ content: 'at 02:00.' }) + delta({}, 'stop') + DONE).replace(/\n/g, '\r\n')
    const parts = [wire.slice(0, 17), wire.slice(17, 60), wire.slice(60, 61), wire.slice(61)]
    expect(await run(parts)).toEqual([
      { type: 'text', delta: 'Run it ' },
      { type: 'text', delta: 'at 02:00.' },
      { type: 'finish', reason: 'stop' },
    ])
  })

  it('accumulates a fragmented tool call by index and emits it once at the end', async () => {
    const events = await run([
      delta({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'recommend_window', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"duration' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '_h":3}' } }] }),
      delta({}, 'tool_calls'),
      usage(500, 20),
      DONE,
    ])
    expect(events).toEqual([
      { type: 'usage', inputTokens: 500, outputTokens: 20, cachedInputTokens: 0 },
      { type: 'tool_call', call: { id: 'call_1', name: 'recommend_window', argsJson: '{"duration_h":3}' } },
      { type: 'finish', reason: 'tool_calls' },
    ])
  })

  it('handles two parallel tool calls with interleaved fragments', async () => {
    const events = await run([
      delta({ tool_calls: [
        { index: 0, id: 'a', function: { name: 'get_forecast', arguments: '{"hours"' } },
        { index: 1, id: 'b', function: { name: 'lookup_device', arguments: '{"q":' } },
      ] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: '"kettle"}' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ':48}' } }] }),
      delta({}, 'tool_calls'),
      DONE,
    ])
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'a', name: 'get_forecast', argsJson: '{"hours":48}' } },
      { type: 'tool_call', call: { id: 'b', name: 'lookup_device', argsJson: '{"q":"kettle"}' } },
    ])
  })

  it('tolerates a whole tool call in one chunk without index or id, and finish_reason "stop"', async () => {
    const events = await run([
      delta({ tool_calls: [{ function: { name: 'get_forecast', arguments: '{}' } }, { function: { name: 'lookup_device', arguments: '{"q":"ev"}' } }] }, 'stop'),
      DONE,
    ])
    expect(events).toEqual([
      { type: 'tool_call', call: { id: 'gen_1', name: 'get_forecast', argsJson: '{}' } },
      { type: 'tool_call', call: { id: 'gen_2', name: 'lookup_device', argsJson: '{"q":"ev"}' } },
      { type: 'finish', reason: 'tool_calls' },
    ])
  })

  it('emits usage (with cached tokens) from the usage chunk', async () => {
    const events = await run([delta({ content: 'ok' }, 'stop'), usage(1200, 40, 1000), DONE])
    expect(events).toContainEqual({ type: 'usage', inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1000 })
  })

  it('emits no usage event when the provider sends none, and tolerates a missing [DONE]', async () => {
    const events = await run([delta({ content: 'ok' }), data({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: null })])
    expect(events).toEqual([{ type: 'text', delta: 'ok' }, { type: 'finish', reason: 'length' }])
  })

  it('ignores SSE comments and non-data fields', async () => {
    const events = await run([': keep-alive\n\n', 'event: message\n', delta({ content: 'x' }, 'stop'), DONE])
    expect(events).toEqual([{ type: 'text', delta: 'x' }, { type: 'finish', reason: 'stop' }])
  })
})

describe('OpenAICompatProvider errors', () => {
  it('429 → rate_limit with Retry-After seconds', async () => {
    const e = await runErr({ status: 429, body: '{"error":"quota"}', headers: { 'retry-after': '7' } })
    expect(e.info).toEqual({ provider: 'gemini-direct', status: 429, retryAfterMs: 7000, kind: 'rate_limit' })
    expect(e.retryable).toBe(false)
    expect(e.message).not.toContain('Bearer')
  })

  it('500 → server (retryable), 408 → timeout, 400 → client', async () => {
    const e500 = await runErr({ status: 500, body: 'oops' })
    expect(e500.info).toMatchObject({ kind: 'server', status: 500, retryAfterMs: null })
    expect(e500.retryable).toBe(true)
    expect((await runErr({ status: 408 })).info.kind).toBe('timeout')
    expect((await runErr({ status: 400 })).info.kind).toBe('client')
  })

  it('network failure → network', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const p = provider(f)
    await expect(p.complete(req, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      info: { kind: 'network', status: null },
    })
  })

  it('malformed JSON line → malformed, after earlier events were yielded', async () => {
    const got: ModelEvent[] = []
    const p = provider(stubFetch([delta({ content: 'a' }), 'data: {"choices":[{"delta":\n\n', DONE]))
    await expect(
      (async () => {
        for await (const e of p.complete(req, new AbortController().signal)) got.push(e)
      })(),
    ).rejects.toMatchObject({ info: { kind: 'malformed' } })
    expect(got).toEqual([{ type: 'text', delta: 'a' }])
  })

  it('a stream cut off without finish_reason or [DONE] → malformed', async () => {
    expect((await runErr([delta({ content: 'a' })])).info.kind).toBe('malformed')
  })

  it('an error object inside the stream → malformed', async () => {
    expect((await runErr([data({ error: { code: 500, message: 'x' } })])).info.kind).toBe('malformed')
  })

  it('rethrows the abort reason instead of a ProviderError', async () => {
    const ctrl = new AbortController()
    const reason = new Error('stop')
    ctrl.abort(reason)
    const f = (async (_u: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return new Response('')
    }) as typeof fetch
    await expect(provider(f).complete(req, ctrl.signal)[Symbol.asyncIterator]().next()).rejects.toBe(reason)
  })
})

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('2', now)).toBe(2000)
    expect(parseRetryAfter('Thu, 08 Oct 2026 12:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('soon', now)).toBeNull()
    expect(parseRetryAfter(null, now)).toBeNull()
  })
})
