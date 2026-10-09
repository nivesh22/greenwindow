// Calendar export for a planned window (PRD FR-4.9, J6). Pure; shared by the make_calendar_event tool and the plan
// panel's "Add to calendar" buttons.
// - .ics: RFC 5545 (https://www.rfc-editor.org/rfc/rfc5545): CRLF lines, UTC DATE-TIME in basic format with "Z",
//   TEXT escaping (§3.3.11) and 75-octet line folding (§3.1).
// - Google Calendar link: `calendar.google.com/calendar/render?action=TEMPLATE&text=&dates=START/END&details=`.
//   Google publishes no reference for this URL (spike S7, docs/spikes.md); the UTC `YYYYMMDDTHHMMSSZ/…Z` form is the
//   one all third-party guides agree on, and the owner checked a generated link by hand.

export interface CalendarEvent {
  uid: string // stable, e.g. plan id or turn id
  title: string
  startUtc: string // ISO UTC
  endUtc: string
  description: string
  url?: string
}

/** 2026-10-09T02:00:00Z -> 20261009T020000Z */
export function icsDate(isoUtc: string): string {
  const d = new Date(isoUtc)
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date ${isoUtc}`)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
}

/** RFC 5545 §3.3.11 TEXT escaping. */
export function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** RFC 5545 §3.1: lines longer than 75 octets are folded with CRLF + one space. Never splits a UTF-8 character. */
export function foldLine(line: string): string {
  const enc = new TextEncoder()
  const out: string[] = []
  let cur = ''
  let bytes = 0
  for (const ch of line) {
    const n = enc.encode(ch).length
    const limit = out.length === 0 ? 75 : 74 // continuation lines start with a space
    if (bytes + n > limit) {
      out.push(cur)
      cur = ''
      bytes = 0
    }
    cur += ch
    bytes += n
  }
  out.push(cur)
  return out.join('\r\n ')
}

export function buildIcs(ev: CalendarEvent, nowUtc: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GreenWindow//Assistant//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${ev.uid}@greenwindow`,
    `DTSTAMP:${icsDate(nowUtc)}`,
    `DTSTART:${icsDate(ev.startUtc)}`,
    `DTEND:${icsDate(ev.endUtc)}`,
    `SUMMARY:${icsEscape(ev.title)}`,
    `DESCRIPTION:${icsEscape(ev.description)}`,
    ...(ev.url ? [`URL:${ev.url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

export function googleCalendarUrl(ev: CalendarEvent): string {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${icsDate(ev.startUtc)}/${icsDate(ev.endUtc)}`,
    details: ev.url ? `${ev.description}\n${ev.url}` : ev.description,
  })
  return `https://calendar.google.com/calendar/render?${p.toString()}`
}
