-- 0003_plans_sessions
--
-- Plans and sessions boundary: master_plans, plan_versions, plan_phases,
-- offline_snapshots, learning_sessions, attempts, session_activity_intervals, and the
-- trigger helper `private.guard_plan_order`.
--
-- Source: docs/Database-schema.md v1.1 (approved by the owner, D74, 4 October 2026):
-- §3.3 learning ERD, §4 conventions (delete classes, composite parent-ownership keys,
-- value sets), §6.3 learning tables, §10 trigger helpers, §11 migration plan
-- `0003_plans_sessions`.
--
-- Scope notes
--   * Every table enables row level security (not forced) and revokes every privilege of
--     `anon`, `authenticated` and `service_role`. The own-row policies, the column
--     grants of `authenticated` and the `app_*` commit functions arrive in
--     `0005_rls_functions` (§11).
--   * The set of memorization paths is quran, matn, sanad, grade (Database-schema.md §4.4;
--     owner correction of 4 October 2026: takhrij is not a memorization path). It appears
--     only in `master_plans_paths_check` below; `passages.path` is the matching set of 0001.
--   * Class G cyclic key: master_plans (id, current_version) references
--     plan_versions (plan_id, version_no), deferrable initially deferred, so a plan and
--     its first version are inserted in one transaction.
--   * No seed rows. Nothing here is applied to any Supabase project by this file's
--     existence.

-- ---------------------------------------------------------------------------
-- 1. Trigger helper (§10): schema private, search_path = '', security definer
-- ---------------------------------------------------------------------------

-- Before insert or update of plan_order, edition_id on master_plans: `reverse` is allowed
-- only when the edition's book has content_format = 'quran' (D72, OPEN-11). Security
-- definer as stated by §10, so the check sees the edition whatever its status.
create function private.guard_plan_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.plan_order = 'reverse' and not exists (
    select 1
    from public.book_editions e
    join public.books b on b.id = e.book_id
    where e.id = new.edition_id
      and b.content_format = 'quran'
  ) then
    raise exception 'plan_order reverse is available for a Quran edition only (D72)'
      using errcode = 'check_violation',
            table = 'master_plans',
            constraint = 'master_plans_plan_order_quran_only_check',
            hint = 'Use plan_order book for a hadith edition.';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_plan_order() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Tables, in dependency order (§11 item 1)
-- ---------------------------------------------------------------------------

-- 2.1 master_plans ----------------------------------------------------------

create table public.master_plans (
  id               uuid        not null default gen_random_uuid(),
  user_id          uuid        not null,
  edition_id       uuid        not null,
  target_scope     jsonb       not null,
  paths            text[]      not null,
  plan_order       text        not null default 'book',
  session_minutes  smallint    not null,
  preferred_date   date,
  agreed_estimate  jsonb       not null,
  current_version  integer     not null default 1,
  status           text        not null default 'active',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint master_plans_pkey primary key (id),
  constraint master_plans_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint master_plans_edition_id_fkey
    foreign key (edition_id) references public.book_editions (id) on delete restrict,
  constraint master_plans_id_user_id_key unique (id, user_id),
  constraint master_plans_id_user_id_edition_id_key unique (id, user_id, edition_id),
  -- an object whose sectionOrdinals is an array (contract §5)
  constraint master_plans_target_scope_check
    check (jsonb_typeof(target_scope) = 'object'
           and coalesce(jsonb_typeof(target_scope -> 'sectionOrdinals') = 'array', false)),
  -- at least one element, each one of the four paths (contract §2.3, §4.4)
  constraint master_plans_paths_check
    check (cardinality(paths) >= 1
           and paths <@ array['quran', 'matn', 'sanad', 'grade']::text[]),
  constraint master_plans_plan_order_check check (plan_order in ('book', 'reverse')),
  constraint master_plans_session_minutes_check check (session_minutes in (5, 10, 15)),
  constraint master_plans_agreed_estimate_check check (jsonb_typeof(agreed_estimate) = 'object'),
  constraint master_plans_current_version_check check (current_version >= 1),
  constraint master_plans_status_check check (status in ('active', 'paused', 'completed'))
);
comment on table public.master_plans is 'The learner''s overall goal for one edition (D09, R14); one active plan per account (D34). Scope, paths, order and minutes mirror current_version.';

-- one active plan per account; starting another pauses the current one in the same transaction
create unique index master_plans_user_id_active_key
  on public.master_plans (user_id)
  where status = 'active';
create index master_plans_user_id_status_idx on public.master_plans (user_id, status);
create index master_plans_edition_id_idx on public.master_plans (edition_id);

create trigger master_plans_set_updated_at
  before update on public.master_plans
  for each row execute function private.set_updated_at();

