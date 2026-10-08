import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_DIR } from '../tools/testing.js'
import { FixtureForecastSource, HttpForecastSource } from './forecast_source.js'

const read = (f: string): string => readFileSync(join(FIXTURE_DIR, f), 'utf8')
const BODIES: Record<string, string> = {
  'meta.json': read('meta.json'),
  'latest_forecast.json': read('latest_forecast.json'),
  'leaderboard.json': read('leaderboard.json'),
  'recent_observations.json': read('recent_observations.json'),
  'backtest_summary.json': read('backtest_summary.json'),
}

function fakeFetch(opts: { fail?: () => boolean } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    if (opts.fail?.()) throw new Error('network down')
    const body = BODIES[url.split('/').pop() ?? '']
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(body, { status: 200 })
  }) as typeof fetch
  return { impl, calls }
}

describe('FixtureForecastSource', () => {
  it('reads and validates all five files, never stale', async () => {
    const s = new FixtureForecastSource(FIXTURE_DIR, () => 5)
    expect((await s.meta()).stale).toBe(false)
    expect((await s.latest()).data.run_id).toBe('20261006T00')
    expect((await s.observations()).data.points.length).toBeGreaterThan(0)
    expect((await s.leaderboard()).data.n_runs).toBeGreaterThanOrEqual(0)
    expect((await s.backtest()).fetchedAtMs).toBe(5)
  })
})

describe('HttpForecastSource', () => {
  const base = 'https://data.example/app_data'
  const site = 'https://site.example'

  it('routes files to the right origin with a plain GET and caches within the ttl', async () => {
    const f = fakeFetch()
    let now = 1_000
    const s = new HttpForecastSource({ baseUrl: `${base}/`, backtestBaseUrl: site, fetchImpl: f.impl, nowMs: () => now })
    await s.latest()
    await s.backtest()
    now += 5 * 60_000
    await s.latest()
    expect(f.calls.map((c) => c.url)).toEqual([`${base}/latest_forecast.json`, `${site}/backtest_summary.json`])
    expect(f.calls.every((c) => c.init === undefined || c.init.headers === undefined)).toBe(true)
  })

  it('refetches after the ttl expires', async () => {
    const f = fakeFetch()
    let now = 0
    const s = new HttpForecastSource({ baseUrl: base, backtestBaseUrl: site, fetchImpl: f.impl, nowMs: () => now, ttlMs: 1000 })
    await s.meta()
    now = 1001
    const r = await s.meta()
    expect(f.calls).toHaveLength(2)
    expect(r.fetchedAtMs).toBe(1001)
  })

  it('serves the last good copy as stale when a refetch fails, and throws when there is none', async () => {
    let down = false
    const f = fakeFetch({ fail: () => down })
    let now = 0
    const s = new HttpForecastSource({ baseUrl: base, backtestBaseUrl: site, fetchImpl: f.impl, nowMs: () => now, ttlMs: 1000 })
    const first = await s.meta()
    expect(first.stale).toBe(false)
    down = true
    now = 5000
    const second = await s.meta()
    expect(second.stale).toBe(true)
    expect(second.data).toEqual(first.data)
    expect(second.fetchedAtMs).toBe(0)
    await expect(s.leaderboard()).rejects.toThrow('network down')
  })

  it('treats HTTP errors and schema failures as failures', async () => {
    const bad = (async () => new Response('{"schema_version":1}', { status: 200 })) as typeof fetch
    const s = new HttpForecastSource({ baseUrl: base, backtestBaseUrl: site, fetchImpl: bad })
    await expect(s.meta()).rejects.toThrow()
    const notFound = (async () => new Response('x', { status: 404 })) as typeof fetch
    const s2 = new HttpForecastSource({ baseUrl: base, backtestBaseUrl: site, fetchImpl: notFound })
    await expect(s2.meta()).rejects.toThrow('HTTP 404')
  })
})
