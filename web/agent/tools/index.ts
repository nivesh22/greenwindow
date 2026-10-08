import { estimateCo2 } from './estimate_co2.js'
import { getForecast } from './get_forecast.js'
import { lookupDevice } from './lookup_device.js'
import { recommendWindow } from './recommend_window.js'
import { ToolRegistry, type ToolDef } from './registry.js'

/** The P1 tool set. explain_uncertainty arrives in P1b. */
export const P1_TOOLS: readonly ToolDef[] = [
  getForecast as unknown as ToolDef,
  recommendWindow as unknown as ToolDef,
  estimateCo2 as unknown as ToolDef,
  lookupDevice as unknown as ToolDef,
]

export function buildRegistry(): ToolRegistry {
  return new ToolRegistry(P1_TOOLS)
}

export { toPlanUpdate } from './recommend_window.js'
