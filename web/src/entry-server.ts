// Build-time prerender entry (scripts/prerender.mjs). Renders one route to HTML, waiting for lazy pages. Forecast data
// is not fetched here: data-driven sections render their loading state and fill in once the app starts in the browser.
// A .ts file (createElement, no JSX) so its non-component exports don't trip the fast-refresh lint rule.
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { prerender } from 'react-dom/static'
import { StaticRouter } from 'react-router-dom'
import { AppRoutes } from './App'
import { makeQueryClient } from './data/hooks'

export { canonicalUrl, NOT_FOUND, ogImageUrl, PUBLIC_PAGES, SITE_URL, structuredData } from './lib/seo'

export async function render(url: string): Promise<string> {
  const app = createElement(QueryClientProvider, { client: makeQueryClient() }, createElement(StaticRouter, { location: url }, createElement(AppRoutes)))
  const { prelude } = await prerender(app)
  return new Response(prelude).text()
}
