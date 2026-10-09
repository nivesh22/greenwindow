import { Link } from 'react-router-dom'
import { opsResponseSchema, type OpsResponse } from '../../agent/harness/api_schemas'
import { formatDateTime } from '../lib/time'
import { DayBars, Histogram, PALETTE, Panel, ShareBar, TrendLine } from '../ops/charts'
import { AdminGate, useAdminFetch } from '../ops/useAdminFetch'

const usd = (v: number): string => `$${v.toFixed(v < 1 ? 4 : 2)}`
const ms = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`)
const pct = (num: number, den: number): string => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : '0%')
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)

const th = 'px-2 py-1 text-left font-medium'
const td = 'px-2 py-1 tabular-nums'

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) return <p className="text-sm text-stone-600 dark:text-stone-300">No data yet.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-stone-200 dark:border-stone-700">
          <tr>{head.map((h) => <th key={h} scope="col" className={th}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-stone-100 last:border-0 dark:border-stone-800">
              {r.map((c, j) => (j === 0 ? <th key={j} scope="row" className={`${th} break-all`}>{c}</th> : <td key={j} className={td}>{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Ops() {
  const state = useAdminFetch('/api/admin/ops?days=14', opsResponseSchema)
  if (state.status !== 'ok') {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Ops</h1>
        <AdminGate state={state} />
      </div>
    )
  }
  return <OpsView d={state.data} />
}

export function OpsView({ d }: { d: OpsResponse }) {
  const b = d.budget
  const usedPct = b.limit_usd > 0 ? b.spent_usd / b.limit_usd : 0
  const intents = [...new Set(d.daily.flatMap((x) => Object.keys(x.by_intent)))].sort()
  const turnsData = d.daily.map((x) => ({ day: x.day, ...Object.fromEntries(intents.map((k) => [k, x.by_intent[k] ?? 0])) }))
  const costData = d.daily.map((x) => ({ day: x.day, cost: x.cost_usd }))
  const freeData = d.daily.map((x) => ({ day: x.day, free: x.free_tier_requests }))
  const evalData = d.evals.map((e) => ({ day: e.created_at_utc.slice(5, 10), pass: e.pass_rate }))

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Ops</h1>
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Last {d.days} days, generated {formatDateTime(d.generated_at_utc)}. Model prices checked {d.prices_checked}.
        </p>
      </header>

      {b.paused && (
        <p role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
          Paused: the monthly budget is used up. The assistant is off until the month rolls over or the limit is raised.
        </p>
      )}
      {!b.paused && usedPct >= 0.8 && (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          Warning: {(usedPct * 100).toFixed(0)}% of the {b.month} budget is used.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Cost per day" note={`Month ${b.month}: ${usd(b.spent_usd)} of ${usd(b.limit_usd)} (${(usedPct * 100).toFixed(0)}%); evals ${usd(b.eval_spent_usd)}. Dashed line: limit divided by 30.`}>
          <DayBars data={costData} series={[{ key: 'cost', label: 'Cost (USD)', color: PALETTE[0]! }]} limit={{ y: b.limit_usd / 30, label: 'daily budget' }} fmt={(v) => `$${v.toFixed(2)}`} />
        </Panel>

        <Panel title="Turns per day by intent">
          {intents.length === 0 ? <p className="text-sm">No turns yet.</p> : (
            <DayBars data={turnsData} series={intents.map((k, i) => ({ key: k, label: k, color: PALETTE[i % PALETTE.length]! }))} />
          )}
        </Panel>

        <Panel title="Free-tier requests per day" note={`Estimated daily request allowance: ${d.free_tier_rpd_estimate}. Dashed line is that estimate; the real limit may differ.`}>
          <DayBars data={freeData} series={[{ key: 'free', label: 'Free-tier requests', color: PALETTE[2]! }]} limit={{ y: d.free_tier_rpd_estimate, label: 'RPD estimate' }} />
          <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            LLM requests in the window: {sum(d.daily.map((x) => x.llm_requests))}, of which free tier {sum(d.daily.map((x) => x.free_tier_requests))}.
          </p>
        </Panel>

        <Panel title="Eval pass rate" note="Golden eval runs, oldest to newest.">
          {evalData.length === 0 ? <p className="text-sm">No eval runs recorded.</p> : (
            <>
              <TrendLine data={evalData} dataKey="pass" label="Pass rate" />
              <Table
                caption="Eval runs"
                head={['Date', 'Mode', 'Pass', 'Window', 'Banned', 'Cost']}
                rows={d.evals.slice(-5).map((e) => [e.created_at_utc.slice(0, 10), e.mode, pct(e.pass_rate, 1), pct(e.window_correctness, 1), e.banned_claims, usd(e.cost_usd)])}
              />
            </>
          )}
        </Panel>

        <Panel title="Latency (p50 / p95)">
          <Table caption="Latency by kind and name" head={['Kind / name', 'n', 'p50', 'p95']} rows={d.latency.map((l) => [`${l.kind} / ${l.name}`, l.n, ms(l.p50_ms), ms(l.p95_ms)])} />
        </Panel>

        <Panel title="Failover" note={`${d.failover.failovers} of ${d.failover.llm_calls} LLM calls (${pct(d.failover.failovers, d.failover.llm_calls)}) used the fallback model.`}>
          <Table caption="Failover reasons" head={['Reason', 'n']} rows={d.failover.reasons.map((r) => [r.reason, r.n])} />
        </Panel>

        <Panel title="Gates" note="Source mix (Jev, rules, fallback) and confidence histogram, buckets of 0.1 from 0 to 1.">
          {d.gates.length === 0 && <p className="text-sm">No gate decisions yet.</p>}
          <div className="space-y-4">
            {d.gates.map((g) => (
              <div key={g.gate} className="space-y-1">
                <h3 className="text-sm font-medium">{g.gate} <span className="font-normal text-stone-500 dark:text-stone-400">(n = {g.n})</span></h3>
                {Object.entries(g.by_source).map(([k, n]) => <ShareBar key={k} label={`source: ${k}`} n={n} total={g.n} />)}
                {Object.entries(g.by_choice).map(([k, n]) => <ShareBar key={k} label={`choice: ${k}`} n={n} total={g.n} />)}
                <Histogram buckets={g.confidence_hist} label={`${g.gate} confidence histogram`} />
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Tool error rates">
          <Table
            caption="Tool calls and errors"
            head={['Tool', 'Calls', 'Errors', 'Rate']}
            rows={d.tools.map((t) => [t.tool, t.calls, t.errors, pct(t.errors, t.calls)])}
          />
        </Panel>

        <Panel title="Stop reasons">
          {d.stop_reasons.length === 0 && <p className="text-sm">No turns yet.</p>}
          <div className="space-y-1">
            {d.stop_reasons.map((s) => <ShareBar key={s.reason} label={s.reason} n={s.n} total={sum(d.stop_reasons.map((x) => x.n))} />)}
          </div>
        </Panel>

        <Panel title="Thumbs-down" note="Open a turn to see its trace.">
          {d.thumbs_down.length === 0 ? <p className="text-sm">None in this window.</p> : (
            <ul className="space-y-2 text-sm">
              {d.thumbs_down.map((t) => (
                <li key={t.turn_id}>
                  <Link className="underline" to={`/ops/trace/${t.turn_id}`}>{formatDateTime(t.created_at_utc)}</Link>
                  {t.comment && <span className="ml-2 break-words text-stone-600 dark:text-stone-300">{t.comment}</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
