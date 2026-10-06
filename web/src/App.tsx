import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { makeQueryClient } from './data/hooks'
import { About } from './pages/About'
import { Home } from './pages/Home'
import { Leaderboard } from './pages/Leaderboard'
import { Scheduler } from './pages/Scheduler'

export function AppRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/scheduler" element={<Scheduler />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/about" element={<About />} />
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
