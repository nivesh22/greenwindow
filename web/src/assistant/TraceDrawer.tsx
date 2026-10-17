import type { TraceSummary } from '../../agent/harness/events'

const PRE_CAP = 1200

const fmtCost = (usd: number): string => `$${usd.toFixed(4)}`

function pretty(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > PRE_CAP ? `${text.slice(0, PRE_CAP)}\n... (${text.length - PRE_CAP} more characters)` : text
}

const badge = 'rounded px-1.5 py-0.5 text-xs font-medium'

/** Collapsed "How I got this" disclosure under an assistant message (FR-1.4). */
export function TraceDrawer({ trace }: { trace: TraceSummary }) {
  const { gates, tools, llm_calls: calls, totals } = trace
  return (
    <details className="mt-1 max-w-[92%] text-xs text-ink-2">
      <summary className="cursor-pointer rounded px-1 py-0.5 font-medium focus-visible:outline-2 focus-visible:outline-accent">
        How I got this
      </summary>
      <div className="mt-2 space-y-3 rounded-lg border border-line p-3">
        <section aria-label="Gate decisions">
          <h3 className="font-semibold text-ink">Gate decisions</h3>
          {gates.length === 0 ? (
            <p>none yet</p>
          ) : (
            <ul className="space-y-1">
              {gates.map((g, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{g.gate}: {g.choice}</span>
                  <span
                    role="meter"
                    aria-label={`${g.gate} confidence`}
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={g.confidence}
                    aria-valuetext={`${Math.round(g.confidence * 100)}%`}
                    className="inline-block h-2 w-16 overflow-hidden rounded bg-line-strong"
                  >
                    <span className="block h-full bg-brand-600" style={{ width: `${Math.round(g.confidence * 100)}%` }} />
                  </span>
                  <span>{Math.round(g.confidence * 100)}%</span>
                  <span className={`${badge} bg-surface-2`}>{g.source}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Tool calls">
          <h3 className="font-semibold text-ink">Tool calls</h3>
          {tools.length === 0 ? (
            <p>none</p>
          ) : (
            <ul className="space-y-2">
              {tools.map((t, i) => (
                <li key={i}>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="font-medium">{t.name}</code>
                    <span className={`${badge} ${t.ok ? 'bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100' : 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100'}`}>
                      {t.ok ? 'ok' : 'error'}
                    </span>
                    <span>{Math.round(t.ms)} ms</span>
                  </div>
                  <details className="mt-1">
                    <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-accent">
                      Details for {t.name}
                    </summary>
                    <p className="mt-1 break-words">{t.summary}</p>
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface-2 p-2 text-[11px]" tabIndex={0} aria-label={`Arguments for ${t.name}`}>
                      {pretty(t.args)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Model calls">
          <h3 className="font-semibold text-ink">Model calls</h3>
          {calls.length === 0 ? (
            <p>none</p>
          ) : (
            <ul className="space-y-1">
              {calls.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{c.model}</span>
                  <span>({c.provider})</span>
                  {!c.ok && (
                    <span className={`${badge} bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100`}>
                      failed{c.error ? `: ${c.error.replace('_', ' ')}` : ''}
                    </span>
                  )}
                  {c.failover && (
                    <span className={`${badge} bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100`}>
                      failover{c.failover_reason ? `: ${c.failover_reason}` : ''}
                    </span>
                  )}
                  {c.finish_reason && <span>finish: {c.finish_reason}</span>}
                  <span>{c.tokens_in} in / {c.tokens_out} out</span>
                  <span>{fmtCost(c.cost_usd)}</span>
                  <span>{Math.round(c.ms)} ms</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p>
          <span className="font-semibold text-ink">Totals:</span> {totals.steps} steps, {totals.tokens_in} tokens in,{' '}
          {totals.tokens_out} out, {fmtCost(totals.cost_usd)}, {Math.round(totals.ms)} ms · prompt {trace.prompt_version}
        </p>
      </div>
    </details>
  )
}
