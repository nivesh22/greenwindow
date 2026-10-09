// P4 stores over PostgREST (service key): SupabasePlanStore (plans, push subscriptions, reminders, eval runs),
// SupabaseOpsStore (admin reads) and SupabaseLedgerStore (cron: impact rows across users).
// Schema: supabase/migrations/20261009000005_p4_plans_push.sql (+ 0001/0003 for turns, spans, feedback, admins).
// Every user-scoped query filters by user_id (defense in depth: the service key bypasses RLS).
import { z } from 'zod'
import { modeSchema, type StopReason } from '../harness/events.js'
import type {
  EvalRunRow,
  NewPlan,
  NewReminder,
  OpsRows,
  OpsStore,
  Plan,
  PlanStore,
  PushSubscriptionRow,
  Reminder,
  ReminderPayload,
  ReminderStatus,
  TurnTrace,
} from './plan_types.js'
import { WEEKDAYS } from './plan_types.js'
import { isoFull, PostgrestClient, q, type PostgrestOptions } from './postgrest.js'
import type { SpanRecord, TurnRecord } from './types.js'
import type { ImpactRow } from './user_types.js'

export type SupabasePlanStoreOptions = PostgrestOptions

const ts = z.string().transform((s) => new Date(s).toISOString().replace(/\.000Z$/, 'Z'))
const num = z.coerce.number()
const utcOpt = z.string().nullish()

const jobJson = z.object({
  duration_h: z.number().int(),
  power_kw: num,
  mode: modeSchema,
  earliest_utc: utcOpt,
  deadline_utc: utcOpt,
})
const ruleJson = z.object({
  days: z.array(z.enum(WEEKDAYS)),
  window_local: z.object({ from: z.string(), to: z.string() }),
  remind: z.boolean(),
})
const planRow = z.object({
  id: z.string(),
  user_id: z.string(),
  label: z.string(),
  kind: z.enum(['once', 'recurring']),
  job: jobJson,
  rule: ruleJson.nullable(),
  next_start_utc: ts.nullable(),
  next_run_id: z.string().nullable(),
  active: z.boolean(),
  created_at: ts,
})
const subRow = z.object({ id: z.string(), user_id: z.string(), endpoint: z.string(), p256dh: z.string(), auth: z.string() })
const payloadJson = z.object({ title: z.string(), body: z.string(), url: z.string(), start_utc: z.string() })
const reminderRow = z.object({
  id: z.string(),
  user_id: z.string(),
  plan_id: z.string().nullable(),
  send_at: ts,
  sent_at: ts.nullable(),
  status: z.enum(['pending', 'sent', 'failed', 'cancelled']),
  attempts: z.number().int(),
  payload: payloadJson,
})

const toPlan = (r: z.infer<typeof planRow>): Plan => ({
  id: r.id,
  userId: r.user_id,
  label: r.label,
  kind: r.kind,
  job: {
    durationH: r.job.duration_h,
    powerKw: r.job.power_kw,
    mode: r.job.mode,
    ...(r.job.earliest_utc ? { earliestUtc: r.job.earliest_utc } : {}),
    ...(r.job.deadline_utc ? { deadlineUtc: r.job.deadline_utc } : {}),
  },
  rule: r.rule ? { days: r.rule.days, windowLocal: r.rule.window_local, remind: r.rule.remind } : null,
  nextStartUtc: r.next_start_utc,
  nextRunId: r.next_run_id,
  active: r.active,
  createdAtUtc: r.created_at,
})

const toReminder = (r: z.infer<typeof reminderRow>): Reminder => ({
  id: r.id,
  userId: r.user_id,
  planId: r.plan_id,
  sendAtUtc: r.send_at,
  sentAtUtc: r.sent_at,
  status: r.status,
  attempts: r.attempts,
  payload: { title: r.payload.title, body: r.payload.body, url: r.payload.url, startUtc: r.payload.start_utc },
})

const toPayloadJson = (p: ReminderPayload) => ({ title: p.title, body: p.body, url: p.url, start_utc: p.startUtc })

/** Plans listed per user are capped (the UI shows a handful). */
export const MAX_PLANS_LISTED = 100
/** Cron safety bound for the recurring job. */
export const MAX_RECURRING_PLANS = 1000

export class SupabasePlanStore implements PlanStore {
  private readonly db: PostgrestClient

  constructor(opts: SupabasePlanStoreOptions) {
    this.db = new PostgrestClient(opts)
  }

  // ---- plans

