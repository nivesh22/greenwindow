import { formatHour, fromLocalInput, toIso, toLocalInput } from './time'

const hoursFrom = (startIso: string, n: number) =>
  Array.from({ length: n }, (_, i) => toIso(Date.parse(startIso) + i * 3_600_000))

describe('Europe/London display on clock-change days', () => {
  it('spring forward (29 Mar 2026): no duplicated labels, 01:00 local is skipped', () => {
    const labels = hoursFrom('2026-03-28T23:00:00Z', 4).map(formatHour)
    expect(labels).toEqual(['23:00 GMT', '00:00 GMT', '02:00 BST', '03:00 BST'])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('fall back (25 Oct 2026): the repeated 01:00 hour stays distinct', () => {
    const labels = hoursFrom('2026-10-24T23:00:00Z', 4).map(formatHour)
    expect(labels).toEqual(['00:00 BST', '01:00 BST', '01:00 GMT', '02:00 GMT'])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('round-trips datetime-local values in London time', () => {
    const ms = Date.parse('2026-07-01T17:00:00Z')
    expect(toLocalInput(ms)).toBe('2026-07-01T18:00')
    expect(fromLocalInput('2026-07-01T18:00')).toBe(ms)
    expect(fromLocalInput('2026-12-01T18:00')).toBe(Date.parse('2026-12-01T18:00:00Z'))
    expect(fromLocalInput('nonsense')).toBeNull()
  })
})
