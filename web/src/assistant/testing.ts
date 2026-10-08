// Test helpers: build a mock SSE response from contract events.
import { encodeSse, type SseEvent } from '../../agent/harness/events'

export function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const c = chunks[i++]
      if (c === undefined) controller.close()
      else controller.enqueue(typeof c === 'string' ? enc.encode(c) : c)
    },
  })
}

export function sseResponse(events: SseEvent[], status = 200): Response {
  return new Response(streamOf(events.map(encodeSse)), { status, headers: { 'content-type': 'text/event-stream' } })
}

export const EMPTY_TRACE = {
  gates: [],
  tools: [],
  llm_calls: [],
  totals: { steps: 1, tokens_in: 1, tokens_out: 1, cost_usd: 0, ms: 1 },
  prompt_version: 'test',
}

export const CONV_ID = '11111111-1111-4111-8111-111111111111'

export function turnEvents(answer: string): SseEvent[] {
  return [
    { type: 'turn_start', data: { turn_id: 't1', conversation_id: CONV_ID, messages_left: 9 } },
    { type: 'tool_start', data: { call_id: 'c1', tool: 'recommend_start', status_text: 'Checking the forecast...' } },
    { type: 'tool_end', data: { call_id: 'c1', tool: 'recommend_start', ok: true, latency_ms: 5, summary: 'ok' } },
    {
      type: 'plan_update',
      data: {
        duration_h: 3,
        power_kw: 7,
        earliest_utc: '2026-10-08T10:00:00Z',
        deadline_utc: '2026-10-09T07:00:00Z',
        mode: 'expected',
        model: 'chronos2_cov',
        best_start_utc: '2026-10-08T23:00:00Z',
        run_id: 'r1',
      },
    },
    { type: 'answer', data: { text: answer } },
    { type: 'done', data: { turn_id: 't1', stop_reason: 'final', trace: EMPTY_TRACE } },
  ]
}
