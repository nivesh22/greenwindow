import { MemoryUserStore } from './user_types.js'

const NOW = Date.parse('2026-10-09T10:00:00Z')

describe('MemoryUserStore', () => {
  it('never hands one user another user\'s conversation', async () => {
    const s = new MemoryUserStore()
    const a = await s.ensureConversation('u1', null, NOW)
    const b = await s.ensureConversation('u2', a.id, NOW)
    expect(b.id).not.toBe(a.id)
    expect(await s.loadConversation('u2', a.id, 10)).toBeNull()
  })

  it('deleteUserData removes everything of that user and nothing else', async () => {
    const s = new MemoryUserStore()
    for (const u of ['u1', 'u2']) {
      const c = await s.ensureConversation(u, null, NOW)
      await s.appendMessages(u, c.id, [{ role: 'user', content: 'hi', turnId: null }], NOW)
      await s.saveDevice({ userId: u, name: 'EV', kw: 7, typicalHours: 6, sourceDeviceId: null })
      await s.upsertProfile({ userId: u, displayName: null, riskDefault: 'expected', quietFrom: null, quietTo: null })
    }
    await s.deleteUserData('u1')
    expect(s.conversations.map((c) => c.userId)).toEqual(['u2'])
    expect(s.messages).toHaveLength(1)
    expect(await s.listDevices('u1')).toEqual([])
    expect(await s.getProfile('u2')).not.toBeNull()
  })

  it('reassign moves an anonymous user\'s conversation to the signed-in user', async () => {
    const s = new MemoryUserStore()
    const c = await s.ensureConversation('anon', null, NOW)
    await s.reassign('anon', 'google')
    expect((await s.loadConversation('google', c.id, 10))?.conversation.id).toBe(c.id)
  })
})
