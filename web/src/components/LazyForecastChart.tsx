import { lazy, Suspense, type ComponentProps } from 'react'
import type { ForecastChart } from './ForecastChart'

// The chart library (recharts) is the largest part of the bundle; loading it separately lets the page text render
// first. The placeholder keeps the chart's height so nothing shifts when it arrives.
const Chart = lazy(() => import('./ForecastChart').then((m) => ({ default: m.ForecastChart })))

export function LazyForecastChart(props: ComponentProps<typeof ForecastChart>) {
  return (
    <Suspense fallback={<div aria-hidden="true" className="w-full" style={{ height: (props.height ?? 320) + 20 }} />}>
      <Chart {...props} />
    </Suspense>
  )
}
