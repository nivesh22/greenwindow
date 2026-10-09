import { Link, useParams } from 'react-router-dom'
import { adminTraceResponseSchema, type AdminTraceResponse } from '../../agent/harness/api_schemas'
import { formatDateTime } from '../lib/time'
import { AdminGate, useAdminFetch } from '../ops/useAdminFetch'

type Span = AdminTraceResponse['spans'][number]

/** Depth of each span by following parent_id; missing parents (or cycles) count as roots. */
export function spanDepths(spans: Span[]): Map<string, number> {
  const byId = new Map(spans.map((s) => [s.id, s]))
  const out = new Map<string, number>()
  for (const s of spans) {
    let depth = 0
    let cur: Span | undefined = s
    const seen = new Set<string>()
    while (cur?.parent_id && byId.has(cur.parent_id) && !seen.has(cur.id) && depth < 20) {
      seen.add(cur.id)
      cur = byId.get(cur.parent_id)
      depth++
    }
    out.set(s.id, depth)
  }
  return out
}

/** Spans in start order with children following their parent. */
function ordered(spans: Span[]): Span[] {
  const kids = new Map<string | null, Span[]>()
  const ids = new Set(spans.map((s) => s.id))
  for (const s of [...spans].sort((a, b) => a.started_at_utc.localeCompare(b.started_at_utc))) {
    const key = s.parent_id && ids.has(s.parent_id) ? s.parent_id : null
    kids.set(key, [...(kids.get(key) ?? []), s])
  }
  const out: Span[] = []
  const walk = (key: string | null, guard: number) => {
    if (guard > 20) return
    for (const s of kids.get(key) ?? []) {
      out.push(s)
      walk(s.id, guard + 1)
    }
  }
  walk(null, 0)
  return out
}

export function OpsTrace() {
  const { turnId = '' } = useParams()
  const state = useAdminFetch(`/api/admin/trace?turn_id=${encodeURIComponent(turnId)}`, adminTraceResponseSchema)
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link className="underline" to="/ops">Back to Ops</Link></p>
      <h1 className="text-2xl font-bold tracking-tight">Turn trace</h1>
      {state.status === 'ok' ? <TraceView d={state.data} /> : <AdminGate state={state} />}
    </div>
  )
}

export function TraceView({ d }: { d: AdminTraceResponse }) {
  const t = d.turn
  const depths = spanDepths(d.spans)
  const box = 'rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900'
  return (
    <div className="space-y-4">
      <section aria-label="Turn" className={box}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {[
            ['When', formatDateTime(t.created_at_utc)],
            ['Intent', t.intent ?? 'none'],
            ['Stop reason', t.stop_reason],
            ['Model', t.model_final ?? 'none'],
            ['Prompt', t.prompt_version],
            ['Tokens in / out', `${t.tokens_in} / ${t.tokens_out}`],
            ['Cost', `$${t.cost_usd.toFixed(4)}`],
            ['Latency', `${t.latency_ms} ms`],
            ['Turn', t.id],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-stone-500 dark:text-stone-400">{k}</dt>
              <dd className="font-medium break-all">{v}</dd>
            </div>
          ))}
        </dl>
        {d.langfuse_url && (
          <p className="mt-2 text-xs">
            <a className="underline" href={d.langfuse_url} target="_blank" rel="noopener noreferrer">Open in Langfuse</a>
          </p>
        )}
      </section>

      <section aria-label="Conversation" className={`${box} space-y-3 text-sm`}>
        <div>
          <h2 className="text-xs font-semibold text-stone-500 dark:text-stone-400">User message</h2>
          <p className="whitespace-pre-wrap break-words">{d.user_message ?? '(not stored)'}</p>
        </div>
        <div>
          <h2 className="text-xs font-semibold text-stone-500 dark:text-stone-400">Answer</h2>
          <p className="whitespace-pre-wrap break-words">{d.answer ?? '(none)'}</p>
        </div>
        <div>
          <h2 className="text-xs font-semibold text-stone-500 dark:text-stone-400">Feedback</h2>
          {d.feedback.length === 0 ? <p>None.</p> : (
            <ul>
              {d.feedback.map((f, i) => (
                <li key={i}>{f.rating === 1 ? 'Thumbs up' : 'Thumbs down'}{f.comment ? `: ${f.comment}` : ''}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="Spans" className={box}>
        <h2 className="text-base font-semibold">Spans</h2>
        {d.spans.length === 0 && <p className="text-sm">No spans recorded.</p>}
        <ol className="mt-2 space-y-1">
          {ordered(d.spans).map((s) => (
            <li key={s.id} style={{ marginLeft: `${Math.min(depths.get(s.id) ?? 0, 6) * 1}rem` }} className="rounded-lg border border-stone-200 p-2 text-xs dark:border-stone-700">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="rounded bg-stone-100 px-1.5 py-0.5 font-medium dark:bg-stone-800">{s.kind}</span>
                <span className="font-medium break-all">{s.name}</span>
                <span className="tabular-nums">{Math.round(s.duration_ms)} ms</span>
                <span className={s.status === 'error' ? 'font-semibold text-red-700 dark:text-red-400' : ''}>{s.status === 'error' ? 'error' : 'ok'}</span>
                {(s.tokens_in > 0 || s.tokens_out > 0) && <span className="tabular-nums">{s.tokens_in}/{s.tokens_out} tok</span>}
                {s.cost_usd > 0 && <span className="tabular-nums">${s.cost_usd.toFixed(4)}</span>}
              </div>
              {Object.keys(s.attrs).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer">Attributes</summary>
                  <pre className="mt-1 max-h-60 overflow-auto rounded bg-stone-100 p-2 whitespace-pre-wrap break-words dark:bg-stone-800">{JSON.stringify(s.attrs, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
