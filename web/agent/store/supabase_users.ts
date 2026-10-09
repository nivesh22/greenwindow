// SupabaseUserStore: UserStore over plain fetch to PostgREST (service key; same header rules as supabase.ts).
// Schema: supabase/migrations/20261009000003_users_memory.sql and 20261009000004_p3_api_retention.sql.
// Every query filters by user_id (defense in depth: the service key bypasses RLS). Never log keys or headers.
import { z } from 'zod'
import { modeSchema } from '../harness/events.js'
import { authHeaders, StoreError } from './supabase.js'
import type { Conversation, ConversationContext, Device, FeedbackInput, ImpactRow, NewImpactRow, Profile, StoredMessage, UserStore } from './user_types.js'

export interface SupabaseUserStoreOptions {
  url: string
  key: string
  fetch?: typeof fetch
  timeoutMs?: number
  newId?: () => string
}

const ts = z.string().transform((s) => new Date(s).toISOString().replace(/\.000Z$/, 'Z'))
const num = z.coerce.number()
const hhmm = z.string().nullable().transform((s) => (s ? s.slice(0, 5) : null))

const profileRow = z.object({ user_id: z.string(), display_name: z.string().nullable(), risk_default: modeSchema, quiet_from: hhmm, quiet_to: hhmm })
const deviceRow = z.object({ id: z.string(), user_id: z.string(), name: z.string(), kw: num, typical_hours: z.number().int().nullable(), source_device_id: z.string().nullable() })
const convRow = z.object({ id: z.string(), user_id: z.string(), title: z.string().nullable(), created_at: ts, updated_at: ts })
const msgRow = z.object({ id: z.string(), conversation_id: z.string(), role: z.enum(['user', 'assistant']), content: z.string(), turn_id: z.string().nullable(), created_at: ts })
const summaryRow = z.object({ summary: z.string(), upto_message_id: z.string().nullable() })
const impactRow = z.object({
  id: z.string(),
  user_id: z.string(),
  conversation_id: z.string().nullable(),
  turn_id: z.string().nullable(),
  window_start_utc: ts,
  run_now_start_utc: ts,
  duration_h: z.number().int(),
  energy_kwh: num,
  run_id: z.string(),
  model: z.string(),
  est_point_g: num,
  est_low_g: num,
  est_high_g: num,
  realized_g: num.nullable(),
  realized_at: ts.nullable(),
  realized_note: z.string().nullable(),
  created_at: ts,
})

const q = encodeURIComponent
const isoFull = (ms: number): string => new Date(ms).toISOString()

export class SupabaseUserStore implements UserStore {
  private readonly url: string
  private readonly base: string
  private readonly key: string
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number
  private readonly newId: () => string

  constructor(opts: SupabaseUserStoreOptions) {
    this.url = opts.url.replace(/\/+$/, '')
    this.base = this.url + '/rest/v1'
    this.key = opts.key
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
    this.timeoutMs = opts.timeoutMs ?? 8000
    this.newId = opts.newId ?? (() => crypto.randomUUID())
  }

  private async send(fullUrl: string, method: string, body?: unknown, prefer?: string): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { ...authHeaders(this.key), accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (prefer) headers.prefer = prefer
    const label = fullUrl.replace(this.url, '').split('?')[0]
    let res: Response
    try {
      res = await this.doFetch(fullUrl, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (e) {
      throw new StoreError('network', `Supabase request failed: ${e instanceof Error ? e.name : 'error'}`)
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 200)
      } catch {
        // ignore
      }
      throw new StoreError('http', `Supabase ${method} ${label} returned ${res.status} ${detail}`.trim(), res.status)
    }
    const text = await res.text()
    if (text === '') return { status: res.status, data: null }
    try {
      return { status: res.status, data: JSON.parse(text) }
    } catch {
      throw new StoreError('parse', `Supabase ${label} returned invalid JSON`, res.status)
    }
  }