  async createPlan(p: NewPlan): Promise<Plan> {
    if ((p.kind === 'recurring') !== (p.rule !== null)) throw new Error('rule must be set iff kind is recurring')
    const raw = await this.db.rest(
      '/plans',
      'POST',
      {
        user_id: p.userId,
        label: p.label,
        kind: p.kind,
        job: {
          duration_h: p.job.durationH,
          power_kw: p.job.powerKw,
          mode: p.job.mode,
          ...(p.job.earliestUtc ? { earliest_utc: p.job.earliestUtc } : {}),
          ...(p.job.deadlineUtc ? { deadline_utc: p.job.deadlineUtc } : {}),
        },
        rule: p.rule ? { days: p.rule.days, window_local: p.rule.windowLocal, remind: p.rule.remind } : null,
        next_start_utc: p.nextStartUtc,
        next_run_id: p.nextRunId,
      },
      'return=representation',
    )
    const r = this.db.parse(z.array(planRow), raw, 'plans')[0]
    if (!r) throw new Error('Unexpected plans response shape')
    return toPlan(r)
  }

  async listPlans(userId: string, opts: { activeOnly: boolean }): Promise<Plan[]> {
    const active = opts.activeOnly ? '&active=eq.true' : ''
    const r = await this.db.rows(planRow, `/plans?user_id=eq.${q(userId)}${active}&select=*&order=created_at.desc&limit=${MAX_PLANS_LISTED}`, 'plans')
    return r.map(toPlan)
  }

  async cancelPlan(userId: string, planId: string): Promise<boolean> {
    const raw = await this.db.rest(
      `/plans?id=eq.${q(planId)}&user_id=eq.${q(userId)}`,
      'PATCH',
      { active: false, updated_at: new Date().toISOString() },
      'return=representation',
    )
    const hit = this.db.parse(z.array(z.object({ id: z.string() }).passthrough()), raw, 'plans')
    if (hit.length === 0) return false
    await this.db.rest(`/reminders?plan_id=eq.${q(planId)}&user_id=eq.${q(userId)}&status=eq.pending`, 'PATCH', { status: 'cancelled' }, 'return=minimal')
    return true
  }

  async activeRecurringPlans(): Promise<Plan[]> {
    const r = await this.db.pages(planRow, '/plans?kind=eq.recurring&active=eq.true&select=*&order=created_at.asc,id.asc', MAX_RECURRING_PLANS, 'plans')
    return r.map(toPlan)
  }

  async setNextStart(planId: string, startUtc: string | null, runId: string | null): Promise<void> {
    await this.db.rest(
      `/plans?id=eq.${q(planId)}`,
      'PATCH',
      { next_start_utc: startUtc, next_run_id: runId, updated_at: new Date().toISOString() },
      'return=minimal',
    )
  }

  // ---- push subscriptions

  async savePushSubscription(s: Omit<PushSubscriptionRow, 'id'>): Promise<void> {
    await this.db.rest(
      '/push_subscriptions?on_conflict=endpoint',
      'POST',
      { user_id: s.userId, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
      'resolution=merge-duplicates,return=minimal',
    )
  }

  async deletePushSubscription(userId: string, endpoint: string): Promise<void> {
    await this.db.rest(`/push_subscriptions?user_id=eq.${q(userId)}&endpoint=eq.${q(endpoint)}`, 'DELETE', undefined, 'return=minimal')
  }

  async listPushSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
    const r = await this.db.rows(subRow, `/push_subscriptions?user_id=eq.${q(userId)}&select=id,user_id,endpoint,p256dh,auth&order=created_at.asc&limit=20`, 'push_subscriptions')
    return r.map((x) => ({ id: x.id, userId: x.user_id, endpoint: x.endpoint, p256dh: x.p256dh, auth: x.auth }))
  }

  async deletePushSubscriptionByEndpoint(endpoint: string): Promise<void> {
    await this.db.rest(`/push_subscriptions?endpoint=eq.${q(endpoint)}`, 'DELETE', undefined, 'return=minimal')
  }

  // ---- reminders

  async addReminder(r: NewReminder): Promise<Reminder> {
    const sendAt = isoFull(Date.parse(r.sendAtUtc))
    const body = { user_id: r.userId, plan_id: r.planId, send_at: sendAt, payload: toPayloadJson(r.payload) }
    if (r.planId === null) {
      const raw = await this.db.rest('/reminders', 'POST', body, 'return=representation')
      const row = this.db.parse(z.array(reminderRow), raw, 'reminders')[0]
      if (!row) throw new Error('Unexpected reminders response shape')
      return toReminder(row)
    }
    // unique (plan_id, send_at): a duplicate is ignored (empty representation), then the existing row is read back.
    const raw = await this.db.rest('/reminders?on_conflict=plan_id,send_at', 'POST', body, 'resolution=ignore-duplicates,return=representation')
    const inserted = this.db.parse(z.array(reminderRow), raw, 'reminders')[0]
    if (inserted) return toReminder(inserted)
    const existing = (
      await this.db.rows(reminderRow, `/reminders?plan_id=eq.${q(r.planId)}&user_id=eq.${q(r.userId)}&send_at=eq.${q(sendAt)}&select=*&limit=1`, 'reminders')
    )[0]
    if (!existing) throw new Error('Reminder insert was ignored but no row exists')
    return toReminder(existing)
  }

