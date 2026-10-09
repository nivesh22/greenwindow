// Contract (orchestrator-owned): user data for P3 (design §9.1, PRD FR-6/7). The Supabase implementation lives in
// store/supabase_users.ts (backend-engineer); MemoryUserStore below is the reference implementation for tests.
// Every method takes the acting userId explicitly and must only touch that user's rows (defense in depth over RLS).
import type { Mode } from '../../src/scheduler/optimizer.js'

/** Who is calling, from a verified Supabase access token (api/_lib/auth.ts). */
export interface AuthUser {
  userId: string
  isAnonymous: boolean
  email: string | null
}

export interface Profile {
  userId: string
  displayName: string | null
  riskDefault: Mode
  quietFrom: string | null // 'HH:mm' Europe/London
  quietTo: string | null
}

export interface Device {
  id: string
  userId: string
  name: string
  kw: number
  typicalHours: number | null
  sourceDeviceId: string | null
}

export interface Conversation {
  id: string
  userId: string
  title: string | null
  createdAtUtc: string
  updatedAtUtc: string
}

export interface StoredMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  turnId: string | null
  createdAtUtc: string
}

export interface ConversationContext {
  conversation: Conversation
  /** The most recent messages, oldest first (at most `limit`). */
  messages: StoredMessage[]
  summary: { text: string; uptoMessageId: string | null } | null
}

export interface ImpactRow {
  id: string
  userId: string
  conversationId: string | null
  turnId: string | null
  windowStartUtc: string
  runNowStartUtc: string
  durationH: number
  energyKwh: number
  runId: string
  model: string
  estPointG: number
  estLowG: number
  estHighG: number
  realizedG: number | null
  realizedAtUtc: string | null
  realizedNote: string | null
  createdAtUtc: string
}

export type NewImpactRow = Omit<ImpactRow, 'id' | 'realizedG' | 'realizedAtUtc' | 'realizedNote' | 'createdAtUtc'>

export interface FeedbackInput {
  turnId: string
  userId: string | null
  rating: 1 | -1
  comment: string | null
}

export interface UserStore {
  getProfile(userId: string): Promise<Profile | null>
  upsertProfile(p: Profile): Promise<Profile>
  listDevices(userId: string): Promise<Device[]>
  /** Insert or update by (userId, name). */
  saveDevice(d: Omit<Device, 'id'> & { id?: string }): Promise<Device>
  deleteDevice(userId: string, id: string): Promise<void>

  /** The conversation if it exists and belongs to userId, else a new one with this id (or a fresh id when null). */
  ensureConversation(userId: string, conversationId: string | null, nowMs: number): Promise<Conversation>
  latestConversation(userId: string): Promise<Conversation | null>
  /** null when the conversation does not exist or belongs to someone else. */
  loadConversation(userId: string, conversationId: string, limit: number): Promise<ConversationContext | null>
  appendMessages(userId: string, conversationId: string, msgs: Omit<StoredMessage, 'id' | 'conversationId' | 'createdAtUtc'>[], nowMs: number): Promise<void>
  saveSummary(userId: string, conversationId: string, summary: string, uptoMessageId: string | null): Promise<void>

  addImpact(row: NewImpactRow): Promise<ImpactRow>
  listImpact(userId: string, limit: number): Promise<ImpactRow[]>
  setRealized(userId: string, id: string, realizedG: number | null, note: string | null, nowMs: number): Promise<void>

  saveFeedback(f: FeedbackInput): Promise<void>
  /** Deletes every row of the user (FR-7.4). The Supabase version deletes the auth user; tables cascade. */
  deleteUserData(userId: string): Promise<void>
  isAdmin(userId: string): Promise<boolean>
  /** Moves an anonymous user's conversations, messages and ledger to another user (Google sign-in fallback, S6). */
  reassign(fromUserId: string, toUserId: string): Promise<void>
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** In-memory UserStore with the same semantics as the SQL implementation. Tests and local dev only. */
export class MemoryUserStore implements UserStore {
  readonly profiles = new Map<string, Profile>()
  readonly devices: Device[] = []
  readonly conversations: Conversation[] = []
  readonly messages: StoredMessage[] = []
  readonly summaries = new Map<string, { userId: string; text: string; uptoMessageId: string | null }>()
  readonly impact: ImpactRow[] = []
  readonly feedback: (FeedbackInput & { id: string })[] = []
  readonly admins = new Set<string>()
  private seq = 0
  private readonly newId: () => string
  private readonly now: () => number

  constructor(opts: { newId?: () => string; now?: () => number } = {}) {
    this.newId = opts.newId ?? (() => `00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}`)
    this.now = opts.now ?? Date.now
  }

