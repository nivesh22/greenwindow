-- P4.1: plans, push subscriptions, reminders, eval runs, and the cron jobs that call the app (design §9.1, §12).
-- Mirrors MemoryPlanStore in web/agent/store/plan_types.ts. RLS as in P3: owners may SELECT their own rows; all writes
-- go through the server (service role), which also filters by user_id.

create table public.plans (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  label          text not null check (char_length(label) between 1 and 80),
  kind           text not null check (kind in ('once', 'recurring')),
  job            jsonb not null,           -- {duration_h, power_kw, mode}; 'once' adds {earliest_utc, deadline_utc}
  rule           jsonb,                    -- recurring only: {days[], window_local: {from, to}, remind}
  next_start_utc timestamptz,              -- the latest computed start (null until computed / no forecast yet)
  next_run_id    text,                     -- forecast run the start came from
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check ((kind = 'recurring') = (rule is not null))
);
create index plans_user_idx on public.plans (user_id, created_at desc);
create index plans_recurring_active_idx on public.plans (kind, active) where active;

create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table public.reminders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  plan_id    uuid references public.plans (id) on delete cascade,
  send_at    timestamptz not null,
  sent_at    timestamptz,
  status     text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'cancelled')),
  attempts   smallint not null default 0,
  payload    jsonb not null,               -- {title, body, url, start_utc}
  created_at timestamptz not null default now(),
  unique (plan_id, send_at)                -- the recurring job can re-run without duplicating reminders
);
create index reminders_due_idx on public.reminders (status, send_at);
create index reminders_user_idx on public.reminders (user_id);

create table public.eval_runs (
  id                 uuid primary key default gen_random_uuid(),
  git_sha            text not null,
  mode               text not null check (mode in ('replay', 'record', 'live')),
  model              text,
  prompt_version     text not null,
  scenarios          integer not null,
  pass_rate          numeric(5,4) not null,
  window_correctness numeric(5,4) not null,
  banned_claims      integer not null,
  cost_usd           numeric(12,6) not null default 0,
  report             jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);
create index eval_runs_created_idx on public.eval_runs (created_at);

alter table public.plans enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminders enable row level security;
alter table public.eval_runs enable row level security;

create policy plans_owner_select on public.plans for select to authenticated using (user_id = (select auth.uid()));
create policy push_owner_select on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy reminders_owner_select on public.reminders for select to authenticated using (user_id = (select auth.uid()));
-- eval_runs: no policies (server/CI only).

-- The Google sign-in merge (S6) also moves P4 rows. Same body as 0004 plus plans, reminders, push subscriptions.
create or replace function public.reassign_user_data(p_from uuid, p_to uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_moved integer;
begin
  if p_from is null or p_to is null or p_from = p_to then
    return 0;
  end if;
  update conversations set user_id = p_to where user_id = p_from;
  get diagnostics v_moved = row_count;
  update messages set user_id = p_to where user_id = p_from;
  update conversation_summaries set user_id = p_to where user_id = p_from;
  update impact_ledger set user_id = p_to where user_id = p_from;
  delete from feedback f where f.user_id = p_from
    and exists (select 1 from feedback g where g.turn_id = f.turn_id and g.user_id = p_to);
  update feedback set user_id = p_to where user_id = p_from;
  update turns set user_id = p_to where user_id = p_from;
  update plans set user_id = p_to where user_id = p_from;
  update reminders set user_id = p_to where user_id = p_from;
  update push_subscriptions set user_id = p_to where user_id = p_from;
  return v_moved;
end;
$$;
revoke all on function public.reassign_user_data(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reassign_user_data(uuid, uuid) to service_role;

-- Cron → app calls (design §12). pg_net signature checked 2026-10-09 against
-- https://supabase.com/docs/guides/database/extensions/pg_net:
--   net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds int) returns bigint
-- Secrets follow https://supabase.com/docs/guides/functions/schedule-functions (vault.create_secret, read from
-- vault.decrypted_secrets). The owner creates two Vault secrets (never in the repo):
--   select vault.create_secret('https://greenwindow-one.vercel.app', 'greenwindow_app_url');
--   select vault.create_secret('<CRON_SECRET>', 'greenwindow_cron_secret');
-- Until both exist, gw_call_app does nothing and returns null, so the jobs are harmless.
create or replace function public.gw_call_app(p_path text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text := (select decrypted_secret from vault.decrypted_secrets where name = 'greenwindow_app_url');
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'greenwindow_cron_secret');
begin
  if v_url is null or v_secret is null then
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || p_path,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 10000
  );
end;
$$;
revoke all on function public.gw_call_app(text) from public, anon, authenticated;
grant execute on function public.gw_call_app(text) to service_role;

-- Reminders: checked every minute, but the app is only called when something is due (keeps invocations ~0).
-- Recurring: daily 06:45 UTC, after the 06:17 pipeline run. Ledger: daily 07:00 UTC.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    perform cron.unschedule(jobid) from cron.job
      where jobname in ('greenwindow-reminders', 'greenwindow-recurring', 'greenwindow-ledger');
    perform cron.schedule('greenwindow-reminders', '* * * * *',
      $job$select public.gw_call_app('/api/cron/reminders')
           where exists (select 1 from public.reminders where status = 'pending' and send_at <= now())$job$);
    perform cron.schedule('greenwindow-recurring', '45 6 * * *', $job$select public.gw_call_app('/api/cron/recurring')$job$);
    perform cron.schedule('greenwindow-ledger', '0 7 * * *', $job$select public.gw_call_app('/api/cron/ledger')$job$);
  else
    raise notice 'pg_cron or pg_net is not available; P4 cron jobs not scheduled';
  end if;
end;
$$;