create trigger master_plans_guard_plan_order
  before insert or update of plan_order, edition_id on public.master_plans
  for each row execute function private.guard_plan_order();

alter table public.master_plans enable row level security;
revoke all on table public.master_plans from anon, authenticated, service_role;

-- 2.2 plan_versions ---------------------------------------------------------

create table public.plan_versions (
  id                      uuid        not null default gen_random_uuid(),
  plan_id                 uuid        not null,
  user_id                 uuid        not null,
  version_no              integer     not null,
  reason_code             text        not null,
  policy_json             jsonb       not null default '{}',
  effective_learning_date date        not null,
  created_at              timestamptz not null default now(),
  constraint plan_versions_pkey primary key (id),
  constraint plan_versions_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  -- class B: personal child to personal parent through (id, user_id)
  constraint plan_versions_plan_id_user_id_fkey
    foreign key (plan_id, user_id) references public.master_plans (id, user_id) on delete cascade,
  constraint plan_versions_plan_id_version_no_key unique (plan_id, version_no),
  constraint plan_versions_id_user_id_key unique (id, user_id),
  constraint plan_versions_id_plan_id_user_id_key unique (id, plan_id, user_id),
  constraint plan_versions_version_no_check check (version_no >= 1),
  constraint plan_versions_reason_code_check check (btrim(reason_code) <> ''),
  constraint plan_versions_policy_json_check check (jsonb_typeof(policy_json) = 'object')
);
comment on table public.plan_versions is 'Append-only plan revisions; never replaces history (D09, D57, D59).';

create index plan_versions_user_id_plan_id_idx on public.plan_versions (user_id, plan_id);

alter table public.plan_versions enable row level security;
revoke all on table public.plan_versions from anon, authenticated, service_role;

-- Class G: the cyclic key from master_plans to plan_versions, checked at commit.
alter table public.master_plans
  add constraint master_plans_id_current_version_fkey
  foreign key (id, current_version) references public.plan_versions (plan_id, version_no)
  on delete no action
  deferrable initially deferred;

-- 2.3 plan_phases -----------------------------------------------------------

create table public.plan_phases (
  id                uuid      not null default gen_random_uuid(),
  plan_version_id   uuid      not null,
  user_id           uuid      not null,
  ordinal           integer   not null,
  section_refs      jsonb     not null,
  unit_range        jsonb     not null,
  goal_size         integer   not null,
  estimated_window  daterange not null,
  constraint plan_phases_pkey primary key (id),
  constraint plan_phases_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint plan_phases_plan_version_id_user_id_fkey
    foreign key (plan_version_id, user_id) references public.plan_versions (id, user_id) on delete cascade,
  constraint plan_phases_plan_version_id_ordinal_key unique (plan_version_id, ordinal),
  constraint plan_phases_id_plan_version_id_user_id_key unique (id, plan_version_id, user_id),
  constraint plan_phases_ordinal_check check (ordinal >= 1),
  constraint plan_phases_section_refs_check check (jsonb_typeof(section_refs) = 'array'),
  constraint plan_phases_unit_range_check check (jsonb_typeof(unit_range) = 'object'),
  constraint plan_phases_goal_size_check check (goal_size > 0),
  constraint plan_phases_estimated_window_check check (not isempty(estimated_window))
);
comment on table public.plan_phases is 'Ordered ranges that cover the goal; not the dates of every future session.';

create index plan_phases_user_id_plan_version_id_idx on public.plan_phases (user_id, plan_version_id);

alter table public.plan_phases enable row level security;
revoke all on table public.plan_phases from anon, authenticated, service_role;

-- 2.4 offline_snapshots -----------------------------------------------------

create table public.offline_snapshots (
  id                   uuid        not null default gen_random_uuid(),
  user_id              uuid        not null,
  plan_id              uuid        not null,
  plan_version         integer     not null,
  edition_id           uuid        not null,
  bank_version         integer     not null,
  client_operation_id  uuid        not null,
  download_target_refs jsonb       not null,
  schema_version       integer     not null,
  protocol_version     integer     not null,
  payload              jsonb       not null,
  created_at           timestamptz not null default now(),
  constraint offline_snapshots_pkey primary key (id),
  constraint offline_snapshots_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint offline_snapshots_plan_id_user_id_edition_id_fkey
    foreign key (plan_id, user_id, edition_id)
    references public.master_plans (id, user_id, edition_id) on delete cascade,
  constraint offline_snapshots_plan_id_plan_version_fkey
    foreign key (plan_id, plan_version)
    references public.plan_versions (plan_id, version_no) on delete cascade,
  constraint offline_snapshots_user_id_client_operation_id_key unique (user_id, client_operation_id),
  constraint offline_snapshots_id_user_id_key unique (id, user_id),
  constraint offline_snapshots_plan_version_check check (plan_version >= 1),
  constraint offline_snapshots_bank_version_check check (bank_version >= 1),
  constraint offline_snapshots_download_target_refs_check check (jsonb_typeof(download_target_refs) = 'array'),
  constraint offline_snapshots_schema_version_check check (schema_version > 0),
  constraint offline_snapshots_protocol_version_check check (protocol_version > 0),
  constraint offline_snapshots_payload_check check (jsonb_typeof(payload) = 'object')
);
comment on table public.offline_snapshots is 'A fixed record of a downloaded plan slice (D46, D58); no lease, no expiry.';

