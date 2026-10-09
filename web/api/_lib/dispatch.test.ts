import { describe, expect, it } from 'vitest'
import { dispatcher, routeName } from './dispatch.js'

const U = (p: string) => `https://example.vercel.app${p}`

describe('routeName', () => {
  it.each([
    ['/api/plans', 'plans'],
    ['/api/plans?id=1', 'plans'],
    ['/api/user/plans', 'plans'],
    ['/api/push/subscribe', 'push-subscribe'],
    ['/api/user/push-subscribe', 'push-subscribe'],
    ['/api/reminders', 'reminders'],
    ['/api/user/reminders/', 'reminders'],
  ])('user %s -> %s', (p, name) => expect(routeName(U(p), 'user')).toBe(name))

  it('reads the rewritten ?route= form and keeps other query params', () => {
    expect(routeName(U('/api/user?route=plans&id=7'), 'user')).toBe('plans')
    expect(routeName(U('/api/cron?route=ledger'), 'cron')).toBe('ledger')
    expect(routeName(U('/api/admin?route=trace&turn_id=x'), 'admin')).toBe('trace')
    expect(routeName(U('/api/admin?route=../x'), 'admin')).toBeNull()
    expect(routeName(U('/api/user?route=plans'), 'admin')).toBeNull()
  })

  it('maps cron and admin paths', () => {
    expect(routeName(U('/api/cron/reminders'), 'cron')).toBe('reminders')
    expect(routeName(U('/api/admin/trace?turn_id=x'), 'admin')).toBe('trace')
    expect(routeName(U('/api/admin/ops'), 'cron')).toBeNull()
    expect(routeName(U('/api/chat'), 'user')).toBeNull()
  })
})

describe('dispatcher', () => {
  const ok = (body: string) => ({ fetch: async () => new Response(body) })
  const d = dispatcher('cron', { reminders: ok('r'), ledger: ok('l') })

  it('forwards by name', async () => {
    expect(await (await d.fetch(new Request(U('/api/cron/ledger'), { method: 'POST' }))).text()).toBe('l')
  })

  it('404s unknown and prototype names', async () => {
    expect((await d.fetch(new Request(U('/api/cron/nope')))).status).toBe(404)
    expect((await d.fetch(new Request(U('/api/cron/constructor')))).status).toBe(404)
  })
})
