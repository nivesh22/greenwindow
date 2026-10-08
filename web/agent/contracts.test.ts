import { z } from 'zod'
import { costUsd, loadConfig } from './config'
import { encodeSse, sseEventSchema } from './harness/events'
import { defineTool, ToolRegistry } from './tools/registry'
import { MemoryStore } from './store/types'

const NOW = Date.parse('2026-10-06T00:30:00Z')
const args = { userId: null, ipHash: 'h', isAnonymous: true, dailyCap: 20, anonCap: 3, ipHourlyCap: 2, globalDailyCap: 100, nowMs: NOW }

describe('MemoryStore', () => {
  it('enforces the per-IP hourly cap', async () => {
    const s = new MemoryStore()
    expect((await s.consumeMessage(args)).allowed).toBe(true)
    expect((await s.consumeMessage(args)).allowed).toBe(true)
    expect(await s.consumeMessage(args)).toEqual({ allowed: false, kind: 'rate', messagesLeft: null })
  })

  it('caps anonymous users and reports messages left', async () => {
    const s = new MemoryStore()
    const a = { ...args, userId: 'u1', ipHourlyCap: 100 }
    expect((await s.consumeMessage(a)).messagesLeft).toBe(2)
    await s.consumeMessage(a)
    await s.consumeMessage(a)
    expect(await s.consumeMessage(a)).toEqual({ allowed: false, kind: 'anon_limit', messagesLeft: 0 })
  })

  it('pauses when spend reaches the monthly limit', async () => {
    const s = new MemoryStore()
    expect((await s.addSpend(NOW, 4, 5)).paused).toBe(false)
    expect((await s.addSpend(NOW, 1, 5)).paused).toBe(true)
    expect((await s.consumeMessage(args)).kind).toBe('budget_paused')
  })
})

describe('contracts', () => {
  it('registry produces provider specs without $schema', () => {
    const t = defineTool({
      name: 'echo', description: 'test', input: z.strictObject({ x: z.number() }), output: z.object({ x: z.number() }),
      auth: 'anon', sideEffect: false, phase: 'P1', intents: 'all', statusText: 'Echoing…',
      handler: async (_ctx, i) => i,
    })
    const [spec] = new ToolRegistry([t]).specs([t])
    expect(spec?.parameters).not.toHaveProperty('$schema')
    expect(spec?.parameters).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('SSE events round-trip through the schema', () => {
    const ev = { type: 'answer', data: { text: 'hi' } } as const
    const wire = encodeSse(ev)
    expect(wire).toBe('event: answer\ndata: {"text":"hi"}\n\n')
    expect(sseEventSchema.parse({ type: 'answer', data: JSON.parse(wire.split('data: ')[1]!) })).toEqual(ev)
  })

  it('config has defaults and prices unknown models at the worst case', () => {
    expect(loadConfig({}).MAX_STEPS).toBe(6)
    expect(costUsd('gemini-3.8-flash', 1e6, 1e6)).toBe(0)
    expect(costUsd('unknown-model', 1e6, 0)).toBe(1)
  })
})
