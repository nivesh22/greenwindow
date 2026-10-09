import { disablePush, enablePush, getPushStatus, urlBase64ToUint8Array } from './push'

const SUB = { endpoint: 'https://push.example/abc', keys: { p256dh: 'pk', auth: 'ak' } }

interface Fakes {
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
  existing: { current: unknown }
}

function install(permission: NotificationPermission = 'granted'): Fakes {
  const existing: { current: unknown } = { current: null }
  const unsubscribe = vi.fn(() => Promise.resolve(true))
  const mkSub = () => ({ endpoint: SUB.endpoint, toJSON: () => SUB, unsubscribe })
  const subscribe = vi.fn(() => {
    existing.current = mkSub()
    return Promise.resolve(existing.current)
  })
  const pushManager = { subscribe, getSubscription: vi.fn(() => Promise.resolve(existing.current)) }
  const reg = { pushManager }
  const register = vi.fn(() => Promise.resolve(reg))
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register, ready: Promise.resolve(reg), getRegistration: vi.fn(() => Promise.resolve(reg)) },
  })
  vi.stubGlobal('PushManager', class {})
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn(() => Promise.resolve(permission)) })
  return { subscribe, unsubscribe, register, existing }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 without padding', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3])
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255])
  })
})

describe('push opt-in', () => {
  it('reports unsupported when the APIs are missing', async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
    expect(await getPushStatus()).toBe('unsupported')
    const r = await enablePush()
    expect(r).toMatchObject({ ok: false, reason: 'unsupported' })
    expect(!r.ok && r.message).toMatch(/Home Screen/)
  })

  it('registers /sw.js, subscribes with the VAPID key and userVisibleOnly, and POSTs the subscription', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'AQID')
    const f = install()
    const m = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })))
    vi.stubGlobal('fetch', m)
    expect(await enablePush()).toEqual({ ok: true })
    expect(f.register).toHaveBeenCalledWith('/sw.js')
    const arg = f.subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array }
    expect(arg.userVisibleOnly).toBe(true)
    expect(Array.from(arg.applicationServerKey)).toEqual([1, 2, 3])
    const [url, init] = m.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/push/subscribe')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ subscription: SUB })
    expect(await getPushStatus()).toBe('on')
  })

  it('does not subscribe when permission is denied or the key is missing', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'AQID')
    const f = install('denied')
    expect(await enablePush()).toMatchObject({ ok: false, reason: 'denied' })
    expect(f.subscribe).not.toHaveBeenCalled()
    expect(await getPushStatus()).toBe('denied')
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '')
    install()
    expect(await enablePush()).toMatchObject({ ok: false, reason: 'no_key' })
  })

  it('rolls the browser subscription back when the server refuses it', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'AQID')
    const f = install()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))))
    const r = await enablePush()
    expect(r).toMatchObject({ ok: false, reason: 'failed' })
    expect(f.unsubscribe).toHaveBeenCalled()
  })

  it('disable DELETEs the endpoint then unsubscribes', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'AQID')
    const f = install()
    const m = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })))
    vi.stubGlobal('fetch', m)
    await enablePush()
    m.mockClear()
    expect(await disablePush()).toEqual({ ok: true })
    const [, init] = m.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body as string)).toEqual({ endpoint: SUB.endpoint })
    expect(f.unsubscribe).toHaveBeenCalled()
  })
})
