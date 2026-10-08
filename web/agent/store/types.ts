// Contract (orchestrator-owned): persistence used by the harness and API. Design §9, P1a subset
// (usage, cost ledger, turns, spans). The Supabase implementation lives in store/supabase.ts (backend-engineer);
// MemoryStore below is the reference implementation used by unit tests.
import type { StopReason } from '../harness/events.js'

export interface ConsumeArgs {
  userId: string | null // null before auth (P1–P2)
  ipHash: string
  isAnonymous: boolean
  dailyCap: number
  anonCap: number
  ipHourlyCap: number
  globalDailyCap: number
  nowMs: number
}

export type LimitKind = 'anon_limit' | 'daily_cap' | 'rate' | 'budget_paused'

export interface ConsumeResult {
  allowed: boolean
  kind: LimitKind | null
  messagesLeft: number | null
}

export type SpanKind = 'gate' | 'llm' | 'tool' | 'stage'

export interface SpanRecord {
  id: string
  turnId: string
  parentId: string | null
  kind: SpanKind
  name: string
  startedAtUtc: string
  durationMs: number
  status: 'ok' | 'error'
  attrs: Record<string, unknown> // OTel GenAI names + gw.* (design §14)
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface TurnRecord {
  id: string
  conversationId: string
  userId: string | null
  ipHash: string
  intent: string | null
  stopReason: StopReason
  promptVersion: string
  modelFinal: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
  createdAtUtc: string
}

export interface BudgetState {
  month: string // 'YYYY-MM' (UTC)
  spentUsd: number
  paused: boolean
}

export interface Store {
  /** Atomic: kill switch + rate limits + caps + counters in one call (SQL consume_message). */
  consumeMessage(args: ConsumeArgs): Promise<ConsumeResult>
  /** Month-to-date spend; callers cache it for ~60 s. */
  budget(nowMs: number): Promise<BudgetState>
  /** Atomically adds spend; pauses when the total reaches limitUsd. Returns the new state. */
  addSpend(nowMs: number, usd: number, limitUsd: number): Promise<BudgetState>
  saveTurn(turn: TurnRecord, spans: SpanRecord[]): Promise<void>
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const hourOf = (ms: number): string => new Date(ms).toISOString().slice(0, 13)

/** In-memory Store with the same semantics as the SQL implementation. For tests and local dev only. */
export class MemoryStore implements Store {
  readonly turns: TurnRecord[] = []
  readonly spans: SpanRecord[] = []
  private readonly counters = new Map<string, number>()
  private readonly ledger = new Map<string, BudgetState>()

  private bump(key: string): number {
    const v = (this.counters.get(key) ?? 0) + 1
    this.counters.set(key, v)
    return v
  }

  async consumeMessage(a: ConsumeArgs): Promise<ConsumeResult> {
    if ((await this.budget(a.nowMs)).paused) return { allowed: false, kind: 'budget_paused', messagesLeft: null }
    const day = dayOf(a.nowMs)
    const ipHour = `ip:${a.ipHash}:${hourOf(a.nowMs)}`
    const global = `global:${day}`
    if ((this.counters.get(ipHour) ?? 0) >= a.ipHourlyCap || (this.counters.get(global) ?? 0) >= a.globalDailyCap) {
      return { allowed: false, kind: 'rate', messagesLeft: null }
    }
    let left: number | null = null
    if (a.userId !== null) {
      const key = a.isAnonymous ? `anon:${a.userId}` : `user:${a.userId}:${day}`
      const cap = a.isAnonymous ? a.anonCap : a.dailyCap
      const used = this.counters.get(key) ?? 0
      if (used >= cap) return { allowed: false, kind: a.isAnonymous ? 'anon_limit' : 'daily_cap', messagesLeft: 0 }
      left = cap - this.bump(key)
    }
    this.bump(ipHour)
    this.bump(global)
    return { allowed: true, kind: null, messagesLeft: left }
  }

  async budget(nowMs: number): Promise<BudgetState> {
    const month = monthOf(nowMs)
    return this.ledger.get(month) ?? { month, spentUsd: 0, paused: false }
  }

  async addSpend(nowMs: number, usd: number, limitUsd: number): Promise<BudgetState> {
    const cur = await this.budget(nowMs)
    const spentUsd = cur.spentUsd + usd
    const next = { month: cur.month, spentUsd, paused: cur.paused || spentUsd >= limitUsd }
    this.ledger.set(cur.month, next)
    return next
  }

  async saveTurn(turn: TurnRecord, spans: SpanRecord[]): Promise<void> {
    this.turns.push(turn)
    this.spans.push(...spans)
  }
}
