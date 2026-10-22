// Build step after `vite build` and the SSR build of src/entry-server.ts (see package.json "build").
// Writes one HTML file per public page into dist/ with that page's content, title, description and canonical URL, so
// crawlers that do not run JavaScript see real pages. Also writes 404.html, app.html (the bare shell for signed-in
// routes, rewritten in vercel.json), robots.txt and sitemap.xml. The browser app still starts with createRoot and
// replaces the prerendered markup.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const { render, PUBLIC_PAGES, NOT_FOUND, SITE_URL, canonicalUrl, ogImageUrl, structuredData } = await import(pathToFileURL(join(root, 'dist-ssr', 'entry-server.js')).href)

const template = await readFile(join(dist, 'index.html'), 'utf8')
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function page(meta, path, body) {
  const head = [
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    meta.index ? `<link rel="canonical" href="${canonicalUrl(path)}" />` : '<meta name="robots" content="noindex" />',
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="GreenWindow" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    meta.index ? `<meta property="og:url" content="${canonicalUrl(path)}" />` : '',
    `<meta property="og:image" content="${ogImageUrl(path)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${esc(meta.title)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    jsonLd(path),
  ]
    .filter(Boolean)
    .join('\n    ')
  const out = template
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/<meta name="description"[^>]*>/, '')
    .replace('</head>', `    ${head}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${body}</div>`)
  if (!out.includes(canonicalUrl(path)) && meta.index) throw new Error(`prerender: head not injected for ${path}`)
  return out
}

// JSON-LD inside <script>: escape "<" so the text can never close the tag.
function jsonLd(path) {
  const data = structuredData(path)
  return data ? `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>` : ''
}

const fileFor = (path) => (path === '/' ? 'index.html' : `${path.slice(1)}.html`)

// The bare shell first: index.html is overwritten by the prerendered home page below.
await writeFile(join(dist, 'app.html'), template.replace('</head>', '    <meta name="robots" content="noindex" />\n  </head>'))

for (const [path, meta] of Object.entries(PUBLIC_PAGES)) {
  await writeFile(join(dist, fileFor(path)), page(meta, path, await render(path)))
}
await writeFile(join(dist, '404.html'), page(NOT_FOUND, '/404', await render('/__not-found__')))

const today = new Date().toISOString().slice(0, 10)
const urls = Object.entries(PUBLIC_PAGES)
  .filter(([, m]) => m.index)
  .map(([p]) => `  <url><loc>${canonicalUrl(p)}</loc><lastmod>${today}</lastmod></url>`)
await writeFile(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`,
)
await writeFile(
  join(dist, 'robots.txt'),
  `User-agent: *\nDisallow: /api/\nDisallow: /settings\nDisallow: /account\nDisallow: /ops\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
)
console.log(`prerender: ${Object.keys(PUBLIC_PAGES).length} pages, 404.html, app.html, sitemap.xml, robots.txt`)