create index offline_snapshots_user_id_plan_id_created_at_idx
  on public.offline_snapshots (user_id, plan_id, created_at);

alter table public.offline_snapshots enable row level security;
revoke all on table public.offline_snapshots from anon, authenticated, service_role;

-- 2.5 learning_sessions (after offline_snapshots, which it references) -------

create table public.learning_sessions (
  id                  uuid        not null default gen_random_uuid(),
  user_id             uuid        not null,
  plan_id             uuid,
  plan_version_id     uuid,
  phase_id            uuid,
  edition_id          uuid        not null,
  kind                text        not null,
  learning_date       date        not null,
  lesson_refs         uuid[]      not null default '{}',
  question_refs       uuid[]      not null default '{}',
  steps               jsonb       not null,
  bank_version        integer     not null,
  self_rating         text,
  status              text        not null,
  elapsed_ms          bigint      not null default 0,
  offline_snapshot_id uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint learning_sessions_pkey primary key (id),
  constraint learning_sessions_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  -- class C: personal row to published content
  constraint learning_sessions_edition_id_fkey
    foreign key (edition_id) references public.book_editions (id) on delete restrict,
  constraint learning_sessions_plan_id_user_id_edition_id_fkey
    foreign key (plan_id, user_id, edition_id)
    references public.master_plans (id, user_id, edition_id) on delete cascade,
  constraint learning_sessions_plan_version_id_plan_id_user_id_fkey
    foreign key (plan_version_id, plan_id, user_id)
    references public.plan_versions (id, plan_id, user_id) on delete cascade,
  constraint learning_sessions_phase_id_plan_version_id_user_id_fkey
    foreign key (phase_id, plan_version_id, user_id)
    references public.plan_phases (id, plan_version_id, user_id) on delete cascade,
  -- class F: SET NULL on the link column only (column-list form, PostgreSQL 15 or later)
  constraint learning_sessions_offline_snapshot_id_user_id_fkey
    foreign key (offline_snapshot_id, user_id)
    references public.offline_snapshots (id, user_id) on delete set null (offline_snapshot_id),
  constraint learning_sessions_id_user_id_key unique (id, user_id),
  constraint learning_sessions_id_user_id_edition_id_key unique (id, user_id, edition_id),
  constraint learning_sessions_kind_check check (kind in ('daily', 'game', 'placement')),
  constraint learning_sessions_status_check check (status in ('prepared', 'open', 'completed')),
  constraint learning_sessions_self_rating_check
    check (self_rating is null or self_rating in ('none', 'some', 'most')),
  constraint learning_sessions_bank_version_check check (bank_version >= 1),
  constraint learning_sessions_elapsed_ms_check check (elapsed_ms >= 0),
  constraint learning_sessions_steps_check check (jsonb_typeof(steps) = 'array'),
  -- plan_id and plan_version_id are null together
  constraint learning_sessions_plan_pair_check check ((plan_id is null) = (plan_version_id is null)),
  -- a plan is optional only for the initial placement test (D42)
  constraint learning_sessions_plan_required_check check (kind = 'placement' or plan_id is not null),
  constraint learning_sessions_phase_requires_version_check
    check (phase_id is null or plan_version_id is not null),
  constraint learning_sessions_self_rating_placement_check
    check (self_rating is null or kind = 'placement')
);
comment on table public.learning_sessions is 'A server-prepared session (daily, game or placement) with an immutable snapshot of its steps.';

create index learning_sessions_user_id_learning_date_idx
  on public.learning_sessions (user_id, learning_date);
create index learning_sessions_user_id_plan_id_learning_date_idx
  on public.learning_sessions (user_id, plan_id, learning_date);
create index learning_sessions_user_id_unfinished_idx
  on public.learning_sessions (user_id)
  where status <> 'completed';
create index learning_sessions_offline_snapshot_id_idx
  on public.learning_sessions (offline_snapshot_id)
  where offline_snapshot_id is not null;