  private async rest(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, prefer?: string): Promise<unknown> {
    return (await this.send(this.base + path, method, body, prefer)).data
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value)
    if (!r.success) throw new StoreError('parse', `Unexpected ${what} response shape`)
    return r.data
  }

  private async rows<T>(schema: z.ZodType<T>, path: string, what: string): Promise<T[]> {
    return this.parse(z.array(schema), await this.rest(path, 'GET'), what)
  }

  // ---- profile and devices

  private toProfile(r: z.infer<typeof profileRow>): Profile {
    return { userId: r.user_id, displayName: r.display_name, riskDefault: r.risk_default, quietFrom: r.quiet_from, quietTo: r.quiet_to }
  }
  private toDevice(r: z.infer<typeof deviceRow>): Device {
    return { id: r.id, userId: r.user_id, name: r.name, kw: r.kw, typicalHours: r.typical_hours, sourceDeviceId: r.source_device_id }
  }

  async getProfile(userId: string): Promise<Profile | null> {
    const r = await this.rows(profileRow, `/profiles?user_id=eq.${q(userId)}&select=user_id,display_name,risk_default,quiet_from,quiet_to`, 'profiles')
    return r[0] ? this.toProfile(r[0]) : null
  }

  async upsertProfile(p: Profile): Promise<Profile> {
    const raw = await this.rest('/profiles?on_conflict=user_id', 'POST', {
      user_id: p.userId,
      display_name: p.displayName,
      risk_default: p.riskDefault,
      quiet_from: p.quietFrom,
      quiet_to: p.quietTo,
      updated_at: new Date().toISOString(),
    }, 'resolution=merge-duplicates,return=representation')
    const r = this.parse(z.array(profileRow), raw, 'profiles')
    if (!r[0]) throw new StoreError('parse', 'Unexpected profiles response shape')
    return this.toProfile(r[0])
  }

  async listDevices(userId: string): Promise<Device[]> {
    const r = await this.rows(deviceRow, `/devices?user_id=eq.${q(userId)}&select=*&order=created_at.asc`, 'devices')
    return r.map((x) => this.toDevice(x))
  }

  async saveDevice(d: Omit<Device, 'id'> & { id?: string }): Promise<Device> {
    const fields = { name: d.name, kw: d.kw, typical_hours: d.typicalHours, source_device_id: d.sourceDeviceId }
    if (d.id) {
      // Update by id (rename allowed), scoped to the owner.
      const raw = await this.rest(`/devices?id=eq.${q(d.id)}&user_id=eq.${q(d.userId)}`, 'PATCH', fields, 'return=representation')
      const r = this.parse(z.array(deviceRow), raw, 'devices')
      if (r[0]) return this.toDevice(r[0])
    }
    const raw = await this.rest('/devices?on_conflict=user_id,name', 'POST', { user_id: d.userId, ...fields }, 'resolution=merge-duplicates,return=representation')
    const r = this.parse(z.array(deviceRow), raw, 'devices')
    if (!r[0]) throw new StoreError('parse', 'Unexpected devices response shape')
    return this.toDevice(r[0])
  }

  async deleteDevice(userId: string, id: string): Promise<void> {
    await this.rest(`/devices?id=eq.${q(id)}&user_id=eq.${q(userId)}`, 'DELETE')
  }

  // ---- conversations

  private toConv(r: z.infer<typeof convRow>): Conversation {
    return { id: r.id, userId: r.user_id, title: r.title, createdAtUtc: r.created_at, updatedAtUtc: r.updated_at }
  }

  async ensureConversation(userId: string, conversationId: string | null, nowMs: number): Promise<Conversation> {
    let id = conversationId ?? this.newId()
    if (conversationId) {
      const found = await this.rows(convRow, `/conversations?id=eq.${q(conversationId)}&select=*`, 'conversations')
      if (found[0]) {
        if (found[0].user_id === userId) return this.toConv(found[0])
        id = this.newId() // someone else's id: never reuse it
      }
    }
    const raw = await this.rest('/conversations', 'POST', { id, user_id: userId, created_at: isoFull(nowMs), updated_at: isoFull(nowMs) }, 'return=representation')
    const r = this.parse(z.array(convRow), raw, 'conversations')
    if (!r[0]) throw new StoreError('parse', 'Unexpected conversations response shape')
    return this.toConv(r[0])
  }

  async latestConversation(userId: string): Promise<Conversation | null> {
    const r = await this.rows(convRow, `/conversations?user_id=eq.${q(userId)}&select=*&order=updated_at.desc&limit=1`, 'conversations')
    return r[0] ? this.toConv(r[0]) : null
  }

  async loadConversation(userId: string, conversationId: string, limit: number): Promise<ConversationContext | null> {
    const convs = await this.rows(convRow, `/conversations?id=eq.${q(conversationId)}&user_id=eq.${q(userId)}&select=*`, 'conversations')
    const c = convs[0]
    if (!c) return null
    const msgs = await this.rows(
      msgRow,
      `/messages?conversation_id=eq.${q(c.id)}&user_id=eq.${q(userId)}&select=id,conversation_id,role,content,turn_id,created_at&order=created_at.desc&limit=${Math.max(0, Math.floor(limit))}`,
      'messages',
    )
    const sums = await this.rows(summaryRow, `/conversation_summaries?conversation_id=eq.${q(c.id)}&user_id=eq.${q(userId)}&select=summary,upto_message_id`, 'summaries')
    const messages: StoredMessage[] = msgs.reverse().map((m) => ({ id: m.id, conversationId: m.conversation_id, role: m.role, content: m.content, turnId: m.turn_id, createdAtUtc: m.created_at }))
    return { conversation: this.toConv(c), messages, summary: sums[0] ? { text: sums[0].summary, uptoMessageId: sums[0].upto_message_id } : null }
  }

  private async assertOwns(userId: string, conversationId: string): Promise<void> {
    const r = await this.rows(z.object({ id: z.string() }), `/conversations?id=eq.${q(conversationId)}&user_id=eq.${q(userId)}&select=id`, 'conversations')
    if (!r[0]) throw new Error('conversation not found for user')
  }

  async appendMessages(userId: string, conversationId: string, msgs: Omit<StoredMessage, 'id' | 'conversationId' | 'createdAtUtc'>[], nowMs: number): Promise<void> {
    await this.assertOwns(userId, conversationId)
    if (msgs.length > 0) {
      // 1 ms apart so the order within a turn (user, then assistant) is stable when read back by created_at.
      await this.rest('/messages', 'POST', msgs.map((m, i) => ({ conversation_id: conversationId, user_id: userId, role: m.role, content: m.content, turn_id: m.turnId, created_at: isoFull(nowMs + i) })), 'return=minimal')
    }
    await this.rest(`/conversations?id=eq.${q(conversationId)}&user_id=eq.${q(userId)}`, 'PATCH', { updated_at: isoFull(nowMs + msgs.length) }, 'return=minimal')
  }

  async saveSummary(userId: string, conversationId: string, summary: string, uptoMessageId: string | null): Promise<void> {
    await this.assertOwns(userId, conversationId)
    await this.rest('/conversation_summaries?on_conflict=conversation_id', 'POST', { conversation_id: conversationId, user_id: userId, summary, upto_message_id: uptoMessageId, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal')
  }

  // ---- impact ledger

  private toImpact(r: z.infer<typeof impactRow>): ImpactRow {
    return {
      id: r.id,
      userId: r.user_id,
      conversationId: r.conversation_id,
      turnId: r.turn_id,
      windowStartUtc: r.window_start_utc,
      runNowStartUtc: r.run_now_start_utc,
      durationH: r.duration_h,
      energyKwh: r.energy_kwh,
      runId: r.run_id,
      model: r.model,
      estPointG: r.est_point_g,
      estLowG: r.est_low_g,
      estHighG: r.est_high_g,
      realizedG: r.realized_g,
      realizedAtUtc: r.realized_at,
      realizedNote: r.realized_note,
      createdAtUtc: r.created_at,
    }
  }

  async addImpact(row: NewImpactRow): Promise<ImpactRow> {
    const raw = await this.rest('/impact_ledger', 'POST', {
      user_id: row.userId,
      conversation_id: row.conversationId,
      turn_id: row.turnId,
      window_start_utc: row.windowStartUtc,
      run_now_start_utc: row.runNowStartUtc,
      duration_h: row.durationH,
      energy_kwh: row.energyKwh,
      run_id: row.runId,
      model: row.model,
      est_point_g: row.estPointG,
      est_low_g: row.estLowG,
      est_high_g: row.estHighG,
    }, 'return=representation')
    const r = this.parse(z.array(impactRow), raw, 'impact_ledger')
    if (!r[0]) throw new StoreError('parse', 'Unexpected impact_ledger response shape')
    return this.toImpact(r[0])
  }

  async listImpact(userId: string, limit: number): Promise<ImpactRow[]> {
    const r = await this.rows(impactRow, `/impact_ledger?user_id=eq.${q(userId)}&select=*&order=created_at.desc&limit=${Math.max(0, Math.floor(limit))}`, 'impact_ledger')
    return r.map((x) => this.toImpact(x))
  }

  async setRealized(userId: string, id: string, realizedG: number | null, note: string | null, nowMs: number): Promise<void> {
    await this.rest(`/impact_ledger?id=eq.${q(id)}&user_id=eq.${q(userId)}`, 'PATCH', { realized_g: realizedG, realized_note: note, realized_at: isoFull(nowMs) }, 'return=minimal')
  }

  // ---- feedback, admin, delete, reassign

  async saveFeedback(f: FeedbackInput): Promise<void> {
    await this.rest('/feedback?on_conflict=turn_id,user_id', 'POST', { turn_id: f.turnId, user_id: f.userId, rating: f.rating, comment: f.comment }, 'resolution=merge-duplicates,return=minimal')
  }

  async deleteUserData(userId: string): Promise<void> {
    // Auth admin API: https://supabase.com/docs/reference/javascript/auth-admin-deleteuser (DELETE /auth/v1/admin/users/{id}).
    // Every user table references auth.users with ON DELETE CASCADE, so this removes all rows. 404 = already gone.
    try {
      await this.send(`${this.url}/auth/v1/admin/users/${q(userId)}`, 'DELETE')
    } catch (e) {
      if (e instanceof StoreError && e.status === 404) return
      throw e
    }
  }

  async isAdmin(userId: string): Promise<boolean> {
    const r = await this.rows(z.object({ user_id: z.string() }), `/admins?user_id=eq.${q(userId)}&select=user_id`, 'admins')
    return r.length > 0
  }

  /** Same as reassign but returns how many conversations moved (SQL reassign_user_data). */
  async reassignCounted(fromUserId: string, toUserId: string): Promise<number> {
    const raw = await this.rest('/rpc/reassign_user_data', 'POST', { p_from: fromUserId, p_to: toUserId })
    return this.parse(z.number().int(), raw, 'reassign_user_data')
  }

  async reassign(fromUserId: string, toUserId: string): Promise<void> {
    await this.reassignCounted(fromUserId, toUserId)
  }

  // ---- P3 usage helpers (not part of UserStore)

  /** Atomic per-IP new-session cap per hour (SQL consume_session). true = allowed. */
  async consumeSession(ipHash: string, cap: number): Promise<boolean> {
    const raw = await this.rest('/rpc/consume_session', 'POST', { p_ip_hash: ipHash, p_cap: cap })
    return this.parse(z.boolean(), raw, 'consume_session')
  }

  /** Free messages an anonymous user has already used (SQL anon_messages_used). */
  async anonMessagesUsed(userId: string): Promise<number> {
    const raw = await this.rest('/rpc/anon_messages_used', 'POST', { p_user: userId })
    return this.parse(z.number().int(), raw, 'anon_messages_used')
  }
}
