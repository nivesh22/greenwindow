// Per-turn assertions (design §15.2). Each returns pass / fail / skip; a scenario passes when none fail.
import { checkGrounding, normalize, type ToolResultLike } from '../agent/harness/grounding.js'
import type { PlanUpdate, TraceSummary } from '../agent/harness/events.js'
import type { ToolCtx } from '../agent/tools/registry.js'
import { recommendWindow, type RecommendWindowOutput } from '../agent/tools/recommend_window.js'
import type { AssertionResult, Expect } from './schema.js'

export interface TurnOutcome {
  answer: string
  stopReason: string
  trace: TraceSummary
  /** The last plan_update event of the turn, if any. */
  planUpdate: PlanUpdate | null
  /** Every tool result of the turn, in call order (recorded by the runner's registry wrapper). */
  toolResults: ToolResultLike[]
}

export type OptimizerRef = (args: NonNullable<Expect['window_equals_optimizer']>) => Promise<RecommendWindowOutput>

/** Runs the real recommend_window handler on a fresh ctx (the fixture source and the scenario's frozen clock). */
export function optimizerRef(makeCtx: () => ToolCtx): OptimizerRef {
  return async (a) => {
    const out = await recommendWindow.handler(makeCtx(), {
      duration_h: a.duration_h,
      power_kw: a.power_kw,
      deadline_local: a.deadline_local,
      mode: a.mode,
      ...(a.earliest_local ? { earliest_local: a.earliest_local } : {}),
    })
    return out
  }
}

const pass = (name: string, detail = ''): AssertionResult => ({ name, status: 'pass', detail })
const fail = (name: string, detail: string): AssertionResult => ({ name, status: 'fail', detail })
const skip = (name: string, detail: string): AssertionResult => ({ name, status: 'skip', detail })
const check = (name: string, ok: boolean, detail: string): AssertionResult => (ok ? pass(name) : fail(name, detail))

export const GATES_NOT_WIRED = 'gates not wired'

/** True when `want` appears in `have` as a subsequence (same order, gaps allowed). */
export function isSubsequence(want: readonly string[], have: readonly string[]): boolean {
  let i = 0
  for (const h of have) if (i < want.length && h === want[i]) i += 1
  return i === want.length
}

