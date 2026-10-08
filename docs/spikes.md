# Desk-research spikes S1–S5

Date checked: 2026-10-08. Method: primary vendor docs fetched directly (vercel.com/docs, docs.typesafe.ai, ai.google.dev, supabase.com/docs). Third-party blogs and search snippets are labelled SECONDARY and were not relied on for any value. No live API calls were made; anything that needs a live call is marked UNVERIFIED and listed for the orchestrator (H2/H3 in the execution plan). Some pages were read through a summarising fetch tool, so exact strings should be re-checked against the page before they are hard-coded.

---

## S1 Jev (TypeSafe AI)

**Status: CONFIRMED that Jev is a real product with official docs and a public API. PARTIAL on access terms, pricing and latency. Jev is reachable both directly and through Vercel AI Gateway.**

Findings (primary unless marked):
- Official docs site: https://docs.typesafe.ai (introduction, quickstart, models, API reference, SDK pages). Says "Jev is TypeSafe's flagship model and the first System One model." Source: https://docs.typesafe.ai/introduction
- Direct API: `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer <API_KEY>`, plus `Content-Type: application/json`. Source: https://docs.typesafe.ai/api.md
- Request body: `state` (string | object | array, required), `model` (required, e.g. `jev-latest`), `questions` (map of id to question). Question `type` is one of `noul`, `choice`, `score`. `choice` needs `criteria` (max 255 options); `score` needs 2–10 level descriptions. Source: https://docs.typesafe.ai/api.md
- Response: `model`, `answers` (keyed by the same question ids), `usage.input_tokens`, `usage.output_tokens`. Noul answer: `{type:"noul", noul: 0..1}`. Source: https://docs.typesafe.ai/api.md
- Model IDs: `jev-1.13.0` (current), aliases `jev-latest` and `jev-preview` both point to it. Source: https://docs.typesafe.ai/models.md
- API key: the quickstart says "Get your API key" from the dashboard at https://console.typesafe.ai/keys, with a playground at https://console.typesafe.ai/playground. It does not describe a waitlist, so access looks self-serve, but this is UNVERIFIED until someone signs up. Source: https://docs.typesafe.ai/introduction/quickstart.md
- Pricing (official TypeSafe models page): "$42 / $0.042" per Mtok, "Charged per input token. Output tokens are free." Source: https://docs.typesafe.ai/models.md
- Context: 64k tokens per request; 32k for `state` plus the longest question. Source: https://docs.typesafe.ai/models.md
- Latency: the official docs make no numeric latency claim. They say "Adding questions barely changes the response time" and that questions are "evaluated in parallel". Source: https://docs.typesafe.ai/introduction. The "under 15 ms" and "about 300 ms" figures from third-party blogs are NOT supported by a primary source.
- Official SDKs exist: Python and JavaScript (`@typesafe-ai/sdk`). Source: https://docs.typesafe.ai/sdk.md and https://docs.typesafe.ai/sdk/javascript.md
- Vercel AI Gateway, TypeSafe-compatible route (official Vercel docs, updated 2026-10-05): base URL `https://ai-gateway.vercel.sh/typesafe`, endpoint `POST /typesafe/v1/systemone`, model `typesafe-ai/jev`, auth `Authorization: Bearer $AI_GATEWAY_API_KEY`. Response `usage` and `provider_metadata.gateway.cost` are returned. Source: https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
- Vercel AI Gateway, OpenAI-compatible route (official, updated 2026-10-07): `POST https://ai-gateway.vercel.sh/v1/decisions` with question types `predicate`, `choice`, `score`. This is a different shape from TypeSafe's native API and is not the path the design uses. Source: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions
- Vercel changelog dated 2026-09-21 names a different path, `POST /v1/evaluate` on `https://ai-gateway.vercel.sh`, with question types `boolean`, `choice`, `score`. This conflicts with the docs above (`noul` vs `boolean`, `/evaluate` vs `/typesafe/v1/systemone`). The docs page is newer and is preferred. Source: https://vercel.com/changelog/ai-gateway-now-supports-typesafe-clients-and-http-api-for-jev
- Gateway model list (official page, read through the summariser): `typesafe-ai/jev` at $0.04 / 1M input, $0.00 output. This is close to but not the same as TypeSafe's $0.042. Source: https://vercel.com/ai-gateway/models
- OpenRouter: the design doc's ID `typesafe/jev-1.13` could NOT be confirmed. `https://openrouter.ai/typesafe-ai/jev` returned HTTP 404. The `llms.txt` for `typesafe/jev-router` exists, with the name "TypeSafe: Jev Router". No price was found on it. Source: https://openrouter.ai/typesafe/jev-router/llms.txt. Price and exact OpenRouter ID: UNVERIFIED.
- SECONDARY ONLY (not relied on): oflight.co.jp guide, eesel.ai pricing post, cloudprice.net, aiagentskit.com, LLM Reference listings.

