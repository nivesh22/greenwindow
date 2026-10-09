// GreenWindow push service worker. Deliberately tiny: it handles push notifications only and caches nothing,
// so it can never serve stale app files.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'GreenWindow'
  const body = typeof data.body === 'string' ? data.body : ''
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/scheduler'
  event.waitUntil(self.registration.showNotification(title, { body, icon: '/favicon.svg', data: { url } }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL((event.notification.data && event.notification.data.url) || '/scheduler', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if ('navigate' in c) c.navigate(target)
          return c.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
