import { FIXTURES, clone } from '../test/fixtures'
import { DataSchemaError, SchemaVersionError, fetchFile, parseFile } from './client'
import { FILES, type FileKey } from './schemas'

const KEYS = Object.keys(FILES) as FileKey[]

describe('JSON contract (Python exporter output -> zod)', () => {
  it.each(KEYS)('fixture for %s parses', (key) => {
    expect(() => parseFile(key, FIXTURES[FILES[key].file])).not.toThrow()
  })

  it.each(KEYS)('corrupted %s is rejected', (key) => {
    const bad = clone(FIXTURES[FILES[key].file]) as Record<string, unknown>
    bad.generated_at_utc = 'yesterday'
    expect(() => parseFile(key, bad)).toThrow(DataSchemaError)
  })

  it('rejects a series with the wrong number of points', () => {
    const bad = clone(FIXTURES['latest_forecast.json']) as { series: { points: unknown[] }[] }
    bad.series[0]!.points.pop()
    expect(() => parseFile('latestForecast', bad)).toThrow(DataSchemaError)
  })

  it('rejects NaN-like values', () => {
    const bad = clone(FIXTURES['latest_forecast.json']) as { series: { points: { q50: unknown }[] }[] }
    bad.series[0]!.points[0]!.q50 = 'NaN'
    expect(() => parseFile('latestForecast', bad)).toThrow(DataSchemaError)
  })

  it('refuses a newer major schema_version', () => {
    const bad = { ...(FIXTURES['meta.json'] as object), schema_version: 2 }
    expect(() => parseFile('meta', bad)).toThrow(SchemaVersionError)
  })

  it('fetches with a plain GET and no custom headers', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(FIXTURES['meta.json'])))
    vi.stubGlobal('fetch', spy)
    await fetchFile('meta', 'https://example.test/app_data')
    expect(spy).toHaveBeenCalledWith('https://example.test/app_data/meta.json')
    vi.unstubAllGlobals()
  })
})
