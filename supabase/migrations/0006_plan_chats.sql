-- STATUS (4 Oct 2026, merge snapshot): this migration applies cleanly after 0001–0005 on the local
-- harness (checks 0001–0005 stay green), but its own checks (checks_0006.sql: two-account isolation
-- of the chat tables, the open→append→confirm flow, app_resume_plan, privilege matrix) are NOT
-- written yet. Treat it as UNTESTED until checks_0006 exists and passes; no production use.
--
-- 0006_plan_chats
--
-- Plan conversation boundary (D75): `plan_chats` and `plan_chat_messages`, their policies and
-- grants, four learner functions (`app_resume_plan` and the three `app_plan_chat_*`), and an
-- extended `srv_delete_personal_rows`.
--
-- Source: docs/Database-schema.md v1.2 (D74, D75): §4.2/§4.3 (classes A and B, composite keys),
-- §4.4 value sets, §4.5 P-OWN, §5.2/§5.3 grants (issued here because 0005 has already run),
-- §6.3 `plan_chats` and `plan_chat_messages`, §10, §11 `0006_plan_chats`, §12.1 (deletion list),
-- OPEN-18 (decided by the coordinator, 4 October 2026: multi-row writes go through three
-- SECURITY INVOKER `app_*` functions; no DELETE grant, no purge: Plan-conversation §2.1, §2.9).
-- docs/Plan-conversation.md v1.1 §2.1, §2.9 (one open chat per user; closing shares the
-- transaction of the plan commit); API-spec E30 (resume).
--
-- Scope notes
--   * Both tables enable row level security (not forced) and revoke every privilege of `anon`,
--     `authenticated` and `service_role`; the reviewed `authenticated` grants and the P-OWN
--     policies follow in this file. `qatra_server` has no access (no `srv_*` function reads them).
--   * `app_resume_plan` (E30, A-08) is added here although it is not one of the six functions of
--     §8.3: coordinator decision of 4 October 2026.
--   * SQLSTATEs as in 0005: QT002 version_conflict, QT003 invalid_state; P0002 no_data_found.
--   * The model's raw output is never stored; no learner text leaves these tables except through
--     the owner's own rows. No seed rows.

-- ---------------------------------------------------------------------------
-- 1. Tables (§11 `0006_plan_chats` item 1)
-- ---------------------------------------------------------------------------

create table public.plan_chats (
  id               uuid        not null default gen_random_uuid(),
  user_id          uuid        not null,
  plan_id          uuid,
  status           text        not null,
  language         text        not null,
  proposal         jsonb,
  proposal_version integer     not null default 0,
  model_turns      integer     not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  closed_at        timestamptz,
  constraint plan_chats_pkey primary key (id),
  constraint plan_chats_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  -- class B; MATCH SIMPLE: not checked while plan_id is NULL (a creation conversation)
  constraint plan_chats_plan_id_user_id_fkey
    foreign key (plan_id, user_id) references public.master_plans (id, user_id) on delete cascade,
  constraint plan_chats_id_user_id_key unique (id, user_id),
  constraint plan_chats_status_check check (status in ('open', 'confirmed', 'abandoned')),
  constraint plan_chats_language_check check (language in ('ar', 'en')),
  constraint plan_chats_proposal_check check (proposal is null or jsonb_typeof(proposal) = 'object'),
  constraint plan_chats_proposal_version_check check (proposal_version >= 0),
  constraint plan_chats_model_turns_check check (model_turns >= 0),
  -- proposed (§6.3): closed_at is set on confirm or abandon, exactly when the chat is not open
  constraint plan_chats_closed_at_check check ((closed_at is null) = (status = 'open'))
);
comment on table public.plan_chats is 'The plan conversation of one account (D75); saves nothing until the learner confirms the current proposal.';

-- one open chat per user: creating a new one abandons the previous one in the same transaction
create unique index plan_chats_user_id_open_key
  on public.plan_chats (user_id)
  where status = 'open';