  async listReminders(userId: string, opts: { pendingOnly: boolean }): Promise<Reminder[]> {
    const pending = opts.pendingOnly ? '&status=eq.pending' : ''
    const r = await this.db.rows(reminderRow, `/reminders?user_id=eq.${q(userId)}${pending}&select=*&order=send_at.asc&limit=200`, 'reminders')
    return r.map(toReminder)
  }

  async dueReminders(nowMs: number, limit: number): Promise<Reminder[]> {
    const n = Math.max(0, Math.floor(limit))
    const r = await this.db.rows(reminderRow, `/reminders?status=eq.pending&send_at=lte.${q(isoFull(nowMs))}&select=*&order=send_at.asc&limit=${n}`, 'reminders')
    return r.map(toReminder)
  }

  async markReminder(id: string, status: Exclude<ReminderStatus, 'pending'>, nowMs: number): Promise<void> {
    // Read-modify-write on `attempts`: only the single minute-by-minute cron touches a reminder, so no counter race matters.
    const cur = (await this.db.rows(z.object({ attempts: z.number().int() }), `/reminders?id=eq.${q(id)}&select=attempts`, 'reminders'))[0]
    if (!cur) return
    await this.db.rest(
      `/reminders?id=eq.${q(id)}`,
      'PATCH',
      { status, attempts: cur.attempts + 1, ...(status === 'sent' ? { sent_at: isoFull(nowMs) } : {}) },
      'return=minimal',
    )
  }

  // ---- eval runs

  async recordEvalRun(r: EvalRunRow): Promise<void> {
    await this.db.rest(
      '/eval_runs',
      'POST',
      {
        git_sha: r.gitSha,
        mode: r.mode,
        model: r.model,
        prompt_version: r.promptVersion,
        scenarios: r.scenarios,
        pass_rate: r.passRate,
        window_correctness: r.windowCorrectness,
        banned_claims: r.bannedClaims,
        cost_usd: r.costUsd,
        report: r.report,
      },
      'return=minimal',
    )
  }
}

// ---------- ops (admin) ----------

const turnRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  user_id: z.string().nullable(),
  ip_hash: z.string(),
  intent: z.string().nullable(),
  stop_reason: z.string(),
  prompt_version: z.string(),
  model_final: z.string().nullable(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  cost_usd: num,
  latency_ms: z.number().int(),
  created_at: ts,
})
const spanRow = z.object({
  id: z.string(),
  turn_id: z.string(),
  parent_id: z.string().nullable(),
  kind: z.enum(['gate', 'llm', 'tool', 'stage']),
  name: z.string(),
  started_at: ts,
  duration_ms: num,
  status: z.enum(['ok', 'error']),
  attrs: z.record(z.string(), z.unknown()),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  cost_usd: num,
})
const opsSpanRow = spanRow.pick({ turn_id: true, kind: true, name: true, duration_ms: true, status: true, attrs: true })
const opsTurnRow = turnRow.pick({ id: true, intent: true, stop_reason: true, cost_usd: true, latency_ms: true, created_at: true, model_final: true })
const feedbackRow = z.object({ turn_id: z.string(), rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().nullable(), created_at: ts })
const evalRow = z.object({
  git_sha: z.string(),
  mode: z.enum(['replay', 'record', 'live']),
  model: z.string().nullable(),
  prompt_version: z.string(),
  scenarios: z.number().int(),
  pass_rate: num,
  window_correctness: num,
  banned_claims: z.number().int(),
  cost_usd: num,
  report: z.record(z.string(), z.unknown()),
  created_at: ts,
})
const ledgerRow = z.object({ month: z.string(), spent_usd: num, eval_spent_usd: num, paused: z.boolean() })

/** Row bounds for opsRows (turns are capped globally at ~300/day, ~15 spans each; 14 days fit comfortably). */
export const OPS_MAX_TURNS = 5000
export const OPS_MAX_SPANS = 25_000
export const OPS_MAX_FEEDBACK = 500
export const OPS_MAX_EVALS = 30

