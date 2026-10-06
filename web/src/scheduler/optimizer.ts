// Scheduler optimizer (spec 6.7, Decision D9/D11). Pure functions: no network, no DOM.

export interface HourForecast { ts: string; q10: number; q50: number; q90: number } // ts: ISO-8601 UTC, hour-beginning

export interface JobSpec {
  durationH: number // integer, 1..12
  powerKw: number // > 0
  earliestStart: string // ISO UTC; must be >= first forecast hour
  deadline: string // ISO UTC; job must END by this; <= last forecast hour + 1h
}

export type Mode = 'expected' | 'cautious'

export interface Candidate { start: string; avgQ10: number; avgQ50: number; avgQ90: number }

export interface Recommendation {
  bestStart: string
  runNowStart: string // = earliestStart
  avgIntensityBest: number // gCO2/kWh, mean of q50 over the best window
  avgIntensityNow: number // same for the run-now window
  energyKwh: number // durationH * powerKw
  intensityReductionPct: number // (now - best) / now * 100, never negative
  gramsDifference: number // energyKwh * (now - best), never negative
  robust: boolean // best window's avg q90 < run-now window's avg q10
  candidates: Candidate[] // every feasible start, in time order
}

export class InfeasibleJobError extends Error {}
/** Inputs outside the documented ranges (the form should prevent these). */
export class InvalidJobError extends Error {}

const HOUR_MS = 3_600_000
const toIso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z')

function validate(forecast: HourForecast[], job: JobSpec, first: number, last: number): [number, number] {
  if (!Number.isInteger(job.durationH) || job.durationH < 1 || job.durationH > 12) {
    throw new InvalidJobError('Duration must be a whole number of hours between 1 and 12.')
  }
  if (!(job.powerKw > 0) || !Number.isFinite(job.powerKw)) throw new InvalidJobError('Power must be greater than 0 kW.')
  const earliest = Date.parse(job.earliestStart)
  const deadline = Date.parse(job.deadline)
  if (Number.isNaN(earliest) || Number.isNaN(deadline)) throw new InvalidJobError('Start and deadline must be valid times.')
  if (forecast.length === 0) throw new InfeasibleJobError('No forecast available.')
  if (earliest < first) throw new InvalidJobError('Earliest start is before the forecast begins.')
  if (deadline > last + HOUR_MS) throw new InvalidJobError('Deadline is after the forecast ends.')
  return [earliest, deadline]
}

export function recommend(forecast: HourForecast[], job: JobSpec, mode: Mode): Recommendation {
  const byTs = new Map(forecast.map((f) => [Date.parse(f.ts), f]))
  const times = [...byTs.keys()].sort((a, b) => a - b)
  const [earliest, deadline] = validate(forecast, job, times[0] ?? 0, times[times.length - 1] ?? 0)

  // Every whole hour s with earliest <= s and s + duration <= deadline, all hours present.
  const firstStart = Math.ceil(earliest / HOUR_MS) * HOUR_MS
  const candidates: Candidate[] = []
  for (let s = firstStart; s + job.durationH * HOUR_MS <= deadline; s += HOUR_MS) {
    const hours: HourForecast[] = []
    for (let i = 0; i < job.durationH; i++) {
      const h = byTs.get(s + i * HOUR_MS)
      if (!h) break
      hours.push(h)
    }
    if (hours.length !== job.durationH) continue // a missing hour makes the start infeasible
    const avg = (k: 'q10' | 'q50' | 'q90') => hours.reduce((acc, h) => acc + h[k], 0) / hours.length
    candidates.push({ start: toIso(s), avgQ10: avg('q10'), avgQ50: avg('q50'), avgQ90: avg('q90') })
  }
  if (candidates.length === 0) {
    throw new InfeasibleJobError("Job doesn't fit before your deadline; shorten it or extend the deadline.")
  }

  const runNow = candidates[0]!
  if (Date.parse(runNow.start) !== firstStart) {
    throw new InfeasibleJobError('The forecast is missing hours at your earliest start; pick a later start.')
  }
  const key = (c: Candidate) => (mode === 'expected' ? c.avgQ50 : c.avgQ90)
  // Ties go to the earliest start: candidates are in time order and only a strictly lower value replaces.
  let best = candidates.reduce((b, c) => (key(c) < key(b) ? c : b), runNow)
  if (!(key(best) < key(runNow))) best = runNow // no better than run-now: no change recommended

  const energyKwh = job.durationH * job.powerKw
  const diff = Math.max(0, runNow.avgQ50 - best.avgQ50)
  return {
    bestStart: best.start,
    runNowStart: runNow.start,
    avgIntensityBest: best.avgQ50,
    avgIntensityNow: runNow.avgQ50,
    energyKwh,
    intensityReductionPct: runNow.avgQ50 > 0 ? (diff / runNow.avgQ50) * 100 : 0,
    gramsDifference: energyKwh * diff,
    robust: best !== runNow && best.avgQ90 < runNow.avgQ10,
    candidates,
  }
}
