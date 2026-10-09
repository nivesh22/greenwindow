import type { ActionEvent } from '../../agent/harness/events'
import { CalendarButtons } from './CalendarButtons'
import { londonClock } from './london'
import { PushOptIn } from './PushOptIn'

/** Small follow-through actions under an assistant message (J6). */
export function ChatActions({ actions }: { actions: ActionEvent[] }) {
  if (actions.length === 0) return null
  return (
    <ul aria-label="Actions" className="mt-1 space-y-1">
      {actions.map((a, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2 text-xs text-stone-700 dark:text-stone-300">
          {a.kind === 'calendar' && <CalendarButtons ics={a.ics} googleUrl={a.google_url} startUtc={a.start_utc} />}
          {a.kind === 'reminder_set' && <span>Reminder set for {londonClock(a.send_at_utc)}</span>}
          {a.kind === 'plan_saved' && (
            <span>
              Saved: {a.label}
              {' · '}
              <a className="underline" href="/settings">Settings</a>
            </span>
          )}
          {a.kind === 'push_needed' && <PushOptIn />}
        </li>
      ))}
    </ul>
  )
}
