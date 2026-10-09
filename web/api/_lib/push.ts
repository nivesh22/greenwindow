// Web Push sender (web-push 3.6.7). API per the installed @types/web-push:
//   sendNotification(subscription: {endpoint, keys:{p256dh, auth}}, payload?: string, options?: RequestOptions)
//   RequestOptions.vapidDetails = {subject, publicKey, privateKey}; TTL in seconds; urgency; timeout in ms.
// It rejects with WebPushError (statusCode, body, endpoint) on a non-2xx answer from the push service.
export interface PushTarget {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** Resolves on success; rejects with an error carrying `statusCode` when the push service refuses. */
export type PushSender = (target: PushTarget, payload: string) => Promise<void>

export interface Vapid {
  subject: string
  publicKey: string
  privateKey: string
}

export function statusOf(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') return err.statusCode
  return null
}

/** Real sender. web-push is imported lazily so tests and cold starts of other endpoints never load it. */
export function createWebPushSender(vapid: Vapid, opts: { ttlSeconds?: number; timeoutMs?: number } = {}): PushSender {
  return async (target, payload) => {
    const mod = await import('web-push')
    // CommonJS module: named exports are on the namespace in Node ESM, on `default` in some bundlers.
    const wp = typeof mod.sendNotification === 'function' ? mod : (mod as unknown as { default: typeof mod }).default
    await wp.sendNotification(target, payload, {
      vapidDetails: vapid,
      TTL: opts.ttlSeconds ?? 600,
      urgency: 'high',
      timeout: opts.timeoutMs ?? 8000,
    })
  }
}
