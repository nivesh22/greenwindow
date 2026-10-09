import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

// Okabe-Ito colour-blind-safe palette; readable on light and dark backgrounds. brand-600 is the app accent.
export const PALETTE = ['var(--color-brand-600)', '#E69F00', '#0072B2', '#CC79A7', '#56B4E9', '#D55E00', '#999999']
export const LIMIT_COLOR = '#D55E00'

export function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <h2 className="text-base font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

const tooltipStyle = { fontSize: 12, borderRadius: 8, border: '1px solid var(--color-stone-300, #d6d3d1)' }

interface BarSeries { key: string; label: string; color: string }

/** Day-by-day bars (stacked when several series), optional horizontal reference line. */
export function DayBars({
  data,
  series,
  limit,
  height = 200,
  fmt = (v: number) => String(v),
}: {
  data: Record<string, string | number>[]
  series: BarSeries[]
  limit?: { y: number; label: string }
  height?: number
  fmt?: (v: number) => string
}) {
  return (
    <div style={{ height }} className="w-full text-stone-500 dark:text-stone-400">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.25} vertical={false} />
          <XAxis dataKey="day" stroke="currentColor" fontSize={11} tickFormatter={(d: string) => d.slice(5)} interval="preserveStartEnd" />
          <YAxis stroke="currentColor" fontSize={11} width={44} tickFormatter={fmt} allowDecimals />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? fmt(v) : String(v))} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} isAnimationActive={false} />
          ))}
          {limit && (
            <ReferenceLine y={limit.y} stroke={LIMIT_COLOR} strokeDasharray="5 3" strokeWidth={2} label={{ value: limit.label, position: 'insideTopRight', fontSize: 11, fill: LIMIT_COLOR }} />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function TrendLine({ data, dataKey, label, height = 180 }: { data: Record<string, string | number>[]; dataKey: string; label: string; height?: number }) {
  return (
    <div style={{ height }} className="w-full text-stone-500 dark:text-stone-400">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.25} vertical={false} />
          <XAxis dataKey="day" stroke="currentColor" fontSize={11} interval="preserveStartEnd" />
          <YAxis stroke="currentColor" fontSize={11} width={44} domain={[0, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : String(v))} />
          <Line dataKey={dataKey} name={label} stroke={PALETTE[0]} strokeWidth={2.5} dot isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Tiny horizontal bar for shares, with the number printed beside it (never colour alone). */
export function ShareBar({ label, n, total }: { label: string; n: number; total: number }) {
  const pct = total > 0 ? (n / total) * 100 : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 truncate" title={label}>{label}</span>
      <span className="h-2 flex-1 rounded bg-stone-200 dark:bg-stone-700" aria-hidden="true">
        <span className="block h-2 rounded bg-brand-600" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-20 shrink-0 text-right tabular-nums">{n} ({pct.toFixed(0)}%)</span>
    </div>
  )
}

/** Vertical mini histogram; each bar has a text label under it. */
export function Histogram({ buckets, label }: { buckets: number[]; label: string }) {
  const max = Math.max(1, ...buckets)
  return (
    <div role="img" aria-label={`${label}: ${buckets.join(', ')}`} className="flex h-16 items-end gap-0.5">
      {buckets.map((n, i) => (
        <div key={i} className="flex flex-1 flex-col items-center justify-end" title={`${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}: ${n}`}>
          <div className="w-full rounded-t bg-brand-600" style={{ height: `${(n / max) * 100}%`, minHeight: n > 0 ? 2 : 0 }} />
          <span className="text-[9px] text-stone-500 dark:text-stone-400">{i === 0 ? '0' : i === 9 ? '1' : ''}</span>
        </div>
      ))}
    </div>
  )
}
