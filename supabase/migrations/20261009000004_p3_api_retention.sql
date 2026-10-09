-- P3.2: reassign on Google-sign-in merge, per-IP session cap, anon message counter read, 90-day retention job.
-- All functions are service_role only (the API calls them with the secret key).

-- Moves an anonymous user's data to another user. Returns the number of conversations moved.
-- Per-user-unique tables (profiles, devices) are not moved: anonymous users cannot write them.
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
  -- feedback is unique on (turn_id, user_id): drop rows that would collide, move the rest.
  delete from feedback f where f.user_id = p_from
    and exists (select 1 from feedback g where g.turn_id = f.turn_id and g.user_id = p_to);
  update feedback set user_id = p_to where user_id = p_from;
  update turns set user_id = p_to where user_id = p_from;
  return v_moved;
end;
$$;

-- New anonymous sessions per IP hash per hour. Returns true (and counts) when under the cap.
create or replace function public.consume_session(p_ip_hash text, p_cap integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key  text := 'session:' || p_ip_hash || ':' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24');
  v_used integer;
begin
  perform pg_advisory_xact_lock(hashtext('consume_session'));
  v_used := coalesce((select count from usage_counters where key = v_key), 0);
  if v_used >= p_cap then
    return false;
  end if;
  insert into usage_counters (key, count) values (v_key, 1)
    on conflict (key) do update set count = usage_counters.count + 1, updated_at = now();
  return true;
end;
$$;

-- Messages an anonymous user has used (usage_counters key 'anon:<id>', written by consume_message).
create or replace function public.anon_messages_used(p_user uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select count from usage_counters where key = 'anon:' || p_user::text), 0);
$$;

revoke all on function public.reassign_user_data(uuid, uuid) from public, anon, authenticated;
revoke all on function public.consume_session(text, integer) from public, anon, authenticated;
revoke all on function public.anon_messages_used(uuid) from public, anon, authenticated;
grant execute on function public.reassign_user_data(uuid, uuid) to service_role;
grant execute on function public.consume_session(text, integer) to service_role;
grant execute on function public.anon_messages_used(uuid) to service_role;

-- Retention (FR-8.4, design 9.4): daily at 03:00 UTC delete messages, turns (spans cascade) and feedback older than
-- 90 days, and anonymous auth users inactive for 30 days (their rows cascade). Supabase Cron is the pg_cron extension,
-- documented at https://supabase.com/docs/guides/cron (jobs via SQL or Dashboard; cron.schedule). That page does not
-- state plan availability (UNVERIFIED here), so the block is guarded: it only schedules when the extension can be
-- created, and otherwise raises a notice (then run public.run_retention() from a scheduled GitHub Actions job).
create or replace function public.run_retention()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.messages where created_at < now() - interval '90 days';
  delete from public.turns where created_at < now() - interval '90 days';
  delete from public.feedback where created_at < now() - interval '90 days';
  delete from auth.users where is_anonymous and coalesce(last_sign_in_at, created_at) < now() - interval '30 days';
end;
$$;
revoke all on function public.run_retention() from public, anon, authenticated;
grant execute on function public.run_retention() to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'greenwindow-retention';
    perform cron.schedule('greenwindow-retention', '0 3 * * *', 'select public.run_retention()');
  else
    raise notice 'pg_cron is not available; retention job not scheduled';
  end if;
end;
$$;