export interface SupabaseOpsStoreOptions extends PostgrestOptions {
  now?: () => number
}

const toTurn = (r: z.infer<typeof turnRow>): TurnRecord => ({
  id: r.id,
  conversationId: r.conversation_id,
  userId: r.user_id,
  ipHash: r.ip_hash,
  intent: r.intent,
  stopReason: r.stop_reason as StopReason, // stored by the harness; the Ops page treats it as a label
  promptVersion: r.prompt_version,
  modelFinal: r.model_final,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  costUsd: r.cost_usd,
  latencyMs: r.latency_ms,
  createdAtUtc: r.created_at,
})
const toSpan = (r: z.infer<typeof spanRow>): SpanRecord => ({
  id: r.id,
  turnId: r.turn_id,
  parentId: r.parent_id,
  kind: r.kind,
  name: r.name,
  startedAtUtc: r.started_at,
  durationMs: r.duration_ms,
  status: r.status,
  attrs: r.attrs,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  costUsd: r.cost_usd,
})

export class SupabaseOpsStore implements OpsStore {
  private readonly db: PostgrestClient
  private readonly now: () => number

  constructor(opts: SupabaseOpsStoreOptions) {
    this.db = new PostgrestClient({ ...opts, timeoutMs: opts.timeoutMs ?? 15_000 })
    this.now = opts.now ?? Date.now
  }

  async isAdmin(userId: string): Promise<boolean> {
    const r = await this.db.rows(z.object({ user_id: z.string() }), `/admins?user_id=eq.${q(userId)}&select=user_id`, 'admins')
    return r.length > 0
  }

  /** Whether the auth user is anonymous (GoTrue admin API: GET /auth/v1/admin/users/{id}); null when unknown. */
  private async isAnonymous(userId: string): Promise<boolean | null> {
    try {
      const { data } = await this.db.send(`${this.db.url}/auth/v1/admin/users/${q(userId)}`, 'GET')
      const r = z.object({ is_anonymous: z.boolean().optional() }).safeParse(data)
      return r.success && r.data.is_anonymous !== undefined ? r.data.is_anonymous : null
    } catch {
      return null
    }
  }

  async turnTrace(turnId: string): Promise<TurnTrace | null> {
    const t = (await this.db.rows(turnRow, `/turns?id=eq.${q(turnId)}&select=*`, 'turns'))[0]
    if (!t) return null
    const [spans, msgs, fb, anon] = await Promise.all([
      this.db.rows(spanRow, `/spans?turn_id=eq.${q(turnId)}&select=*&order=started_at.asc,id.asc&limit=500`, 'spans'),
      this.db.rows(
        z.object({ role: z.enum(['user', 'assistant']), content: z.string() }),
        `/messages?turn_id=eq.${q(turnId)}&select=role,content&order=created_at.asc&limit=10`,
        'messages',
      ),
      this.db.rows(z.object({ rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().nullable() }), `/feedback?turn_id=eq.${q(turnId)}&select=rating,comment&order=created_at.asc&limit=50`, 'feedback'),
      t.user_id ? this.isAnonymous(t.user_id) : Promise.resolve(null),
    ])
    return {
      turn: toTurn(t),
      spans: spans.map(toSpan),
      userMessage: msgs.find((m) => m.role === 'user')?.content ?? null,
      answer: msgs.find((m) => m.role === 'assistant')?.content ?? null,
      isAnonymous: anon,
      feedback: fb,
    }
  }

