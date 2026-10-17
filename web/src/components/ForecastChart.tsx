import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ForecastPoint } from '../data/schemas'
import { axisTicks, formatDateTime, formatTick, londonHour, toMs } from '../lib/time'

export interface ChartSeries { label: string; points: ForecastPoint[] }

interface Props {
  actuals: { ts: string; ci_actual: number | null }[]
  main: ChartSeries
  compare?: ChartSeries
  neso?: ChartSeries
  now: number
  highlight?: { start: number; end: number; label?: string }
  height?: number
}

interface Row {
  t: number
  actual?: number | null
  band?: [number, number]
  median?: number
  compare?: number
  neso?: number
}

export function buildRows({ actuals, main, compare, neso }: Pick<Props, 'actuals' | 'main' | 'compare' | 'neso'>): Row[] {
  const rows = new Map<number, Row>()
  const row = (ts: string): Row => {
    const t = toMs(ts)
    let r = rows.get(t)
    if (!r) rows.set(t, (r = { t }))
    return r
  }
  for (const a of actuals) row(a.ts).actual = a.ci_actual
  for (const p of main.points) {
    const r = row(p.ts)
    r.median = p.q50
    if (p.q10 !== null && p.q90 !== null) r.band = [p.q10, p.q90]
  }
  for (const p of compare?.points ?? []) row(p.ts).compare = p.q50
  for (const p of neso?.points ?? []) row(p.ts).neso = p.q50
  return [...rows.values()].sort((a, b) => a.t - b.t)
}

const COLORS = {
  actual: 'var(--ink-2)',
  main: 'var(--accent)',
  compare: 'var(--chart-compare)',
  neso: 'var(--ink-3)',
}

function TooltipBody({ active, payload, label }: { active?: boolean; payload?: { payload: Row }[]; label?: number }) {
  if (!active || !payload?.length || label === undefined) return null
  const r = payload[0]!.payload
  const line = (name: string, v: number | null | undefined) =>
    v === null || v === undefined ? null : (
      <div className="flex justify-between gap-4">
        <span>{name}</span>
        <span className="tabular-nums">{Math.round(v)}</span>
      </div>
    )
  return (
    <div className="rounded-lg border border-line-strong bg-surface p-2.5 text-xs text-ink shadow-lg">
      <p className="mb-1 font-semibold">{formatDateTime(new Date(label).toISOString())}</p>
      {line('Actual', r.actual)}
      {line('Forecast (P50)', r.median)}
      {r.band && (
        <div className="flex justify-between gap-4 text-ink-3">
          <span>P10–P90</span>
          <span className="tabular-nums">
            {Math.round(r.band[0])}–{Math.round(r.band[1])}
          </span>
        </div>
      )}
      {line('Comparison', r.compare)}
      {line('NESO', r.neso)}
      <p className="mt-1 text-ink-3">gCO₂/kWh</p>
    </div>
  )
}

export function ForecastChart({ actuals, main, compare, neso, now, highlight, height = 320 }: Props) {
  const rows = buildRows({ actuals, main, compare, neso })
  const first = rows[0]?.t ?? now
  const last = rows[rows.length - 1]?.t ?? now
  const ticks = axisTicks(first, last, 6)
  const midnights = ticks.filter((t) => londonHour(t) === 0)
  return (
    <figure className="w-full" aria-label={`Carbon intensity chart: ${main.label} forecast with P10 to P90 band`}>
      <p className="mb-1 text-xs text-ink-3">gCO₂/kWh</p>
      <div style={{ height }} className="w-full text-ink-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 22, right: 8, bottom: 0, left: -18 }}>
            <defs>
              {/* Hatched fill so the band is distinguishable without colour (spec 6.8). */}
              <pattern id="band-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={COLORS.main} fillOpacity={0.1} />
                <line x1="0" y1="0" x2="0" y2="6" stroke={COLORS.main} strokeOpacity={0.3} strokeWidth={1.5} />
              </pattern>
            </defs>
            <CartesianGrid stroke="currentColor" strokeOpacity={0.15} vertical={false} />
            {midnights.map((t) => (
              <ReferenceLine key={t} x={t} stroke="currentColor" strokeOpacity={0.25} />
            ))}
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              ticks={ticks}
              tickFormatter={(t: number) => formatTick(t)}
              stroke="currentColor"
              tick={{ fill: 'currentColor' }}
              tickLine={false}
              axisLine={{ strokeOpacity: 0.4 }}
              fontSize={11}
              minTickGap={8}
            />
            <YAxis stroke="currentColor" tick={{ fill: 'currentColor' }} tickLine={false} axisLine={false} fontSize={11} width={48} domain={[0, 'auto']} />
            <Tooltip content={<TooltipBody />} cursor={{ stroke: 'currentColor', strokeOpacity: 0.4 }} />
            {highlight && (
              <ReferenceArea
                x1={highlight.start}
                x2={highlight.end}
                fill={COLORS.main}
                fillOpacity={0.16}
                stroke="none"
                label={highlight.label ? { value: highlight.label, position: 'top', fontSize: 11, fontWeight: 600, fill: COLORS.main } : undefined}
              />
            )}
            <Area
              dataKey="band"
              name="P10–P90"
              stroke={COLORS.main}
              strokeOpacity={0.5}
              strokeWidth={1}
              strokeDasharray="3 2"
              fill="url(#band-hatch)"
              isAnimationActive={false}
              connectNulls
            />
            <Line dataKey="actual" name="Actual" stroke={COLORS.actual} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="median" name="Forecast" stroke={COLORS.main} strokeWidth={2.5} dot={false} isAnimationActive={false} />
            {neso && (
              <Line dataKey="neso" name="NESO" stroke={COLORS.neso} strokeWidth={1.5} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
            )}
            {compare && (
              <Line dataKey="compare" name="Comparison" stroke={COLORS.compare} strokeWidth={2} strokeDasharray="1 3" strokeLinecap="round" dot={false} isAnimationActive={false} />
            )}
            {now >= first && now <= last && (
              <ReferenceLine x={now} stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 2"
                label={{ value: 'Now', position: 'top', fontSize: 11, fontWeight: 600, fill: 'currentColor' }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-2">
        {actuals.length > 0 && <Legend swatch={<span className="block h-0.5 w-5 bg-ink-2" />} label="Actual" />}
        <Legend swatch={<span className="block h-0.5 w-5 bg-accent" />} label={`${main.label} (P50)`} />
        <Legend swatch={<span className="block h-3 w-5 rounded-sm border border-dashed border-accent bg-accent/15" />} label="80% band (P10–P90)" />
        {neso && <Legend swatch={<span className="block w-5 border-t-2 border-dashed border-ink-3" />} label="NESO forecast" />}
        {compare && <Legend swatch={<span className="block w-5 border-t-2 border-dotted border-[var(--chart-compare)]" />} label={compare.label} />}
        {highlight?.label && <Legend swatch={<span className="block h-3 w-5 rounded-sm bg-accent/25" />} label={highlight.label} />}
      </figcaption>
    </figure>
  )
}

function Legend({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  )
}
