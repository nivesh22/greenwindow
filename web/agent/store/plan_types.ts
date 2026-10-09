// Contract (orchestrator-owned): P4 persistence — plans, push subscriptions, reminders (design §9.1, §12, PRD FR-4.8,
// FR-4.10) and the admin/ops reads (FR-8.3, FR-6.5). Schema: supabase/migrations/20261009000005_p4_plans_push.sql.
// The Supabase implementation lives in store/supabase_plans.ts (backend-engineer); MemoryPlanStore below is the
// reference implementation for tests. User-scoped methods take userId explicitly and touch only that user's rows.
import type { Mode } from '../../src/scheduler/optimizer.js'
import type { SpanRecord, TurnRecord } from './types.js'

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface PlanJob {
  durationH: number // 1..12
  powerKw: number
  mode: Mode
  /** 'once' plans only: the window the user asked for (UTC). */
  earliestUtc?: string
  deadlineUtc?: string
}

/** Recurring rule (design §7.4). Times are Europe/London wall clock; the window must fit the job. */
export interface RecurringRule {
  days: Weekday[] // non-empty
  windowLocal: { from: string; to: string } // 'HH:mm'; to > from (no overnight windows in v1)
  remind: boolean
}

export interface Plan {
  id: string
  userId: string
  label: string
  kind: 'once' | 'recurring'
  job: PlanJob
  rule: RecurringRule | null // non-null iff kind = 'recurring'
  nextStartUtc: string | null
  nextRunId: string | null
  active: boolean
  createdAtUtc: string
}

export type NewPlan = Omit<Plan, 'id' | 'active' | 'createdAtUtc'>

export interface PushSubscriptionRow {
  id: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
}

export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'cancelled'

export interface ReminderPayload {
  title: string
  body: string
  url: string // in-app path, e.g. '/scheduler'
  startUtc: string
}

export interface Reminder {
  id: string
  userId: string
  planId: string | null
  sendAtUtc: string
  sentAtUtc: string | null
  status: ReminderStatus
  attempts: number
  payload: ReminderPayload
}

export type NewReminder = Pick<Reminder, 'userId' | 'planId' | 'sendAtUtc' | 'payload'>

export interface EvalRunRow {
  gitSha: string
  mode: 'replay' | 'record' | 'live'
  model: string | null
  promptVersion: string
  scenarios: number
  passRate: number // 0..1
  windowCorrectness: number // 0..1
  bannedClaims: number
  costUsd: number
  report: Record<string, unknown>
}

export interface PlanStore {
  createPlan(p: NewPlan): Promise<Plan>
  listPlans(userId: string, opts: { activeOnly: boolean }): Promise<Plan[]>
  /** Deactivates the plan and cancels its pending reminders. false when it does not exist or is not the user's. */
  cancelPlan(userId: string, planId: string): Promise<boolean>
  /** Service-side (cron): every active recurring plan, all users. */
  activeRecurringPlans(): Promise<Plan[]>
  setNextStart(planId: string, startUtc: string | null, runId: string | null): Promise<void>

  savePushSubscription(s: Omit<PushSubscriptionRow, 'id'>): Promise<void> // upsert on endpoint
  deletePushSubscription(userId: string, endpoint: string): Promise<void>
  listPushSubscriptions(userId: string): Promise<PushSubscriptionRow[]>
  /** Cron: the push service answered 404/410, so the subscription is gone. */
  deletePushSubscriptionByEndpoint(endpoint: string): Promise<void>

  /** Idempotent on (planId, sendAtUtc) when planId is set: returns the existing row instead of a duplicate. */
  addReminder(r: NewReminder): Promise<Reminder>
  listReminders(userId: string, opts: { pendingOnly: boolean }): Promise<Reminder[]>
  /** Cron: pending reminders with sendAtUtc <= now, oldest first. */
  dueReminders(nowMs: number, limit: number): Promise<Reminder[]>
  markReminder(id: string, status: Exclude<ReminderStatus, 'pending'>, nowMs: number): Promise<void>

  recordEvalRun(r: EvalRunRow): Promise<void>
}

/** One turn with everything stored about it (admin trace view, Langfuse re-export on thumbs-down). */
export interface TurnTrace {
  turn: TurnRecord
  spans: SpanRecord[]
  userMessage: string | null
  answer: string | null
  isAnonymous: boolean | null
  feedback: { rating: 1 | -1; comment: string | null }[]
}

/** Admin-only reads (service role). The response shape is opsResponseSchema in harness/api_schemas.ts. */
export interface OpsStore {
  isAdmin(userId: string): Promise<boolean>
  turnTrace(turnId: string): Promise<TurnTrace | null>
  /** Raw rows for the Ops aggregation (ops/aggregate.ts computes the panels from these). */
  opsRows(sinceMs: number): Promise<OpsRows>
}