  async opsRows(sinceMs: number): Promise<OpsRows> {
    const since = q(isoFull(sinceMs))
    const month = new Date(this.now()).toISOString().slice(0, 7)
    const [turns, spans, feedback, evals, ledger] = await Promise.all([
      this.db.pages(opsTurnRow, `/turns?created_at=gte.${since}&select=id,intent,stop_reason,cost_usd,latency_ms,created_at,model_final&order=created_at.desc,id.asc`, OPS_MAX_TURNS, 'turns'),
      this.db.pages(opsSpanRow, `/spans?started_at=gte.${since}&select=turn_id,kind,name,duration_ms,status,attrs&order=started_at.desc,id.asc`, OPS_MAX_SPANS, 'spans'),
      this.db.rows(feedbackRow, `/feedback?created_at=gte.${since}&select=turn_id,rating,comment,created_at&order=created_at.desc&limit=${OPS_MAX_FEEDBACK}`, 'feedback'),
      this.db.rows(evalRow, `/eval_runs?select=*&order=created_at.desc&limit=${OPS_MAX_EVALS}`, 'eval_runs'),
      this.db.rows(ledgerRow, `/cost_ledger?month=eq.${month}&select=month,spent_usd,eval_spent_usd,paused`, 'cost_ledger'),
    ])
    return {
      turns: turns.map((r) => ({
        id: r.id,
        intent: r.intent,
        stopReason: r.stop_reason as StopReason,
        costUsd: r.cost_usd,
        latencyMs: r.latency_ms,
        createdAtUtc: r.created_at,
        modelFinal: r.model_final,
      })),
      spans: spans.map((r) => ({ turnId: r.turn_id, kind: r.kind, name: r.name, durationMs: r.duration_ms, status: r.status, attrs: r.attrs })),
      feedback: feedback.map((r) => ({ turnId: r.turn_id, rating: r.rating, comment: r.comment, createdAtUtc: r.created_at })),
      evalRuns: evals
        .map((r) => ({
          gitSha: r.git_sha,
          mode: r.mode,
          model: r.model,
          promptVersion: r.prompt_version,
          scenarios: r.scenarios,
          passRate: r.pass_rate,
          windowCorrectness: r.window_correctness,
          bannedClaims: r.banned_claims,
          costUsd: r.cost_usd,
          report: r.report,
          createdAtUtc: r.created_at,
        }))
        .reverse(),
      budget: ledger[0]
        ? { month: ledger[0].month, spentUsd: ledger[0].spent_usd, evalSpentUsd: ledger[0].eval_spent_usd, paused: ledger[0].paused }
        : { month, spentUsd: 0, evalSpentUsd: 0, paused: false },
    }
  }
}

// ---------- impact ledger across users (cron) ----------

const impactRow = z.object({
  id: z.string(),
  user_id: z.string(),
  window_start_utc: ts,
  run_now_start_utc: ts,
  duration_h: z.number().int(),
  energy_kwh: num,
})

/** The slice of an impact_ledger row the realization job needs. */
export type PendingImpact = Pick<ImpactRow, 'id' | 'userId' | 'windowStartUtc' | 'runNowStartUtc' | 'durationH' | 'energyKwh'>

/** Cron-only access to impact rows of all users. Realization math lives in api/_lib/ledger.ts. */
export interface LedgerStore {
  /** Rows with no realized value and no note whose window started at or before `startedBeforeMs`, oldest first. */
  pendingImpact(startedBeforeMs: number, limit: number): Promise<PendingImpact[]>
  setRealized(userId: string, id: string, realizedG: number | null, note: string | null, nowMs: number): Promise<void>
}

export class SupabaseLedgerStore implements LedgerStore {
  private readonly db: PostgrestClient

  constructor(opts: PostgrestOptions) {
    this.db = new PostgrestClient(opts)
  }

  async pendingImpact(startedBeforeMs: number, limit: number): Promise<PendingImpact[]> {
    const r = await this.db.rows(
      impactRow,
      `/impact_ledger?realized_g=is.null&realized_note=is.null&window_start_utc=lte.${q(isoFull(startedBeforeMs))}&select=id,user_id,window_start_utc,run_now_start_utc,duration_h,energy_kwh&order=window_start_utc.asc&limit=${Math.max(0, Math.floor(limit))}`,
      'impact_ledger',
    )
    return r.map((x) => ({ id: x.id, userId: x.user_id, windowStartUtc: x.window_start_utc, runNowStartUtc: x.run_now_start_utc, durationH: x.duration_h, energyKwh: x.energy_kwh }))
  }

  async setRealized(userId: string, id: string, realizedG: number | null, note: string | null, nowMs: number): Promise<void> {
    await this.db.rest(
      `/impact_ledger?id=eq.${q(id)}&user_id=eq.${q(userId)}`,
      'PATCH',
      { realized_g: realizedG, realized_note: note, realized_at: isoFull(nowMs) },
      'return=minimal',
    )
  }
}

/** In-memory LedgerStore for tests. */
export class MemoryLedgerStore implements LedgerStore {
  readonly rows: (PendingImpact & { realizedG: number | null; note: string | null })[] = []
  async pendingImpact(startedBeforeMs: number, limit: number): Promise<PendingImpact[]> {
    return this.rows
      .filter((r) => r.realizedG === null && r.note === null && Date.parse(r.windowStartUtc) <= startedBeforeMs)
      .sort((a, b) => Date.parse(a.windowStartUtc) - Date.parse(b.windowStartUtc))
      .slice(0, limit)
  }
  async setRealized(userId: string, id: string, realizedG: number | null, note: string | null): Promise<void> {
    const r = this.rows.find((x) => x.id === id && x.userId === userId)
    if (r) {
      r.realizedG = realizedG
      r.note = note
    }
  }
}
