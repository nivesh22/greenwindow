import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { ASSISTANT_ENABLED } from '../assistant/flag'
import { HeaderAccount } from '../assistant/HeaderAccount'
import { useDataFile } from '../data/hooks'
import { formatHour, hoursAgo } from '../lib/time'
import { LogoMark } from './Logo'
import { STALE_AFTER_H, StaleBanner } from './Status'

const NAV = [
  { to: '/', label: 'Forecast' },
  { to: '/scheduler', label: 'Plan a job' },
  { to: '/leaderboard', label: 'Leaderboard' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/about', label: 'About & limits' },
]

const FALLBACK_ATTRIBUTION = [
  'Carbon intensity data: National Energy System Operator (NESO) Carbon Intensity API, CC BY 4.0.',
  'Weather data by Open-Meteo.com, CC BY 4.0.',
]

const footLink = 'underline decoration-line-strong underline-offset-2 hover:text-ink hover:decoration-ink-3'

export function Layout({ children }: { children: ReactNode }) {
  const meta = useDataFile('meta')
  const generated = meta.data?.generated_at_utc
  const fresh = generated ? hoursAgo(generated) <= STALE_AFTER_H : null
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-x-6 px-4 pt-3 sm:pb-3">
          <NavLink to="/" className="flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
            <LogoMark />
            <span className="font-display text-xl font-semibold tracking-tight">GreenWindow</span>
          </NavLink>
          <nav aria-label="Main" className="hidden md:block">
            <NavItems />
          </nav>
          <div className="ml-auto flex items-center gap-x-3">
            <p className="hidden items-center gap-1.5 text-xs text-ink-3 lg:flex" title="When the forecast data was last published">
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${fresh === false ? 'bg-amber-500' : 'bg-brand-500'}`} />
              Data last updated: {generated ? formatHour(generated) : '…'}
            </p>
            <HeaderAccount />
          </div>
        </div>
        {/* Phones: the nav scrolls sideways rather than wrapping or overflowing the page. */}
        <nav aria-label="Main (compact)" className="overflow-x-auto px-3 py-2 [scrollbar-width:none] [mask-image:linear-gradient(90deg,#000_85%,transparent)] md:hidden">
          <NavItems />
        </nav>
      </header>
      {meta.data && <StaleBanner generatedAt={meta.data.generated_at_utc} />}
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:py-10">{children}</main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 text-xs text-ink-3 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <div className="mb-3 flex items-center gap-2 text-ink">
              <LogoMark className="h-5 w-5" />
              <span className="font-display text-base font-semibold">GreenWindow</span>
            </div>
            {(meta.data?.attribution ?? FALLBACK_ATTRIBUTION).map((a) => (
              <p key={a}>{a}</p>
            ))}
            <p>Great Britain only. Forecasts are estimates of average grid intensity, not a guarantee.</p>
          </div>
          <ul className="flex gap-4 sm:flex-col sm:gap-1.5 sm:text-right">
            <li><NavLink className={footLink} to="/about">About &amp; limits</NavLink></li>
            <li><NavLink className={footLink} to="/privacy">Privacy</NavLink></li>
            <li><NavLink className={footLink} to="/terms">Terms</NavLink></li>
            <li><a className={footLink} href="https://github.com/nivesh22/greenwindow">Source on GitHub</a></li>
          </ul>
        </div>
      </footer>
    </div>
  )
}

function NavItems() {
  return (
    <ul className="flex gap-1 text-sm whitespace-nowrap">
      {NAV.map((n) => (
        <li key={n.to}>
          <NavLink
            to={n.to}
            end={n.to === '/'}
            className={({ isActive }) =>
              `block rounded-lg px-3 py-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                isActive ? 'bg-accent-soft text-accent-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
              }`
            }
          >
            {n.label}
            {n.to === '/scheduler' && ASSISTANT_ENABLED && (
              <span className="ml-1.5 rounded bg-brand-600 px-1 py-px align-[1px] text-[10px] font-bold tracking-wide text-white">AI</span>
            )}
          </NavLink>
        </li>
      ))}
    </ul>
  )
}
