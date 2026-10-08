import { estimateCo2 } from './estimate_co2'
import { getForecast } from './get_forecast'
import { lookupDevice } from './lookup_device'
import { recommendWindow } from './recommend_window'
import { ToolRegistry, type ToolDef } from './registry'

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

export { toPlanUpdate } from './recommend_window'
