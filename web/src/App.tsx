import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { makeQueryClient } from './data/hooks'
import { About } from './pages/About'
import { Backtest } from './pages/Backtest'
import { Home } from './pages/Home'
import { Leaderboard } from './pages/Leaderboard'
import { Scheduler } from './pages/Scheduler'

const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const Ops = lazy(() => import('./pages/Ops').then((m) => ({ default: m.Ops })))
const OpsTrace = lazy(() => import('./pages/OpsTrace').then((m) => ({ default: m.OpsTrace })))
const Privacy = lazy(() => import('./pages/Privacy').then((m) => ({ default: m.Privacy })))

export function AppRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/scheduler" element={<Scheduler />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/backtest" element={<Backtest />} />
        <Route path="/about" element={<About />} />
        <Route
          path="/settings"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Settings />
            </Suspense>
          }
        />
        <Route
          path="/privacy"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Privacy />
            </Suspense>
          }
        />
        <Route
          path="/ops"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Ops />
            </Suspense>
          }
        />
        <Route
          path="/ops/trace/:turnId"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <OpsTrace />
            </Suspense>
          }
        />
        <Route path="*" element={<p>Page not found.</p>} />
      </Routes>
    </Layout>
  )
}

export default function App({ client }: { client?: QueryClient }) {
  const [qc] = useState(() => client ?? makeQueryClient())
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
