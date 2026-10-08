// router (design §6.2, FR-3.1): the intent sets the tool subset (registry.forIntent). Rules fallback: keyword rules
// on the message, then on earlier user messages; default plan_job when the panel has a job, else explain_forecast.
import type { GateSpec, RuleDecision } from './gate.js'
import { panelHasJob, type InputState } from './input.js'
import { matchDevices } from './slots.js'
import { INTENTS, type Intent } from './types.js'

export const PLAN_INTENTS: readonly Intent[] = ['plan_job', 'plan_batch', 'recurring']
export const isPlanIntent = (i: Intent): boolean => PLAN_INTENTS.includes(i)

const SMALLTALK = /^\s*(hi|hello|hey|hiya|yo|thanks|thank you|thx|cheers|ta|good (morning|afternoon|evening)|ok(ay)?|great|cool|nice|bye|goodbye|who are you\??|what can you do\??|how are you\??)[\s!.,?:)]*(there|again|a lot|so much|very much)?[\s!.,?:)]*$/i
const OFF_TOPIC = /\b(recipe|poem|poetry|song lyrics|joke|essay|homework|bitcoin|crypto(currency)?|stock (price|market)|football|premier league|capital of|translate|write (me )?(a|an|some) (story|poem|essay|code|script|program))\b/i
const DOMAIN = /\b(grid|carbon|co2|emission|intensity|electric|electricity|power|energy|charg\w*|kw|kwh|forecast|wind|solar|green|clean)\b/i

const KEYWORDS: readonly [Intent, RegExp][] = [
  ['recurring', /\b(every (day|night|morning|evening|week|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each (day|night|week)|daily|nightly|weekly|recurring|regularly|routine)\b/i],
  ['profile_update', /\b(remember (that|my|i)|update my (profile|settings|defaults?)|set my default|change my default|save (my|this) (device|setting|default|charger)s?|my default (is|should)|always use)\b/i],
  ['impact_history', /\b(my (impact|history|past plans|savings|total)|how much (have|did) i|so far (this|in)|have i (saved|avoided|reduced)|my plans)\b/i],
  ['model_accuracy', /\b(accura\w*|how (good|reliable|well)|reliab\w*|leaderboard|backtest\w*|mase|mae|benchmark|seasonal naive|which model|best model|chronos|sarimax|prophet|ets model|compare (the )?models?)\b/i],
  ['plan_job', /\b(when should|best time|cheapest time|greenest time|good time|schedule|plan|start|run|charge|charging|dishwasher|washing|laundry|dryer|deadline|by \d|before \d|\d+\s*(h|hrs?|hours?)\b|\d+(\.\d+)?\s*kw\b)/i],
  ['explain_forecast', /\b(forecast|intensity|grid|carbon|co2|clean(est)?|green(est)?|dirt(y|iest)|wind|solar|uncertain\w*|why|tonight|tomorrow|today|right now|now)\b/i],
]

function keywordIntent(text: string): RuleDecision<Intent> | null {
  if (SMALLTALK.test(text)) return { choice: 'smalltalk', confidence: 0.9, reason: 'greeting/thanks' }
  if (OFF_TOPIC.test(text) && !DOMAIN.test(text)) return { choice: 'off_topic', confidence: 0.8, reason: 'off-topic keyword' }
  const devices = matchDevices(text)
  for (const [intent, re] of KEYWORDS) {
    if (intent === 'plan_job' && devices.length >= 2) return { choice: 'plan_batch', confidence: 0.7, reason: `${devices.length} devices` }
    if (re.test(text)) return { choice: intent, confidence: 0.7, reason: `keyword (${intent})` }
    if (intent === 'plan_job' && devices.length === 1) return { choice: 'plan_job', confidence: 0.7, reason: `device ${devices[0]!.id}` }
  }
  return null
}

export function routerRules(s: InputState): RuleDecision<Intent> {
  const now = keywordIntent(s.message)
  if (now) return now
  // A short reply ("about 3 hours") continues the earlier request.
  const earlier = s.history.filter((h) => h.role === 'user').map((h) => h.content).reverse()
  for (const t of earlier) {
    const k = keywordIntent(t)
    if (k && k.choice !== 'smalltalk' && k.choice !== 'off_topic') return { ...k, confidence: 0.6, reason: `earlier message: ${k.reason}` }
  }
  return panelHasJob(s.panel)
    ? { choice: 'plan_job', confidence: 0.5, reason: 'default (panel has a job)' }
    : { choice: 'explain_forecast', confidence: 0.5, reason: 'default' }
}

const DESCRIPTIONS: Record<Intent, string> = {
  plan_job:
    'Wants a recommended start time for ONE job or device (EV charging, dishwasher, washing machine, heat pump, a ' +
    "compute/GPU job), or is answering the assistant's question about such a job (duration, power, deadline).",
  plan_batch: 'Wants start times for SEVERAL different jobs or devices in the same request.',
  recurring: 'Wants a plan for a job that repeats (every night, daily, weekly, every weekday).',
  explain_forecast:
    'Asks about the carbon-intensity forecast itself: when the grid is cleanest or dirtiest, why, how uncertain it is, ' +
    'what the numbers mean. No specific job to schedule.',
  model_accuracy: 'Asks how accurate or reliable the forecasting models are, about the leaderboard, backtests, or comparing models.',
  impact_history: "Asks about the user's own past plans or their accumulated estimated emissions difference.",
  profile_update: 'Wants the assistant to remember or change their defaults, devices or settings.',
  smalltalk: 'Greetings, thanks, or asking what the assistant can do, with no planning or forecast request.',
  off_topic: 'Unrelated to electricity use, the power grid or carbon intensity.',
}

export function routerSpec(threshold: number): GateSpec<InputState, Intent> {
  const options = {} as Record<Intent, string>
  for (const i of INTENTS) options[i] = DESCRIPTIONS[i]
  return {
    name: 'router',
    threshold,
    instructions:
      "Pick the intent of the user's latest message (`message`) to the assistant described in `assistant`. Use " +
      '`recent_conversation` for context: a short answer to a question the assistant just asked continues that request.',
    options,
    rules: routerRules,
  }
}
