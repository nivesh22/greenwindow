import { describe, expect, it } from 'vitest'
import { MemoryUserStore } from '../store/user_types.js'
import { lookupDevice } from './lookup_device.js'
import { makeCtx } from './testing.js'

const USER = '00000000-0000-4000-8000-0000000000aa'

async function storeWithDishwasher(): Promise<MemoryUserStore> {
  const users = new MemoryUserStore()
  await users.saveDevice({ userId: USER, name: 'Dishwasher', kw: 1.4, typicalHours: 3, sourceDeviceId: 'dishwasher' })
  return users
}

describe('lookup_device with saved devices (J3)', () => {
  it("puts the signed-in user's saved device first, not assumed", async () => {
    const users = await storeWithDishwasher()
    const out = await lookupDevice.handler(makeCtx({ userId: USER, isAnonymous: false, users }), { query: 'dishwasher' })
    expect(out.matches[0]).toMatchObject({ name: 'Dishwasher', kw: 1.4, typical_hours: 3, assumed: false, source: 'your saved device' })
    expect(out.matches.slice(1).every((m) => m.assumed)).toBe(true)
    expect(out.matches.length).toBeLessThanOrEqual(3)
    lookupDevice.output.parse(out)
  })

  it('ignores saved devices for anonymous users and unrelated queries', async () => {
    const users = await storeWithDishwasher()
    const anon = await lookupDevice.handler(makeCtx({ userId: USER, isAnonymous: true, users }), { query: 'dishwasher' })
    expect(anon.matches.every((m) => m.assumed)).toBe(true)
    const other = await lookupDevice.handler(makeCtx({ userId: USER, isAnonymous: false, users }), { query: 'EV charger' })
    expect(other.matches.every((m) => m.assumed)).toBe(true)
  })

  it('falls back to typical values when the user store fails', async () => {
    const users = await storeWithDishwasher()
    users.listDevices = async () => {
      throw new Error('db down')
    }
    const out = await lookupDevice.handler(makeCtx({ userId: USER, isAnonymous: false, users }), { query: 'dishwasher' })
    expect(out.matches[0]?.assumed).toBe(true)
  })
})
