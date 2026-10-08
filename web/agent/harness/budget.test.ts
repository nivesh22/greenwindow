import { Budget, estimateMessagesTokens, estimateTokens, type BudgetLimits } from './budget'
import { BudgetExceeded } from './errors'

const limits: BudgetLimits = { maxSteps: 2, maxInputTokens: 1000, maxOutputTokens: 100, maxCostUsd: 0.01, wallMs: 1000 }

function reasonOf(fn: () => void): string | null {
  try {
    fn()
    return null
  } catch (e) {
    expect(e).toBeInstanceOf(BudgetExceeded)
    return (e as BudgetExceeded).reason
  }
}

describe('Budget', () => {
  let b: Budget
  let t = 0
  beforeEach(() => {
    t = 0
    b = new Budget(limits, { now: () => t })
  })
  afterEach(() => b.dispose())

  it('estimates tokens as chars / 4', () => {
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateMessagesTokens([{ role: 'user', content: 'x'.repeat(36) }])).toBe(10)
  })

  it('counts steps and stops with max_steps', () => {
    b.assertCanStart('gemini-3.8-flash', 10)
    b.assertCanStart('gemini-3.8-flash', 10)
    expect(b.steps).toBe(2)
    expect(reasonOf(() => b.assertCanStart('gemini-3.8-flash', 10))).toBe('max_steps')
  })

  it('stops with token_budget before a call that would pass the cumulative cap', () => {
    b.charge('gemini-3.8-flash', 900, 10)
    expect(reasonOf(() => b.assertCanStart('gemini-3.8-flash', 101))).toBe('token_budget')
    expect(b.steps).toBe(0)
    expect(reasonOf(() => b.assertCanStart('gemini-3.8-flash', 100))).toBeNull()
  })

  it('checks the worst-case cost of the most expensive routable model before the call', () => {
    // Haiku: 1000 in × $1/M + 100 out × $5/M = $0.0015 per call.
    const big = new Budget({ ...limits, maxInputTokens: 1e9, maxCostUsd: 0.002 }, { now: () => t })
    expect(reasonOf(() => big.assertCanStart(['gemini-3.8-flash', 'anthropic/claude-haiku-5.5'], 1000))).toBeNull()
    big.charge('anthropic/claude-haiku-5.5', 1000, 0) // $0.001 actual
    expect(reasonOf(() => big.assertCanStart(['gemini-3.8-flash', 'anthropic/claude-haiku-5.5'], 1000))).toBe('cost_budget')
    // a free model alone still fits
    expect(reasonOf(() => big.assertCanStart('gemini-3.8-flash', 1000))).toBeNull()
    big.dispose()
  })

  it('post-call actual totals are checked', () => {
    expect(b.charge('anthropic/claude-haiku-5.5', 2000, 1000)).toBeCloseTo(0.007)
    expect(reasonOf(() => b.assertWithinTotals())).toBe('token_budget')
    const c = new Budget({ ...limits, maxInputTokens: 1e9 }, { now: () => t })
    c.charge('anthropic/claude-haiku-5.5', 1000, 2000) // $0.011
    expect(reasonOf(() => c.assertWithinTotals())).toBe('cost_budget')
    c.dispose()
  })

  it('stops with wall_clock after the deadline', () => {
    t = 999
    expect(reasonOf(() => b.assertTime())).toBeNull()
    expect(b.remainingMs()).toBe(1)
    t = 1000
    expect(reasonOf(() => b.assertCanStart('gemini-3.8-flash', 1))).toBe('wall_clock')
  })

  it('aborts its signal at the deadline and when the parent aborts', async () => {
    const parent = new AbortController()
    const fast = new Budget({ ...limits, wallMs: 5 }, { parentSignal: parent.signal })
    await new Promise((r) => setTimeout(r, 20))
    expect(fast.signal.aborted).toBe(true)
    expect(fast.signal.reason).toMatchObject({ reason: 'wall_clock' })

    const slow = new Budget(limits, { parentSignal: parent.signal })
    parent.abort(new Error('stop'))
    expect(slow.signal.aborted).toBe(true)
    expect(reasonOf(() => slow.assertTime())).toBe('wall_clock')
    slow.dispose()
  })
})
