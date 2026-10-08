// Deterministic slot extraction for the plan gates (design §6.2 ask_or_act state): what the user wrote, what the
// planner panel holds, and device defaults from the curated table (tools/devices.ts via lookup_device).
import type { PanelState } from '../harness/events.js'
import { DEVICES, tokens } from '../tools/lookup_device.js'
import type { HistoryMsg } from './input.js'

export type SlotSource = 'user' | 'panel' | 'device_default'
export interface Slot<T> {
  value: T
  source: SlotSource
}

export interface DeviceMatch {
  id: string
  name: string
  kw: number | null
  typicalHours: number | null
}

export interface Slots {
  duration_h: Slot<number> | null
  power_kw: Slot<number> | null
  deadline: Slot<string> | null
  earliest: Slot<string> | null
  device: DeviceMatch | null
}

type Device = (typeof DEVICES.devices)[number]

function deviceKw(d: Device): number | null {
  if (d.kw !== undefined) return d.kw
  if (d.tdp_w !== undefined) return d.tdp_w / 1000
  return null
}

/** Devices whose name or an alias appears in the text (all alias tokens present), best (longest alias) first. */
export function matchDevices(text: string): DeviceMatch[] {
  const have = new Set(tokens(text))
  const hits: { d: Device; matched: string[] }[] = []
  for (const d of DEVICES.devices) {
    let best: string[] = []
    for (const alias of [d.name, ...d.aliases]) {
      const t = tokens(alias)
      if (t.length > best.length && t.every((x) => have.has(x))) best = t
    }
    if (best.length > 0) hits.push({ d, matched: best })
  }
  hits.sort((a, b) => b.matched.length - a.matched.length)
  // A device whose matched words were all used by a better match is the same mention ("h100" vs "h100 pcie").
  const used = new Set<string>()
  const out: DeviceMatch[] = []
  for (const { d, matched } of hits) {
    if (matched.every((x) => used.has(x))) continue
    for (const x of matched) used.add(x)
    out.push({ id: d.id, name: d.name, kw: deviceKw(d), typicalHours: d.typical_hours ?? null })
  }
  return out
}

const NUM = String.raw`(\d+(?:\.\d+)?)`
const DURATION = new RegExp(String.raw`\b${NUM}\s*(?:-|\s)?(h|hrs?|hours?)\b`, 'i')
const DURATION_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, an: 1, a: 1 }
const DURATION_WORD = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an|a)\s*(?:-|\s)?(hours?|hrs?)\b/i
const POWER = new RegExp(String.raw`\b${NUM}\s*(kw|kilowatts?|w|watts?)(?!h)\b`, 'i')
const DEADLINE: readonly RegExp[] = [
  /\b(by|before|until|till|til|no later than|done by|finished by|ready by|finish by|deadline( is| of)?)\s+(\d{1,2}([:.]\d{2})?\s*(am|pm)?|noon|midnight|morning|tonight|tomorrow|the morning|(mon|tues|wednes|thurs|fri|satur|sun)day)/i,
  /\b(overnight|tonight|by (the )?morning|by tomorrow|tomorrow (morning|evening|night|afternoon))\b/i,
  /\b(within|in) the next \d+\s*(h|hrs?|hours?|days?)\b/i,
  /\b(any ?time|whenever|no (deadline|rush)|next (two|2|48) (days|hours))\b/i,
]

function durationIn(text: string): number | null {
  const m = DURATION.exec(text)
  if (m) return Number(m[1])
  const w = DURATION_WORD.exec(text)
  return w ? (DURATION_WORDS[w[1]!.toLowerCase()] ?? null) : null
}

function powerIn(text: string): number | null {
  const m = POWER.exec(text)
  if (!m) return null
  const v = Number(m[1])
  return /^k/i.test(m[2]!) ? v : v / 1000
}

function deadlineIn(text: string): string | null {
  for (const re of DEADLINE) {
    const m = re.exec(text)
    if (m) return m[0]
  }
  return null
}

/**
 * Slots from the current message first, then earlier user messages (newest first), then the panel, then device
 * defaults. A device match fills power and, when the table has one, a typical duration.
 */
export function extractSlots(message: string, history: readonly HistoryMsg[], panel: PanelState | null): Slots {
  const texts = [message, ...history.filter((h) => h.role === 'user').map((h) => h.content).reverse()]
  const first = <T>(f: (t: string) => T | null): T | null => {
    for (const t of texts) {
      const v = f(t)
      if (v !== null) return v
    }
    return null
  }
  const device = first((t) => matchDevices(t)[0] ?? null)
  const dUser = first(durationIn)
  const pUser = first(powerIn)
  const dl = first(deadlineIn)

  const duration_h: Slot<number> | null =
    dUser !== null ? { value: dUser, source: 'user' }
    : panel?.duration_h != null ? { value: panel.duration_h, source: 'panel' }
    : device?.typicalHours != null ? { value: device.typicalHours, source: 'device_default' }
    : null
  const power_kw: Slot<number> | null =
    pUser !== null ? { value: pUser, source: 'user' }
    : panel?.power_kw != null ? { value: panel.power_kw, source: 'panel' }
    : device?.kw != null ? { value: device.kw, source: 'device_default' }
    : null
  const deadline: Slot<string> | null =
    dl !== null ? { value: dl, source: 'user' } : panel?.deadline_utc != null ? { value: panel.deadline_utc, source: 'panel' } : null
  const earliest: Slot<string> | null = panel?.earliest_utc != null ? { value: panel.earliest_utc, source: 'panel' } : null
  return { duration_h, power_kw, deadline, earliest, device }
}

export function missingSlots(s: Slots): ('duration_h' | 'power_kw' | 'deadline')[] {
  const out: ('duration_h' | 'power_kw' | 'deadline')[] = []
  if (!s.duration_h) out.push('duration_h')
  if (!s.power_kw) out.push('power_kw')
  if (!s.deadline) out.push('deadline')
  return out
}
