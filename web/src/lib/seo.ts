// Per-route <title>, meta description and indexing. One source for the browser (Layout updates the head on
// navigation) and for the build-time prerender (scripts/prerender.mjs writes one HTML file per public page).

export const SITE_URL = 'https://greenwindow.uk'
const SUFFIX = ' — GreenWindow'

export interface PageMeta {
  title: string
  description: string
  /** false: private or utility page, sent with noindex and left out of the sitemap. */
  index: boolean
}

/** Public pages, in sitemap order. Keys are router paths. */
export const PUBLIC_PAGES: Record<string, PageMeta> = {
  '/': {
    title: 'GB grid carbon intensity forecast, next 48 hours — GreenWindow',
    description:
      'Hourly 48-hour forecasts of Great Britain grid carbon intensity with uncertainty ranges, from several models scored against NESO actuals.',
    index: true,
  },
  '/scheduler': {
    title: 'Plan a job for the cleanest hours on the GB grid' + SUFFIX,
    description:
      'Find the start time with the lowest forecast grid carbon intensity for flexible jobs like EV charging, laundry or batch computing in Great Britain.',
    index: true,
  },
  '/leaderboard': {
    title: 'Carbon intensity forecast model leaderboard' + SUFFIX,
    description:
      'Live accuracy of GB carbon intensity forecasts (Chronos-2, SARIMAX, ETS, Prophet and NESO) scored against actuals, always beside a seasonal-naive benchmark.',
    index: true,
  },
  '/backtest': {
    title: 'Carbon intensity forecast backtest results' + SUFFIX,
    description:
      'How GreenWindow forecasting models performed on 90 historical forecast origins for the Great Britain grid, by horizon, with error and coverage.',
    index: true,
  },
  '/about': {
    title: 'About GreenWindow, data sources and limits' + SUFFIX,
    description:
      'How GreenWindow forecasts GB grid carbon intensity: NESO and Open-Meteo data, the models, what the numbers mean and what they cannot tell you.',
    index: true,
  },
  '/privacy': { title: 'Privacy policy' + SUFFIX, description: 'What GreenWindow stores, why, for how long, and your rights.', index: true },
  '/terms': { title: 'Terms of service' + SUFFIX, description: 'The terms for using GreenWindow, a free GB grid carbon intensity forecast.', index: true },
}

const PRIVATE: Record<string, string> = {
  '/settings': 'Settings',
  '/account': 'Devices & schedule',
  '/ops': 'Ops',
}

export const NOT_FOUND: PageMeta = { title: 'Page not found' + SUFFIX, description: 'This page does not exist on GreenWindow.', index: false }

export function metaFor(path: string): PageMeta {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  const pub = PUBLIC_PAGES[p]
  if (pub) return pub
  const key = Object.keys(PRIVATE).find((k) => p === k || p.startsWith(`${k}/`))
  if (key) return { title: PRIVATE[key]! + SUFFIX, description: PUBLIC_PAGES['/']!.description, index: false }
  return NOT_FOUND
}

export function canonicalUrl(path: string): string {
  return SITE_URL + (path === '/' ? '/' : path.replace(/\/+$/, ''))
}

function headTag<T extends HTMLElement>(selector: string, create: () => T): T {
  const found = document.head.querySelector<T>(selector)
  if (found) return found
  const el = create()
  document.head.appendChild(el)
  return el
}

/** Browser: sets the title, description, canonical and robots tags for the current route. */
export function applyPageMeta(path: string): void {
  const meta = metaFor(path)
  document.title = meta.title
  headTag('meta[name="description"]', () => Object.assign(document.createElement('meta'), { name: 'description' })).content = meta.description
  const canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')
  if (meta.index) {
    headTag('link[rel="canonical"]', () => Object.assign(document.createElement('link'), { rel: 'canonical' })).href = canonicalUrl(path)
    robots?.remove()
  } else {
    canonical?.remove()
    headTag('meta[name="robots"]', () => Object.assign(document.createElement('meta'), { name: 'robots' })).content = 'noindex'
  }
}
