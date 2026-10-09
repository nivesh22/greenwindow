import { useState } from 'react'
import { reminderRequestSchema, reminderResponseSchema } from '../../agent/harness/api_schemas'
import { buildIcs, googleCalendarUrl, type CalendarEvent } from '../lib/calendar'
import { apiFetch } from './auth'
import { CalendarButtons, actionBtn } from './CalendarButtons'
import { londonClock } from './london'
import { PushOptIn } from './PushOptIn'

interface Props {
  startUtc: string
  endUtc: string
  label: string
  description: string
  signedIn: boolean
  /** Injectable for tests. */
  now?: () => string
}

type Phase = { kind: 'idle' } | { kind: 'sending' } | { kind: 'set'; sendAt: string } | { kind: 'push_needed' } | { kind: 'error'; message: string }

/** Plan panel follow-through for the panel's own best window: calendar file/link and (signed in) a push reminder. */
export function PlanActions({ startUtc, endUtc, label, description, signedIn, now = () => new Date().toISOString() }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const ev: CalendarEvent = { uid: `plan-${startUtc}`, title: label, startUtc, endUtc, description }
  const ics = buildIcs(ev, now())

  const remind = async () => {
    setPhase({ kind: 'sending' })
    try {
      const body = reminderRequestSchema.parse({ start_utc: startUtc, label: label.slice(0, 80), lead_min: 10 })
      const res = await apiFetch('/api/reminders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 409) {
        const j: unknown = await res.json().catch(() => null)
        const code = typeof j === 'object' && j !== null && 'error' in j ? (j as { error?: { code?: unknown } }).error?.code : undefined
        if (code === 'push_needed') {
          setPhase({ kind: 'push_needed' })
          return
        }
      }
      if (!res.ok) {
        setPhase({ kind: 'error', message: `Could not set the reminder (HTTP ${res.status}).` })
        return
      }
      const parsed = reminderResponseSchema.parse(await res.json())
      setPhase({ kind: 'set', sendAt: parsed.send_at_utc })
    } catch (e) {
      setPhase({ kind: 'error', message: `Could not set the reminder${e instanceof Error ? ` (${e.message})` : ''}.` })
    }
  }

  return (
    <div aria-label="Plan actions" role="group" className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-stone-700 dark:text-stone-300">Add to calendar</span>
      <CalendarButtons ics={ics} googleUrl={googleCalendarUrl(ev)} startUtc={startUtc} />
      {signedIn && phase.kind !== 'set' && (
        <button type="button" className={actionBtn} disabled={phase.kind === 'sending'} onClick={() => void remind()}>
          Remind me
        </button>
      )}
      {phase.kind === 'set' && <span role="status" className="text-xs">Reminder set for {londonClock(phase.sendAt)}</span>}
      {phase.kind === 'push_needed' && (
        <div className="w-full space-y-1">
          <p role="status" className="text-xs">Turn on notifications first, then we can remind you.</p>
          <PushOptIn onEnabled={() => void remind()} />
        </div>
      )}
      {phase.kind === 'error' && <span role="alert" className="text-xs text-amber-700 dark:text-amber-300">{phase.message}</span>}
    </div>
  )
}