create index learning_sessions_plan_version_id_idx on public.learning_sessions (plan_version_id);
create index learning_sessions_phase_id_idx on public.learning_sessions (phase_id);

-- at most one server-side daily session per account and learning date (A-01, §6.3); this is what
-- makes the get-or-create of app_open_session atomic. Offline-prepared, completed, game and
-- placement sessions are outside the index and may coexist (OPEN-08).
create unique index learning_sessions_user_id_learning_date_daily_key
  on public.learning_sessions (user_id, learning_date)
  where kind = 'daily'
    and status in ('prepared', 'open')
    and offline_snapshot_id is null;

create trigger learning_sessions_set_updated_at
  before update on public.learning_sessions
  for each row execute function private.set_updated_at();

alter table public.learning_sessions enable row level security;
revoke all on table public.learning_sessions from anon, authenticated, service_role;

-- 2.6 attempts --------------------------------------------------------------

create table public.attempts (
  id               uuid        not null default gen_random_uuid(),
  user_id          uuid        not null,
  session_id       uuid        not null,
  edition_id       uuid        not null,
  client_event_id  uuid        not null,
  question_id      uuid        not null,
  passage_id       uuid        not null,
  correct          boolean     not null,
  assisted         boolean     not null default false,
  error_kind       text,
  wrong_token_ref  text,
  review_round_id  uuid,
  duration_ms      integer     not null,
  occurred_at      timestamptz not null,
  created_at       timestamptz not null default now(),
  constraint attempts_pkey primary key (id),
  constraint attempts_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint attempts_session_id_user_id_edition_id_fkey
    foreign key (session_id, user_id, edition_id)
    references public.learning_sessions (id, user_id, edition_id) on delete cascade,
  -- class C: personal row to published content
  constraint attempts_question_id_edition_id_passage_id_fkey
    foreign key (question_id, edition_id, passage_id)
    references public.question_items (id, edition_id, passage_id) on delete restrict,
  constraint attempts_user_id_client_event_id_key unique (user_id, client_event_id),
  constraint attempts_id_user_id_passage_id_key unique (id, user_id, passage_id),
  constraint attempts_error_kind_check
    check (error_kind is null
           or error_kind in ('none', 'wrong_choice', 'wrong_order', 'wrong_recall',
                             'similar_confusion', 'timeout', 'skipped')),
  -- a reference to an edition word: <unitOrdinal>:<tokenIndex>; the word itself is never stored
  constraint attempts_wrong_token_ref_check
    check (wrong_token_ref is null or wrong_token_ref ~ '^[0-9]+:[0-9]+$'),
  constraint attempts_duration_ms_check check (duration_ms >= 0)
);
comment on table public.attempts is 'Immutable, server-graded answer events; the free-text answer is never stored (D31, D41, D59, D64, D66).';

create index attempts_session_id_created_at_idx on public.attempts (session_id, created_at);
create index attempts_user_id_passage_id_created_at_idx on public.attempts (user_id, passage_id, created_at);

alter table public.attempts enable row level security;
revoke all on table public.attempts from anon, authenticated, service_role;

-- 2.7 session_activity_intervals --------------------------------------------

create table public.session_activity_intervals (
  id              uuid        not null default gen_random_uuid(),
  user_id         uuid        not null,
  session_id      uuid        not null,
  client_event_id uuid        not null,
  started_at      timestamptz not null,
  ended_at        timestamptz not null,
  active_ms       bigint      not null,
  learning_date   date        not null,
  created_at      timestamptz not null default now(),
  constraint session_activity_intervals_pkey primary key (id),
  constraint session_activity_intervals_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint session_activity_intervals_session_id_user_id_fkey
    foreign key (session_id, user_id)
    references public.learning_sessions (id, user_id) on delete cascade,
  constraint session_activity_intervals_user_id_client_event_id_key unique (user_id, client_event_id),
  constraint session_activity_intervals_ended_at_check check (ended_at >= started_at),
  -- at most 30 minutes per event (contract §7)
  constraint session_activity_intervals_active_ms_range_check
    check (active_ms between 0 and 1800000),
  -- at most the interval plus 1,000 ms (contract §7)
  constraint session_activity_intervals_active_ms_window_check
    check (active_ms::numeric <= extract(epoch from (ended_at - started_at)) * 1000 + 1000)
);
comment on table public.session_activity_intervals is 'Server-validated active-time intervals; the daily total is the union of overlapping intervals (D40).';

create index session_activity_intervals_user_id_learning_date_started_at_idx
  on public.session_activity_intervals (user_id, learning_date, started_at);
create index session_activity_intervals_session_id_idx on public.session_activity_intervals (session_id);

alter table public.session_activity_intervals enable row level security;
revoke all on table public.session_activity_intervals from anon, authenticated, service_role;
