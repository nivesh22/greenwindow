-- Local RLS and cascade checks for the P4 tables (migration 20261009000005). Run by the orchestrator, not CI:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/p4_rls.local.sql
-- Everything runs in one transaction that is rolled back, so no data is left behind. Any failed check raises.
-- Needs the postgres role (table owner) to create fixtures and then switches to `authenticated` / `anon`.
begin;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'rls-a@example.invalid'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'rls-b@example.invalid');

insert into public.plans (id, user_id, label, kind, job, rule) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'A once', 'once', '{"duration_h":2,"power_kw":1,"mode":"expected"}', null),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000002', 'B rec', 'recurring', '{"duration_h":2,"power_kw":1,"mode":"expected"}',
   '{"days":["mon"],"window_local":{"from":"20:00","to":"23:00"},"remind":true}');
insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'https://push.invalid/a', 'k', 'a'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'https://push.invalid/b', 'k', 'a');
insert into public.reminders (user_id, plan_id, send_at, payload) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', now(), '{"title":"t","body":"b","url":"/","start_utc":"2026-10-10T10:00:00Z"}'),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', now(), '{"title":"t","body":"b","url":"/","start_utc":"2026-10-10T10:00:00Z"}');
insert into public.eval_runs (git_sha, mode, prompt_version, scenarios, pass_rate, window_correctness, banned_claims)
  values ('abc', 'replay', 'v3', 50, 1, 1, 0);

-- Constraints: recurring needs a rule, once must not have one; reminders are unique per (plan, send_at).
do $$
begin
  begin
    insert into public.plans (user_id, label, kind, job) values ('aaaaaaaa-0000-4000-8000-000000000001', 'bad', 'recurring', '{}');
    raise exception 'check failed: recurring plan without rule was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.reminders (user_id, plan_id, send_at, payload)
      select user_id, plan_id, send_at, payload from public.reminders where user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
    raise exception 'check failed: duplicate (plan_id, send_at) was accepted';
  exception when unique_violation then null; end;
end $$;

-- Owner A sees only A's rows.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
begin
  if (select count(*) from public.plans) <> 1 or (select count(*) from public.plans where user_id <> auth.uid()) <> 0 then
    raise exception 'check failed: plans leak across users'; end if;
  if (select count(*) from public.push_subscriptions) <> 1 then raise exception 'check failed: push_subscriptions leak'; end if;
  if (select count(*) from public.reminders) <> 1 then raise exception 'check failed: reminders leak'; end if;
  if (select count(*) from public.eval_runs) <> 0 then raise exception 'check failed: eval_runs visible to a user'; end if;
end $$;

-- Owners cannot write directly (no INSERT/UPDATE/DELETE policies): updates hit zero rows, inserts are refused.
do $$
declare n integer;
begin
  update public.plans set label = 'hacked' where user_id = auth.uid();
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'check failed: owner could update a plan'; end if;
  delete from public.reminders where user_id = auth.uid();
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'check failed: owner could delete a reminder'; end if;
  begin
    insert into public.plans (user_id, label, kind, job) values (auth.uid(), 'x', 'once', '{}');
    raise exception 'check failed: owner could insert a plan';
  exception when insufficient_privilege or others then
    if sqlerrm like 'check failed%' then raise; end if;
  end;
end $$;

-- Anonymous (no JWT) sees nothing.
reset role;
set local role anon;
do $$
begin
  if (select count(*) from public.plans) <> 0 or (select count(*) from public.push_subscriptions) <> 0 or (select count(*) from public.reminders) <> 0 then
    raise exception 'check failed: anon role can read P4 tables'; end if;
exception when insufficient_privilege then null;
end $$;
reset role;

-- gw_call_app is not callable by users.
do $$
begin
  set local role authenticated;
  begin
    perform public.gw_call_app('/api/cron/ledger');
    raise exception 'check failed: authenticated can call gw_call_app';
  exception when insufficient_privilege then null; end;
  reset role;
end $$;

-- Deleting a user cascades to plans, reminders and push subscriptions (POST /api/me/delete relies on this).
delete from auth.users where id = 'aaaaaaaa-0000-4000-8000-000000000001';
do $$
begin
  if exists (select 1 from public.plans where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
     or exists (select 1 from public.push_subscriptions where user_id = 'aaaaaaaa-0000-4000-8000-000000000001')
     or exists (select 1 from public.reminders where user_id = 'aaaaaaaa-0000-4000-8000-000000000001') then
    raise exception 'check failed: user delete did not cascade';
  end if;
  if (select count(*) from public.plans) <> 1 then raise exception 'check failed: cascade removed another user''s plan'; end if;
end $$;

select 'p4 rls checks passed' as result;
rollback;
