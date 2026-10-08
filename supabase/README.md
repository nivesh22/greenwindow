# Supabase

Schema lives in `migrations/` (append-only; never edit an applied file). RLS is on for every table with no
policies, so only server-side code using the service-role key can read or write.

## Applying migrations
The orchestrator or owner runs, from the repo root with the project linked:

    npx supabase@2.120.0 db push

Agents and CI do not run this.

## Manual budget reset
When the month is paused (spend reached `MONTHLY_BUDGET_USD`), after raising the budget or deciding to continue,
run in the Supabase SQL editor:

    select public.reset_budget('2026-10');   -- the paused month, 'YYYY-MM' UTC

It sets `paused = false` and returns the row (null if the month has no row). Spend is kept, so the next
`add_spend` re-pauses if the total is still at or over the limit passed by the app.

## Checking spend

    select public.budget_status();           -- {month, spent_usd, paused, alerted_80} for the current month
    select * from public.cost_ledger order by month desc;

`alerted_80` flips to true once spend reaches 80% of the limit; the API logs `budget 80%` once at that crossing.
The public `/api/health?db=1` shows only `{ok, db, budget: {month, paused}}`, never amounts.
