// Test helpers for tool unit tests: a fixture-backed ToolCtx with the frozen clock.
import { resolve } from 'node:path'
import { FixtureForecastSource } from '../data/forecast_source.js'
import { FIXTURE_NOW_UTC } from '../data/types.js'
import { MemoryStore } from '../store/types.js'
import type { ToolCtx } from './registry.js'

export const FIXTURE_DIR = resolve(import.meta.dirname, '../../../tests/app_data')
export const NOW_MS = Date.parse(FIXTURE_NOW_UTC)

export function makeCtx(over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    userId: null,
    isAnonymous: true,
    nowMs: NOW_MS,
    data: new FixtureForecastSource(FIXTURE_DIR, () => NOW_MS),
    store: new MemoryStore(),
    riskMode: 'expected',
    turn: { lastRecommendation: null },
    signal: new AbortController().signal,
    ...over,
  }
}
