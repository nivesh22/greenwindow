import { render } from './entry-server'

describe('prerender entry', () => {
  it('renders page content without data, including lazy pages and the not-found route', async () => {
    expect(await render('/about')).toMatch(/<h1[^>]*>[^<]*About/)
    expect(await render('/privacy')).toContain('Privacy policy')
    expect(await render('/')).toContain('When is Great Britain')
    expect(await render('/scheduler')).toContain('Plan a flexible job')
    expect(await render('/nope')).toContain('Page not found')
  })
})