Implications for the design:
- Use the TypeSafe-native route through Vercel AI Gateway (`POST https://ai-gateway.vercel.sh/typesafe/v1/systemone`, model `typesafe-ai/jev`) so the request uses `noul`/`choice`/`score` and the gateway's `usage` and cost fields. Alternatively call `https://api.typesafe.ai/v1/systemone` directly with `model: "jev-latest"`. Pick one in P2.5 and do not mix the two.
- Do not write latency or cost copy from the blogs. Use "UNVERIFIED, measure in the 10-call script" until measured, and cite the $0.042/Mtok input figure from docs.typesafe.ai with its date.
- Keep Jev behind the fallback gate. The docs show it is real and reachable, but it is a System One model with "jaggedness" notes (https://docs.typesafe.ai/model-jaggedness/jev-1.13.md), so the design should keep the fallback path.

---

## S2 Vercel Hobby: function duration, SSE streaming, handler signature, cron

**Status: PARTIAL. Duration and cron limits CONFIRMED from the docs. SSE streaming for `/api` in a Vite project is supported by the docs but NOT yet tested on a deployed preview.**

Findings:
- Duration (official, last updated 2026-08-24). Fluid compute is enabled by default. Hobby: default 300 s, maximum 300 s, no extended max. Pro/Enterprise: default 300 s, maximum 800 s, extended beta up to 1800 s. Source: https://vercel.com/docs/functions/configuring-functions/duration
- The Hobby plan page agrees: "Vercel Function maximum duration: 300s (5 minutes)". Source: https://vercel.com/docs/plans/hobby
- Without Fluid compute: the pages read do not give a separate Hobby figure. The 2024 changelog (60 s for Hobby) is superseded by the 300 s figure. Treat non-Fluid behaviour as UNVERIFIED and assume Fluid is on for the project (default). Source for the superseded figure: https://vercel.com/changelog/vercel-functions-for-hobby-can-now-run-up-to-60-seconds
- Handler signatures for `/api` in a non-Next.js project (official Node.js runtime doc, updated 2026-08-11):
  - Web-standard default export: `export default { fetch(request: Request) { return new Response(...) } }` (async is allowed).
  - Web-standard method export: `export function GET(request: Request) { return new Response(...) }`.
  - Node-style `(request, response)` handlers also still work, but Web handlers are the documented default for new code. Source: https://vercel.com/docs/functions/runtimes/node-js
- Streaming (official, updated 2026-09-01): "Maximum durations can be configured for Node.js functions to enable streaming responses for longer periods." The example returns `response.toTextStreamResponse({ headers: { 'Content-Type': 'text/event-stream' } })`, which is a standard Web `Response`. The example is shown for Next.js and for `api/*.js` with `framework=other`. Source: https://vercel.com/docs/functions/streaming-functions
- The Node runtime doc says Web Handler exports and `fetch` exports "do not need `server.listen()`", i.e. they are the non-server path. Source: https://vercel.com/docs/functions/runtimes/node-js
- Cron on Hobby (official, updated 2026-07-15): 100 cron jobs per project; minimum interval once per day; scheduling precision per hour (up to 59 min late). Expressions that run more than once a day fail at deployment. Source: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Hobby terms (official): non-commercial, personal use only. Source: https://vercel.com/docs/plans/hobby

Implications for the design:
- Plan the SSE handler as a Web-standard `export default { fetch }` or `export function POST` in `api/` that returns a `Response` with a `ReadableStream` body and `text/event-stream`. Budget for 300 s total (including the Jev and LLM calls) and send heartbeats so an idle HTTP/1.1 client does not drop the connection.
- Do not use Vercel Cron for anything faster than daily on Hobby. Keep the 1-minute reminder cadence on Supabase `pg_net` or GitHub Actions (see S8), and not on Vercel Cron.
- Keep the "confirm streaming on a preview" step (S2 in the design) because the docs' streaming example is Next.js-first. Also check Hobby's non-commercial clause before any public launch.

---

## S3 Gemini API OpenAI compatibility

**Status: PARTIAL. Base URL, auth and model IDs CONFIRMED. Streaming tool-call fragmentation and `include_usage` behaviour are NOT documented and need the scripted test. Free-tier RPM/RPD NOT on the page.**

Findings:
- Base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`. Auth: `Authorization: Bearer $GEMINI_API_KEY`. Source: https://ai.google.dev/gemini-api/docs/openai
- Streaming: "The Gemini API supports streaming responses." Examples use `stream=True`. The page does NOT describe how function/tool calls are streamed (fragment shape). UNVERIFIED. Source: https://ai.google.dev/gemini-api/docs/openai
- `stream_options.include_usage`: not in any supported-parameters list. It appears only in one `extra_body` example that prints `chunk.usage`. Support is UNVERIFIED on the official page. One forum post (not official) says Gemini includes usage in the final chunk without the flag. Source (secondary): https://discuss.ai.google.dev/t/gemini-openai-compatibility-does-it-support-the-stream-options-parameter/92785
- Unsupported parameters: the page says parameters not listed "will be silently ignored by the compatibility layer". It also says `reasoning_effort` and `thinking_*` cannot be used together. Source: https://ai.google.dev/gemini-api/docs/openai
- Current Flash / Flash-Lite model IDs (official models page, 2026-10): `gemini-3.8-flash` (Stable, New), `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash` (labelled legacy), `gemini-3.5-flash-lite` (Stable), `gemini-3.1-flash-lite` (Stable). `gemini-2.5-flash` and `gemini-2.5-flash-lite` are not deprecated but access is limited to earlier users. Shutdown dates are not on the page. Source: https://ai.google.dev/gemini-api/docs/models
- `-latest` aliases: none in the model tables. The only mention is `gemini-flash-latest` as a naming example. So pin explicit IDs (for example `gemini-3.5-flash-lite`). Source: https://ai.google.dev/gemini-api/docs/models
- Free-tier rate limits: the rate-limits page (updated 2026-09-02) does NOT list RPM/TPM/RPD figures. It says limits vary per model, can be seen in AI Studio, and that RPD resets at midnight Pacific time. Per-model numbers: UNVERIFIED, read them from AI Studio. Source: https://ai.google.dev/gemini-api/docs/rate-limits
- Free-tier data use (official terms): "Google uses the content you submit to the Services and any generated responses to provide, improve, and develop" Google products for unpaid services. For users in the EEA, Switzerland or the UK, the paid-services data terms apply, and Google does not use prompts to improve products. Source: https://ai.google.dev/gemini-api/terms

Implications for the design:
- Free-tier prompts may be used to improve Google products outside the EEA/UK/CH. Do not send user-entered personal data through the Gemini free tier, and say so in the privacy copy. Keep the Gemini path for synthetic or public data only, or use paid quota.
- Pin `gemini-3.5-flash-lite` (or the current Flash-Lite ID at build time) rather than an alias. Record the chosen ID and the check date in `docs/decisions.md`.
- Before P1a.6, run a recorded fixture test with a tool-call stream and with and without `stream_options`. Do not rely on `include_usage`; estimate usage if the final chunk lacks it.

---

## S4 Claude Haiku 5.5 on Vercel AI Gateway

**Status: CONFIRMED for base URL, auth and model slug. Usage-in-stream and caching NOT documented. Price is UNVERIFIED (see below).**

Findings:
- Base URL: `https://ai-gateway.vercel.sh/v1`. Auth: `Authorization: Bearer <AI_GATEWAY_API_KEY>` (or a Vercel OIDC token). Source: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions
- Model slug: `anthropic/claude-haiku-5.5`. Note the dot, not a hyphen: the gateway uses `5.5`, while Anthropic's API id is `claude-haiku-5-5`. Source: https://vercel.com/changelog/claude-haiku-5-5-now-available-on-ai-gateway
- The same changelog says Haiku 5.5 is the first Haiku with effort levels `low`, `medium`, `high`, `xhigh`, `max`, set through `reasoning_effort` on Chat Completions. Thinking can be turned off at low/medium/high and must stay on at xhigh/max. Zero Data Retention is supported. Source: https://vercel.com/changelog/claude-haiku-5-5-now-available-on-ai-gateway
- Other Haiku slugs on the gateway (from the model list read through the summariser): `anthropic/claude-haiku-4.5`, `anthropic/claude-3-haiku`. Source: https://vercel.com/ai-gateway/models . The design doc's "Haiku 4.5" is therefore a different model from the spec's Haiku 5.5.
- Usage in streams: the streaming page documents SSE `chat.completion.chunk` deltas but does NOT mention `stream_options.include_usage` or usage in the final chunk. UNVERIFIED. Non-streamed responses include `usage`. Source: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/streaming
- Price: the model list read through the summariser shows `anthropic/claude-haiku-5.5` at $0.10 / 1M input and $0.50 / 1M output. This looks implausibly low against Haiku 4.5's $1.00 / $5.00 on the same page. Treat as UNVERIFIED and check the live model page before using it for budgeting. Source: https://vercel.com/ai-gateway/models
- Pricing policy (official): "AI Gateway charges no markup and no platform fee on tokens." You pay the provider list price. Source: https://vercel.com/docs/ai-gateway/pricing
- Free tier (official): a subset of models only. The free-tier list shows Haiku 5.5 is NOT free-tagged. Free credits start on the first request. The page does not state a dollar amount, so the "$5 monthly" figure in the design is UNVERIFIED. Purchasing credits moves the team to the paid tier. Card requirement: not stated on the page. UNVERIFIED. Sources: https://vercel.com/docs/ai-gateway/pricing and https://vercel.com/ai-gateway/models?freeTier=true
- Tool calling on the gateway is documented with the standard OpenAI `tools` / `tool_calls` shape. Source: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/tool-calling
- Model listing: `GET https://ai-gateway.vercel.sh/v1/models` returns the live IDs and is the cheapest way to confirm the slug before the first paid call. Source: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions

Implications for the design:
- Use `anthropic/claude-haiku-5.5` in config, not `claude-haiku-4.5`. Confirm with `GET /v1/models` at P1b.1, and confirm the price on the live model page before setting the kill-switch budget.
- Do not assume stream usage. Either request a non-streamed usage call for accounting or estimate tokens from the final stream chunk, and record the estimate as an estimate.
- Free tier does not include Haiku 5.5, so the first live call spends paid credit. Check the spend ceiling in the gateway budget settings before the orchestrator's first live call.

---

## S5 Supabase JWT verification and API keys

**Status: CONFIRMED. The current official guidance is asymmetric JWTs with `getClaims()` (or verification against the JWKS endpoint). Legacy `anon`/`service_role` keys are being replaced by `publishable`/`secret` keys.**

Findings:
- New projects use asymmetric JWTs by default. Source: https://supabase.com/blog/jwt-signing-keys (blog: "Starting October 1, 2025, all *new projects* will use asymmetric JWTs by default.")
- Supported algorithms (official signing-keys docs): ES256 (preferred), RS256, EdDSA ("Coming soon"), and HS256 ("Not recommended for production applications"). Source: https://supabase.com/docs/guides/auth/signing-keys
- JWKS URL: `https://<project-id>.supabase.co/auth/v1/.well-known/jwks.json`. Source: https://supabase.com/docs/guides/auth/signing-keys
- Recommended server-side verification: `supabase.auth.getClaims()`. The docs call it "the best way to do this". It verifies locally with the Web Crypto API for asymmetric keys, and calls the Auth server for symmetric keys. Source: https://supabase.com/docs/guides/auth/signing-keys and https://supabase.com/blog/jwt-signing-keys
- Caching warning: if you verify against JWKS yourself, the endpoint and client libraries may cache keys for up to about 20 minutes, so your own cache must pick up new keys before rotation. `getClaims()` handles this. Source: https://supabase.com/docs/guides/auth/signing-keys
- `getClaims()` is intended only for tokens issued by Supabase Auth. Source: https://supabase.com/blog/jwt-signing-keys (secondary wording from the summariser; re-check the JWT docs page https://supabase.com/docs/guides/auth/jwts before relying on it).
- Key names: new `publishable` keys (`sb_publishable_...`) replace `anon`; new `secret` keys (`sb_secret_...`) replace `service_role`. Legacy JWT-based `anon` and `service_role` keys are "no longer recommended" and are on a deprecation timeline. Source: https://supabase.com/docs/guides/auth/signing-keys and https://supabase.com/blog/jwt-signing-keys
- Migration path for existing projects: import the legacy JWT secret, rotate to the new key, wait past the access-token lifetime, then revoke the legacy secret. The "wait 1 h 15 min for a 1 h expiry" detail came from a SECONDARY search snippet (https://objectgraph.com/blog/migrating-supabase-jwt-jwks/ and the Supabase migration guide, not fully read). Re-check the exact wording in the official migration guide before relying on it.

Implications for the design:
- P3.2 should verify the Supabase access token with `supabase.auth.getClaims()` in the `/api` functions, not with the legacy JWT secret and not with a per-request `getUser()` round trip. Put the publishable key in the browser and the secret key only in server env vars (never `VITE_*`).
- Name the env vars and docs after `publishable` / `secret` keys. Any mention of `anon` / `service_role` in the design should be updated (rule 11/12 check).
- Confirm on the actual project dashboard that the signing key is asymmetric (ES256) before deploy. Legacy-secret projects need the migration first. Record the result in `docs/decisions.md`.

---

## Open items (UNVERIFIED, for the orchestrator)

1. Jev live call through the gateway (`typesafe-ai/jev`, `/typesafe/v1/systemone`) and the 10-call latency measurement. Also confirm whether the direct TypeSafe API requires a waitlist for the user's account.
2. Haiku 5.5 live price on the gateway model page, and whether a card is needed for the first paid call.
3. Gemini streamed tool-call fragments and `include_usage` in the final chunk (scripted test with recorded fixture).
4. Gemini free-tier RPM/RPD for the chosen Flash-Lite ID (read from AI Studio).
5. Vercel Hobby streaming on a Vite project's `/api` function, deployed to a preview (S2 test).
6. Supabase project signing algorithm (dashboard check).

## Live checks (orchestrator, 2026-10-08, owner's keys, nothing printed)
- **S3 Gemini:** `GET /v1beta/openai/models` -> 200, 62 models. Available: `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, plus `gemini-flash-latest` / `gemini-flash-lite-latest` aliases (listed by the API, unlike the docs). Streaming chat with one tool: `gemini-3.8-flash` -> **HTTP 503 "high demand"** (transient, but shows failover is needed). `gemini-3.5-flash-lite` -> 200, 3 chunks, the tool call arrived **whole in one chunk** with an id, `finish_reason: "stop"` (not `tool_calls`), and `include_usage` works (`prompt_tokens`, `completion_tokens`, `total_tokens`; no cached-token field). First call ~6.9 s. Raw stream saved as a parser fixture.
- **S4 Gateway:** `GET /v1/models` -> 200, 413 models. `anthropic/claude-haiku-5.5` is listed at **$0.10 / 1M input, $0.50 / 1M output** (tier above 100k input tokens: $0.50 / $2.50; cache read $0.01 / 1M) — the desk finding was right. Streaming call -> **HTTP 403 "Free tier users do not have access to this model"**: Haiku 5.5 needs paid gateway credits.
- **S1 Jev:** `typesafe-ai/jev` is listed on the gateway (type `evaluation`, $0.042 / 1M input, $0 output). Not called yet.
