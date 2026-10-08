// Temporary: live SSE streaming check on a preview deploy (spike S2). Remove after P1a.6.
import { json, sseResponse } from './_lib/http'
import { emptyTrace } from './_lib/turn_runner'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default {
  fetch(request: Request): Response {
    if (request.method !== 'GET') return json(405, { error: { code: 'method_not_allowed', message: 'GET only' } })
    return sseResponse(async (emit, signal) => {
      for (let i = 1; i <= 5; i++) {
        if (signal.aborted) return
        emit({ type: 'tool_start', data: { call_id: `t${i}`, tool: 'sse_test', status_text: `tick ${i} of 5` } })
        await sleep(1000)
      }
      emit({ type: 'done', data: { turn_id: 'sse-test', stop_reason: 'final', trace: emptyTrace('sse-test') } })
    }, request.signal)
  },
}
