import { describe, expect, it } from 'vitest'
import { MemoryStore, type Store } from '../../agent/store/types.js'
import { createHealthHandler } from '../health.js'

const NOW = Date.UTC(2026, 9, 8, 10)
const get = (q = '', method = 'GET') => new Request(`https://x.test/api/health${q}`, { method })

describe('health handler', () => {
  it('plain GET returns ok without touching the store', async () => {
    const h = createHealthHandler(() => {
      throw new Error('should not be called')
    })
    expect(await (await h(get())).json()).toEqual({ ok: true })
  })

  it('rejects non-GET', async () => {
    expect((await createHealthHandler(() => null)(get('', 'POST'))).status).toBe(405)
  })

  it('?db=1 returns month and paused only, never amounts', async () => {
    const store = new MemoryStore()
    await store.addSpend(NOW, 3.21, 5)
    const r = await createHealthHandler(() => store, () => NOW)(get('?db=1'))
    const text = await r.text()
    expect(JSON.parse(text)).toEqual({ ok: true, db: 'ok', budget: { month: '2026-10', paused: false } })
    expect(text).not.toContain('3.21')
    expect(text).not.toContain('spent')
  })

  it('reports paused after the limit is reached', async () => {
    const store = new MemoryStore()
    await store.addSpend(NOW, 5, 5)
    const r = await createHealthHandler(() => store, () => NOW)(get('?db=1'))
    expect(((await r.json()) as { budget: { paused: boolean } }).budget.paused).toBe(true)
  })

  it('db error and missing config give ok:false', async () => {
    const bad: Store = Object.assign(new MemoryStore(), { budget: () => Promise.reject(new Error('down')) })
    expect(await (await createHealthHandler(() => bad)(get('?db=1'))).json()).toEqual({ ok: false, db: 'error' })
    expect(await (await createHealthHandler(() => null)(get('?db=1'))).json()).toEqual({ ok: false, db: 'error' })
  })
})