-- foreign-key support
create index plan_chats_plan_id_idx on public.plan_chats (plan_id) where plan_id is not null;

create trigger plan_chats_set_updated_at
  before update on public.plan_chats
  for each row execute function private.set_updated_at();

alter table public.plan_chats enable row level security;
revoke all on table public.plan_chats from anon, authenticated, service_role;

create table public.plan_chat_messages (
  id         uuid        not null default gen_random_uuid(),
  chat_id    uuid        not null,
  user_id    uuid        not null,
  ordinal    integer     not null,
  role       text        not null,
  kind       text        not null,
  text       text        not null,
  source     text        not null,
  payload    jsonb,
  created_at timestamptz not null default now(),
  constraint plan_chat_messages_pkey primary key (id),
  constraint plan_chat_messages_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint plan_chat_messages_chat_id_user_id_fkey
    foreign key (chat_id, user_id) references public.plan_chats (id, user_id) on delete cascade,
  constraint plan_chat_messages_chat_id_ordinal_key unique (chat_id, ordinal),
  constraint plan_chat_messages_role_check check (role in ('learner', 'assistant')),
  constraint plan_chat_messages_kind_check
    check (kind in ('text', 'proposal', 'refusal', 'redirect', 'fallback', 'quick_reply')),
  constraint plan_chat_messages_text_check check (char_length(text) <= 2000),
  constraint plan_chat_messages_source_check check (source in ('learner', 'rules', 'model', 'fixed'))
);
comment on table public.plan_chat_messages is 'Ordered, append-only messages of a plan conversation (D75); the model''s raw output is never stored.';

alter table public.plan_chat_messages enable row level security;
revoke all on table public.plan_chat_messages from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Policies (P-OWN) and grants (§5.2, §5.3)
-- ---------------------------------------------------------------------------

create policy "plan_chats__authenticated__select" on public.plan_chats
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "plan_chats__authenticated__insert" on public.plan_chats
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "plan_chats__authenticated__update" on public.plan_chats
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "plan_chat_messages__authenticated__select" on public.plan_chat_messages
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "plan_chat_messages__authenticated__insert" on public.plan_chat_messages
  for insert to authenticated
  with check (user_id = (select auth.uid()));

grant select, insert on table public.plan_chats to authenticated;
grant update (status, proposal, proposal_version, model_turns, closed_at)
  on table public.plan_chats to authenticated;
grant select, insert on table public.plan_chat_messages to authenticated;

-- ---------------------------------------------------------------------------
-- 3. app_resume_plan (E30, A-08): SECURITY INVOKER, EXECUTE for authenticated only
-- ---------------------------------------------------------------------------
-- Atomically pauses the caller's active plan (if another) and makes the given paused plan
-- active; returns its current_version. A plan that is already active is returned unchanged;
-- a completed plan raises QT003; an unknown or foreign plan raises no_data_found. Of two
-- simultaneous resumes the loser fails on master_plans_user_id_active_key (23505).

