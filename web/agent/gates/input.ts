// The state shared by guard_in and router (stage 4, one Jev call) and its compact Jev form (design §6.2).
import type { PanelState } from '../harness/events.js'
import { clip } from './gate.js'

export interface HistoryMsg {
  role: 'user' | 'assistant'
  content: string
}

export interface InputState {
  message: string
  history: readonly HistoryMsg[]
  panel: PanelState | null
}

export const ASSISTANT_SCOPE =
  'GreenWindow Assistant plans when to run flexible electricity use in Great Britain (EV charging, appliances, heat ' +
  'pumps, compute/GPU jobs) around the forecast carbon intensity of the national grid, and answers questions about ' +
  'that forecast, its accuracy, and the user\'s plans and settings.'

export function panelHasJob(p: PanelState | null): boolean {
  return p !== null && (p.duration_h !== null || p.power_kw !== null || p.deadline_utc !== null)
}

/** The last two exchanges (4 messages), each clipped. */
export function recent(history: readonly HistoryMsg[], n = 4): HistoryMsg[] {
  return history.slice(-n).map((h) => ({ role: h.role, content: clip(h.content, 600) }))
}

export function inputJevState(s: InputState): Record<string, unknown> {
  return {
    assistant: ASSISTANT_SCOPE,
    message: clip(s.message, 2000),
    recent_conversation: recent(s.history),
    planner_panel_has_job: panelHasJob(s.panel),
  }
}
