import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export const PRIVACY_UPDATED = '21 October 2026'

const PROCESSORS: [string, string][] = [
  [
    'Google Gemini API',
    'Generates assistant answers. Your message and the tool results it needs are sent to it. On the free tier, Google may use prompts to improve its products where its terms allow.',
  ],
  ['Vercel AI Gateway, routing to Anthropic', 'Fallback model provider for assistant answers when the primary model is unavailable.'],
  ['TypeSafe (Jev)', 'Evaluates the safety rules that check requests and answers.'],
  ['Supabase (EU, Ireland)', 'Stores accounts, conversations and the data below.'],
  ['Vercel', 'Hosts this site and the assistant API. Like any web host, it sees your IP address and browser details when you load a page.'],
  ['GitHub', 'Serves the published forecast files your browser downloads, so it sees the same request details.'],
  ['Cloudflare Turnstile', 'Checks that a first-time visitor is human before a guest session starts.'],
  [
    'Langfuse (EU)',
    'Receives a sample of assistant traces for debugging: message text shortened to 500 characters, with e-mail addresses and long numbers removed. Linked to your account ID, not your name or e-mail.',
  ],
]

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <div className="mt-2 space-y-2 text-sm text-ink-2">{children}</div>
    </section>
  )
}

export function Privacy() {
  return (
    <article className="max-w-3xl space-y-6">
      <h1 className="page-title">Privacy policy</h1>
      <p className="text-ink-3 text-sm">Last updated {PRIVACY_UPDATED}</p>
      <p className="text-ink-2">
        GreenWindow is a free, non-commercial portfolio project run by Nivesh Kannan Elangovanraaj (&ldquo;we&rdquo;). The forecast
        pages store nothing about you. This policy mainly covers the optional assistant and accounts.
      </p>

      <Section title="Who is responsible">
        <p>
          Nivesh Kannan Elangovanraaj, who runs GreenWindow, is the data controller. Contact details are under <a className="underline" href="#contact">Contact</a>.
        </p>
      </Section>

      <Section title="What is stored">
        <ul className="list-disc space-y-1 pl-5">
          <li>Account: your e-mail address and name from Google, if you sign in. Guests get a random ID only.</li>
          <li>Messages: what you type to the assistant and its answers.</li>
          <li>Profile: display name, default risk mode and quiet hours, if you set them.</li>
          <li>Devices: names and power ratings you save.</li>
          <li>Plans and impact rows: the job plans the assistant makes and their estimated outcomes.</li>
          <li>
            Notifications: if you turn them on, your browser&apos;s push subscription (an endpoint address and encryption keys) and
            any reminders you set are stored until you turn notifications off, cancel the plan, or delete your data. Calendar
            files and links are made in your browser; we do not receive them.
          </li>
          <li>Feedback: thumbs and comments you send.</li>
          <li>Traces: which tools ran, timings and token counts for each assistant turn, used to debug and measure quality.</li>
          <li>
            Abuse limits: a salted one-way hash of your IP address, used to cap how many guest sessions and messages one network
            can start. We do not store the IP address itself.
          </li>
        </ul>
        <p>Please don&apos;t type sensitive personal information into the assistant. It doesn&apos;t need any.</p>
      </Section>

      <Section title="Why we use it (legal basis)">
        <ul className="list-disc space-y-1 pl-5">
          <li>To provide the assistant and your account when you choose to use them (performing the service you asked for).</li>
          <li>To keep the service secure, stop abuse and keep costs under a fixed budget (legitimate interests).</li>
          <li>To debug and improve answer quality from traces and feedback (legitimate interests).</li>
          <li>To send reminders only after you turn notifications on (consent, which you can withdraw at any time).</li>
        </ul>
        <p>We do not sell your data, show ads, or use it to profile you for marketing.</p>
      </Section>

      <Section title="Cookies and browser storage">
        <p>
          There are no advertising or analytics cookies. If you use the assistant, your browser keeps a sign-in session in local
          storage and a guest token in session storage. Cloudflare Turnstile may set its own cookies to tell humans from bots.
          Clearing your site data removes what we store in your browser.
        </p>
      </Section>

      <Section title="How long">
        <p>Data is kept for 90 days. Guest (anonymous) users who have been idle for 30 days are deleted sooner.</p>
      </Section>

      <Section title="Who processes it">
        <ul className="space-y-2">
          {PROCESSORS.map(([n, d]) => (
            <li key={n}>
              <span className="font-medium text-ink">{n}.</span> {d}
            </li>
          ))}
        </ul>
        <p>Some of these providers process data outside the UK and EU, under their own standard data protection terms.</p>
      </Section>

      <Section title="Google sign-in">
        <p>Signing in with Google requests the email and profile scopes only. Nothing else in your Google account is read.</p>
      </Section>

      <Section title="Your rights">
        <p>
          Under UK and EU data protection law you can ask to access, correct, delete or export your data, object to how it is
          used, or withdraw consent. Signed-in users can delete their account and all data from{' '}
          <Link className="underline" to="/settings">Settings</Link> (Delete my data). Guests can clear their browser data; guest
          records are removed after 30 idle days. You can also complain to the UK Information Commissioner&apos;s Office (ico.org.uk)
          or your local regulator.
        </p>
      </Section>

      <Section title="Children">
        <p>The assistant is not meant for children under 13, and we do not knowingly collect their data.</p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes, the date at the top changes too. The full history is public in the source repository.
        </p>
      </Section>

      <Section title="Limits of the service">
        <p>
          Great Britain national grid only. Everything shown is an estimate of average grid intensity from a forecast, not a
          guarantee. See also the <Link className="underline" to="/terms">Terms of service</Link>.
        </p>
      </Section>

      <section id="contact">
        <h2 className="font-display text-xl font-semibold">Contact</h2>
        <p className="mt-2 text-sm text-ink-2">
          Open an issue on the{' '}
          <a className="underline" href="https://github.com/nivesh22/greenwindow/issues">GitHub repository</a>. Please don&apos;t
          post personal data in a public issue; ask for a private contact instead.
        </p>
      </section>
    </article>
  )
}
