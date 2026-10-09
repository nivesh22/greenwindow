import { describe, expect, it } from 'vitest'
import { buildIcs, foldLine, googleCalendarUrl, icsDate, icsEscape } from './calendar'

const ev = {
  uid: 'plan-1',
  title: 'Run dishwasher, cleaner window',
  startUtc: '2026-10-10T01:00:00Z',
  endUtc: '2026-10-10T03:00:00Z',
  description: 'Estimated emissions difference: about 120 g; uses average grid intensity.',
}

describe('calendar', () => {
  it('formats UTC dates in basic form', () => {
    expect(icsDate('2026-10-10T01:00:00Z')).toBe('20261010T010000Z')
    expect(icsDate('2026-10-10T01:00:00.000Z')).toBe('20261010T010000Z')
    expect(() => icsDate('nope')).toThrow()
  })

  it('escapes TEXT and folds long lines at 75 octets', () => {
    expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne')
    const folded = foldLine('DESCRIPTION:' + 'é'.repeat(80))
    for (const l of folded.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75)
    expect(folded.split('\r\n').slice(1).every((l) => l.startsWith(' '))).toBe(true)
  })

  it('builds a valid single-event calendar with CRLF lines', () => {
    const ics = buildIcs(ev, '2026-10-09T12:00:00Z')
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(ics).toContain('DTSTART:20261010T010000Z\r\n')
    expect(ics).toContain('DTEND:20261010T030000Z\r\n')
    expect(ics).toContain('UID:plan-1@greenwindow\r\n')
    expect(ics).toContain('SUMMARY:Run dishwasher\\, cleaner window\r\n')
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })

  it('builds the Google Calendar template link', () => {
    const u = new URL(googleCalendarUrl(ev))
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(u.searchParams.get('action')).toBe('TEMPLATE')
    expect(u.searchParams.get('dates')).toBe('20261010T010000Z/20261010T030000Z')
    expect(u.searchParams.get('text')).toBe(ev.title)
  })
})
