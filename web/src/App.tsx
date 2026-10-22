import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { makeQueryClient } from './data/hooks'
import { Home } from './pages/Home'

// Only the home page is in the main bundle; the other pages load on demand (the prerendered HTML already has their text).
const Scheduler = lazy(() => import('./pages/Scheduler').then((m) => ({ default: m.Scheduler })))
const Leaderboard = lazy(() => import('./pages/Leaderboard').then((m) => ({ default: m.Leaderboard })))
const Backtest = lazy(() => import('./pages/Backtest').then((m) => ({ default: m.Backtest })))
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })))
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })))
const Ops = lazy(() => import('./pages/Ops').then((m) => ({ default: m.Ops })))
const OpsTrace = lazy(() => import('./pages/OpsTrace').then((m) => ({ default: m.OpsTrace })))
const Privacy = lazy(() => import('./pages/Privacy').then((m) => ({ default: m.Privacy })))
const Account = lazy(() => import('./pages/Account').then((m) => ({ default: m.Account })))
const Terms = lazy(() => import('./pages/Terms').then((m) => ({ default: m.Terms })))

export function AppRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route
          path="/scheduler"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Scheduler />
            </Suspense>
          }
        />
        <Route
          path="/leaderboard"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Leaderboard />
            </Suspense>
          }
        />
        <Route
          path="/backtest"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Backtest />
            </Suspense>
          }
        />
        <Route
          path="/about"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <About />
            </Suspense>
          }
        />
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
          path="/account"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Account />
            </Suspense>
          }
        />
        <Route
          path="/terms"
          element={
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Terms />
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
