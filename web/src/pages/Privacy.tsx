const PROCESSORS: [string, string][] = [
  [
    'Google Gemini API',
    'Generates assistant answers. Your message and the tool results it needs are sent to it. On the free tier, Google may use prompts to improve its products where its terms allow.',
  ],
  ['Vercel AI Gateway, routing to Anthropic', 'Fallback model provider for assistant answers when the primary model is unavailable.'],
  ['TypeSafe (Jev)', 'Evaluates the safety rules that check requests and answers.'],
  ['Supabase (EU, Ireland)', 'Stores accounts, conversations and the data below.'],
  ['Vercel', 'Hosts this site and the assistant API.'],
  ['Cloudflare Turnstile', 'Checks that a first-time visitor is human before a guest session starts.'],
  [
    'Langfuse (EU)',
    'Receives a sample of assistant traces for debugging: message text shortened to 500 characters, with e-mail addresses and long numbers removed. Linked to your account ID, not your name or e-mail.',
  ],
]

export function Privacy() {
  return (
    <article className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Privacy</h1>
      <p className="text-stone-600 dark:text-stone-300">
        The forecast pages store nothing about you. This notice covers the optional assistant and accounts.
      </p>

      <section>
        <h2 className="text-lg font-semibold">What is stored</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-600 dark:text-stone-300">
          <li>Messages: what you type to the assistant and its answers.</li>
          <li>Profile: display name, default risk mode and quiet hours, if you set them.</li>
          <li>Devices: names and power ratings you save.</li>
          <li>Plans and impact rows: the job plans the assistant makes and their estimated outcomes.</li>
          <li>Feedback: thumbs and comments you send.</li>
          <li>Traces: which tools ran, timings and token counts for each assistant turn, used to debug and measure quality.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">How long</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
          Data is kept for 90 days. Guest (anonymous) users who have been idle for 30 days are deleted sooner.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Who processes it</h2>
        <ul className="mt-2 space-y-2 text-sm">
          {PROCESSORS.map(([n, d]) => (
            <li key={n}>
              <span className="font-medium">{n}.</span> <span className="text-stone-600 dark:text-stone-300">{d}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Google sign-in</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
          Signing in with Google requests the email and profile scopes only. Nothing else in your Google account is read.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Deleting your data</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
          Signed-in users can delete their account and all data from <a className="underline" href="/settings">Settings</a> (Delete my
          data). Guests can clear their browser data; guest records are removed after 30 idle days.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Limits of the service</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
          Great Britain national grid only. Everything shown is an estimate of average grid intensity from a forecast, not a guarantee.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Contact</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
          Open an issue on the{' '}
          <a className="underline" href="https://github.com/nivesh22/greenwindow/issues">GitHub repository</a>.
        </p>
      </section>
    </article>
  )
}
