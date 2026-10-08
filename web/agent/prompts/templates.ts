// Fixed replies used when a gate ends the turn without the model (design §4 stages 4-5). No numbers in them, so
// they never need grounding. Versioned with the trace through TEMPLATES_VERSION.
import type { AskOrActChoice } from '../gates/plan_gates.js'

export const TEMPLATES_VERSION = 'templates.v1'

export const REFUSAL =
  "I can't help with that. I can help you plan when to run electricity use (EV charging, appliances, compute jobs) " +
  'for lower grid carbon intensity in Great Britain.'

export const SCOPE_REPLY =
  'Sorry, I only help plan when to run electricity use around the carbon intensity of the GB grid, so I can\'t help ' +
  'with that one. Try asking, for example, when to charge your EV tonight.'

const GREETING =
  'Hello! I help you choose when to run flexible electricity use (EV charging, appliances, compute jobs) so it runs ' +
  'when the GB grid is forecast to be cleaner. Tell me what you want to run, how long it takes and when it must be done.'
const THANKS = "You're welcome! Ask me any time you want to plan another job."
const CAPABILITIES =
  'I look at the carbon-intensity forecast for the GB grid and recommend when to start a job, such as charging an EV ' +
  'or running a dishwasher or a GPU job, before your deadline. I can also explain the forecast and how accurate it is.'

export function smalltalkReply(message: string): string {
  if (/\b(thanks|thank you|thx|cheers|ta)\b/i.test(message)) return THANKS
  if (/\b(what can you do|who are you|help)\b/i.test(message)) return CAPABILITIES
  return GREETING
}

type Ask = Exclude<AskOrActChoice, 'act'>

/** What the model is told to ask (stage 5 ask path). */
export const ASK_FOCUS: Record<Ask, string> = {
  ask_duration: 'how long the job runs, in whole hours',
  ask_power: 'what device it is or how much power it draws, in kW',
  ask_deadline: 'by when the job must be finished',
  ask_clarify: 'what they want to run, and by when it must be finished',
}

/** Used when the model's question fails the grounding check twice. */
export const ASK_TEMPLATES: Record<Ask, string> = {
  ask_duration: 'How long does the job need to run, in whole hours?',
  ask_power: 'What device is it, or how much power does it draw (in kW)?',
  ask_deadline: 'By when does it need to be finished?',
  ask_clarify: 'What would you like to run, and by when does it need to be finished?',
}

export function askInstruction(choice: Ask): string {
  return (
    `Instruction for this reply: ask the user exactly one short question: ${ASK_FOCUS[choice]}. ` +
    'You may acknowledge what they said in a few words first. Do not call tools and do not state any times, ' +
    'carbon intensities or emissions figures.'
  )
}
