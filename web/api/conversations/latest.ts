// GET /api/conversations/latest: the caller's most recent conversation (last 30 messages) for restoring the chat.
import type { ConversationResponse } from '../../agent/harness/api_schemas.js'
import { authenticate, lazyFetch, methodNotAllowed, unauthorized, type ApiDeps } from '../_lib/deps.js'
import { errorBody, json } from '../_lib/http.js'

export const maxDuration = 15
export const RESTORE_MESSAGES = 30

export function createLatestHandler(deps: ApiDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') return methodNotAllowed('GET')
    const auth = await authenticate(request, deps)
    if (!auth) return unauthorized()
    try {
      let messagesLeft: number | null = null
      if (auth.isAnonymous) messagesLeft = Math.max(0, deps.config.ANON_MESSAGE_CAP - (await deps.usage.anonMessagesUsed(auth.userId)))
      const latest = await deps.users.latestConversation(auth.userId)
      const ctx = latest ? await deps.users.loadConversation(auth.userId, latest.id, RESTORE_MESSAGES) : null
      const out: ConversationResponse = {
        conversation: ctx
          ? { id: ctx.conversation.id, messages: ctx.messages.map((m) => ({ role: m.role, content: m.content, turn_id: m.turnId, created_at_utc: m.createdAtUtc })) }
          : null,
        messages_left: messagesLeft,
        is_anonymous: auth.isAnonymous,
      }
      return json(200, out)
    } catch {
      return json(503, errorBody('store_unavailable', 'Could not load your conversation.'))
    }
  }
}

export default lazyFetch(createLatestHandler)
