// guard_out (design §6.2, FR-3.2 output side): runs after the deterministic grounding check passed, over the final
// text and the turn's compact tool outputs. Rules fallback: pass (grounding already ran).
import type { ToolResultLike } from '../harness/grounding.js'
import { clip, type GateSpec, type RuleDecision } from './gate.js'

// Numbers are checked deterministically by grounding.ts, which also sees the conversation history; Jev does not, so
// asking it about numbers produced false positives (2026-10-09). guard_out judges wording and safety only.
export const GUARD_OUT_OPTIONS = ['pass', 'overclaim_co2', 'unsafe'] as const
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
      "Check the wording of the assistant's `answer` (numbers are verified separately). Emissions must be described " +
      'as an estimated difference with a caveat, never as CO2 saved or avoided, and never as certain.',
    options: {
      pass: 'Impact is worded as an estimate (or not mentioned) and nothing is unsafe.',
      overclaim_co2: 'Says the user saved or will save CO2, or presents the emissions difference as certain or without its caveat.',
      unsafe: 'Gives unsafe electrical advice, encourages bypassing safety limits, or contains harmful content.',
    },
    rules: guardOutRules,
  }
}

/** The instruction for the one regeneration after a guard_out flag. */
export function guardOutInstruction(choice: Exclude<GuardOutChoice, 'pass'>): string {
  const why: Record<Exclude<GuardOutChoice, 'pass'>, string> = {
    overclaim_co2: 'it overclaims the emissions impact (say "estimated difference" with the caveat; never "saved")',
    unsafe: 'it contains unsafe advice',
  }
  return `Your previous answer was rejected because ${why[choice]}. Rewrite it using only the tool results above, keeping the required caveat. Do not call tools.`
}
