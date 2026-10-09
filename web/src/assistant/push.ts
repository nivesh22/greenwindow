// Web Push opt-in (PRD FR-4.10, J6). Registers /sw.js, subscribes with the VAPID public key, and tells the server.
import { pushSubscribeRequestSchema, pushUnsubscribeRequestSchema } from '../../agent/harness/api_schemas'
import { apiFetch } from './auth'

export type PushStatus = 'unsupported' | 'denied' | 'off' | 'on'
export type PushResult = { ok: true } | { ok: false; reason: 'unsupported' | 'denied' | 'no_key' | 'failed'; message: string }

export const UNSUPPORTED_MESSAGE =
  'This browser cannot receive notifications. On iPhone or iPad, add GreenWindow to your Home Screen first (Share, then Add to Home Screen), then open it from there.'

const vapidKey = (): string | undefined => (import.meta.env as Record<string, string | undefined>).VITE_VAPID_PUBLIC_KEY

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** URL-safe base64 -> bytes, for PushManager's applicationServerKey. */
export function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const padded = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js')
  return navigator.serviceWorker.ready
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!isPushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    const sub = await reg?.pushManager.getSubscription()
    return sub && Notification.permission === 'granted' ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

export async function enablePush(): Promise<PushResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported', message: UNSUPPORTED_MESSAGE }
  const key = vapidKey()
  if (!key) return { ok: false, reason: 'no_key', message: 'Notifications are not configured on this deployment.' }
  try {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      return { ok: false, reason: 'denied', message: 'Notifications are blocked. Allow them in your browser settings for this site, then try again.' }
    }
    const reg = await registration()
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }))
    const body = pushSubscribeRequestSchema.parse({ subscription: sub.toJSON() })
    const res = await apiFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      await sub.unsubscribe().catch(() => false)
      return { ok: false, reason: 'failed', message: res.status === 401 || res.status === 403 ? 'Sign in to turn on notifications.' : `Could not save the subscription (HTTP ${res.status}).` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'failed', message: `Could not turn on notifications${e instanceof Error ? ` (${e.message})` : ''}.` }
  }
}

export async function disablePush(): Promise<PushResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported', message: UNSUPPORTED_MESSAGE }
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      const body = pushUnsubscribeRequestSchema.parse({ endpoint: sub.endpoint })
      const res = await apiFetch('/api/push/subscribe', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return { ok: false, reason: 'failed', message: `Could not turn off notifications (HTTP ${res.status}).` }
      await sub.unsubscribe()
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'failed', message: `Could not turn off notifications${e instanceof Error ? ` (${e.message})` : ''}.` }
  }
}
