// Replays a real Gemini OpenAI-compat stream (recorded 2026-10-08, docs/spikes.md live checks) through the parser.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ProviderError } from '../harness/errors.js'
import { ChatStreamParser, toWireMessage } from './openai_compat.js'
import type { ModelEvent } from './types.js'

const raw = readFileSync(join(import.meta.dirname, 'fixtures', 'gemini-3.5-flash-lite.tool_call.sse'), 'utf8')
const malformed = (m: string) => new ProviderError({ provider: 'gemini-direct', status: null, retryAfterMs: null, kind: 'malformed' }, m)

function parse(chunkSize: number): ModelEvent[] {
  const p = new ChatStreamParser(malformed, () => 'generated')
  const out: ModelEvent[] = []
  for (let i = 0; i < raw.length; i += chunkSize) out.push(...p.push(raw.slice(i, i + chunkSize)))
  return [...out, ...p.end()]
}

describe('real Gemini stream', () => {
  it.each([raw.length, 7])('yields one tool call, usage once, finish tool_calls (chunk %i)', (size) => {
    const evs = parse(size)
    expect(evs.map((e) => e.type)).toEqual(['tool_call', 'usage', 'finish'])
    const call = evs[0]?.type === 'tool_call' ? evs[0].call : null
    expect(call?.name).toBe('recommend_window')
    expect(JSON.parse(call?.argsJson ?? '')).toEqual({ deadline_local: '2026-10-09T07:00', duration_h: 6, power_kw: 7 })
    expect(call?.extra).toHaveProperty('google.thought_signature')
    expect(evs[1]).toEqual({ type: 'usage', inputTokens: 118, outputTokens: 45, cachedInputTokens: 0 })
    expect(evs[2]).toEqual({ type: 'finish', reason: 'tool_calls' })
  })

  it('echoes the thought signature back on the assistant message', () => {
    const call = parse(raw.length).find((e) => e.type === 'tool_call')
    if (call?.type !== 'tool_call') throw new Error('no call')
    const wire = toWireMessage({ role: 'assistant', content: '', toolCalls: [call.call] })
    expect(wire).toMatchObject({ tool_calls: [{ extra_content: { google: { thought_signature: expect.any(String) } } }] })
  })
})

it('counts reasoning tokens (total - prompt) as output when completion_tokens leaves them out', () => {
  const p = new ChatStreamParser(malformed, () => 'id')
  const line = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 137 } })
  const evs = [...p.push(`${line}

data: [DONE]

`), ...p.end()]
  expect(evs).toContainEqual({ type: 'usage', inputTokens: 21, outputTokens: 116, cachedInputTokens: 0 })
})
