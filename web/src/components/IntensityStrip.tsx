import { formatDateTime, formatTick, londonHour, toMs } from '../lib/time'

interface Point { ts: string; q50: number }

const STOPS = [
  { l: 0.7, c: 0.15, h: 155 }, // low: green
  { l: 0.82, c: 0.15, h: 92 }, // middle: amber
  { l: 0.63, c: 0.18, h: 35 }, // high: rust
]

/** Colour for a position r in [0, 1] between the lowest and highest hour shown. */
function rampColor(r: number): string {
  const x = Math.min(1, Math.max(0, r)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(x))
  const f = x - i
  const a = STOPS[i]!
  const b = STOPS[i + 1]!
  const mix = (p: number, q: number) => (p + (q - p) * f).toFixed(3)
  return `oklch(${mix(a.l, b.l)} ${mix(a.c, b.c)} ${mix(a.h, b.h)})`
}

/**
 * The next hours as a row of coloured cells, relative to the range shown (not an absolute scale). Decorative: the
 * chart below and the summary text carry the numbers, so the strip is hidden from screen readers.
 */
export function IntensityStrip({ points, bestTs }: { points: Point[]; bestTs?: string }) {
  if (points.length === 0) return null
  const lo = Math.min(...points.map((p) => p.q50))
  const hi = Math.max(...points.map((p) => p.q50))
  const span = hi - lo || 1
  return (
    <div aria-hidden="true">
      <div className="flex h-10 gap-px overflow-hidden rounded-lg">
        {points.map((p) => (
          <div
            key={p.ts}
            title={`${formatDateTime(p.ts)}: ${Math.round(p.q50)} gCO₂/kWh`}
            className={`relative flex-1 ${p.ts === bestTs ? 'ring-2 ring-ink ring-inset' : ''}`}
            style={{ background: rampColor((p.q50 - lo) / span) }}
          />
        ))}
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-ink-3">
        {points.map((p, i) =>
          londonHour(toMs(p.ts)) === 0 ? (
            <span key={p.ts} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${(i / points.length) * 100}%` }}>
              {formatTick(toMs(p.ts))}
            </span>
          ) : null,
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-3">
        <span>Lower</span>
        <span className="h-1.5 w-24 rounded-full" style={{ background: `linear-gradient(90deg, ${rampColor(0)}, ${rampColor(0.5)}, ${rampColor(1)})` }} />
        <span>Higher, relative to these {points.length} hours</span>
      </div>
    </div>
  )
}
