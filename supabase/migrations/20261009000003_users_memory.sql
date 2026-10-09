-- P3: users and memory (design §9.1–9.2, plan §4 P3.1). Mirrors MemoryUserStore in web/agent/store/user_types.ts.
-- Every user-owned row cascades from auth.users, so deleting the auth user deletes all of that user's data (FR-7.4).
-- RLS: owners may SELECT their own rows; all writes go through the server (service role), which also filters by user_id.

create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  risk_default text not null default 'expected' check (risk_default in ('expected', 'cautious')),
  quiet_from   time,            -- Europe/London wall clock
  quiet_to     time,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.devices (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 60),
  kw               numeric(10,3) not null check (kw > 0 and kw <= 10000),
  typical_hours    integer check (typical_hours between 1 and 12),
  source_device_id text,         -- id in agent/tools/devices.ts when it started from a default
  created_at       timestamptz not null default now(),
  unique (user_id, name)
);

create table public.conversations (
  id         uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_updated_idx on public.conversations (user_id, updated_at desc);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  turn_id         uuid,
  created_at      timestamptz not null default now()
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

create table public.conversation_summaries (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  summary         text not null,
  upto_message_id uuid,
  updated_at      timestamptz not null default now()
);

create table public.impact_ledger (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  conversation_id    uuid,
  turn_id            uuid,
  window_start_utc   timestamptz not null,
  run_now_start_utc  timestamptz not null,
  duration_h         integer not null check (duration_h between 1 and 12),
  energy_kwh         numeric(12,3) not null,
  run_id             text not null,
  model              text not null,
  est_point_g        numeric(14,1) not null,
  est_low_g          numeric(14,1) not null,
  est_high_g         numeric(14,1) not null,
  realized_g         numeric(14,1),   -- energy x (actual run-now avg - actual chosen-window avg), once actuals exist
  realized_at        timestamptz,
  realized_note      text,            -- e.g. 'no actuals after 7 days'
  created_at         timestamptz not null default now()
);
create index impact_ledger_user_created_idx on public.impact_ledger (user_id, created_at desc);

create table public.feedback (
  id         uuid primary key default gen_random_uuid(),
  turn_id    uuid not null,
  user_id    uuid references auth.users (id) on delete cascade,
  rating     smallint not null check (rating in (-1, 1)),
  comment    text check (char_length(comment) <= 1000),
  created_at timestamptz not null default now(),
  unique (turn_id, user_id)
);

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- Traces belong to the user too (FR-7.4, FR-8.4): deleting the user removes their turns (spans cascade from turns).
alter table public.turns
  add constraint turns_user_fk foreign key (user_id) references auth.users (id) on delete cascade;

-- RLS: on everywhere; owner-only SELECT on user tables. No INSERT/UPDATE/DELETE policies: the server writes.
alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_summaries enable row level security;
alter table public.impact_ledger enable row level security;
alter table public.feedback enable row level security;
alter table public.admins enable row level security;

create policy profiles_owner_select on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy devices_owner_select on public.devices for select to authenticated using (user_id = (select auth.uid()));
create policy conversations_owner_select on public.conversations for select to authenticated using (user_id = (select auth.uid()));
create policy messages_owner_select on public.messages for select to authenticated using (user_id = (select auth.uid()));
create policy summaries_owner_select on public.conversation_summaries for select to authenticated using (user_id = (select auth.uid()));
create policy impact_owner_select on public.impact_ledger for select to authenticated using (user_id = (select auth.uid()));
create policy feedback_owner_select on public.feedback for select to authenticated using (user_id = (select auth.uid()));
-- admins: no policies (server only).