create function public.app_resume_plan(p_plan uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_status  text;
  v_version integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select mp.status, mp.current_version into v_status, v_version
  from public.master_plans mp
  where mp.id = p_plan
    and mp.user_id = v_uid
  for update;

  if not found then
    raise exception 'plan_not_found' using errcode = 'no_data_found';
  end if;
  if v_status = 'completed' then
    raise exception 'invalid_state' using errcode = 'QT003';
  end if;
  if v_status = 'active' then
    return v_version;
  end if;

  update public.master_plans mp
     set status = 'paused'
   where mp.user_id = v_uid
     and mp.status = 'active'
     and mp.id <> p_plan;

  update public.master_plans mp
     set status = 'active'
   where mp.id = p_plan
     and mp.user_id = v_uid;

  return v_version;
end;
$$;

revoke all on function public.app_resume_plan(uuid) from public, anon, service_role, qatra_server;
grant execute on function public.app_resume_plan(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. app_plan_chat_open (E31)
-- ---------------------------------------------------------------------------
-- Marks the caller's previous open chat `abandoned` (replaced_chat_id, NULL if none) and
-- inserts the new chat with its first messages: the learner's text (skipped when NULL, e.g. a
-- quick-reply-only conversation) and the first assistant message(s). p_first_assistant is one
-- message object or an array of them (a fixed refusal followed by a rules proposal, Plan-
-- conversation §2.9 item 5); a message object is {kind, text, source, payload?}. A given
-- p_proposal is stored with proposal_version 1. The parameter order differs from the brief
-- only because PostgreSQL requires every parameter after a defaulted one to have a default:
-- the optional p_plan and p_proposal come last. A forged or foreign p_plan raises 23503.

create function public.app_plan_chat_open(
  p_language            text,
  p_first_learner_text  text,
  p_first_assistant     jsonb,
  p_plan                uuid default null,
  p_proposal            jsonb default null
)
returns table (chat_id uuid, replaced_chat_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid      uuid := (select auth.uid());
  v_chat     uuid;
  v_replaced uuid := null;
  v_msgs     jsonb;
  v_ord      integer := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  v_msgs := case pg_catalog.jsonb_typeof(p_first_assistant)
              when 'object' then pg_catalog.jsonb_build_array(p_first_assistant)
              when 'array'  then p_first_assistant
              else null end;
  if v_msgs is null or pg_catalog.jsonb_array_length(v_msgs) = 0 then
    raise exception 'p_first_assistant must be a message object or a non-empty array'
      using errcode = 'invalid_parameter_value';
  end if;

  -- one open chat per account: the previous one is abandoned in the same transaction
  update public.plan_chats c
     set status = 'abandoned',
         closed_at = pg_catalog.now()
   where c.user_id = v_uid
     and c.status = 'open'
  returning c.id into v_replaced;

  insert into public.plan_chats (user_id, plan_id, status, language, proposal, proposal_version)
  values (v_uid, p_plan, 'open', p_language, p_proposal, case when p_proposal is null then 0 else 1 end)
  returning id into v_chat;

  if p_first_learner_text is not null then
    v_ord := v_ord + 1;
    insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source)
    values (v_chat, v_uid, v_ord, 'learner', 'text', p_first_learner_text, 'learner');
  end if;

  insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source, payload)
  select v_chat, v_uid, v_ord + e.ord::integer, 'assistant', m.kind, m.text, m.source, m.payload
  from pg_catalog.jsonb_array_elements(v_msgs) with ordinality as e(value, ord)
  cross join lateral pg_catalog.jsonb_to_record(e.value) as m(kind text, text text, source text, payload jsonb);

  return query select v_chat, v_replaced;
end;
$$;

