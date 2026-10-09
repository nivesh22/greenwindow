// Stage 5 gates for plan intents (design §6.2, FR-3.3/3.4), asked together in one Jev call:
// ask_or_act {act, ask_duration, ask_power, ask_deadline, ask_clarify} and risk_mode {expected, cautious}.
import type { PanelState } from '../harness/events.js'
import { clip, type GateSpec, type RuleDecision } from './gate.js'
import { recent, type HistoryMsg } from './input.js'
import { extractSlots, missingSlots, type Slots } from './slots.js'
import type { Intent } from './types.js'

export const ASK_OR_ACT_OPTIONS = ['act', 'ask_duration', 'ask_power', 'ask_deadline', 'ask_clarify'] as const
export type AskOrActChoice = (typeof ASK_OR_ACT_OPTIONS)[number]
export const RISK_MODE_OPTIONS = ['expected', 'cautious'] as const
export type RiskModeChoice = (typeof RISK_MODE_OPTIONS)[number]

export interface PlanState {
  intent: Intent
  message: string
  history: readonly HistoryMsg[]
  panel: PanelState | null
  slots: Slots
}

export function planState(intent: Intent, message: string, history: readonly HistoryMsg[], panel: PanelState | null): PlanState {
  return { intent, message, history, panel, slots: extractSlots(message, history, panel) }
}

export function planJevState(s: PlanState): Record<string, unknown> {
  const sl = s.slots
  return {
    intent: s.intent,
    message: clip(s.message, 2000),
    recent_conversation: recent(s.history),
    known: {
      duration_hours: sl.duration_h,
      power_kw: sl.power_kw,
      deadline: sl.deadline,
      earliest_start: sl.earliest,
      device: sl.device ? { name: sl.device.name, typical_kw: sl.device.kw, typical_hours: sl.device.typicalHours } : null,
    },
    missing: missingSlots(sl),
    planner_panel_mode: s.panel?.mode ?? null,
  }
}

/** Rules (design §6.2): act iff duration and deadline are known and power is known or defaultable. */
export function askOrActRules(s: PlanState): RuleDecision<AskOrActChoice> {
  const sl = s.slots
  if (!sl.duration_h && !sl.power_kw && !sl.deadline && !sl.device) return { choice: 'ask_clarify', confidence: 0.6, reason: 'no job details' }
  if (!sl.duration_h) return { choice: 'ask_duration', confidence: 0.8, reason: 'duration unknown' }
  if (!sl.deadline) return { choice: 'ask_deadline', confidence: 0.8, reason: 'deadline unknown' }
  if (!sl.power_kw) return { choice: 'ask_power', confidence: 0.8, reason: 'power unknown, no device default' }
  return { choice: 'act', confidence: 0.8, reason: 'duration, deadline and power known' }
}

export function askOrActSpec(threshold: number): GateSpec<PlanState, AskOrActChoice> {
  return {
    name: 'ask_or_act',
    threshold,
    instructions:
      'The user wants a start-time recommendation for an electricity job. `known` lists what is already known and where ' +
      'it came from (the user, the planner panel, or a typical default for the named device; defaults are fine to use). ' +
      'Decide whether the assistant can plan now or must first ask ONE question.',
    options: {
      act: 'Enough is known to plan: the duration, the deadline and the power are known or can be taken from a device default or the planner panel.',
      ask_duration: 'How long the job runs is unknown and there is no default for it.',
      ask_power: 'The power draw is unknown and there is no device to take a typical value from.',
      ask_deadline: 'When the job must be finished is unknown.',
      ask_clarify: 'It is unclear what the user wants to run.',
    },
    rules: askOrActRules,
  }
}

const EXPLICIT_CAUTIOUS = /\b(cautious|conservative|safe) (mode|option|plan|setting)\b|\buse cautious\b|\bbe cautious\b|\bplay it safe\b/i
const EXPLICIT_EXPECTED = /\b(expected|median|typical|average)[- ](mode|case|forecast)\b|\buse expected\b/i
// Cautious = plan on the high (q90) forecast so the carbon benefit holds even if the forecast is off. Deadline urgency
// ("must be done by 7am") is NOT a risk signal: the deadline is a hard constraint in both modes.
const CAUTIOUS_HINTS = /\b(no risk|lowest risk|least risk|low risk|risk[- ]averse|guarantee\w*|be sure|make sure it'?s (cleaner|greener|lower)|certain(ly)? (cleaner|greener|lower)|worst case|confident)\b/i
const FLEXIBLE_HINTS = /\b(flexible|no rush|whenever|don'?t mind|not fussed|any ?time|relaxed)\b/i

/** The mode the user explicitly asked for in this message, if any. It wins over Jev and the rules. */
export function explicitMode(message: string): RiskModeChoice | null {
  if (EXPLICIT_CAUTIOUS.test(message)) return 'cautious'
  if (EXPLICIT_EXPECTED.test(message)) return 'expected'
  return null
}

export function riskModeRules(s: PlanState): RuleDecision<RiskModeChoice> {
  const explicit = explicitMode(s.message)
  if (explicit) return { choice: explicit, confidence: 1, reason: 'user asked for this mode' }
  if (CAUTIOUS_HINTS.test(s.message)) return { choice: 'cautious', confidence: 0.75, reason: 'criticality wording' }
  if (FLEXIBLE_HINTS.test(s.message)) return { choice: 'expected', confidence: 0.75, reason: 'flexibility wording' }
  if (s.panel) return { choice: s.panel.mode, confidence: 0.5, reason: 'planner panel mode' }
  return { choice: 'expected', confidence: 0.5, reason: 'default' }
}

export function riskModeSpec(threshold: number): GateSpec<PlanState, RiskModeChoice> {
  return {
    name: 'risk_mode',
    threshold,
    instructions:
      'Choose how to plan around FORECAST UNCERTAINTY in carbon intensity, from the user\'s wording in `message` and ' +
      '`recent_conversation`. `planner_panel_mode` is the user\'s current default. A deadline ("must be done by 7am", ' +
      '"has to finish before work") is a hard constraint in both modes and is NOT a reason to choose cautious.',
    options: {
      expected: 'Plan on the expected (median) forecast. The default, including when the user only states a deadline.',
      cautious:
        'Plan on the high end of the forecast so the lower-carbon benefit holds even if the forecast is wrong: the user ' +
        'asks for certainty or low risk about the carbon outcome, or for a cautious/conservative plan.',
    },
    rules: riskModeRules,
    override: (s, a) => {
      const explicit = explicitMode(s.message)
      return explicit && explicit !== a.choice ? { choice: explicit, confidence: 1, reason: 'user asked for this mode' } : null
    },
  }
}
