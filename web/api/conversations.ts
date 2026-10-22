// GET /api/conversations: the caller's chat history (newest first, titled by the first message).
// GET /api/conversations?id=<uuid>: one conversation (last 30 messages), for opening it from the history.
// GET /api/conversations?view=latest (also /api/conversations/latest via a rewrite): the most recent conversation, plus
// a guest's free messages left; used on load to continue a conversation after sign-in.
import { z } from 'zod'
import type { ConversationList, ConversationResponse } from '../agent/harness/api_schemas.js'
import type { AuthUser, ConversationContext } from '../agent/store/user_types.js'
import { authenticate, lazyFetch, methodNotAllowed, unauthorized, type ApiDeps } from './_lib/deps.js'
import { errorBody, json } from './_lib/http.js'

export const maxDuration = 15
export const RESTORE_MESSAGES = 30
export const HISTORY_LIST_MAX = 30

function toResponse(ctx: ConversationContext | null, auth: AuthUser, messagesLeft: number | null): ConversationResponse {
  return {
    conversation: ctx
      ? { id: ctx.conversation.id, messages: ctx.messages.map((m) => ({ role: m.role, content: m.content, turn_id: m.turnId, created_at_utc: m.createdAtUtc })) }
      : null,
    messages_left: messagesLeft,
    is_anonymous: auth.isAnonymous,
  }
}

export function createConversationsHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    const auth = await authenticate(request, deps)
    if (!auth) return unauthorized()
    const params = new URL(request.url).searchParams
    const latest = params.get('view') === 'latest' || new URL(request.url).pathname.endsWith('/latest')
    try {
      if (latest) {
        let messagesLeft: number | null = null
        if (auth.isAnonymous) messagesLeft = Math.max(0, deps.config.ANON_MESSAGE_CAP - (await deps.usage.anonMessagesUsed(auth.userId)))
        const c = await deps.users.latestConversation(auth.userId)
        const ctx = c ? await deps.users.loadConversation(auth.userId, c.id, RESTORE_MESSAGES) : null
        return json(200, toResponse(ctx, auth, messagesLeft))
      }
      if (params.has('id')) {
        const id = z.string().uuid().safeParse(params.get('id'))
        if (!id.success) return json(400, errorBody('bad_request', 'Query parameter id must be a conversation id.'))
        const ctx = await deps.users.loadConversation(auth.userId, id.data, RESTORE_MESSAGES)
        if (!ctx) return json(404, errorBody('not_found', 'No such conversation.'))
        return json(200, toResponse(ctx, auth, null))
      }
      const list = await deps.users.listConversations(auth.userId, HISTORY_LIST_MAX)
      const out: ConversationList = { conversations: list.map((c) => ({ id: c.id, title: c.title, updated_at_utc: c.updatedAtUtc })) }
      return json(200, out)
    } catch {
      return json(503, errorBody('store_unavailable', 'Could not load your conversations.'))
    }
  }
}

export default lazyFetch(createConversationsHandler)
