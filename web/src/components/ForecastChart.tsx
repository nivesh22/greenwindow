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
import { formatDateTime, formatTick, toMs } from '../lib/time'

export interface ChartSeries { label: string; points: ForecastPoint[] }

interface Props {
  actuals: { ts: string; ci_actual: number | null }[]
  main: ChartSeries
  compare?: ChartSeries
  neso?: ChartSeries
  now: number
  highlight?: { start: number; end: number }
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
  actual: 'var(--color-stone-700)',
  main: 'var(--color-brand-600)',
  compare: 'var(--color-amber-600)',
  neso: 'var(--color-stone-500)',
}

function TooltipBody({ active, payload, label }: { active?: boolean; payload?: { payload: Row }[]; label?: number }) {
  if (!active || !payload?.length || label === undefined) return null
  const r = payload[0]!.payload
  const line = (name: string, v: number | null | undefined) =>
    v === null || v === undefined ? null : (
      <div className="flex justify-between gap-4">
        <span>{name}</span>
        <span className="font-mono">{Math.round(v)}</span>
      </div>
    )
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-2.5 text-xs shadow-md dark:border-stone-700 dark:bg-stone-900">
      <p className="mb-1 font-semibold">{formatDateTime(new Date(label).toISOString())}</p>
      {line('Actual', r.actual)}
      {line('Forecast (P50)', r.median)}
      {r.band && (
        <div className="flex justify-between gap-4 text-stone-500 dark:text-stone-400">
          <span>P10–P90</span>
          <span className="font-mono">
            {Math.round(r.band[0])}–{Math.round(r.band[1])}
          </span>
        </div>
      )}
      {line('Comparison', r.compare)}
      {line('NESO', r.neso)}
      <p className="mt-1 text-stone-500 dark:text-stone-400">gCO₂/kWh</p>
    </div>
  )
}

export function ForecastChart({ actuals, main, compare, neso, now, highlight, height = 320 }: Props) {
  const rows = buildRows({ actuals, main, compare, neso })
  return (
    <figure className="w-full" aria-label={`Carbon intensity chart: ${main.label} forecast with P10 to P90 band`}>
      <div style={{ height }} className="w-full text-stone-500 dark:text-stone-400">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
            <defs>
              {/* Hatched fill so the band is distinguishable without colour (spec 6.8). */}
              <pattern id="band-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={COLORS.main} fillOpacity={0.12} />
                <line x1="0" y1="0" x2="0" y2="6" stroke={COLORS.main} strokeOpacity={0.35} strokeWidth={1.5} />
              </pattern>
            </defs>
            <CartesianGrid strokeDasharray="2 4" stroke="currentColor" strokeOpacity={0.25} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(t: number) => formatTick(new Date(t).toISOString())}
              stroke="currentColor"
              fontSize={11}
              minTickGap={24}
            />
            <YAxis stroke="currentColor" fontSize={11} width={48} domain={[0, 'auto']} />
            <Tooltip content={<TooltipBody />} />
            {highlight && (
              <ReferenceArea x1={highlight.start} x2={highlight.end} fill={COLORS.main} fillOpacity={0.15} stroke={COLORS.main} strokeDasharray="4 2" />
            )}
            <Area
              dataKey="band"
              name="P10–P90"
              stroke={COLORS.main}
              strokeOpacity={0.6}
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
            <ReferenceLine x={now} stroke="currentColor" strokeWidth={1.5} label={{ value: 'now', position: 'insideTopRight', fontSize: 11, fill: 'currentColor' }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-stone-600 dark:text-stone-300">
        <Legend swatch={<span className="block h-0.5 w-5 bg-stone-700 dark:bg-stone-300" />} label="Actual" />
        <Legend swatch={<span className="block h-0.5 w-5 bg-brand-600" />} label={`${main.label} (P50)`} />
        <Legend swatch={<span className="block h-3 w-5 border border-dashed border-brand-600 bg-brand-100/60 dark:bg-brand-900/60" />} label="80% band (P10–P90)" />
        {neso && <Legend swatch={<span className="block w-5 border-t-2 border-dashed border-stone-500" />} label="NESO forecast" />}
        {compare && <Legend swatch={<span className="block w-5 border-t-2 border-dotted border-amber-600" />} label={compare.label} />}
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
