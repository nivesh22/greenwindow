import { describe, expect, it } from 'vitest'
import { isPlanFollowUp } from './plan_gates.js'

describe('isPlanFollowUp (ask_or_act acts on plan management and follow-ups)', () => {
  it.each([
    'Cancel my recurring compressor plan.',
    'Yes, cancel the recurring compressor plan.',
    'What plans do I have?',
    'show my saved plans',
    'Add it to my calendar',
    'remind me 10 minutes before',
  ])('acts on %s', (m) => expect(isPlanFollowUp(m)).toBe(true))

  it.each(['Charge my EV by 7am', 'When should I run the dishwasher?', 'Every weekday, best 3h for the compressor before 5pm'])(
    'does not short-circuit planning: %s',
    (m) => expect(isPlanFollowUp(m)).toBe(false),
  )
})