export interface OpsRows {
  turns: Pick<TurnRecord, 'id' | 'intent' | 'stopReason' | 'costUsd' | 'latencyMs' | 'createdAtUtc' | 'modelFinal'>[]
  spans: Pick<SpanRecord, 'turnId' | 'kind' | 'name' | 'durationMs' | 'status' | 'attrs'>[]
  feedback: { turnId: string; rating: 1 | -1; comment: string | null; createdAtUtc: string }[]
  evalRuns: (EvalRunRow & { createdAtUtc: string })[]
  budget: { month: string; spentUsd: number; evalSpentUsd: number; paused: boolean }
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** In-memory PlanStore with the same semantics as the SQL implementation. Tests and local dev only. */
export class MemoryPlanStore implements PlanStore {
  readonly plans: Plan[] = []
  readonly subs: PushSubscriptionRow[] = []
  readonly reminders: Reminder[] = []
  readonly evalRuns: EvalRunRow[] = []
  private seq = 0
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now
  }

  private id(): string {
    return `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`
  }

  async createPlan(p: NewPlan): Promise<Plan> {
    if ((p.kind === 'recurring') !== (p.rule !== null)) throw new Error('rule must be set iff kind is recurring')
    const plan: Plan = { ...p, id: this.id(), active: true, createdAtUtc: iso(this.now()) }
    this.plans.push(plan)
    return { ...plan }
  }
  async listPlans(userId: string, opts: { activeOnly: boolean }): Promise<Plan[]> {
    return this.plans.filter((p) => p.userId === userId && (!opts.activeOnly || p.active)).map((p) => ({ ...p })).reverse()
  }
  async cancelPlan(userId: string, planId: string): Promise<boolean> {
    const p = this.plans.find((x) => x.id === planId && x.userId === userId)
    if (!p) return false
    p.active = false
    for (const r of this.reminders) if (r.planId === planId && r.status === 'pending') r.status = 'cancelled'
    return true
  }
  async activeRecurringPlans(): Promise<Plan[]> {
    return this.plans.filter((p) => p.active && p.kind === 'recurring').map((p) => ({ ...p }))
  }
  async setNextStart(planId: string, startUtc: string | null, runId: string | null): Promise<void> {
    const p = this.plans.find((x) => x.id === planId)
    if (p) {
      p.nextStartUtc = startUtc
      p.nextRunId = runId
    }
  }

  async savePushSubscription(s: Omit<PushSubscriptionRow, 'id'>): Promise<void> {
    const i = this.subs.findIndex((x) => x.endpoint === s.endpoint)
    if (i >= 0) this.subs[i] = { ...s, id: this.subs[i]!.id }
    else this.subs.push({ ...s, id: this.id() })
  }
  async deletePushSubscription(userId: string, endpoint: string): Promise<void> {
    const i = this.subs.findIndex((x) => x.userId === userId && x.endpoint === endpoint)
    if (i >= 0) this.subs.splice(i, 1)
  }
  async listPushSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
    return this.subs.filter((s) => s.userId === userId).map((s) => ({ ...s }))
  }
  async deletePushSubscriptionByEndpoint(endpoint: string): Promise<void> {
    const i = this.subs.findIndex((x) => x.endpoint === endpoint)
    if (i >= 0) this.subs.splice(i, 1)
  }

  async addReminder(r: NewReminder): Promise<Reminder> {
    const existing = r.planId !== null ? this.reminders.find((x) => x.planId === r.planId && x.sendAtUtc === r.sendAtUtc) : undefined
    if (existing) return { ...existing }
    const row: Reminder = { ...r, id: this.id(), sentAtUtc: null, status: 'pending', attempts: 0 }
    this.reminders.push(row)
    return { ...row }
  }
  async listReminders(userId: string, opts: { pendingOnly: boolean }): Promise<Reminder[]> {
    return this.reminders.filter((r) => r.userId === userId && (!opts.pendingOnly || r.status === 'pending')).map((r) => ({ ...r }))
  }
  async dueReminders(nowMs: number, limit: number): Promise<Reminder[]> {
    return this.reminders
      .filter((r) => r.status === 'pending' && Date.parse(r.sendAtUtc) <= nowMs)
      .sort((a, b) => Date.parse(a.sendAtUtc) - Date.parse(b.sendAtUtc))
      .slice(0, limit)
      .map((r) => ({ ...r }))
  }
  async markReminder(id: string, status: Exclude<ReminderStatus, 'pending'>, nowMs: number): Promise<void> {
    const r = this.reminders.find((x) => x.id === id)
    if (!r) return
    r.status = status
    r.attempts += 1
    if (status === 'sent') r.sentAtUtc = iso(nowMs)
  }

  async recordEvalRun(r: EvalRunRow): Promise<void> {
    this.evalRuns.push({ ...r })
  }
}
