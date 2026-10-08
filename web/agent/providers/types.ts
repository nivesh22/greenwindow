// Contract (orchestrator-owned): the provider-agnostic model interface. Design §5.1.
// Providers speak OpenAI-compatible Chat Completions over plain fetch (no SDKs, decisions 2026-10-08).

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  argsJson: string // raw JSON text from the model; parsed and zod-validated by the loop
}

export interface Msg {
  role: Role
  content: string
  toolCalls?: ToolCall[] // assistant messages only
  toolCallId?: string // tool messages only
}

/** JSON Schema object, as produced by z.toJSONSchema. */
export type JsonSchema = Record<string, unknown>

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export interface ModelRequest {
  model: string // provider-specific model ID from config
  messages: Msg[]
  tools?: ToolSpec[]
  toolChoice?: 'auto' | 'none'
  maxOutputTokens: number
  temperature: number
  responseFormat?: 'json'
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter'

export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall } // emitted once the call's arguments are complete
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { type: 'finish'; reason: FinishReason }

export type ProviderId = 'gemini-direct' | 'ai-gateway' | 'scripted'

export interface ModelProvider {
  id: ProviderId
  /** Streams events. Throws ProviderError (harness/errors.ts) on HTTP/network failure. Must honour `signal`. */
  complete(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
}

export interface ProviderErrorInfo {
  provider: ProviderId
  status: number | null // HTTP status, null for network/timeout
  retryAfterMs: number | null
  kind: 'network' | 'timeout' | 'rate_limit' | 'server' | 'client' | 'malformed'
}