revoke all on function public.app_plan_chat_open(text, text, jsonb, uuid, jsonb)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_plan_chat_open(text, text, jsonb, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. app_plan_chat_append (E32)
-- ---------------------------------------------------------------------------
-- Appends messages to the caller's open chat (ordinals continue), optionally replaces the
-- proposal (proposal_version + 1) and adds to model_turns. Returns the proposal_version after
-- the call. A chat that is not open raises QT003; an unknown or foreign chat no_data_found.
--   p_messages: array of {role, kind, text, source, payload?}

create function public.app_plan_chat_append(
  p_chat                  uuid,
  p_messages              jsonb,
  p_proposal              jsonb default null,
  p_model_turns_increment integer default 0
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_status  text;
  v_version integer;
  v_max     integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if pg_catalog.jsonb_typeof(p_messages) is distinct from 'array' or coalesce(p_model_turns_increment, 0) < 0 then
    raise exception 'p_messages must be a JSON array and the increment not negative'
      using errcode = 'invalid_parameter_value';
  end if;

  select c.status, c.proposal_version into v_status, v_version
  from public.plan_chats c
  where c.id = p_chat
    and c.user_id = v_uid
  for update;

  if not found then
    raise exception 'chat_not_found' using errcode = 'no_data_found';
  end if;
  if v_status <> 'open' then
    raise exception 'invalid_state' using errcode = 'QT003';
  end if;

  select coalesce(max(m.ordinal), 0) into v_max
  from public.plan_chat_messages m
  where m.chat_id = p_chat
    and m.user_id = v_uid;

  insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source, payload)
  select p_chat, v_uid, v_max + e.ord::integer, m.role, m.kind, m.text, m.source, m.payload
  from pg_catalog.jsonb_array_elements(p_messages) with ordinality as e(value, ord)
  cross join lateral pg_catalog.jsonb_to_record(e.value) as m(role text, kind text, text text, source text, payload jsonb);

  if p_proposal is not null then
    v_version := v_version + 1;
  end if;

  update public.plan_chats c
     set proposal         = coalesce(p_proposal, c.proposal),
         proposal_version = v_version,
         model_turns      = c.model_turns + coalesce(p_model_turns_increment, 0)
   where c.id = p_chat
     and c.user_id = v_uid;

  return v_version;
end;
$$;

revoke all on function public.app_plan_chat_append(uuid, jsonb, jsonb, integer)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_plan_chat_append(uuid, jsonb, jsonb, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. app_plan_chat_confirm (E34)
-- ---------------------------------------------------------------------------
-- Confirms the stored proposal in one transaction: checks the chat is open (QT003) and that
-- p_expected_proposal_version equals proposal_version (QT002); then creates the plan with
-- app_create_plan, or revises it with app_revise_plan when the chat has a plan_id; then marks
-- the chat `confirmed` (closed_at set). Returns the plan id. The plan values come from the
-- stored proposal (editionId, targetScope, paths, order, sessionMinutes, preferredDate,
-- estimate -> agreed_estimate); the rest comes from p_plan_args:
--   reason_code, policy_json?, effective_learning_date, phases (array, as app_create_plan),
--   sessions? and plan_id? (creation only), expected_version? (revision only; default: the
--   plan's current version).
-- A chat without a proposal raises QT003. Any failing step rolls the whole call back, so a
-- chat is never closed without its plan.

create function public.app_plan_chat_confirm(
  p_chat                      uuid,
  p_expected_proposal_version integer,
  p_plan_args                 jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_status   text;
  v_plan     uuid;
  v_proposal jsonb;
  v_version  integer;
  v_paths    text[];
  v_scope    jsonb;
  v_minutes  smallint;
  v_pref     date;
  v_order    text;
  v_estimate jsonb;
  v_expected integer;
  v_result   uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if pg_catalog.jsonb_typeof(p_plan_args) is distinct from 'object'
     or pg_catalog.jsonb_typeof(p_plan_args -> 'phases') is distinct from 'array' then
    raise exception 'p_plan_args must be an object holding a phases array'
      using errcode = 'invalid_parameter_value';
  end if;

  select c.status, c.plan_id, c.proposal, c.proposal_version
    into v_status, v_plan, v_proposal, v_version
  from public.plan_chats c
  where c.id = p_chat
    and c.user_id = v_uid
  for update;

  if not found then
    raise exception 'chat_not_found' using errcode = 'no_data_found';
  end if;
  if v_status <> 'open' or v_proposal is null then
    raise exception 'invalid_state' using errcode = 'QT003';
  end if;
  if v_version is distinct from p_expected_proposal_version then
    raise exception 'version_conflict' using errcode = 'QT002';
  end if;

  v_scope    := v_proposal -> 'targetScope';
  v_order    := v_proposal ->> 'order';
  v_minutes  := (v_proposal ->> 'sessionMinutes')::smallint;
  v_pref     := (v_proposal ->> 'preferredDate')::date;
  v_estimate := v_proposal -> 'estimate';
  select coalesce(array_agg(t.value order by t.ord), '{}'::text[]) into v_paths
  from pg_catalog.jsonb_array_elements_text(v_proposal -> 'paths') with ordinality as t(value, ord);

  if v_plan is null then
    v_result := public.app_create_plan(
      (v_proposal ->> 'editionId')::uuid, v_scope, v_paths, v_order, v_minutes, v_pref, v_estimate,
      p_plan_args ->> 'reason_code', coalesce(p_plan_args -> 'policy_json', '{}'::jsonb),
      (p_plan_args ->> 'effective_learning_date')::date, p_plan_args -> 'phases',
      p_plan_args -> 'sessions', (p_plan_args ->> 'plan_id')::uuid);
  else
    v_expected := coalesce(
      (p_plan_args ->> 'expected_version')::integer,
      (select mp.current_version from public.master_plans mp where mp.id = v_plan and mp.user_id = v_uid));
    perform public.app_revise_plan(
      v_plan, v_expected, v_scope, v_paths, v_order, v_minutes, v_pref, v_estimate,
      p_plan_args ->> 'reason_code', coalesce(p_plan_args -> 'policy_json', '{}'::jsonb),
      (p_plan_args ->> 'effective_learning_date')::date, p_plan_args -> 'phases');
    v_result := v_plan;
  end if;

  update public.plan_chats c
     set status = 'confirmed',
         closed_at = pg_catalog.now()
   where c.id = p_chat
     and c.user_id = v_uid;

  return v_result;
end;
$$;

revoke all on function public.app_plan_chat_confirm(uuid, integer, jsonb)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_plan_chat_confirm(uuid, integer, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. srv_delete_personal_rows (§12.1): the same signature, now including the two chat tables
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps the owner and the grants of 0005 (EXECUTE for qatra_server only);
-- they are stated again so the file is self-explanatory.

create or replace function public.srv_delete_personal_rows(p_user_id uuid, p_username_throttle_key_hash bytea)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- the list of §12.1, children first; content and ai_usage are untouched. The Auth user is
  -- deleted afterwards through the Admin API; every table also cascades from auth.users.
  -- (content_feedback joins this list when the conditional migration creates it.)
  delete from public.plan_chat_messages          where user_id = p_user_id;
  delete from public.plan_chats                  where user_id = p_user_id;
  delete from public.target_part_evidence        where user_id = p_user_id;
  delete from public.target_mastery              where user_id = p_user_id;
  delete from public.daily_completions           where user_id = p_user_id;
  delete from public.daily_progress              where user_id = p_user_id;
  delete from public.session_activity_intervals  where user_id = p_user_id;
  delete from public.attempts                    where user_id = p_user_id;
  delete from public.learning_sessions           where user_id = p_user_id;
  delete from public.offline_snapshots           where user_id = p_user_id;
  delete from public.plan_phases                 where user_id = p_user_id;
  delete from public.plan_versions               where user_id = p_user_id;
  delete from public.master_plans                where user_id = p_user_id;
  delete from public.profiles                    where user_id = p_user_id;
  delete from private.app_sessions               where user_id = p_user_id;
  delete from private.password_reset_grants      where user_id = p_user_id;
  delete from private.recovery_codes             where user_id = p_user_id;
  delete from private.account_handles            where user_id = p_user_id;

  -- the throttle rows of the account's username key; IP-prefix rows are not linked to the
  -- account and expire by the 24-hour purge
  if p_username_throttle_key_hash is not null then
    delete from private.auth_throttle where key_hash = p_username_throttle_key_hash;
  end if;
end;
$$;

revoke all on function public.srv_delete_personal_rows(uuid, bytea) from public, anon, authenticated, service_role;
grant execute on function public.srv_delete_personal_rows(uuid, bytea) to qatra_server;
