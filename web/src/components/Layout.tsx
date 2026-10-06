import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useDataFile } from '../data/hooks'
import { formatDateTime } from '../lib/time'
import { StaleBanner } from './Status'

const NAV = [
  { to: '/', label: 'Forecast' },
  { to: '/scheduler', label: 'Plan a job' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/about', label: 'About & limits' },
]

const FALLBACK_ATTRIBUTION = [
  'Carbon intensity data: National Energy System Operator (NESO) Carbon Intensity API, CC BY 4.0.',
  'Weather data by Open-Meteo.com, CC BY 4.0.',
]

export function Layout({ children }: { children: ReactNode }) {
  const meta = useDataFile('meta')
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-stone-200 bg-white/80 backdrop-blur dark:border-stone-800 dark:bg-stone-900/80">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <NavLink to="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span aria-hidden className="inline-block h-3 w-3 rounded-full bg-brand-500" />
            GreenWindow
          </NavLink>
          <nav aria-label="Main" className="-mx-1 flex flex-wrap gap-1 text-sm">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  `rounded-lg px-2.5 py-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand-600 ${
                    isActive
                      ? 'bg-brand-100 text-brand-900 dark:bg-brand-900 dark:text-brand-50'
                      : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900 dark:text-stone-300 dark:hover:bg-stone-800'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <p className="text-xs text-stone-500 sm:ml-auto dark:text-stone-400">
            Data last updated: {meta.data ? formatDateTime(meta.data.generated_at_utc) : '…'}
          </p>
        </div>
      </header>
      {meta.data && <StaleBanner generatedAt={meta.data.generated_at_utc} />}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:py-8">{children}</main>
      <footer className="border-t border-stone-200 py-6 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
        <div className="mx-auto max-w-5xl space-y-1 px-4">
          {(meta.data?.attribution ?? FALLBACK_ATTRIBUTION).map((a) => (
            <p key={a}>{a}</p>
          ))}
          <p>
            Great Britain only. Forecasts are estimates of average grid intensity, not a guarantee.{' '}
            <a className="underline hover:text-stone-800 dark:hover:text-stone-200" href="https://github.com/nivesh22/greenwindow">
              Source on GitHub
            </a>
          </p>
        </div>
      </footer>
    </div>
  )
}
