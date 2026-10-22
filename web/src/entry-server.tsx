// Build-time prerender entry (scripts/prerender.mjs). Renders one route to HTML, waiting for lazy pages. Forecast data
// is not fetched here: data-driven sections render their loading state and fill in once the app starts in the browser.
import { QueryClientProvider } from '@tanstack/react-query'
import { prerender } from 'react-dom/static'
import { StaticRouter } from 'react-router-dom'
import { AppRoutes } from './App'
import { makeQueryClient } from './data/hooks'

export { canonicalUrl, NOT_FOUND, PUBLIC_PAGES, SITE_URL } from './lib/seo'

export async function render(url: string): Promise<string> {
  const { prelude } = await prerender(
    <QueryClientProvider client={makeQueryClient()}>
      <StaticRouter location={url}>
        <AppRoutes />
      </StaticRouter>
    </QueryClientProvider>,
  )
  return new Response(prelude).text()
}
