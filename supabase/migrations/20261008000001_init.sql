-- P1a schema: spend ledger, usage counters, turns, spans, and the atomic limit function.
-- Design §9 (P1a subset). Mirrors MemoryStore in web/agent/store/types.ts; keep both in sync.
-- All tables: RLS on, no policies => only the service role (server-side functions) can read/write.

create table public.cost_ledger (
  month          text primary key,                -- 'YYYY-MM' UTC
  spent_usd      numeric(12,6) not null default 0,
  eval_spent_usd numeric(12,6) not null default 0,
  paused         boolean not null default false,
  paused_at      timestamptz,
  updated_at     timestamptz not null default now()
);

create table public.usage_counters (
  key        text primary key,                    -- 'ip:<hash>:<YYYY-MM-DDTHH>', 'global:<day>', 'anon:<uid>', 'user:<uid>:<day>'
  count      integer not null default 0,
  updated_at timestamptz not null default now()
);

create table public.turns (
  id              uuid primary key,
  conversation_id uuid not null,
  user_id         uuid,
  ip_hash         text not null,
  intent          text,
  stop_reason     text not null,
  prompt_version  text not null,
  model_final     text,
  tokens_in       integer not null default 0,
  tokens_out      integer not null default 0,
  cost_usd        numeric(12,6) not null default 0,
  latency_ms      integer not null default 0,
  created_at      timestamptz not null default now()
);
create index turns_created_at_idx on public.turns (created_at);

create table public.spans (
  id          uuid primary key,
  turn_id     uuid not null references public.turns (id) on delete cascade,
  parent_id   uuid,
  kind        text not null check (kind in ('gate', 'llm', 'tool', 'stage')),
  name        text not null,
  started_at  timestamptz not null,
  duration_ms integer not null,
  status      text not null check (status in ('ok', 'error')),
  attrs       jsonb not null default '{}'::jsonb,
  tokens_in   integer not null default 0,
  tokens_out  integer not null default 0,
  cost_usd    numeric(12,6) not null default 0
);
create index spans_turn_id_idx on public.spans (turn_id);

alter table public.cost_ledger enable row level security;
alter table public.usage_counters enable row level security;
alter table public.turns enable row level security;
alter table public.spans enable row level security;

-- Atomic limit check + counter increment. Serialized with a transaction-level advisory lock: traffic is tiny,
-- and serializing removes every check-then-increment race. Returns {allowed, kind, messages_left}.
create or replace function public.consume_message(
  p_user uuid,
  p_ip_hash text,
  p_is_anon boolean,
  p_daily_cap integer,
  p_anon_cap integer,
  p_ip_hourly_cap integer,
  p_global_daily_cap integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
  v_month   text := to_char(v_now at time zone 'UTC', 'YYYY-MM');
  v_day     text := to_char(v_now at time zone 'UTC', 'YYYY-MM-DD');
  v_ip_key  text := 'ip:' || p_ip_hash || ':' || to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24');
  v_glb_key text := 'global:' || v_day;
  v_usr_key text;
  v_cap     integer;
  v_used    integer;
  v_left    integer := null;
begin
  perform pg_advisory_xact_lock(hashtext('consume_message'));

  if exists (select 1 from cost_ledger where month = v_month and paused) then
    return jsonb_build_object('allowed', false, 'kind', 'budget_paused', 'messages_left', null);
  end if;

  if coalesce((select count from usage_counters where key = v_ip_key), 0) >= p_ip_hourly_cap
     or coalesce((select count from usage_counters where key = v_glb_key), 0) >= p_global_daily_cap then
    return jsonb_build_object('allowed', false, 'kind', 'rate', 'messages_left', null);
  end if;

  if p_user is not null then
    if p_is_anon then
      v_usr_key := 'anon:' || p_user::text;
      v_cap := p_anon_cap;
    else
      v_usr_key := 'user:' || p_user::text || ':' || v_day;
      v_cap := p_daily_cap;
    end if;
    v_used := coalesce((select count from usage_counters where key = v_usr_key), 0);
    if v_used >= v_cap then
      return jsonb_build_object('allowed', false,
        'kind', case when p_is_anon then 'anon_limit' else 'daily_cap' end, 'messages_left', 0);
    end if;
    insert into usage_counters (key, count) values (v_usr_key, 1)
      on conflict (key) do update set count = usage_counters.count + 1, updated_at = v_now;
    v_left := v_cap - (v_used + 1);
  end if;

  insert into usage_counters (key, count) values (v_ip_key, 1)
    on conflict (key) do update set count = usage_counters.count + 1, updated_at = v_now;
  insert into usage_counters (key, count) values (v_glb_key, 1)
    on conflict (key) do update set count = usage_counters.count + 1, updated_at = v_now;

  return jsonb_build_object('allowed', true, 'kind', null, 'messages_left', v_left);
end;
$$;

-- Atomic spend add; pauses the month when the total reaches the limit.
create or replace function public.add_spend(p_usd numeric, p_limit_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month text := to_char(now() at time zone 'UTC', 'YYYY-MM');
  r cost_ledger;
begin
  insert into cost_ledger (month, spent_usd) values (v_month, p_usd)
    on conflict (month) do update set spent_usd = cost_ledger.spent_usd + p_usd, updated_at = now()
    returning * into r;
  if r.spent_usd >= p_limit_usd and not r.paused then
    update cost_ledger set paused = true, paused_at = now() where month = v_month returning * into r;
  end if;
  return jsonb_build_object('month', r.month, 'spent_usd', r.spent_usd, 'paused', r.paused);
end;
$$;

revoke all on function public.consume_message(uuid, text, boolean, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.add_spend(numeric, numeric) from public, anon, authenticated;
grant execute on function public.consume_message(uuid, text, boolean, integer, integer, integer, integer) to service_role;
grant execute on function public.add_spend(numeric, numeric) to service_role;
