import { JevBackend, JevError, isMultiChoice } from './jev.js'

const URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone'

interface Captured {
  url: string
  init: RequestInit
}

function fakeFetch(body: unknown, opts: { status?: number; captured?: Captured[] } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    opts.captured?.push({ url: String(input), init: init ?? {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
}

/** Never resolves until aborted (then rejects like fetch does). */
const hangingFetch: typeof fetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })) as typeof fetch

const QUESTIONS = {
  guard_in: { instructions: 'screen it', options: { allow: 'fine', injection: 'attack' } },
  router: { instructions: 'route it', options: { plan_job: 'plan', smalltalk: 'chat' } },
}

const OK_BODY = {
  model: 'typesafe-ai/jev',
  answers: {
    guard_in: { type: 'choice', choice: 'allow', confidence: 0.97, probabilities: { allow: 0.97, injection: 0.03 } },
    router: { type: 'choice', choice: 'plan_job', confidence: 0.91, probabilities: { plan_job: 0.91, smalltalk: 0.09 } },
  },
  usage: { input_tokens: 400, output_tokens: 0 },
  provider_metadata: { gateway: { cost: '0.0000166' } },
}

const make = (f: typeof fetch, timeoutMs = 1200) => {
  let t = 0
  return new JevBackend({ apiKey: 'test-key', url: URL, model: 'typesafe-ai/jev', timeoutMs, fetch: f, now: () => (t += 150) })
}
const signal = () => new AbortController().signal

describe('JevBackend', () => {
  it('sends several questions in ONE request with the verified gateway shape', async () => {
    const captured: Captured[] = []
    const jev = make(fakeFetch(OK_BODY, { captured }))
    const r = await jev.chooseMany({ state: { message: 'charge my EV by 7am' }, questions: QUESTIONS }, signal())

    expect(captured).toHaveLength(1)
    const c = captured[0]!
    expect(c.url).toBe(URL)
    expect(c.init.method).toBe('POST')
    expect(c.init.headers).toEqual({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(c.init.body))).toEqual({
      model: 'typesafe-ai/jev',
      state: { message: 'charge my EV by 7am' },
      questions: {
        guard_in: { type: 'choice', instructions: 'screen it', criteria: { allow: 'fine', injection: 'attack' } },
        router: { type: 'choice', instructions: 'route it', criteria: { plan_job: 'plan', smalltalk: 'chat' } },
      },
    })
    expect(r.answers.guard_in).toEqual({ choice: 'allow', confidence: 0.97, probabilities: { allow: 0.97, injection: 0.03 } })
    expect(r.answers.router.choice).toBe('plan_job')
    expect(r.costUsd).toBeCloseTo(0.0000166, 10)
    expect(r.latencyMs).toBe(150)
    expect(isMultiChoice(jev)).toBe(true)
  })

  it('choose() is a one-question chooseMany', async () => {
    const captured: Captured[] = []
    const body = { answers: { decision: { type: 'choice', choice: 'b', confidence: 0.8, probabilities: { a: 0.2, b: 0.8 } } }, provider_metadata: { gateway: { cost: '0.00001' } } }
    const r = await make(fakeFetch(body, { captured })).choose({ instructions: 'pick', state: { x: 1 }, options: { a: 'A', b: 'B' } }, signal())
    expect(r).toEqual({ choice: 'b', confidence: 0.8, probabilities: { a: 0.2, b: 0.8 }, costUsd: 0.00001 })
    expect(Object.keys(JSON.parse(String(captured[0]!.init.body)).questions)).toEqual(['decision'])
  })

  it('prices from usage when the gateway cost is missing; missing probabilities default to the choice', async () => {
    const body = { answers: { decision: { type: 'choice', choice: 'a', confidence: 0.7 } }, usage: { input_tokens: 1_000_000 } }
    const r = await make(fakeFetch(body)).choose({ instructions: 'pick', state: {}, options: { a: 'A', b: 'B' } }, signal())
    expect(r.costUsd).toBeCloseTo(0.042, 10)
    expect(r.probabilities).toEqual({ a: 0.7 })
  })

  const fails = async (f: typeof fetch, timeoutMs = 1200, sig = signal()): Promise<JevError> => {
    const err = await make(f, timeoutMs).chooseMany({ state: {}, questions: QUESTIONS }, sig).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JevError)
    return err as JevError
  }

  it('HTTP errors throw JevError(http) with the status', async () => {
    const e = await fails(fakeFetch({ error: 'nope' }, { status: 429 }))
    expect([e.kind, e.status]).toEqual(['http', 429])
  })

  it('times out after timeoutMs', async () => {
    expect((await fails(hangingFetch, 20)).kind).toBe('timeout')
  })

  it('an aborted turn aborts the call', async () => {
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 5)
    expect((await fails(hangingFetch, 5000, ctrl.signal)).kind).toBe('aborted')
  })

  it('network failures throw JevError(network)', async () => {
    expect((await fails((() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch)).kind).toBe('network')
  })

  it.each([
    ['not JSON', 'oops'],
    ['no answers', { model: 'x' }],
    ['a missing answer', { answers: { guard_in: OK_BODY.answers.guard_in } }],
    ['a wrong answer type', { answers: { ...OK_BODY.answers, router: { type: 'score', score: 2 } } }],
    ['confidence out of range', { answers: { ...OK_BODY.answers, router: { type: 'choice', choice: 'plan_job', confidence: 1.4 } } }],
    ['an unknown option', { answers: { ...OK_BODY.answers, router: { type: 'choice', choice: 'recurring', confidence: 0.9 } } }],
  ])('rejects %s as invalid_response', async (_label, body) => {
    expect((await fails(fakeFetch(body))).kind).toBe('invalid_response')
  })
})
