import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

export const TERMS_UPDATED = '21 October 2026'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <div className="mt-2 space-y-2 text-sm text-ink-2">{children}</div>
    </section>
  )
}

export function Terms() {
  return (
    <article className="max-w-3xl space-y-6">
      <h1 className="page-title">Terms of service</h1>
      <p className="text-ink-3 text-sm">Last updated {TERMS_UPDATED}</p>
      <p className="text-ink-2">
        GreenWindow is a free, non-commercial portfolio project run by an individual developer (&ldquo;we&rdquo;). By using this
        site you agree to these terms. If you don&apos;t agree, please don&apos;t use it.
      </p>

      <Section title="What GreenWindow is">
        <p>
          GreenWindow forecasts the carbon intensity of the Great Britain electricity grid and suggests times to run flexible jobs.
          An optional assistant can help plan jobs, save devices and send reminders.
        </p>
      </Section>

      <Section title="Forecasts are estimates">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Forecasts and plans are estimates of average grid intensity, not measurements or guarantees. They can be wrong, late
            or missing.
          </li>
          <li>
            Any emissions figure is an estimated difference based on average (not marginal) intensity. It is not a certified
            carbon saving and must not be used for carbon reporting, offsetting or regulatory claims.
          </li>
          <li>
            Don&apos;t rely on GreenWindow for anything safety-critical, medical, financial or where a missed or mistimed job would
            cause harm. You decide when to run your devices and are responsible for doing so safely.
          </li>
          <li>
            The assistant uses AI language models. Its answers can be wrong; check anything important. Numbers come from our
            tools, but the wording around them is generated.
          </li>
        </ul>
      </Section>

      <Section title="Accounts and limits">
        <p>
          You can use the assistant as a guest or sign in with Google. Keep your account secure; you are responsible for activity
          on it. To keep the service free, we cap messages per guest, per day and per month, and may pause the assistant when the
          budget runs out.
        </p>
      </Section>

      <Section title="Acceptable use">
        <p>Please don&apos;t:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>use the service for anything unlawful, or to harass or harm others;</li>
          <li>try to get around the usage limits, bot checks or safety rules, or overload the service;</li>
          <li>attempt to access other users&apos; data or systems you aren&apos;t allowed to;</li>
          <li>scrape the assistant automatically or use it to build a competing service;</li>
          <li>enter other people&apos;s personal data or sensitive information.</li>
        </ul>
        <p>We may limit, suspend or delete access that breaks these terms.</p>
      </Section>

      <Section title="Your content">
        <p>
          You own what you type. You let us store and process it to run the service, as described in the{' '}
          <Link className="underline" to="/privacy">Privacy policy</Link>.
        </p>
      </Section>

      <Section title="Data sources and code">
        <p>
          Carbon intensity data comes from NESO and weather data from Open-Meteo (CC BY 4.0); their own licences and terms apply.
          The source code is on{' '}
          <a className="underline" href="https://github.com/nivesh22/greenwindow">GitHub</a> under the licence stated there.
        </p>
      </Section>

      <Section title="Availability and changes">
        <p>
          The service is provided free, &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. We may change, pause or shut down any part of it at
          any time, with or without notice. We may update these terms; the date at the top shows the latest version, and using
          the site afterwards means you accept the change.
        </p>
      </Section>

      <Section title="Liability">
        <p>
          To the extent the law allows, we give no warranties and are not liable for any loss arising from your use of, or
          reliance on, GreenWindow, including higher energy costs or emissions. Nothing in these terms limits liability that
          cannot be limited by law, such as for death or personal injury caused by negligence, or fraud.
        </p>
      </Section>

      <Section title="Law">
        <p>These terms are governed by the law of England and Wales. Consumer protections in your home country still apply.</p>
      </Section>

      <Section title="Contact">
        <p>
          Open an issue on the{' '}
          <a className="underline" href="https://github.com/nivesh22/greenwindow/issues">GitHub repository</a>.
        </p>
      </Section>
    </article>
  )
}
