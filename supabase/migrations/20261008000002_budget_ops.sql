-- P1b.3: 80% budget alert flag, manual reset, and a status function. Design §10-11.
-- Never edit 20261008000001_init.sql; this migration only adds.

alter table public.cost_ledger add column if not exists alerted_80 boolean not null default false;

-- Same signature as before. Also sets alerted_80 once spend reaches 80% of the limit and pauses at 100%.
-- Returned jsonb gains alert_80: true only on the call that first crosses 80% (so callers log once per crossing).
-- Pausing at 100% is unchanged; a month that is already paused stays paused.
create or replace function public.add_spend(p_usd numeric, p_limit_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  r cost_ledger;
  v_crossed boolean := false;
begin
  insert into cost_ledger (month, spent_usd) values (v_month, p_usd)
    on conflict (month) do update set spent_usd = cost_ledger.spent_usd + p_usd, updated_at = now()
    returning * into r;
  if r.spent_usd >= 0.8 * p_limit_usd and not r.alerted_80 then
    update cost_ledger set alerted_80 = true where month = v_month returning * into r;
    v_crossed := true;
  end if;
  if r.spent_usd >= p_limit_usd and not r.paused then
    update cost_ledger set paused = true, paused_at = now() where month = v_month returning * into r;
  end if;
  return jsonb_build_object('month', r.month, 'spent_usd', r.spent_usd, 'paused', r.paused,
                            'alerted_80', r.alerted_80, 'alert_80', v_crossed);
end;
$$;

-- Documented manual reset: unpauses a month (e.g. after raising MONTHLY_BUDGET_USD) and returns the row.
create or replace function public.reset_budget(p_month text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r cost_ledger;
begin
  update cost_ledger set paused = false, paused_at = null, updated_at = now()
    where month = p_month returning * into r;
  if not found then
    return null;
  end if;
  return to_jsonb(r);
end;
$$;

-- Current UTC month: spent, paused, alerted_80 (zeros when no row yet).
create or replace function public.budget_status()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object('month', month, 'spent_usd', spent_usd, 'paused', paused, 'alerted_80', alerted_80)
       from cost_ledger where month = to_char(now() at time zone 'UTC', 'YYYY-MM')),
    jsonb_build_object('month', to_char(now() at time zone 'UTC', 'YYYY-MM'), 'spent_usd', 0,
                       'paused', false, 'alerted_80', false));
$$;

revoke all on function public.add_spend(numeric, numeric) from public, anon, authenticated;
revoke all on function public.reset_budget(text) from public, anon, authenticated;
revoke all on function public.budget_status() from public, anon, authenticated;
grant execute on function public.add_spend(numeric, numeric) to service_role;
grant execute on function public.reset_budget(text) to service_role;
grant execute on function public.budget_status() to service_role;
