// ForecastSource implementations (design §7.6): HTTP with a TTL cache and stale fallback, and a fixture reader.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFile } from '../../src/data/parse.js'
import { FILES, type FileData, type FileKey } from '../../src/data/schemas.js'
import type { Fetched, ForecastSource } from './types.js'

export const DEFAULT_TTL_MS = 10 * 60_000

export interface HttpForecastSourceOptions {
  /** Base URL of the published JSON files (no trailing slash needed). */
  baseUrl: string
  /** Deployment origin that serves backtest_summary.json. */
  backtestBaseUrl: string
  fetchImpl?: typeof fetch
  nowMs?: () => number
  ttlMs?: number
}

interface CacheEntry {
  data: unknown
  fetchedAtMs: number
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '')

export class HttpForecastSource implements ForecastSource {
  private readonly cache = new Map<FileKey, CacheEntry>()
  private readonly fetchImpl: typeof fetch
  private readonly nowMs: () => number
  private readonly ttlMs: number
  private readonly baseUrl: string
  private readonly backtestBaseUrl: string

  constructor(opts: HttpForecastSourceOptions) {
    this.baseUrl = trimSlash(opts.baseUrl)
    this.backtestBaseUrl = trimSlash(opts.backtestBaseUrl)
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.nowMs = opts.nowMs ?? Date.now
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  private async get<K extends FileKey>(key: K): Promise<Fetched<FileData[K]>> {
    const now = this.nowMs()
    const cached = this.cache.get(key)
    if (cached && now - cached.fetchedAtMs < this.ttlMs) {
      return { data: cached.data as FileData[K], stale: false, fetchedAtMs: cached.fetchedAtMs }
    }
    const spec = FILES[key]
    const base = 'sameOrigin' in spec && spec.sameOrigin ? this.backtestBaseUrl : this.baseUrl
    try {
      const res = await this.fetchImpl(`${base}/${spec.file}`) // plain GET, no custom headers
      if (!res.ok) throw new Error(`${spec.file}: HTTP ${res.status}`)
      const data = parseFile(key, await res.json())
      this.cache.set(key, { data, fetchedAtMs: now })
      return { data, stale: false, fetchedAtMs: now }
    } catch (err) {
      if (cached) return { data: cached.data as FileData[K], stale: true, fetchedAtMs: cached.fetchedAtMs }
      throw err
    }
  }

  meta() {
    return this.get('meta')
  }
  latest() {
    return this.get('latestForecast')
  }
  observations() {
    return this.get('recentObservations')
  }
  leaderboard() {
    return this.get('leaderboard')
  }
  backtest() {
    return this.get('backtestSummary')
  }
}

/** Reads the shared fixtures (tests/app_data/*.json) from disk; used by unit tests and evals. */
export class FixtureForecastSource implements ForecastSource {
  private readonly dir: string
  private readonly nowMs: () => number

  constructor(dir: string, nowMs: () => number = Date.now) {
    this.dir = dir
    this.nowMs = nowMs
  }

  private async get<K extends FileKey>(key: K): Promise<Fetched<FileData[K]>> {
    const raw: unknown = JSON.parse(await readFile(join(this.dir, FILES[key].file), 'utf8'))
    return { data: parseFile(key, raw), stale: false, fetchedAtMs: this.nowMs() }
  }

  meta() {
    return this.get('meta')
  }
  latest() {
    return this.get('latestForecast')
  }
  observations() {
    return this.get('recentObservations')
  }
  leaderboard() {
    return this.get('leaderboard')
  }
  backtest() {
    return this.get('backtestSummary')
  }
}
