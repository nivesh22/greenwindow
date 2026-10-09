import { describe, expect, it } from 'vitest'
import type { ChoiceBackend } from '../../agent/gates/types.js'
import { RecordingChoiceBackend, ReplayChoiceBackend, StaleTracker } from '../recording.js'
import type { RecordedGateCall } from '../schema.js'

const req = { instructions: 'pick', state: { message: 'hi' }, options: { a: 'A', b: 'B' } }

describe('gate record/replay', () => {
  it('records a failed gate call and replays it as the same failure, not as stale', async () => {
    const failing: ChoiceBackend = {
      source: 'jev',
      choose: async () => {
        throw new Error('timeout')
      },
    }
    const sink: RecordedGateCall[] = []
    await expect(new RecordingChoiceBackend(failing, sink).choose(req, new AbortController().signal)).rejects.toThrow('timeout')
    expect(sink).toHaveLength(1)
    expect('error' in sink[0]!).toBe(true)

    const stale = new StaleTracker()
    await expect(new ReplayChoiceBackend(sink, stale).choose(req, new AbortController().signal)).rejects.toThrow('recorded gate failure')
    expect(stale.problem).toBeNull()
  })

  it('still marks an unrecorded gate request as stale', async () => {
    const stale = new StaleTracker()
    await expect(new ReplayChoiceBackend([], stale).choose(req, new AbortController().signal)).rejects.toThrow()
    expect(stale.problem).not.toBeNull()
  })
})
