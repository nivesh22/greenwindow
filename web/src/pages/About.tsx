const BIASES: [string, string][] = [
  ['Modelled target', "The \"actual\" intensity is NESO's own estimate, not a meter reading. Models learn NESO's methodology."],
  ['Average, not marginal', 'This is the average carbon intensity of the grid. Moving a job to a low-average hour does not guarantee the same cut in marginal emissions, so we never say "CO₂ saved".'],
  ['Optimistic backtest weather', 'Backtests use archived weather forecasts that are closer to reality than a true 1–2-day-ahead forecast, so weather-driven models look better in backtests than live. The live leaderboard corrects this.'],
  ['Possible pretraining overlap', 'Chronos-2 may have seen similar electricity series in training. Only live scoring on genuinely future data rules out leakage.'],
  ['Regime drift', "Britain's grid is decarbonising and its mix keeps changing. Short training windows limit, but do not remove, the problem."],
  ['One country', 'Results are for Great Britain only and do not transfer to other grids.'],
  ['Operator forecast vintage', "Past NESO forecasts returned by the API have unknown lead times, so historical comparisons with NESO are not a fair head-to-head. Only our live snapshots are."],
  ['Weather aggregation', 'Weather comes from four fixed points (London, Birmingham, Glasgow, the North Sea) with fixed weights, a simplification of where wind and solar actually are.'],
  ['Revisions', 'Recent actuals can be revised. Each run re-reads the last 7 days and rescoring is idempotent.'],
  ['Weather API terms', "Open-Meteo's free tier is for non-commercial use. This is a portfolio project."],
]

const MODELS: [string, string][] = [
  ['Seasonal naive (yesterday / last week)', 'Repeats the value from 24 h or 168 h earlier. The benchmark every model must beat.'],
  ['SARIMAX + weather', 'Dynamic harmonic regression: ARMA errors, Fourier terms for daily and weekly cycles, and temperature, 100 m wind, solar radiation and bank-holiday regressors.'],
  ['Chronos-2', 'A pretrained time-series foundation model (Amazon, 120M parameters) used zero-shot, without and with the weather covariates.'],
  ['NESO', "The grid operator's own published forecast, stored as issued so it can be scored fairly."],
]

export function About() {
  return (
    <article className="max-w-3xl space-y-8">
      <section>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">About & limitations</h1>
        <p className="mt-2 text-stone-600 dark:text-stone-300">
          GreenWindow forecasts Great Britain's national grid carbon intensity for the next 48 hours, recommends a start
          time for flexible jobs, and grades its own forecasts as the actual values arrive. Every 6 hours an automated
          pipeline fetches fresh data, runs each model, stores the forecast exactly as issued, and scores past forecasts.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Models</h2>
        <dl className="mt-3 space-y-3">
          {MODELS.map(([t, d]) => (
            <div key={t}>
              <dt className="font-medium">{t}</dt>
              <dd className="text-sm text-stone-600 dark:text-stone-300">{d}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-stone-600 dark:text-stone-300">
          Every model sees the same trailing window of data (56 days for classical models, 28 days of context for
          Chronos-2) and must output a P10, P50 and P90 for each of the next 48 hours.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">How the planner decides</h2>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
          It averages the forecast over every possible job window and picks the lowest (median in "expected" mode, P90 in
          "cautious" mode). A choice is marked robust only if its P90 average is below the run-now window's P10 average.
          Averaging quantiles across hours assumes forecast errors are perfectly correlated, which overstates uncertainty;
          the robust flag is deliberately conservative.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Known biases and limitations</h2>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm">
          {BIASES.map(([t, d]) => (
            <li key={t}><span className="font-medium">{t}.</span> <span className="text-stone-600 dark:text-stone-300">{d}</span></li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Data sources</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-600 dark:text-stone-300">
          <li>
            Carbon intensity (actuals and operator forecast):{' '}
            <a className="underline" href="https://carbonintensity.org.uk/">NESO Carbon Intensity API</a>, licensed CC BY 4.0.
          </li>
          <li>
            Weather (Historical Forecast and Forecast APIs): <a className="underline" href="https://open-meteo.com/">Open-Meteo.com</a>,
            licensed CC BY 4.0.
          </li>
          <li>Bank holidays: England, from the open-source <code>holidays</code> package.</li>
        </ul>
      </section>
    </article>
  )
}
