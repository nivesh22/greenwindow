import { applyPageMeta, canonicalUrl, metaFor, ogImageUrl, PUBLIC_PAGES, structuredData } from './seo'

describe('seo', () => {
  it('gives every public page its own title and description', () => {
    const titles = Object.values(PUBLIC_PAGES).map((m) => m.title)
    const descs = Object.values(PUBLIC_PAGES).map((m) => m.description)
    expect(new Set(titles).size).toBe(titles.length)
    expect(new Set(descs).size).toBe(descs.length)
    for (const m of Object.values(PUBLIC_PAGES)) {
      expect(m.title.length).toBeLessThanOrEqual(70)
      expect(m.description.length).toBeLessThanOrEqual(160)
      expect(`${m.title} ${m.description}`).not.toMatch(/saved|avoided/i)
    }
  })

  it('marks private, nested and unknown routes noindex', () => {
    expect(metaFor('/about/').index).toBe(true)
    expect(metaFor('/settings').index).toBe(false)
    expect(metaFor('/ops/trace/abc').title).toMatch(/^Ops/)
    expect(metaFor('/nope').title).toMatch(/^Page not found/)
    expect(canonicalUrl('/')).toBe('https://greenwindow.uk/')
    expect(canonicalUrl('/about/')).toBe('https://greenwindow.uk/about')
  })

  it('updates the head on navigation', () => {
    applyPageMeta('/about')
    expect(document.title).toBe(PUBLIC_PAGES['/about']!.title)
    expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute('href', 'https://greenwindow.uk/about')
    applyPageMeta('/settings')
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull()
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex')
    applyPageMeta('/')
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull()
    expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute('content', PUBLIC_PAGES['/']!.description)
  })

  it('has a share image on disk for every public page', () => {
    const files = Object.keys(import.meta.glob('../../public/og/*.png')).map((f) => f.replace('../../public', ''))
    for (const path of Object.keys(PUBLIC_PAGES)) expect(files).toContain(new URL(ogImageUrl(path)).pathname)
    expect(ogImageUrl('/nope')).toBe('https://greenwindow.uk/og/home.png')
  })

  it('describes the forecast dataset on the home page only, with the fields Google requires', () => {
    expect(structuredData('/about')).toBeNull()
    const graph = (structuredData('/') as { '@graph': Record<string, unknown>[] })['@graph']
    const ds = graph.find((n) => n['@type'] === 'Dataset')!
    expect(typeof ds.name).toBe('string')
    expect((ds.description as string).length).toBeGreaterThanOrEqual(50)
    expect(ds.license).toBeUndefined() // the repository has no license; do not claim one
    expect(JSON.stringify(ds)).toContain('CC BY 4.0')
  })
})
