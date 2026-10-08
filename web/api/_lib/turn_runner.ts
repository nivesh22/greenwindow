import type { ChatRequest, SseEvent, TraceSummary } from '../../agent/harness/events.js'

export type TurnRunner = (
  input: { request: ChatRequest; ipHash: string; nowMs: number; signal: AbortSignal },
  emit: (ev: SseEvent) => void,
) => Promise<void>

export const emptyTrace = (promptVersion: string): TraceSummary => ({
  gates: [],
  tools: [],
  llm_calls: [],
  totals: { steps: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, ms: 0 },
  prompt_version: promptVersion,
})

/** Placeholder until the real turn loop (P1a.6) is wired in. */
export const placeholderRunner: TurnRunner = async ({ request }, emit) => {
  const turnId = crypto.randomUUID()
  emit({
    type: 'turn_start',
    data: { turn_id: turnId, conversation_id: request.conversation_id ?? crypto.randomUUID(), messages_left: null },
  })
  emit({ type: 'answer', data: { text: 'The assistant is being built.' } })
  emit({ type: 'done', data: { turn_id: turnId, stop_reason: 'final', trace: emptyTrace('placeholder') } })
}
