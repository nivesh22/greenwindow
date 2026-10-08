// guard_out (design §6.2, FR-3.2 output side): runs after the deterministic grounding check passed, over the final
// text and the turn's compact tool outputs. Rules fallback: pass (grounding already ran).
import type { ToolResultLike } from '../harness/grounding.js'
import { clip, type GateSpec, type RuleDecision } from './gate.js'

export const GUARD_OUT_OPTIONS = ['pass', 'ungrounded_number', 'overclaim_co2', 'unsafe'] as const
export type GuardOutChoice = (typeof GUARD_OUT_OPTIONS)[number]

export interface OutputState {
  text: string
  toolResults: readonly ToolResultLike[]
}

const TOOL_CHARS = 6000

/** Compact tool outputs: failed calls reduced to their error code, the whole list clipped. */
export function outputJevState(s: OutputState): Record<string, unknown> {
  const tools = s.toolResults.map((r) => (r.ok ? { tool: r.tool, ok: true, data: r.data } : { tool: r.tool, ok: false }))
  return { answer: clip(s.text, 3000), tool_outputs: clip(JSON.stringify(tools), TOOL_CHARS) }
}

export function guardOutRules(): RuleDecision<GuardOutChoice> {
  return { choice: 'pass', confidence: 0.5, reason: 'deterministic grounding already passed' }
}

export function guardOutSpec(threshold: number): GateSpec<OutputState, GuardOutChoice> {
  return {
    name: 'guard_out',
    threshold,
    instructions:
      "Check the assistant's `answer` against `tool_outputs` (the only allowed source of times, intensities and " +
      'emissions figures; times may appear as their London-time fields). Numbers the user gave, durations and power ' +
      'ratings are fine. Emissions must be described as an estimated difference with a caveat, never as CO2 saved.',
    options: {
      pass: 'Every start time, intensity and emissions figure is in the tool outputs, impact is worded as an estimate, and nothing is unsafe.',
      ungrounded_number: 'States a start time, carbon intensity, percentage or emissions figure that is not in the tool outputs.',
      overclaim_co2: 'Says the user saved or will save CO2, or presents the emissions difference as certain or without its caveat.',
      unsafe: 'Gives unsafe electrical advice, encourages bypassing safety limits, or contains harmful content.',
    },
    rules: guardOutRules,
  }
}

/** The instruction for the one regeneration after a guard_out flag. */
export function guardOutInstruction(choice: Exclude<GuardOutChoice, 'pass'>): string {
  const why: Record<Exclude<GuardOutChoice, 'pass'>, string> = {
    ungrounded_number: 'it states a time or figure that is not in the tool results',
    overclaim_co2: 'it overclaims the emissions impact (say "estimated difference" with the caveat; never "saved")',
    unsafe: 'it contains unsafe advice',
  }
  return `Your previous answer was rejected because ${why[choice]}. Rewrite it using only the tool results above, keeping the required caveat. Do not call tools.`
}
