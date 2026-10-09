// Deterministic grounding check (design §6.4, AGENTS.md rules 9 and 14, plan X4). Every clock time, mass,
// intensity, percentage and kW/kWh figure in the answer must trace back to a tool output of this turn or to a number
// the user wrote. Banned impact wording and a missing caveat are violations too. Pure function: no I/O, no clock.
import { fmtMass } from '../../src/lib/format.js'
import { HOUR_MS, formatHour, toIso } from '../../src/lib/time.js'

export type ViolationKind = 'ungrounded_number' | 'banned_claim' | 'missing_caveat'
export interface Violation {
  kind: ViolationKind
  match: string
}

export interface ToolResultLike {
  tool: string
  ok: boolean
  /** The tool's output when ok, its error object otherwise (error messages may quote times too). */
  data: unknown
}

export interface GroundingInput {
  text: string
  toolResults: readonly ToolResultLike[]
  userTexts: readonly string[]
}

export interface GroundingResult {
  ok: boolean
  violations: Violation[]
}

type NumUnit = 'intensity' | 'percent' | 'power' | 'energy'

/** A figure found in text. `tol` is one rounding unit of the precision it was written with. */
export type Found =
  | { kind: 'time'; zone: 'london' | 'utc'; minutes: number[]; match: string }
  | { kind: 'mass'; grams: number; tol: number; match: string }
  | { kind: 'number'; unit: NumUnit; value: number; tol: number; match: string }

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?`
const AMPM = String.raw`(a\.m\.|p\.m\.|am|pm)`
const ZONE = String.raw`(?:\s*\b(BST|GMT|UTC|Z)\b)?`

const RE = {
  // Order matters: earlier patterns are masked out before later ones run (e.g. "51.2 gCO2/kWh" is not a mass).
  intensity: new RegExp(String.raw`(?<![\w.,])(-\s?)?${NUM}\s*g(?:rams?)?\s*(?:of\s+)?(?:CO2e?\s*)?(?:\/|per\s+)\s*kWh\b`, 'gi'),
  percent: new RegExp(String.raw`(?<![\w.,])(-\s?)?${NUM}\s*(?:%|per\s?cent\b)`, 'gi'),
  energy: new RegExp(String.raw`(?<![\w.,])(-\s?)?${NUM}\s*(kWh|kW)(?![\w])`, 'gi'),
  mass: new RegExp(String.raw`(?<![\w.,])(-\s?)?${NUM}\s*(kilograms?|kg|grams?|g|tonnes?|t)(?![\w])(?:\s*CO2e?\b)?`, 'gi'),
  clock: new RegExp(String.raw`(?<![\w:.,])([01]?\d|2[0-3]):([0-5]\d)(?!\d)(?:\s*${AMPM}(?![\w]))?${ZONE}`, 'gi'),
  clockDot: new RegExp(String.raw`(?<![\w:.,])(1[0-2]|0?[1-9])\.([0-5]\d)\s*${AMPM}(?![\w])${ZONE}`, 'gi'),
  hourAmPm: new RegExp(String.raw`(?<![\w:.,])(1[0-2]|0?[1-9])\s*${AMPM}(?![\w])${ZONE}`, 'gi'),
} as const

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/
const BARE_NUMBER = /-?\d+(?:\.\d+)?/g

/** Unicode minus/dashes, subscript CO₂ and curly apostrophes, so the patterns stay ASCII. */
export function normalize(text: string): string {
  return text.replace(/[−‒–]/g, '-').replace(/CO₂/gi, 'CO2').replace(/[‘’]/g, "'")
}

const parseNum = (int: string, frac: string | undefined, sign: string | undefined): { value: number; decimals: number } => {
  const decimals = frac ? frac.length - 1 : 0
  const v = Number(int.replace(/,/g, '') + (frac ?? ''))
  return { value: sign ? -v : v, decimals }
}

const MASS_FACTOR: Record<string, number> = { g: 1, gram: 1, grams: 1, kg: 1e3, kilogram: 1e3, kilograms: 1e3, t: 1e6, tonne: 1e6, tonnes: 1e6 }

function clockMinutes(h: number, m: number, ampm: string | undefined, hourText: string): number[] {
  if (ampm) {
    const pm = ampm.toLowerCase().startsWith('p')
    return [((h % 12) + (pm ? 12 : 0)) * 60 + m]
  }
  // "7:00" without am/pm or a leading zero may mean 19:00 in casual writing; "07:00" may not.
  return h < 12 && !hourText.startsWith('0') && h !== 0 ? [h * 60 + m, (h + 12) * 60 + m] : [h * 60 + m]
}

const zoneOf = (z: string | undefined): 'london' | 'utc' => (z && /^(utc|z)$/i.test(z) ? 'utc' : 'london')

type Groups = [string, ...(string | undefined)[]]

/** Extracts every checked figure from `text`, in order of pattern priority. Dates and bare counts are not extracted. */
export function extractFigures(raw: string): Found[] {
  let text = normalize(raw)
  const out: Found[] = []
  /** Runs `re`, maps each match (m[0] = whole match, m[i] = group i) and blanks it out for later patterns. */
  const take = (re: RegExp, f: (m: Groups) => Found): void => {
    text = text.replace(re, (...args: unknown[]) => {
      const m = args.slice(0, -2) as Groups // replace() passes (match, ...groups, offset, input)
      out.push(f(m))
      return ' '.repeat(m[0].length)
    })
  }
  const numeric = (unit: NumUnit) => (m: Groups): Found => {
    const { value, decimals } = parseNum(m[2]!, m[3], m[1])
    return { kind: 'number', unit, value, tol: 10 ** -decimals, match: m[0].trim() }
  }
  take(RE.intensity, numeric('intensity'))
  take(RE.percent, numeric('percent'))
  take(RE.energy, (m) => numeric(m[4]!.toLowerCase() === 'kwh' ? 'energy' : 'power')(m))
  take(RE.mass, (m) => {
    const { value, decimals } = parseNum(m[2]!, m[3], m[1])
    const unit = (m[4] ?? 'g').toLowerCase()
    const factor = MASS_FACTOR[unit] ?? 1
    return { kind: 'mass', grams: value * factor, tol: 10 ** -decimals * factor, match: m[0].trim() }
  })
  take(RE.clock, (m) => ({
    kind: 'time',
    zone: zoneOf(m[4]),
    minutes: clockMinutes(Number(m[1]), Number(m[2]), m[3], m[1]!),
    match: m[0].trim(),
  }))
  take(RE.clockDot, (m) => ({ kind: 'time', zone: zoneOf(m[4]), minutes: clockMinutes(Number(m[1]), Number(m[2]), m[3], m[1]!), match: m[0].trim() }))
  take(RE.hourAmPm, (m) => ({ kind: 'time', zone: zoneOf(m[3]), minutes: clockMinutes(Number(m[1]), 0, m[2], m[1]!), match: m[0].trim() }))
  return out
}

/** Values the answer may use. Masses are in grams; times are minutes after midnight. */
export interface Allowed {
  numbers: number[]
  masses: number[]
  london: Set<number>
  utc: Set<number>
}

const hhmm = (s: string): number | null => {
  const m = /(\d{2}):(\d{2})/.exec(s)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

function addInstant(a: Allowed, ms: number): void {
  const london = hhmm(formatHour(toIso(ms)))
  if (london !== null) a.london.add(london)
  const d = new Date(ms)
  a.utc.add(d.getUTCHours() * 60 + d.getUTCMinutes())
}

function addText(a: Allowed, s: string): void {
  for (const f of extractFigures(s)) {
    if (f.kind === 'time') for (const m of f.minutes) (f.zone === 'utc' ? a.utc : a.london).add(m)
    else if (f.kind === 'mass') a.masses.push(f.grams)
    else a.numbers.push(f.value)
  }
  for (const n of normalize(s).match(BARE_NUMBER) ?? []) {
    const v = Number(n)
    a.numbers.push(v)
    a.masses.push(v)
  }
}

function addNumber(a: Allowed, n: number): void {
  if (!Number.isFinite(n)) return
  a.numbers.push(n)
  a.masses.push(n) // tool masses are in grams
  for (const f of extractFigures(fmtMass(n))) if (f.kind === 'mass') a.masses.push(f.grams)
}

function walk(a: Allowed, v: unknown, depth = 0): void {
  if (depth > 20) return
  if (typeof v === 'number') addNumber(a, v)
  else if (typeof v === 'string') {
    if (ISO_UTC.test(v)) addInstant(a, Date.parse(v))
    else addText(a, v)
  } else if (Array.isArray(v)) {
    for (const x of v) walk(a, x, depth + 1)
  } else if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    // Derived end time of a recommendation (start + duration): "finish by 07:00" is a tool fact too.
    if (typeof o.best_start_utc === 'string' && ISO_UTC.test(o.best_start_utc) && typeof o.duration_h === 'number') {
      addInstant(a, Date.parse(o.best_start_utc) + o.duration_h * HOUR_MS)
    }
    for (const x of Object.values(o)) walk(a, x, depth + 1)
  }
}

export function allowedValues(toolResults: readonly ToolResultLike[], userTexts: readonly string[]): Allowed {
  const a: Allowed = { numbers: [], masses: [], london: new Set(), utc: new Set() }
  for (const r of toolResults) walk(a, r.data)
  for (const t of userTexts) addText(a, t)
  return a
}

const EPS = 1e-9
const near = (x: number, pool: readonly number[], tol: number): boolean => pool.some((p) => Math.abs(x - p) <= tol + EPS)

/** True when `f` traces back to an allowed value. Masses compare by magnitude ("up to 2.6 kg worse" is fine). */
export function isGrounded(f: Found, a: Allowed): boolean {
  if (f.kind === 'time') return f.minutes.some((m) => (f.zone === 'utc' ? a.utc : a.london).has(m))
  if (f.kind === 'mass') return near(Math.abs(f.grams), a.masses.map(Math.abs), f.tol)
  return near(f.value, a.numbers, f.tol)
}

const BANNED: RegExp[] = [/\byou(?:'ve| have)? saved\b/i, /\bCO2 saved\b/i]
const NEAR_CO2 = /\b(avoided|saving|savings)\b/gi
const CO2_WORD = /CO2|carbon|emission/i
const NEAR_CHARS = 60

function bannedClaims(text: string): Violation[] {
  const out: Violation[] = []
  for (const re of BANNED) {
    const m = re.exec(text)
    if (m) out.push({ kind: 'banned_claim', match: m[0] })
  }
  for (const m of text.matchAll(NEAR_CO2)) {
    const i = m.index
    const window = text.slice(Math.max(0, i - NEAR_CHARS), i + m[0].length + NEAR_CHARS)
    if (CO2_WORD.test(window)) out.push({ kind: 'banned_claim', match: m[0] })
  }
  return out
}

export function checkGrounding(input: GroundingInput): GroundingResult {
  const text = normalize(input.text)
  const allowed = allowedValues(input.toolResults, input.userTexts)
  const found = extractFigures(text)
  const violations: Violation[] = []
  const seen = new Set<string>()
  const add = (v: Violation): void => {
    const k = `${v.kind}|${v.match}`
    if (seen.has(k)) return
    seen.add(k)
    violations.push(v)
  }
  for (const f of found) if (!isGrounded(f, allowed)) add({ kind: 'ungrounded_number', match: f.match })
  for (const v of bannedClaims(text)) add(v)
  if (found.some((f) => f.kind === 'mass')) {
    if (!/average/i.test(text)) add({ kind: 'missing_caveat', match: 'average' })
    if (!/estimat/i.test(text)) add({ kind: 'missing_caveat', match: 'estimate' })
  }
  return { ok: violations.length === 0, violations }
}

/** The user-role instruction for the one regeneration attempt. */
export function regenerateInstruction(violations: readonly Violation[]): string {
  const nums = violations.filter((v) => v.kind === 'ungrounded_number').map((v) => `"${v.match}"`)
  const banned = violations.filter((v) => v.kind === 'banned_claim').map((v) => `"${v.match}"`)
  const caveat = violations.some((v) => v.kind === 'missing_caveat')
  const parts: string[] = []
  if (nums.length > 0) parts.push(`Your answer contained figures that are not in the tool results: ${nums.join(', ')}.`)
  if (banned.length > 0) parts.push(`It used wording that is not allowed: ${banned.join(', ')} (never say CO2 was saved or avoided).`)
  if (caveat) parts.push('It gave an emissions figure without the caveat that it is an estimate based on average grid intensity.')
  parts.push('Write the final answer to the user again from scratch, using only figures from the tool results and keeping the required caveat. Do not call tools, and do not mention an earlier draft or a correction.')
  return parts.join(' ')
}
