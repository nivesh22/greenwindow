import { ev, providerError, ScriptedProvider } from './scripted.js'
import type { ModelEvent, ModelRequest } from './types.js'

const req: ModelRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10, temperature: 0 }

async function drain(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('ScriptedProvider', () => {
  it('plays back steps in order and records requests', async () => {
    const p = new ScriptedProvider([[ev.text('a'), ev.finish()], [ev.text('b'), ev.finish()]])
    const s = new AbortController().signal
    expect(await drain(p.complete(req, s))).toEqual([ev.text('a'), ev.finish()])
    expect(await drain(p.complete({ ...req, model: 'n' }, s))).toEqual([ev.text('b'), ev.finish()])
    expect(p.requests.map((r) => r.model)).toEqual(['m', 'n'])
    await expect(drain(p.complete(req, s))).rejects.toThrow(/exhausted/)
  })

  it('throws on call N without consuming a step, and supports mid-stream errors', async () => {
    const err = providerError('server', { status: 500 })
    const p = new ScriptedProvider([{ events: [ev.text('x')], error: err }, [ev.finish()]]).failOnCall(1, providerError('network'))
    const s = new AbortController().signal
    await expect(drain(p.complete(req, s))).rejects.toMatchObject({ info: { kind: 'network' } })
    const got: ModelEvent[] = []
    await expect(
      (async () => {
        for await (const e of p.complete(req, s)) got.push(e)
      })(),
    ).rejects.toBe(err)
    expect(got).toEqual([ev.text('x')])
    expect(await drain(p.complete(req, s))).toEqual([ev.finish()])
  })
})
