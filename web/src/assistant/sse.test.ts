import { encodeSse, type SseEvent } from '../../agent/harness/events'
import { parseSse, type SseItem } from './sse'
import { EMPTY_TRACE, streamOf } from './testing'

async function collect(chunks: (string | Uint8Array)[]): Promise<SseItem[]> {
  const out: SseItem[] = []
  for await (const i of parseSse(streamOf(chunks))) out.push(i)
  return out
}

const answer: SseEvent = { type: 'answer', data: { text: 'Héllo — 你好 🌱' } }
const done: SseEvent = { type: 'done', data: { turn_id: 't', stop_reason: 'final', trace: EMPTY_TRACE } }

describe('parseSse', () => {
  it('parses events delivered whole', async () => {
    const items = await collect([encodeSse(answer) + encodeSse(done)])
    expect(items.map((i) => i.ok && i.event.type)).toEqual(['answer', 'done'])
  })

  it('handles chunks split at every byte, including mid-UTF8', async () => {
    const bytes = new TextEncoder().encode(encodeSse(answer) + encodeSse(done))
    const items = await collect(Array.from(bytes, (b) => new Uint8Array([b])))
    expect(items).toHaveLength(2)
    const first = items[0]
    expect(first?.ok && first.event.type === 'answer' && first.event.data.text).toBe('Héllo — 你好 🌱')
  })

  it('handles CRLF, even when CR and LF arrive in separate chunks', async () => {
    const wire = encodeSse(answer).replace(/\n/g, '\r\n')
    const items = await collect([wire.slice(0, wire.length - 3), '\r', '\n', wire.slice(wire.length - 2)])
    expect(items).toHaveLength(1)
    expect(items[0]?.ok).toBe(true)
  })

  it('ignores comment heartbeats and unknown fields', async () => {
    const items = await collect([': ping\n\n', 'id: 7\nretry: 100\n', ': hb\n', encodeSse(answer)])
    expect(items).toHaveLength(1)
  })

  it('joins multi-line data with newlines', async () => {
    const json = JSON.stringify({ text: 'a\nb' }, null, 1).split('\n')
    const items = await collect(['event: answer\n' + json.map((l) => `data: ${l}\n`).join('') + '\n'])
    const first = items[0]
    expect(first?.ok && first.event.type === 'answer' && first.event.data.text).toBe('a\nb')
  })

  it('reports invalid JSON, schema violations and unknown types as parse errors, then continues', async () => {
    const items = await collect([
      'event: answer\ndata: {not json\n\n',
      'event: answer\ndata: {"text": 5}\n\n',
      'event: mystery\ndata: {}\n\n',
      encodeSse(answer),
    ])
    expect(items.map((i) => i.ok)).toEqual([false, false, false, true])
    const bad = items[0]
    expect(!bad?.ok && bad?.error.kind).toBe('parse_error')
  })

  it('drops an incomplete trailing event', async () => {
    const items = await collect([encodeSse(answer), 'event: done\ndata: {"turn_id"'])
    expect(items).toHaveLength(1)
  })
})
