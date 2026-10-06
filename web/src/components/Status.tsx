import { DataFetchError, SchemaVersionError } from '../data/client'
import { formatDateTime, hoursAgo } from '../lib/time'

export const STALE_AFTER_H = 12

export function StaleBanner({ generatedAt, now }: { generatedAt: string; now?: number }) {
  const age = hoursAgo(generatedAt, now)
  if (age <= STALE_AFTER_H) return null
  return (
    <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      Data may be stale: the last update was {Math.floor(age)} hours ago ({formatDateTime(generatedAt)}). The pipeline
      normally refreshes every 6 hours.
    </div>
  )
}

export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  let title = 'Data temporarily unavailable'
  let body = 'We could not load the forecast data. Please try again in a few minutes.'
  if (error instanceof SchemaVersionError) {
    title = 'This page needs an update'
    body = `The published data (${error.file}) uses a newer format than this version of the site understands.`
  } else if (error instanceof DataFetchError && error.constructor !== DataFetchError) {
    title = `Couldn't read ${error.file}`
    body = 'This is a bug on our side; please check back later.'
  }
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm">{body}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
        >
          Retry
        </button>
      )}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-xl bg-stone-200 dark:bg-stone-800 ${className}`} />
}

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-4">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-72 w-full" />
    </div>
  )
}
