import { describe, expect, it } from 'vitest'
import { googleName } from '../../api/_lib/auth.js'
import { seedDisplayName } from './seed_name.js'
import { MemoryUserStore } from './user_types.js'

const U = '44444444-4444-4444-8444-444444444444'

describe('googleName', () => {
  it('prefers user_metadata, falls back to the google identity, ignores junk', () => {
    expect(googleName({ user_metadata: { full_name: 'Ada Lovelace', name: 'x' } })).toBe('Ada Lovelace')
    expect(googleName({ user_metadata: { name: 'Ada' } })).toBe('Ada')
    expect(googleName({ user_metadata: {}, identities: [{ provider: 'anonymous' }, { provider: 'google', identity_data: { full_name: 'G' } }] })).toBe('G')
    expect(googleName({ user_metadata: { full_name: 42 }, identities: 'no' })).toBeNull()
    expect(googleName({ user_metadata: { full_name: 'x'.repeat(100) } })).toHaveLength(60)
    expect(googleName(null)).toBeNull()
  })
})

describe('seedDisplayName', () => {
  it('seeds only signed-in users with a name and an empty display_name, keeping other fields', async () => {
    const users = new MemoryUserStore()
    expect(await seedDisplayName(users, { userId: U, isAnonymous: true, email: null, name: 'Guest' }, null)).toBeNull()
    expect(await seedDisplayName(users, { userId: U, isAnonymous: false, email: 'a@b.c', name: null }, null)).toBeNull()
    const existing = { userId: U, displayName: null, riskDefault: 'cautious' as const, quietFrom: '22:00', quietTo: '07:00' }
    const seeded = await seedDisplayName(users, { userId: U, isAnonymous: false, email: 'a@b.c', name: 'Ada' }, existing)
    expect(seeded).toEqual({ ...existing, displayName: 'Ada' })
    const kept = await seedDisplayName(users, { userId: U, isAnonymous: false, email: 'a@b.c', name: 'Other' }, seeded)
    expect(kept?.displayName).toBe('Ada')
  })

  it('returns the profile unchanged when the write fails', async () => {
    const failing = { upsertProfile: () => Promise.reject(new Error('down')) }
    expect(await seedDisplayName(failing, { userId: U, isAnonymous: false, email: null, name: 'Ada' }, null)).toBeNull()
  })
})