  async getProfile(userId: string): Promise<Profile | null> {
    return this.profiles.get(userId) ?? null
  }
  async upsertProfile(p: Profile): Promise<Profile> {
    this.profiles.set(p.userId, { ...p })
    return { ...p }
  }
  async listDevices(userId: string): Promise<Device[]> {
    return this.devices.filter((d) => d.userId === userId).map((d) => ({ ...d }))
  }
  async saveDevice(d: Omit<Device, 'id'> & { id?: string }): Promise<Device> {
    const i = this.devices.findIndex((x) => x.userId === d.userId && x.name === d.name)
    const row: Device = { ...d, id: i >= 0 ? this.devices[i]!.id : (d.id ?? this.newId()) }
    if (i >= 0) this.devices[i] = row
    else this.devices.push(row)
    return { ...row }
  }
  async deleteDevice(userId: string, id: string): Promise<void> {
    const i = this.devices.findIndex((d) => d.userId === userId && d.id === id)
    if (i >= 0) this.devices.splice(i, 1)
  }

  async ensureConversation(userId: string, conversationId: string | null, nowMs: number): Promise<Conversation> {
    const found = conversationId ? this.conversations.find((c) => c.id === conversationId) : undefined
    if (found && found.userId === userId) return { ...found }
    const id = found || !conversationId ? this.newId() : conversationId // someone else's id: never reuse it
    const c: Conversation = { id, userId, title: null, createdAtUtc: iso(nowMs), updatedAtUtc: iso(nowMs) }
    this.conversations.push(c)
    return { ...c }
  }
  async latestConversation(userId: string): Promise<Conversation | null> {
    const mine = this.conversations.filter((c) => c.userId === userId).sort((a, b) => b.updatedAtUtc.localeCompare(a.updatedAtUtc))
    return mine[0] ? { ...mine[0] } : null
  }
  async loadConversation(userId: string, conversationId: string, limit: number): Promise<ConversationContext | null> {
    const c = this.conversations.find((x) => x.id === conversationId && x.userId === userId)
    if (!c) return null
    const msgs = this.messages.filter((m) => m.conversationId === c.id)
    const s = this.summaries.get(c.id)
    return { conversation: { ...c }, messages: msgs.slice(-limit).map((m) => ({ ...m })), summary: s ? { text: s.text, uptoMessageId: s.uptoMessageId } : null }
  }
  async appendMessages(userId: string, conversationId: string, msgs: Omit<StoredMessage, 'id' | 'conversationId' | 'createdAtUtc'>[], nowMs: number): Promise<void> {
    const c = this.conversations.find((x) => x.id === conversationId && x.userId === userId)
    if (!c) throw new Error('conversation not found for user')
    for (const m of msgs) this.messages.push({ ...m, id: this.newId(), conversationId, createdAtUtc: iso(nowMs) })
    c.updatedAtUtc = iso(nowMs)
  }
  async saveSummary(userId: string, conversationId: string, summary: string, uptoMessageId: string | null): Promise<void> {
    this.summaries.set(conversationId, { userId, text: summary, uptoMessageId })
  }

  async addImpact(row: NewImpactRow): Promise<ImpactRow> {
    const r: ImpactRow = { ...row, id: this.newId(), realizedG: null, realizedAtUtc: null, realizedNote: null, createdAtUtc: iso(this.now()) }
    this.impact.push(r)
    return { ...r }
  }
  async listImpact(userId: string, limit: number): Promise<ImpactRow[]> {
    return this.impact.filter((r) => r.userId === userId).slice(-limit).reverse().map((r) => ({ ...r }))
  }
  async setRealized(userId: string, id: string, realizedG: number | null, note: string | null, nowMs: number): Promise<void> {
    const r = this.impact.find((x) => x.id === id && x.userId === userId)
    if (r) Object.assign(r, { realizedG, realizedNote: note, realizedAtUtc: iso(nowMs) })
  }

  async saveFeedback(f: FeedbackInput): Promise<void> {
    const i = this.feedback.findIndex((x) => x.turnId === f.turnId && x.userId === f.userId)
    if (i >= 0) this.feedback[i] = { ...f, id: this.feedback[i]!.id }
    else this.feedback.push({ ...f, id: this.newId() })
  }
  async deleteUserData(userId: string): Promise<void> {
    this.profiles.delete(userId)
    const convIds = new Set(this.conversations.filter((c) => c.userId === userId).map((c) => c.id))
    const keep = <T extends { userId: string | null }>(xs: T[]) => xs.splice(0, xs.length, ...xs.filter((x) => x.userId !== userId))
    keep(this.devices)
    keep(this.conversations)
    this.messages.splice(0, this.messages.length, ...this.messages.filter((m) => !convIds.has(m.conversationId)))
    keep(this.impact)
    keep(this.feedback)
    for (const [k, v] of this.summaries) if (v.userId === userId) this.summaries.delete(k)
    this.admins.delete(userId)
  }
  async isAdmin(userId: string): Promise<boolean> {
    return this.admins.has(userId)
  }
  async reassign(fromUserId: string, toUserId: string): Promise<void> {
    for (const c of this.conversations) if (c.userId === fromUserId) c.userId = toUserId
    for (const r of this.impact) if (r.userId === fromUserId) r.userId = toUserId
    for (const [, v] of this.summaries) if (v.userId === fromUserId) v.userId = toUserId
    // Messages follow their conversation (the SQL version also updates messages.user_id).
  }
}