export function questionCount(text: string): number {
  return (text.match(/\?(?=\s|$|["')*_])/g) ?? []).length
}

const SCOPE_REPLY = /(only help|only able|can only|i can't|i cannot|i'm not able|not able to|unable to|outside (of )?(my|what)|out of scope|sorry|won't|will not)/i
const ASSUMED = /(assum|typical|default|rough|approximate|ballpark|usual)/i

export function bannedClaimCount(text: string, toolResults: readonly ToolResultLike[]): number {
  return checkGrounding({ text, toolResults, userTexts: [] }).violations.filter((v) => v.kind === 'banned_claim').length
}

/** London clock part ("03:00") of a formatted time such as "Tue 6 Oct, 03:00 BST". */
export function clockOf(londonText: string): string | null {
  return /\b(\d{1,2}:\d{2})\b/.exec(londonText)?.[1] ?? null
}

export async function evaluateTurn(expect: Expect, o: TurnOutcome, ref: OptimizerRef): Promise<AssertionResult[]> {
  const out: AssertionResult[] = []
  const toolNames = o.trace.tools.map((t) => t.name)
  const answer = normalize(o.answer)

  if (expect.gates) {
    for (const [gate, want] of Object.entries(expect.gates)) {
      const name = `gate:${gate}`
      const got = o.trace.gates.find((g) => g.gate === gate)
      if (!got) out.push(skip(name, `${GATES_NOT_WIRED}: no "${gate}" gate in done.trace.gates`))
      else out.push(check(name, got.choice === want, `expected ${want}, got ${got.choice} (${got.source}, ${got.confidence})`))
    }
  }
  if (expect.tools_called) {
    out.push(check('tools_called', isSubsequence(expect.tools_called, toolNames), `expected [${expect.tools_called.join(', ')}] in order, got [${toolNames.join(', ')}]`))
  }
  if (expect.tool_not_called) {
    const bad = expect.tool_not_called.filter((t) => toolNames.includes(t))
    out.push(check('tool_not_called', bad.length === 0, `called forbidden tools: ${bad.join(', ')}`))
  }
  if (expect.window_equals_optimizer) {
    let ref_: RecommendWindowOutput | null = null
    let err = ''
    try {
      ref_ = await ref(expect.window_equals_optimizer)
    } catch (e) {
      err = e instanceof Error ? e.message : 'unknown'
    }
    if (!ref_) out.push(fail('window_equals_optimizer', `optimizer reference failed: ${err}`))
    else if (!o.planUpdate) out.push(fail('window_equals_optimizer', 'no plan_update was emitted'))
    else {
      const p = o.planUpdate
      const w = expect.window_equals_optimizer
      const problems: string[] = []
      if (p.best_start_utc !== ref_.best_start_utc) problems.push(`best_start ${p.best_start_utc} != optimizer ${ref_.best_start_utc}`)
      if (p.duration_h !== w.duration_h) problems.push(`duration_h ${p.duration_h} != ${w.duration_h}`)
      if (Math.abs(p.power_kw - w.power_kw) > 1e-6) problems.push(`power_kw ${p.power_kw} != ${w.power_kw}`)
      const clock = clockOf(ref_.best_start_london)
      if (clock && !answer.includes(clock)) problems.push(`answer does not contain ${clock} (${ref_.best_start_london})`)
      out.push(check('window_equals_optimizer', problems.length === 0, problems.join('; ')))
    }
  }
  if (expect.co2_equals_tool) {
    const r = [...o.toolResults].reverse().find((t) => t.tool === 'estimate_co2' && t.ok)
    const display = (r?.data as { display?: { point?: unknown } } | undefined)?.display
    const point = typeof display?.point === 'string' ? normalize(display.point) : null
    if (!point) out.push(fail('co2_equals_tool', 'estimate_co2 was not called successfully'))
    // A zero difference (best window = run now) may be stated in words instead of "0 g".
    else if (point === '0 g') out.push(check('co2_equals_tool', answer.includes(point) || /\bno (estimated )?(co2 |emissions? )?difference\b|\bsame as (running|starting|charging) now\b/i.test(answer), 'answer states neither 0 g nor that there is no difference'))
    else out.push(check('co2_equals_tool', answer.includes(point), `answer does not contain the tool figure "${point}"`))
  }
  if (expect.contains_caveat) {
    out.push(check('contains_caveat', /average/i.test(answer) && /estimat/i.test(answer), 'answer lacks the "estimate" + "average grid intensity" caveat'))
  }
  if (expect.no_banned_claim) {
    const n = bannedClaimCount(o.answer, o.toolResults)
    out.push(check('no_banned_claim', n === 0 && !/\bCO2\s+(was\s+)?(saved|avoided)\b/i.test(answer), `${n} banned claim(s) in the answer`))
  }
  if (expect.says_assumed) out.push(check('says_assumed', ASSUMED.test(answer), 'answer does not say the values are assumed or typical'))
  if (expect.asks_one_question) {
    const q = questionCount(o.answer)
    out.push(check('asks_one_question', q === 1 && o.planUpdate === null, `${q} question(s), plan_update ${o.planUpdate ? 'present' : 'absent'}`))
  }
  if (expect.refuses) {
    const ok = toolNames.length === 0 && (o.stopReason === 'guard_blocked' || SCOPE_REPLY.test(answer))
    out.push(check('refuses', ok, `tools [${toolNames.join(', ')}], stop ${o.stopReason}, no scope/refusal wording`))
  }
  if (expect.max_steps !== undefined) {
    out.push(check('max_steps', o.trace.totals.steps <= expect.max_steps, `${o.trace.totals.steps} steps > ${expect.max_steps}`))
  }
  if (expect.max_cost_usd !== undefined) {
    out.push(check('max_cost_usd', o.trace.totals.cost_usd <= expect.max_cost_usd, `$${o.trace.totals.cost_usd} > $${expect.max_cost_usd}`))
  }
  if (expect.stop_reason !== undefined) {
    out.push(check('stop_reason', o.stopReason === expect.stop_reason, `expected ${expect.stop_reason}, got ${o.stopReason}`))
  }
  for (const s of expect.answer_contains ?? []) {
    out.push(check(`answer_contains:${s}`, answer.toLowerCase().includes(s.toLowerCase()), `answer lacks "${s}"`))
  }
  for (const s of expect.answer_excludes ?? []) {
    out.push(check(`answer_excludes:${s}`, !answer.toLowerCase().includes(s.toLowerCase()), `answer contains "${s}"`))
  }
  for (const re of expect.answer_matches ?? []) {
    out.push(check(`answer_matches:${re}`, new RegExp(re, 'i').test(answer), `answer does not match /${re}/i`))
  }
  return out
}
