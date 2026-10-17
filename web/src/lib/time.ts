// All data is UTC. Convert to Europe/London only here, at render time (spec 6.8).
const TZ = 'Europe/London'

const hourFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
})
const dayHourFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
})
const tickDayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' })
const tickHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const londonHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' })

/** "01:00 BST" - includes the zone so the repeated hour on the October clock change stays distinct. */
export const formatHour = (iso: string): string => hourFmt.format(new Date(iso))
/** "Mon 5 Oct, 18:00 BST" */
export const formatDateTime = (iso: string): string => dayHourFmt.format(new Date(iso))
/** Hour of day (0-23) in UK time. */
export const londonHour = (ms: number): number => Number(londonHourFmt.format(new Date(ms))) % 24
/** Axis tick: the day at UK midnight ("Sun 18"), otherwise the UK time ("06:00"). */
export const formatTick = (ms: number): string =>
  londonHour(ms) === 0 ? tickDayFmt.format(new Date(ms)).replace(',', '') : tickHourFmt.format(new Date(ms))
/** Whole hours in [startMs, endMs] that fall on a UK hour divisible by everyH (0, 6, 12, 18 by default). */
export function axisTicks(startMs: number, endMs: number, everyH = 6): number[] {
  const ticks: number[] = []
  for (let t = Math.ceil(startMs / HOUR_MS) * HOUR_MS; t <= endMs; t += HOUR_MS) {
    if (londonHour(t) % everyH === 0) ticks.push(t)
  }
  return ticks
}

export const HOUR_MS = 3_600_000
export const toMs = (iso: string): number => Date.parse(iso)
/** ISO-8601 UTC with a trailing Z and no milliseconds, like the data files. */
export const toIso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z')

export function hoursAgo(iso: string, now: number = Date.now()): number {
  return (now - toMs(iso)) / HOUR_MS
}

/** UTC ms -> value for <input type="datetime-local"> in London time ("2026-10-05T18:00"). */
export function toLocalInput(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

/** London wall-clock "YYYY-MM-DDTHH:mm" -> UTC ms. Picks the first match on ambiguous/missing clock-change hours. */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const asUtc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)
  for (const offsetH of [1, 0]) {
    const candidate = asUtc - offsetH * HOUR_MS
    if (toLocalInput(candidate) === value) return candidate
  }
  return asUtc - HOUR_MS // non-existent spring-forward hour: treat as the next valid instant
}
