-- 0005_rls_functions
--
-- Access boundary of the Qatra database: row level security policies, grants, the two
-- catalog views, the 19 `srv_*` SECURITY DEFINER functions and the six `app_*` learner
-- commit functions.
--
-- Source: docs/Database-schema.md v1.1 (approved by the owner, D74, 4 October 2026):
-- §4.5 RLS predicate catalogue, §5 roles, grant posture and access matrix, §7 catalog
-- views, §8 functions (8.1 common rules, 8.2 the 19 `srv_*`, 8.3 the six `app_*`, A-01),
-- §9 storage (no `storage.objects` policy for `sources`), §11 migration plan
-- `0005_rls_functions`, §12.2 throttle purge (A-03), §12.3 redaction (A-04).
--
-- Scope notes
--   * Every policy is named `<table>__<role>__<operation>` and uses `(select auth.uid())`.
--     Only `authenticated` receives policies. `service_role` bypasses RLS (a role
--     attribute) and `anon` reads only the two views.
--   * `qatra_server` (created in 0002) receives `USAGE` on schema `public` and `EXECUTE`
--     on `srv_*` items 1-18 only. `service_role` receives `EXECUTE` on item 19
--     (`srv_redact_revoked_content`) only. `authenticated` receives `EXECUTE` on the six
--     `app_*` functions only.
--   * Error signalling of the functions. Standard SQLSTATEs are used where one fits
--     (`unique_violation`, `check_violation`, `no_data_found`, `invalid_parameter_value`,
--     `insufficient_privilege`). Four Qatra-specific SQLSTATEs (class QT) carry the rest;
--     the message is the machine code and never contains a fingerprint or a secret:
--         QT001  epoch_mismatch      (srv_create_app_session: epoch is not current)
--         QT002  version_conflict    (app_*: plan version is not the one in force)
--         QT003  invalid_state       (srv_recovery_consume: grant not executing;
--                                     srv_redact_revoked_content: edition not revoked)
--                plan_not_active     (the same SQLSTATE; app_revise_plan: the plan is completed;
--                                     the message tells the causes apart)
--         QT004  idempotency_input   (app_create_offline_snapshot: same operation id,
--                                     different input)
--   * The six `app_*` functions persist results already computed by the Python domain
--     policies. They hold integrity checks only (ownership, version in force,
--     idempotency); no mastery, time or planning rule lives here (§8.3).
--   * No seed rows. Nothing here is applied to any Supabase project by this file's
--     existence.

-- ---------------------------------------------------------------------------
-- 1. Default function privileges closed (§5.2 item 6)
-- ---------------------------------------------------------------------------

-- Reverses the platform's per-schema default EXECUTE grants for the migration owner's new
-- functions in `public`. The built-in default EXECUTE for PUBLIC cannot be removed per
-- schema, so every function below also revokes EXECUTE from PUBLIC explicitly.
alter default privileges in schema public
  revoke execute on functions from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Row level security policies (§4.5, §5.3)
-- ---------------------------------------------------------------------------
-- Content tables approved_source_rules, unit_embeddings and content_jobs carry no policy
-- (default deny for every learner role). Private tables carry no policy at all.

-- 2.1 Published content, read by `authenticated` ------------------------------

-- P-CAT: a book of the category has a published or superseded edition (A-02)
create policy "categories__authenticated__select" on public.categories
  for select to authenticated
  using (exists (
    select 1
    from public.books b
    join public.book_editions e on e.book_id = b.id
    where b.category_id = categories.id
      and e.status in ('published', 'superseded')));

-- P-SRC: a published or superseded edition uses the source
create policy "sources__authenticated__select" on public.sources
  for select to authenticated
  using (exists (
    select 1
    from public.book_editions e
    where e.source_id = sources.id
      and e.status in ('published', 'superseded')));

-- P-BOOK: a published or superseded edition of the book exists
create policy "books__authenticated__select" on public.books
  for select to authenticated
  using (exists (
    select 1
    from public.book_editions e
    where e.book_id = books.id
      and e.status in ('published', 'superseded')));

-- P-ED: published or superseded (catalog hiding and archiving do not apply here, D44)
create policy "book_editions__authenticated__select" on public.book_editions
  for select to authenticated
  using (status in ('published', 'superseded'));

-- P-PUB-CHILD: the edition row of the child is published or superseded
create policy "edition_pages__authenticated__select" on public.edition_pages
  for select to authenticated
  using (exists (
    select 1 from public.book_editions e
    where e.id = edition_pages.edition_id
      and e.status in ('published', 'superseded')));

create policy "book_sections__authenticated__select" on public.book_sections
  for select to authenticated
  using (exists (
    select 1 from public.book_editions e
    where e.id = book_sections.edition_id
      and e.status in ('published', 'superseded')));

create policy "units__authenticated__select" on public.units
  for select to authenticated
  using (exists (
    select 1 from public.book_editions e
    where e.id = units.edition_id
      and e.status in ('published', 'superseded')));

create policy "unit_page_spans__authenticated__select" on public.unit_page_spans
  for select to authenticated
  using (exists (
    select 1 from public.book_editions e
    where e.id = unit_page_spans.edition_id
      and e.status in ('published', 'superseded')));

-- P-PUB-BANK: P-PUB-CHILD and the bank version equals the edition's bank version (A-02)
create policy "passages__authenticated__select" on public.passages
  for select to authenticated
  using (exists (
    select 1 from public.book_editions e
    where e.id = passages.edition_id
      and e.status in ('published', 'superseded')
      and e.bank_version = passages.bank_version));

-- P-VIA-PARENT: a visible parent row exists; the parent's own policy applies inside
create policy "passage_parts__authenticated__select" on public.passage_parts
  for select to authenticated
  using (exists (
    select 1 from public.passages p
    where p.id = passage_parts.passage_id));

-- P-PUB-ITEM: P-PUB-BANK and the item itself is published
create policy "lessons__authenticated__select" on public.lessons
  for select to authenticated
  using (
    status = 'published'
    and exists (
      select 1 from public.book_editions e
      where e.id = lessons.edition_id
        and e.status in ('published', 'superseded')
        and e.bank_version = lessons.bank_version));

create policy "lesson_units__authenticated__select" on public.lesson_units
  for select to authenticated
  using (exists (
    select 1 from public.lessons l
    where l.id = lesson_units.lesson_id));

create policy "question_items__authenticated__select" on public.question_items
  for select to authenticated
  using (
    status = 'published'
    and exists (
      select 1 from public.book_editions e
      where e.id = question_items.edition_id
        and e.status in ('published', 'superseded')
        and e.bank_version = question_items.bank_version));

-- P-TPL
create policy "generic_plan_templates__authenticated__select" on public.generic_plan_templates
  for select to authenticated
  using (status = 'published');

-- 2.2 Personal rows (P-OWN), read and written by `authenticated` ---------------

-- profiles: select and update own row (no insert, no delete)
create policy "profiles__authenticated__select" on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "profiles__authenticated__update" on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- master_plans: select, insert, update
create policy "master_plans__authenticated__select" on public.master_plans
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "master_plans__authenticated__insert" on public.master_plans
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "master_plans__authenticated__update" on public.master_plans
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- plan_versions: select, insert (append-only)
create policy "plan_versions__authenticated__select" on public.plan_versions
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "plan_versions__authenticated__insert" on public.plan_versions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- plan_phases: select, insert (append-only)
create policy "plan_phases__authenticated__select" on public.plan_phases
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "plan_phases__authenticated__insert" on public.plan_phases
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- offline_snapshots: select, insert
create policy "offline_snapshots__authenticated__select" on public.offline_snapshots
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "offline_snapshots__authenticated__insert" on public.offline_snapshots
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- learning_sessions: select, insert, update
create policy "learning_sessions__authenticated__select" on public.learning_sessions
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "learning_sessions__authenticated__insert" on public.learning_sessions
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "learning_sessions__authenticated__update" on public.learning_sessions
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- attempts: select, insert
create policy "attempts__authenticated__select" on public.attempts
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "attempts__authenticated__insert" on public.attempts
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- session_activity_intervals: select, insert
create policy "session_activity_intervals__authenticated__select" on public.session_activity_intervals
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "session_activity_intervals__authenticated__insert" on public.session_activity_intervals
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- daily_progress: select, insert, update
create policy "daily_progress__authenticated__select" on public.daily_progress
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "daily_progress__authenticated__insert" on public.daily_progress
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "daily_progress__authenticated__update" on public.daily_progress
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- daily_completions: select, insert
create policy "daily_completions__authenticated__select" on public.daily_completions
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "daily_completions__authenticated__insert" on public.daily_completions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- target_mastery: select, insert, update
create policy "target_mastery__authenticated__select" on public.target_mastery
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "target_mastery__authenticated__insert" on public.target_mastery
  for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "target_mastery__authenticated__update" on public.target_mastery
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- target_part_evidence: select, insert
create policy "target_part_evidence__authenticated__select" on public.target_part_evidence
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy "target_part_evidence__authenticated__insert" on public.target_part_evidence
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Grants (§5.2, §5.3)
-- ---------------------------------------------------------------------------

-- Start from nothing on every table of 0001-0004 for anon and authenticated, then issue the
-- reviewed grants. (The earlier migrations already revoked; repeating it makes this file
-- the single readable statement of the final posture.)
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'approved_source_rules', 'sources', 'books', 'book_editions',
    'edition_pages', 'book_sections', 'units', 'unit_page_spans', 'passages',
    'passage_parts', 'lessons', 'lesson_units', 'question_items', 'unit_embeddings',
    'content_jobs', 'generic_plan_templates',
    'profiles', 'master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots',
    'learning_sessions', 'attempts', 'session_activity_intervals', 'daily_progress',
    'daily_completions', 'target_mastery', 'target_part_evidence', 'ai_usage'
  ] loop
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end;
$$;

-- 3.1 service_role: select, insert, update, delete on the 17 content tables (publishing
-- scope); truncate, references, trigger (and any other privilege) revoked there.
do $$
declare
  t text;
begin
  foreach t in array array[
    'categories', 'approved_source_rules', 'sources', 'books', 'book_editions',
    'edition_pages', 'book_sections', 'units', 'unit_page_spans', 'passages',
    'passage_parts', 'lessons', 'lesson_units', 'question_items', 'unit_embeddings',
    'content_jobs', 'generic_plan_templates'
  ] loop
    execute format('revoke all on table public.%I from service_role', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end;
$$;

-- 3.2 service_role: nothing on private and personal tables
revoke all on table
  private.account_handles, private.password_reset_grants, private.recovery_codes,
  private.app_sessions, private.auth_throttle,
  public.profiles, public.master_plans, public.plan_versions, public.plan_phases,
  public.offline_snapshots, public.learning_sessions, public.attempts,
  public.session_activity_intervals, public.daily_progress, public.daily_completions,
  public.target_mastery, public.target_part_evidence, public.ai_usage
from service_role;

-- 3.3 authenticated: read grants on published content (the policies decide the rows)
grant select on table
  public.categories, public.books, public.edition_pages, public.book_sections,
  public.units, public.unit_page_spans, public.passages, public.passage_parts,
  public.lessons, public.lesson_units, public.question_items,
  public.generic_plan_templates
to authenticated;

-- every column of book_editions except raw_storage_path and review_record
grant select (
  id, book_id, source_id, edition_key, edition_label, language, version, bank_version,
  content_hash, pagination_record, status, catalog_hidden, archived_at, created_at, updated_at
) on table public.book_editions to authenticated;

-- eligibility and licence records stay internal
grant select (id, title, provider, source_url) on table public.sources to authenticated;

-- 3.4 authenticated: personal tables (no DELETE anywhere, no grant on ai_usage,
-- unit_embeddings, content_jobs, approved_source_rules or any private table)
grant select on table
  public.profiles, public.master_plans, public.plan_versions, public.plan_phases,
  public.offline_snapshots, public.learning_sessions, public.attempts,
  public.session_activity_intervals, public.daily_progress, public.daily_completions,
  public.target_mastery, public.target_part_evidence
to authenticated;

-- append-only rows: INSERT only
grant insert on table
  public.plan_versions, public.plan_phases, public.attempts,
  public.session_activity_intervals, public.daily_completions,
  public.target_part_evidence, public.offline_snapshots
to authenticated;

-- INSERT and column-limited UPDATE
grant insert on table
  public.master_plans, public.learning_sessions, public.daily_progress, public.target_mastery
to authenticated;

grant update (target_scope, paths, plan_order, session_minutes, preferred_date,
              agreed_estimate, current_version, status, updated_at)
  on table public.master_plans to authenticated;
grant update (status, elapsed_ms) on table public.learning_sessions to authenticated;
grant update (active_ms, goal_ms) on table public.daily_progress to authenticated;
grant update (status, consecutive_correct, initial_success_at, initial_learning_date,
              review_stage, next_review_due, last_review_date, confirmed_at,
              first_confirmed_at, maintenance_stage, lapse_count, error_part_ids)
  on table public.target_mastery to authenticated;

-- column-limited UPDATE only, no INSERT: profiles
-- (terms_version, terms_accepted_at and is_demo are never writable by the learner)
grant update (language, time_zone, session_minutes, reminder_settings, pending_settings)
  on table public.profiles to authenticated;

-- 3.5 qatra_server: USAGE on schema public (to call the functions) and nothing else here
grant usage on schema public to qatra_server;

-- ---------------------------------------------------------------------------
-- 4. Catalog views: the only anonymous surface (§7, D71)
-- ---------------------------------------------------------------------------
-- Owned by the migration owner and run with the owner's rights (not security_invoker), so
-- they can aggregate `passages`, which `anon` never touches. The view definition is the
-- access control; security_barrier is a proposed hardening. This is a deliberate,
-- documented exception to the Supabase advisor's warning about definer views.
-- Row filter: published, not hidden, not archived. Metadata only: no text, token, unit,
-- lesson, question, source_url, raw_storage_path, content_hash, review_record,
-- pagination_record or source record.

create view public.catalog_editions
with (security_barrier = true)
as
select
  e.id                                         as edition_id,
  e.edition_key                                as edition_key,
  e.edition_label                              as edition_label,
  e.language                                   as language,
  e.bank_version                               as catalog_version,
  b.title_ar                                   as book_title_ar,
  b.title_en                                   as book_title_en,
  b.author                                     as author,
  b.content_format                             as content_format,
  c.slug                                       as category_slug,
  c.label_ar                                   as category_label_ar,
  c.label_en                                   as category_label_en,
  coalesce(agg.available_paths, array[]::text[])        as available_paths,
  coalesce(agg.path_word_counts, '{}'::jsonb)           as path_word_counts,
  coalesce(agg.path_passage_counts, '{}'::jsonb)        as path_passage_counts
from public.book_editions e
join public.books b on b.id = e.book_id
join public.categories c on c.id = b.category_id
left join lateral (
  select
    array_agg(x.path order by x.path)                    as available_paths,
    jsonb_object_agg(x.path, x.words)                    as path_word_counts,
    jsonb_object_agg(x.path, x.passages)                 as path_passage_counts
  from (
    select p.path, sum(p.word_count)::bigint as words, count(*)::bigint as passages
    from public.passages p
    where p.edition_id = e.id
      and p.bank_version = e.bank_version
    group by p.path
  ) x
) agg on true
where e.status = 'published'
  and e.catalog_hidden = false
  and e.archived_at is null;

comment on view public.catalog_editions is 'Anonymous catalog metadata of published, visible editions (D71); never text, units, lessons or questions.';

create view public.catalog_sections
with (security_barrier = true)
as
select
  e.id            as edition_id,
  s.id            as section_id,
  s.ordinal       as ordinal,
  s.kind          as kind,
  s.reference     as reference,
  s.title_ar      as title_ar,
  s.title_en      as title_en,
  coalesce(agg.available_paths, array[]::text[])  as available_paths,
  coalesce(agg.path_stats, '{}'::jsonb)           as path_stats
from public.book_editions e
join public.book_sections s on s.edition_id = e.id
left join lateral (
  select
    array_agg(x.path order by x.path)                                              as available_paths,
    jsonb_object_agg(x.path, jsonb_build_object('words', x.words, 'passages', x.passages)) as path_stats
  from (
    select p.path, sum(p.word_count)::bigint as words, count(*)::bigint as passages
    from public.passages p
    where p.section_id = s.id
      and p.edition_id = e.id
      and p.bank_version = e.bank_version
    group by p.path
  ) x
) agg on true
where e.status = 'published'
  and e.catalog_hidden = false
  and e.archived_at is null;

comment on view public.catalog_sections is 'Anonymous catalog sections with per-path counts for published, visible editions (D71).';

revoke all on table public.catalog_editions, public.catalog_sections
  from public, anon, authenticated, service_role;
grant select on table public.catalog_editions, public.catalog_sections to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Helper for the redaction function (schema private, owner use only)
-- ---------------------------------------------------------------------------

-- Replaces the value of every text-bearing key with JSON null at any depth, keeping the
-- structure and every other value (ids, references, positions). The JSON shapes of
-- offline_snapshots.payload and learning_sessions.steps are only partly fixed
-- (Database-schema OPEN-04, API-spec NR), so the keys are a documented list that
-- follows the SessionSnapshot sample of API-spec E20: `text` (passage units, context
-- words, option words), `answerKey`, `correctRef`, `canonicalText`, `takhrij`, `grade`.
create function private.redact_json(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_result jsonb;
  v_key    text;
  v_item   jsonb;
begin
  case pg_catalog.jsonb_typeof(p_value)
    when 'object' then
      v_result := '{}'::jsonb;
      for v_key, v_item in select o.key, o.value from pg_catalog.jsonb_each(p_value) as o loop
        if v_key in ('text', 'answerKey', 'correctRef', 'canonicalText', 'takhrij', 'grade') then
          v_result := v_result || pg_catalog.jsonb_build_object(v_key, 'null'::jsonb);
        else
          v_result := v_result || pg_catalog.jsonb_build_object(v_key, private.redact_json(v_item));
        end if;
      end loop;
      return v_result;
    when 'array' then
      select coalesce(pg_catalog.jsonb_agg(private.redact_json(a.value) order by a.ord), '[]'::jsonb)
        into v_result
      from pg_catalog.jsonb_array_elements(p_value) with ordinality as a(value, ord);
      return v_result;
    else
      return p_value;
  end case;
end;
$$;

revoke all on function private.redact_json(jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The 19 srv_* functions (§8.2): SECURITY DEFINER, search_path = '', owner = migration owner
-- ---------------------------------------------------------------------------
-- Items 1-18: EXECUTE for qatra_server only. Item 19: EXECUTE for service_role only.
-- Every function schema-qualifies every object it uses; none uses dynamic SQL.

-- 6.1 srv_find_handle (1) ----------------------------------------------------

create function public.srv_find_handle(p_username_normalized text)
returns table (
  user_id             uuid,
  username_display    text,
  internal_auth_alias text,
  auth_epoch          integer,
  is_demo             boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select h.user_id, h.username_display, h.internal_auth_alias, h.auth_epoch, h.is_demo
  from private.account_handles h
  where h.username_normalized = p_username_normalized
$$;

revoke all on function public.srv_find_handle(text) from public, anon, authenticated, service_role;
grant execute on function public.srv_find_handle(text) to qatra_server;

-- 6.2 srv_register_account (2) ----------------------------------------------

create function public.srv_register_account(
  p_user_id              uuid,
  p_username_display     text,
  p_username_normalized  text,
  p_internal_auth_alias  text,
  p_is_demo              boolean,
  p_terms_version        text,
  p_language             text,
  p_time_zone            text,
  p_recovery_code_hash   bytea
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- One transaction: handle, profile (terms accepted at server time) and the first active
  -- recovery code. A duplicate username or alias raises unique_violation; an invalid value
  -- raises check_violation; no partial rows remain.
  insert into private.account_handles
    (user_id, username_display, username_normalized, internal_auth_alias, is_demo)
  values
    (p_user_id, p_username_display, p_username_normalized, p_internal_auth_alias, p_is_demo);

  insert into public.profiles
    (user_id, language, time_zone, terms_version, terms_accepted_at, is_demo)
  values
    (p_user_id, p_language, p_time_zone, p_terms_version, pg_catalog.now(), p_is_demo);

  insert into private.recovery_codes (user_id, code_hash)
  values (p_user_id, p_recovery_code_hash);
end;
$$;

revoke all on function public.srv_register_account(uuid, text, text, text, boolean, text, text, text, bytea)
  from public, anon, authenticated, service_role;
grant execute on function public.srv_register_account(uuid, text, text, text, boolean, text, text, text, bytea)
  to qatra_server;

-- 6.3 srv_accept_terms (3) ---------------------------------------------------

create function public.srv_accept_terms(p_user_id uuid, p_terms_version text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_accepted_at timestamptz;
begin
  update public.profiles p
     set terms_version     = p_terms_version,
         terms_accepted_at = pg_catalog.now()
   where p.user_id = p_user_id
  returning p.terms_accepted_at into v_accepted_at;

  if not found then
    raise exception 'profile_not_found' using errcode = 'no_data_found';
  end if;

  return v_accepted_at;
end;
$$;

revoke all on function public.srv_accept_terms(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.srv_accept_terms(uuid, text) to qatra_server;

-- 6.4 srv_recovery_active_code (4) -------------------------------------------

create function public.srv_recovery_active_code(p_user_id uuid)
returns table (code_id uuid, code_hash bytea)
language sql
stable
security definer
set search_path = ''
as $$
  -- the single active code: not consumed and not under an unexpired reservation
  select c.id, c.code_hash
  from private.recovery_codes c
  where c.user_id = p_user_id
    and c.consumed_at is null
    and (c.reserved_grant_id is null or c.reserved_until <= pg_catalog.now())
$$;

revoke all on function public.srv_recovery_active_code(uuid) from public, anon, authenticated, service_role;
grant execute on function public.srv_recovery_active_code(uuid) to qatra_server;

-- 6.5 srv_recovery_reserve (5) -----------------------------------------------

create function public.srv_recovery_reserve(
  p_user_id           uuid,
  p_code_id           uuid,
  p_grant_id          uuid,
  p_grant_hash        bytea,
  p_grant_expires_at  timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reserved_grant_id uuid;
  v_reserved_until    timestamptz;
  v_constraint        text;
begin
  -- Row lock on the code: of two parallel requests one waits and then sees the reservation.
  select c.reserved_grant_id, c.reserved_until
    into v_reserved_grant_id, v_reserved_until
  from private.recovery_codes c
  where c.id = p_code_id
    and c.user_id = p_user_id
    and c.consumed_at is null
  for update;

  if not found then
    return false;
  end if;

  -- An unexpired reservation is held by someone else.
  if v_reserved_grant_id is not null and v_reserved_until > pg_catalog.now() then
    return false;
  end if;

  -- A grant that expired before it was executed releases its slot (an expired grant that is
  -- already `executing` stays: an uncertain outcome is reviewed before release, step 5).
  update private.password_reset_grants g
     set status = 'cancelled'
   where g.user_id = p_user_id
     and g.status = 'active'
     and g.expires_at <= pg_catalog.now();

  begin
    insert into private.password_reset_grants (id, user_id, grant_hash, expires_at, status)
    values (p_grant_id, p_user_id, p_grant_hash, p_grant_expires_at, 'active');
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    -- only the one-live-grant rule means "another grant is live"; anything else is a defect
    if v_constraint = 'password_reset_grants_user_id_live_key' then
      return false;
    end if;
    raise;
  end;

  update private.recovery_codes c
     set reserved_grant_id = p_grant_id,
         reserved_until    = p_grant_expires_at
   where c.id = p_code_id;

  return true;
end;
$$;

revoke all on function public.srv_recovery_reserve(uuid, uuid, uuid, bytea, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.srv_recovery_reserve(uuid, uuid, uuid, bytea, timestamptz)
  to qatra_server;

-- 6.6 srv_recovery_begin (6) -------------------------------------------------

create function public.srv_recovery_begin(p_grant_hash bytea)
returns table (grant_id uuid, user_id uuid)
language sql
security definer
set search_path = ''
as $$
  -- one conditional update: of two parallel requests exactly one gets the row
  update private.password_reset_grants g
     set status = 'executing'
   where g.grant_hash = p_grant_hash
     and g.status = 'active'
     and g.expires_at > pg_catalog.now()
  returning g.id, g.user_id
$$;

revoke all on function public.srv_recovery_begin(bytea) from public, anon, authenticated, service_role;
grant execute on function public.srv_recovery_begin(bytea) to qatra_server;

-- 6.7 srv_recovery_release (7) -----------------------------------------------

create function public.srv_recovery_release(p_grant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.password_reset_grants g
     set status = 'cancelled'
   where g.id = p_grant_id
     and g.status in ('active', 'executing');

  update private.recovery_codes c
     set reserved_grant_id = null,
         reserved_until    = null
   where c.reserved_grant_id = p_grant_id
     and c.consumed_at is null;
end;
$$;

revoke all on function public.srv_recovery_release(uuid) from public, anon, authenticated, service_role;
grant execute on function public.srv_recovery_release(uuid) to qatra_server;

-- 6.8 srv_recovery_consume (8) -----------------------------------------------

create function public.srv_recovery_consume(p_grant_id uuid, p_new_code_hash bytea)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_epoch   integer;
begin
  -- only for an `executing` grant; the lock makes a second consume wait and then fail
  select g.user_id into v_user_id
  from private.password_reset_grants g
  where g.id = p_grant_id
    and g.status = 'executing'
  for update;

  if not found then
    raise exception 'invalid_state' using errcode = 'QT003';
  end if;

  -- the reserved code is consumed (the account has exactly one active code, and it is the
  -- reserved one unless a rotation replaced it meanwhile; either way it is consumed now)
  update private.recovery_codes c
     set consumed_at = pg_catalog.now()
   where c.user_id = v_user_id
     and c.consumed_at is null;

  update private.password_reset_grants g
     set status = 'consumed'
   where g.id = p_grant_id;

  insert into private.recovery_codes (user_id, code_hash)
  values (v_user_id, p_new_code_hash);

  update private.account_handles h
     set auth_epoch = h.auth_epoch + 1
   where h.user_id = v_user_id
  returning h.auth_epoch into v_epoch;

  if not found then
    raise exception 'account_not_found' using errcode = 'no_data_found';
  end if;

  update private.app_sessions s
     set revoked_at = pg_catalog.now()
   where s.user_id = v_user_id
     and s.revoked_at is null;

  return v_epoch;
end;
$$;

revoke all on function public.srv_recovery_consume(uuid, bytea) from public, anon, authenticated, service_role;
grant execute on function public.srv_recovery_consume(uuid, bytea) to qatra_server;

-- 6.9 srv_recovery_rotate (9) ------------------------------------------------

create function public.srv_recovery_rotate(p_user_id uuid, p_new_code_hash bytea)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.recovery_codes c
     set consumed_at = pg_catalog.now()
   where c.user_id = p_user_id
     and c.consumed_at is null;

  insert into private.recovery_codes (user_id, code_hash)
  values (p_user_id, p_new_code_hash);

  -- a grant that was only reserved against the replaced code has nothing left to reset
  update private.password_reset_grants g
     set status = 'cancelled'
   where g.user_id = p_user_id
     and g.status = 'active';
end;
$$;

revoke all on function public.srv_recovery_rotate(uuid, bytea) from public, anon, authenticated, service_role;
grant execute on function public.srv_recovery_rotate(uuid, bytea) to qatra_server;

-- 6.10 srv_create_app_session (10) -------------------------------------------

create function public.srv_create_app_session(
  p_user_id               uuid,
  p_session_hash          bytea,
  p_encrypted_auth_tokens bytea,
  p_auth_epoch            integer,
  p_expires_at            timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_epoch integer;
  v_id    uuid;
begin
  -- FOR SHARE: a concurrent epoch bump waits until this session is committed, and then
  -- revokes it together with the others.
  select h.auth_epoch into v_epoch
  from private.account_handles h
  where h.user_id = p_user_id
  for share;

  if not found or v_epoch <> p_auth_epoch then
    raise exception 'epoch_mismatch' using errcode = 'QT001';
  end if;

  insert into private.app_sessions
    (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at)
  values
    (p_user_id, p_session_hash, p_auth_epoch, p_encrypted_auth_tokens, p_expires_at)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.srv_create_app_session(uuid, bytea, bytea, integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.srv_create_app_session(uuid, bytea, bytea, integer, timestamptz)
  to qatra_server;

-- 6.11 srv_read_app_session (11) ---------------------------------------------

create function public.srv_read_app_session(p_session_hash bytea)
returns table (
  session_id            uuid,
  user_id               uuid,
  username_display      text,
  internal_auth_alias   text,
  auth_epoch            integer,
  encrypted_auth_tokens bytea,
  expires_at            timestamptz,
  is_demo               boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  -- zero rows unless the session is not revoked, not expired and its epoch is current
  select s.id, s.user_id, h.username_display, h.internal_auth_alias, s.auth_epoch,
         s.encrypted_auth_tokens, s.expires_at, h.is_demo
  from private.app_sessions s
  join private.account_handles h on h.user_id = s.user_id
  where s.session_hash = p_session_hash
    and s.revoked_at is null
    and s.expires_at > pg_catalog.now()
    and s.auth_epoch = h.auth_epoch
$$;

revoke all on function public.srv_read_app_session(bytea) from public, anon, authenticated, service_role;
grant execute on function public.srv_read_app_session(bytea) to qatra_server;

-- 6.12 srv_update_app_session_tokens (12) ------------------------------------

create function public.srv_update_app_session_tokens(p_session_id uuid, p_encrypted_auth_tokens bytea)
returns void
language sql
security definer
set search_path = ''
as $$
  -- a live session only (not revoked, not expired, current epoch); quiet otherwise
  update private.app_sessions s
     set encrypted_auth_tokens = p_encrypted_auth_tokens
   where s.id = p_session_id
     and s.revoked_at is null
     and s.expires_at > pg_catalog.now()
     and s.auth_epoch = (
       select h.auth_epoch from private.account_handles h where h.user_id = s.user_id
     )
$$;

revoke all on function public.srv_update_app_session_tokens(uuid, bytea)
  from public, anon, authenticated, service_role;
grant execute on function public.srv_update_app_session_tokens(uuid, bytea) to qatra_server;

-- 6.13 srv_revoke_app_session (13) -------------------------------------------

create function public.srv_revoke_app_session(p_session_hash bytea)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.app_sessions s
     set revoked_at = pg_catalog.now()
   where s.session_hash = p_session_hash
     and s.revoked_at is null
$$;

revoke all on function public.srv_revoke_app_session(bytea) from public, anon, authenticated, service_role;
grant execute on function public.srv_revoke_app_session(bytea) to qatra_server;

-- 6.14 srv_bump_auth_epoch (14) ----------------------------------------------

create function public.srv_bump_auth_epoch(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_epoch integer;
begin
  update private.account_handles h
     set auth_epoch = h.auth_epoch + 1
   where h.user_id = p_user_id
  returning h.auth_epoch into v_epoch;

  if not found then
    raise exception 'account_not_found' using errcode = 'no_data_found';
  end if;

  -- every app session of the account, including the caller's; the backend then creates a
  -- fresh session bound to the new epoch (C-02)
  update private.app_sessions s
     set revoked_at = pg_catalog.now()
   where s.user_id = p_user_id
     and s.revoked_at is null;

  return v_epoch;
end;
$$;

revoke all on function public.srv_bump_auth_epoch(uuid) from public, anon, authenticated, service_role;
grant execute on function public.srv_bump_auth_epoch(uuid) to qatra_server;

-- 6.15 srv_throttle_check (15) -----------------------------------------------

create function public.srv_throttle_check(p_key_hashes bytea[])
returns table (key_hash bytea, attempts integer)
language sql
stable
security definer
set search_path = ''
as $$
  -- attempts per key summed over the trailing 15 one-minute buckets: the current bucket and
  -- the 14 before it (A-03); a key without buckets answers 0
  select k.key_hash, coalesce(sum(t.attempts), 0)::integer
  from (
    select distinct u.k as key_hash
    from pg_catalog.unnest(p_key_hashes) as u(k)
    where u.k is not null
  ) k
  left join private.auth_throttle t
    on t.key_hash = k.key_hash
   and t.window_start > pg_catalog.date_trunc('minute', pg_catalog.now()) - interval '15 minutes'
  group by k.key_hash
$$;

revoke all on function public.srv_throttle_check(bytea[]) from public, anon, authenticated, service_role;
grant execute on function public.srv_throttle_check(bytea[]) to qatra_server;

-- 6.16 srv_throttle_record (16) ----------------------------------------------

create function public.srv_throttle_record(p_key_hashes bytea[], p_outcome text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_outcome = 'failure' then
    -- one-minute bucket of each key
    insert into private.auth_throttle (key_hash, window_start, attempts)
    select distinct u.k, pg_catalog.date_trunc('minute', pg_catalog.now()), 1
    from pg_catalog.unnest(p_key_hashes) as u(k)
    where u.k is not null
    on conflict (key_hash, window_start)
    do update set attempts = private.auth_throttle.attempts + 1;
  elsif p_outcome = 'success' then
    -- a successful login clears every bucket of the given keys (A-03)
    delete from private.auth_throttle t
    where t.key_hash = any (p_key_hashes);
  else
    raise exception 'p_outcome must be failure or success'
      using errcode = 'invalid_parameter_value';
  end if;

  -- opportunistic, bounded purge: at most 100 rows older than 24 hours per call (A-03, §12.2)
  delete from private.auth_throttle t
  where t.ctid in (
    select o.ctid
    from private.auth_throttle o
    where o.window_start < pg_catalog.now() - interval '24 hours'
    limit 100
  );
end;
$$;

revoke all on function public.srv_throttle_record(bytea[], text) from public, anon, authenticated, service_role;
grant execute on function public.srv_throttle_record(bytea[], text) to qatra_server;

-- 6.17 srv_delete_personal_rows (17) -----------------------------------------

create function public.srv_delete_personal_rows(p_user_id uuid, p_username_throttle_key_hash bytea)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- the list of §12.1, children first; content and ai_usage are untouched. The Auth user is
  -- deleted afterwards through the Admin API; every table also cascades from auth.users.
  -- (content_feedback joins this list when the conditional migration creates it.)
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

-- 6.18 srv_record_ai_usage (18) ----------------------------------------------

create function public.srv_record_ai_usage(
  p_provider        text,
  p_model           text,
  p_prompt_version  text,
  p_input_tokens    integer,
  p_output_tokens   integer,
  p_cost_usd        numeric,
  p_status          text,
  p_quota_record    jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  -- null token and cost arguments stay null (unknown, never zero); no learner data
  insert into public.ai_usage
    (provider, model, prompt_version, input_tokens, output_tokens, cost_usd, status, quota_record)
  values
    (p_provider, p_model, p_prompt_version, p_input_tokens, p_output_tokens, p_cost_usd, p_status, p_quota_record)
$$;

revoke all on function public.srv_record_ai_usage(text, text, text, integer, integer, numeric, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.srv_record_ai_usage(text, text, text, integer, integer, numeric, text, jsonb)
  to qatra_server;

-- 6.19 srv_redact_revoked_content (19, A-04): EXECUTE for service_role ONLY ---

create function public.srv_redact_revoked_content(p_edition_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select e.status into v_status
  from public.book_editions e
  where e.id = p_edition_id;

  if not found then
    raise exception 'edition_not_found' using errcode = 'no_data_found';
  end if;

  -- guard decided by the coordinator on 4 October 2026: only a revoked edition
  if v_status <> 'revoked' then
    raise exception 'invalid_state' using errcode = 'QT003';
  end if;

  -- text fields and answer keys go; structure and ids stay; repeating it changes nothing
  update public.offline_snapshots o
     set payload = private.redact_json(o.payload)
   where o.edition_id = p_edition_id
     and o.payload is distinct from private.redact_json(o.payload);

  -- the only function that changes learning_sessions.steps after creation
  update public.learning_sessions s
     set steps = private.redact_json(s.steps)
   where s.edition_id = p_edition_id
     and s.steps is distinct from private.redact_json(s.steps);
end;
$$;

revoke all on function public.srv_redact_revoked_content(uuid) from public, anon, authenticated, service_role;
grant execute on function public.srv_redact_revoked_content(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. The six app_* learner commit functions (§8.3, A-01): SECURITY INVOKER
-- ---------------------------------------------------------------------------
-- They run with the learner's token, so RLS and the grants of section 3 stay in force. The
-- owner is `auth.uid()` of the token; `user_id` is never an argument. EXECUTE: authenticated
-- only. The jsonb arguments carry results the Python domain policies already computed.

-- 7.1 app_create_plan --------------------------------------------------------
-- Pauses the account's active plan; inserts master_plans (version 1 as current_version),
-- plan_versions (version 1) and plan_phases; optional prepared sessions. Returns the plan id.
--   p_phases   : array of {id?, ordinal, section_refs, unit_range, goal_size, estimated_window}
--   p_sessions : null, or array of {id?, kind, phase_ordinal?, learning_date, lesson_refs,
--                question_refs, steps, bank_version, status? ('prepared' by default)}
-- A race on the one-active-plan rule surfaces as unique_violation on
-- master_plans_user_id_active_key (E16: active_plan_conflict).

create function public.app_create_plan(
  p_edition_id              uuid,
  p_target_scope            jsonb,
  p_paths                   text[],
  p_plan_order              text,
  p_session_minutes         smallint,
  p_preferred_date          date,
  p_agreed_estimate         jsonb,
  p_reason_code             text,
  p_policy_json             jsonb,
  p_effective_learning_date date,
  p_phases                  jsonb,
  p_sessions                jsonb default null,
  p_plan_id                 uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_plan_id uuid := coalesce(p_plan_id, gen_random_uuid());
  v_version uuid := gen_random_uuid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  -- one active plan per account: the previous one is paused in the same transaction
  update public.master_plans mp
     set status = 'paused'
   where mp.user_id = v_uid
     and mp.status = 'active';

  -- current_version points at a row inserted next; the key is checked at commit (class G)
  insert into public.master_plans
    (id, user_id, edition_id, target_scope, paths, plan_order, session_minutes,
     preferred_date, agreed_estimate, current_version, status)
  values
    (v_plan_id, v_uid, p_edition_id, p_target_scope, p_paths, p_plan_order, p_session_minutes,
     p_preferred_date, p_agreed_estimate, 1, 'active');

  insert into public.plan_versions
    (id, plan_id, user_id, version_no, reason_code, policy_json, effective_learning_date)
  values
    (v_version, v_plan_id, v_uid, 1, p_reason_code, coalesce(p_policy_json, '{}'::jsonb),
     p_effective_learning_date);

  insert into public.plan_phases
    (id, plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
  select coalesce(x.id, gen_random_uuid()), v_version, v_uid, x.ordinal, x.section_refs,
         x.unit_range, x.goal_size, x.estimated_window
  from pg_catalog.jsonb_to_recordset(p_phases) as x(
    id uuid, ordinal integer, section_refs jsonb, unit_range jsonb, goal_size integer,
    estimated_window daterange);

  if p_sessions is not null then
    insert into public.learning_sessions
      (id, user_id, plan_id, plan_version_id, phase_id, edition_id, kind, learning_date,
       lesson_refs, question_refs, steps, bank_version, status)
    select coalesce(x.id, gen_random_uuid()), v_uid, v_plan_id, v_version,
           (select ph.id from public.plan_phases ph
             where ph.plan_version_id = v_version and ph.user_id = v_uid
               and ph.ordinal = x.phase_ordinal),
           p_edition_id, x.kind, x.learning_date,
           coalesce(x.lesson_refs, '{}'::uuid[]), coalesce(x.question_refs, '{}'::uuid[]),
           x.steps, x.bank_version, coalesce(x.status, 'prepared')
    from pg_catalog.jsonb_to_recordset(p_sessions) as x(
      id uuid, kind text, phase_ordinal integer, learning_date date, lesson_refs uuid[],
      question_refs uuid[], steps jsonb, bank_version integer, status text);
  end if;

  return v_plan_id;
end;
$$;

revoke all on function public.app_create_plan(
  uuid, jsonb, text[], text, smallint, date, jsonb, text, jsonb, date, jsonb, jsonb, uuid)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_create_plan(
  uuid, jsonb, text[], text, smallint, date, jsonb, text, jsonb, date, jsonb, jsonb, uuid)
  to authenticated;

-- 7.2 app_revise_plan --------------------------------------------------------
-- Locks the plan row first and tests it under that lock: an unknown or foreign plan raises
-- no_data_found; a completed plan raises QT003 (plan_not_active, API-spec E17); a version other
-- than the expected one raises QT002 (version_conflict). The status is tested before the
-- version, because retrying with the current version cannot help a completed plan. Nothing is
-- written before the tests pass, and the lock is held to the end of the transaction, so a
-- concurrent completion or revision cannot slip in between the tests and the write: it waits
-- and is then tested against the new row. Then it updates master_plans (the mirrored values of
-- the new latest version and current_version + 1; status unchanged) and appends plan_versions
-- and plan_phases. Returns the new version number. Of two simultaneous revisions with the same
-- expected version one wins (the other waits for the row lock, then fails the version test).

create function public.app_revise_plan(
  p_plan_id                 uuid,
  p_expected_version        integer,
  p_target_scope            jsonb,
  p_paths                   text[],
  p_plan_order              text,
  p_session_minutes         smallint,
  p_preferred_date          date,
  p_agreed_estimate         jsonb,
  p_reason_code             text,
  p_policy_json             jsonb,
  p_effective_learning_date date,
  p_phases                  jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_new     integer := p_expected_version + 1;
  v_version uuid := gen_random_uuid();
  v_status  text;
  v_current integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select mp.status, mp.current_version into v_status, v_current
  from public.master_plans mp
  where mp.id = p_plan_id
    and mp.user_id = v_uid
  for update;

  if not found then
    raise exception 'plan_not_found' using errcode = 'no_data_found';
  end if;
  if v_status = 'completed' then
    raise exception 'plan_not_active' using errcode = 'QT003';
  end if;
  if v_current is distinct from p_expected_version then
    raise exception 'version_conflict' using errcode = 'QT002';
  end if;

  update public.master_plans mp
     set target_scope    = p_target_scope,
         paths           = p_paths,
         plan_order      = p_plan_order,
         session_minutes = p_session_minutes,
         preferred_date  = p_preferred_date,
         agreed_estimate = p_agreed_estimate,
         current_version = v_new
   where mp.id = p_plan_id
     and mp.user_id = v_uid;

  insert into public.plan_versions
    (id, plan_id, user_id, version_no, reason_code, policy_json, effective_learning_date)
  values
    (v_version, p_plan_id, v_uid, v_new, p_reason_code, coalesce(p_policy_json, '{}'::jsonb),
     p_effective_learning_date);

  insert into public.plan_phases
    (id, plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
  select coalesce(x.id, gen_random_uuid()), v_version, v_uid, x.ordinal, x.section_refs,
         x.unit_range, x.goal_size, x.estimated_window
  from pg_catalog.jsonb_to_recordset(p_phases) as x(
    id uuid, ordinal integer, section_refs jsonb, unit_range jsonb, goal_size integer,
    estimated_window daterange);

  return v_new;
end;
$$;

revoke all on function public.app_revise_plan(
  uuid, integer, jsonb, text[], text, smallint, date, jsonb, text, jsonb, date, jsonb)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_revise_plan(
  uuid, integer, jsonb, text[], text, smallint, date, jsonb, text, jsonb, date, jsonb)
  to authenticated;

-- 7.3 app_open_session -------------------------------------------------------
-- Inserts an `open` learning session with its immutable steps snapshot. For kind = 'daily' it
-- is an atomic get-or-create guarded by the partial unique index of §6.3: when the insert
-- finds the daily session already there, the existing one is returned with created = false
-- (E20: 200); a new one is created = true (201). game and placement always create.
-- p_plan_version_id must be the version in force for p_plan_id (QT002 otherwise).

create function public.app_open_session(
  p_kind            text,
  p_plan_id         uuid,
  p_plan_version_id uuid,
  p_phase_id        uuid,
  p_edition_id      uuid,
  p_learning_date   date,
  p_lesson_refs     uuid[],
  p_question_refs   uuid[],
  p_steps           jsonb,
  p_bank_version    integer,
  p_self_rating     text default null,
  p_session_id      uuid default null
)
returns table (session_id uuid, created boolean)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid := null;
  v_try integer := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  if p_plan_id is not null then
    if not exists (
      select 1
      from public.master_plans mp
      join public.plan_versions pv on pv.plan_id = mp.id and pv.version_no = mp.current_version
      where mp.id = p_plan_id
        and mp.user_id = v_uid
        and pv.id = p_plan_version_id
    ) then
      if exists (select 1 from public.master_plans mp where mp.id = p_plan_id and mp.user_id = v_uid) then
        raise exception 'version_conflict' using errcode = 'QT002';
      end if;
      raise exception 'plan_not_found' using errcode = 'no_data_found';
    end if;
  end if;

  if p_kind = 'daily' then
    loop
      v_try := v_try + 1;

      insert into public.learning_sessions
        (id, user_id, plan_id, plan_version_id, phase_id, edition_id, kind, learning_date,
         lesson_refs, question_refs, steps, bank_version, self_rating, status)
      values
        (coalesce(p_session_id, gen_random_uuid()), v_uid, p_plan_id, p_plan_version_id,
         p_phase_id, p_edition_id, 'daily', p_learning_date,
         coalesce(p_lesson_refs, '{}'::uuid[]), coalesce(p_question_refs, '{}'::uuid[]),
         p_steps, p_bank_version, p_self_rating, 'open')
      on conflict (user_id, learning_date)
        where kind = 'daily' and status in ('prepared', 'open') and offline_snapshot_id is null
      do nothing
      returning id into v_id;

      if v_id is not null then
        return query select v_id, true;
        return;
      end if;

      select s.id into v_id
      from public.learning_sessions s
      where s.user_id = v_uid
        and s.learning_date = p_learning_date
        and s.kind = 'daily'
        and s.status in ('prepared', 'open')
        and s.offline_snapshot_id is null;

      if v_id is not null then
        return query select v_id, false;
        return;
      end if;

      -- the existing session was completed between the two statements: try again
      if v_try >= 3 then
        raise exception 'daily session could not be opened' using errcode = 'serialization_failure';
      end if;
    end loop;
  end if;

  insert into public.learning_sessions
    (id, user_id, plan_id, plan_version_id, phase_id, edition_id, kind, learning_date,
     lesson_refs, question_refs, steps, bank_version, self_rating, status)
  values
    (coalesce(p_session_id, gen_random_uuid()), v_uid, p_plan_id, p_plan_version_id,
     p_phase_id, p_edition_id, p_kind, p_learning_date,
     coalesce(p_lesson_refs, '{}'::uuid[]), coalesce(p_question_refs, '{}'::uuid[]),
     p_steps, p_bank_version, p_self_rating, 'open')
  returning id into v_id;

  return query select v_id, true;
end;
$$;

revoke all on function public.app_open_session(
  text, uuid, uuid, uuid, uuid, date, uuid[], uuid[], jsonb, integer, text, uuid)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_open_session(
  text, uuid, uuid, uuid, uuid, date, uuid[], uuid[], jsonb, integer, text, uuid)
  to authenticated;

-- 7.4 app_apply_events -------------------------------------------------------
-- Persists the outcome of a batch of session events in one transaction.
--   p_events: array; each element holds EXACTLY ONE of
--       "attempt":  {client_event_id, question_id, passage_id, correct, assisted?, error_kind?,
--                    wrong_token_ref?, review_round_id?, duration_ms, occurred_at}
--                   optionally with "mastery": the target_mastery state after the answer
--                   {plan_id, passage_id, status, consecutive_correct, initial_success_at,
--                    initial_learning_date, review_stage, next_review_due, last_review_date,
--                    confirmed_at, first_confirmed_at, maintenance_stage, lapse_count,
--                    error_part_ids} and "evidence": [{plan_id, passage_id, part_id,
--                    learning_date}] (the attempt of the element is the covering attempt)
--       "interval": {client_event_id, started_at, ended_at, active_ms, learning_date}
--   p_daily : null, or {learning_date, active_ms, goal_ms, completed?, reached_in_plan_id?}
--   p_open_session: true moves a `prepared` session to `open` (first accepted event, A-12).
-- An element whose client_event_id was already recorded is `duplicate`: nothing of it (nor
-- its mastery and evidence) is written. The session's edition is read from the session, so a
-- question of another edition fails its composite key. Returns
--   {"outcomes": ["acknowledged" | "duplicate", ...], "daily_completion_inserted": bool}.
-- daily_progress.active_ms never decreases (the intervals are append-only, so a smaller figure
-- can only come from a stale read).

create function public.app_apply_events(
  p_session_id   uuid,
  p_events       jsonb,
  p_daily        jsonb default null,
  p_open_session boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_edition    uuid;
  v_el         jsonb;
  v_outcomes   jsonb := '[]'::jsonb;
  v_attempt_id uuid;
  v_interval   uuid;
  v_rows       integer;
  v_completion boolean := false;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if pg_catalog.jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'p_events must be a JSON array' using errcode = 'invalid_parameter_value';
  end if;

  select s.edition_id into v_edition
  from public.learning_sessions s
  where s.id = p_session_id
    and s.user_id = v_uid;

  if not found then
    raise exception 'session_not_found' using errcode = 'no_data_found';
  end if;

  if p_open_session then
    update public.learning_sessions s
       set status = 'open'
     where s.id = p_session_id
       and s.user_id = v_uid
       and s.status = 'prepared';
  end if;

  for v_el in select e.value from pg_catalog.jsonb_array_elements(p_events) as e loop
    if (v_el ? 'attempt') = (v_el ? 'interval') then
      raise exception 'each event element must hold exactly one of attempt and interval'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_el ? 'attempt' then
      v_attempt_id := null;

      insert into public.attempts
        (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct,
         assisted, error_kind, wrong_token_ref, review_round_id, duration_ms, occurred_at)
      select v_uid, p_session_id, v_edition, a.client_event_id, a.question_id, a.passage_id,
             a.correct, coalesce(a.assisted, false), a.error_kind, a.wrong_token_ref,
             a.review_round_id, a.duration_ms, a.occurred_at
      from pg_catalog.jsonb_to_record(v_el -> 'attempt') as a(
        client_event_id uuid, question_id uuid, passage_id uuid, correct boolean,
        assisted boolean, error_kind text, wrong_token_ref text, review_round_id uuid,
        duration_ms integer, occurred_at timestamptz)
      on conflict (user_id, client_event_id) do nothing
      returning id into v_attempt_id;

      if v_attempt_id is null then
        v_outcomes := v_outcomes || '"duplicate"'::jsonb;
        continue;
      end if;

      if pg_catalog.jsonb_typeof(v_el -> 'mastery') = 'object' then
        insert into public.target_mastery
          (user_id, plan_id, passage_id, edition_id, status, consecutive_correct,
           initial_success_at, initial_learning_date, review_stage, next_review_due,
           last_review_date, confirmed_at, first_confirmed_at, maintenance_stage,
           lapse_count, error_part_ids)
        select v_uid, m.plan_id, m.passage_id, v_edition, m.status, m.consecutive_correct,
               m.initial_success_at, m.initial_learning_date, m.review_stage, m.next_review_due,
               m.last_review_date, m.confirmed_at, m.first_confirmed_at, m.maintenance_stage,
               m.lapse_count, coalesce(m.error_part_ids, '{}'::uuid[])
        from pg_catalog.jsonb_to_record(v_el -> 'mastery') as m(
          plan_id uuid, passage_id uuid, status text, consecutive_correct integer,
          initial_success_at timestamptz, initial_learning_date date, review_stage smallint,
          next_review_due date, last_review_date date, confirmed_at timestamptz,
          first_confirmed_at timestamptz, maintenance_stage smallint, lapse_count integer,
          error_part_ids uuid[])
        on conflict (user_id, plan_id, passage_id) do update
          set status              = excluded.status,
              consecutive_correct = excluded.consecutive_correct,
              initial_success_at  = excluded.initial_success_at,
              initial_learning_date = excluded.initial_learning_date,
              review_stage        = excluded.review_stage,
              next_review_due     = excluded.next_review_due,
              last_review_date    = excluded.last_review_date,
              confirmed_at        = excluded.confirmed_at,
              first_confirmed_at  = excluded.first_confirmed_at,
              maintenance_stage   = excluded.maintenance_stage,
              lapse_count         = excluded.lapse_count,
              error_part_ids      = excluded.error_part_ids;
      end if;

      if pg_catalog.jsonb_typeof(v_el -> 'evidence') = 'array' then
        insert into public.target_part_evidence
          (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
        select v_uid, ev.plan_id, ev.passage_id, ev.part_id, v_attempt_id, ev.learning_date
        from pg_catalog.jsonb_to_recordset(v_el -> 'evidence') as ev(
          plan_id uuid, passage_id uuid, part_id uuid, learning_date date)
        on conflict (user_id, plan_id, part_id) do nothing;
      end if;

      v_outcomes := v_outcomes || '"acknowledged"'::jsonb;
    else
      v_interval := null;

      insert into public.session_activity_intervals
        (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
      select v_uid, p_session_id, i.client_event_id, i.started_at, i.ended_at, i.active_ms,
             i.learning_date
      from pg_catalog.jsonb_to_record(v_el -> 'interval') as i(
        client_event_id uuid, started_at timestamptz, ended_at timestamptz, active_ms bigint,
        learning_date date)
      on conflict (user_id, client_event_id) do nothing
      returning id into v_interval;

      if v_interval is null then
        v_outcomes := v_outcomes || '"duplicate"'::jsonb;
      else
        v_outcomes := v_outcomes || '"acknowledged"'::jsonb;
      end if;
    end if;
  end loop;

  if p_daily is not null then
    insert into public.daily_progress (user_id, learning_date, active_ms, goal_ms)
    select v_uid, d.learning_date, d.active_ms, d.goal_ms
    from pg_catalog.jsonb_to_record(p_daily) as d(
      learning_date date, active_ms bigint, goal_ms bigint)
    on conflict (user_id, learning_date) do update
      set active_ms = greatest(public.daily_progress.active_ms, excluded.active_ms),
          goal_ms   = excluded.goal_ms;

    if coalesce((p_daily ->> 'completed')::boolean, false) then
      insert into public.daily_completions (user_id, learning_date, reached_in_plan_id)
      select v_uid, d.learning_date, d.reached_in_plan_id
      from pg_catalog.jsonb_to_record(p_daily) as d(
        learning_date date, reached_in_plan_id uuid)
      on conflict (user_id, learning_date) do nothing;
      get diagnostics v_rows = row_count;
      v_completion := v_rows > 0;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcomes', v_outcomes,
    'daily_completion_inserted', v_completion);
end;
$$;

revoke all on function public.app_apply_events(uuid, jsonb, jsonb, boolean)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_apply_events(uuid, jsonb, jsonb, boolean) to authenticated;

-- 7.5 app_complete_session ---------------------------------------------------
-- Sets status = completed and elapsed_ms. Returns true when this call completed the session,
-- false when it was already completed (nothing changes: completion is idempotent).

create function public.app_complete_session(p_session_id uuid, p_elapsed_ms bigint)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_rows integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  update public.learning_sessions s
     set status     = 'completed',
         elapsed_ms = p_elapsed_ms
   where s.id = p_session_id
     and s.user_id = v_uid
     and s.status <> 'completed';
  get diagnostics v_rows = row_count;

  if v_rows > 0 then
    return true;
  end if;

  if exists (select 1 from public.learning_sessions s where s.id = p_session_id and s.user_id = v_uid) then
    return false;
  end if;

  raise exception 'session_not_found' using errcode = 'no_data_found';
end;
$$;

revoke all on function public.app_complete_session(uuid, bigint)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_complete_session(uuid, bigint) to authenticated;

-- 7.6 app_create_offline_snapshot --------------------------------------------
-- Inserts offline_snapshots and its prepared learning_sessions (status prepared,
-- offline_snapshot_id set). Idempotent per (user, client operation id): the same operation id
-- with the same plan, plan version and target refs returns the existing snapshot with
-- created = false and creates no session; a different input raises QT004 (idempotency_input).
-- A new snapshot needs p_plan_version to be the version in force (QT002 otherwise); the
-- edition comes from the plan. Target refs are compared as stored (order-sensitive).
--   p_sessions: array of {id?, kind, phase_id?, learning_date, lesson_refs, question_refs,
--               steps, bank_version}

create function public.app_create_offline_snapshot(
  p_plan_id              uuid,
  p_plan_version         integer,
  p_bank_version         integer,
  p_client_operation_id  uuid,
  p_download_target_refs jsonb,
  p_schema_version       integer,
  p_protocol_version     integer,
  p_payload              jsonb,
  p_sessions             jsonb default '[]'::jsonb,
  p_snapshot_id          uuid default null
)
returns table (snapshot_id uuid, created boolean)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid     uuid := (select auth.uid());
  v_edition uuid;
  v_current integer;
  v_id      uuid := null;
  v_same    boolean;
  v_pass    integer := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = 'insufficient_privilege';
  end if;

  select mp.edition_id, mp.current_version into v_edition, v_current
  from public.master_plans mp
  where mp.id = p_plan_id
    and mp.user_id = v_uid;

  if not found then
    raise exception 'plan_not_found' using errcode = 'no_data_found';
  end if;

  loop
    v_pass := v_pass + 1;

    -- the same request again returns the same snapshot; a changed input is a conflict
    select o.id,
           (o.plan_id = p_plan_id
            and o.plan_version = p_plan_version
            and o.download_target_refs = p_download_target_refs)
      into v_id, v_same
    from public.offline_snapshots o
    where o.user_id = v_uid
      and o.client_operation_id = p_client_operation_id;

    if found then
      if v_same is not true then
        raise exception 'idempotency_input' using errcode = 'QT004';
      end if;
      return query select v_id, false;
      return;
    end if;

    -- a new snapshot is prepared for the version in force only
    if p_plan_version is distinct from v_current then
      raise exception 'version_conflict' using errcode = 'QT002';
    end if;

    insert into public.offline_snapshots
      (id, user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id,
       download_target_refs, schema_version, protocol_version, payload)
    values
      (coalesce(p_snapshot_id, gen_random_uuid()), v_uid, p_plan_id, p_plan_version, v_edition,
       p_bank_version, p_client_operation_id, p_download_target_refs, p_schema_version,
       p_protocol_version, p_payload)
    on conflict (user_id, client_operation_id) do nothing
    returning id into v_id;

    exit when v_id is not null;

    -- a parallel request with the same operation id won: read its row on the next pass
    if v_pass >= 3 then
      raise exception 'offline snapshot could not be created' using errcode = 'serialization_failure';
    end if;
  end loop;

  insert into public.learning_sessions
    (id, user_id, plan_id, plan_version_id, phase_id, edition_id, kind, learning_date,
     lesson_refs, question_refs, steps, bank_version, status, offline_snapshot_id)
  select coalesce(x.id, gen_random_uuid()), v_uid, p_plan_id,
         (select pv.id from public.plan_versions pv
           where pv.plan_id = p_plan_id and pv.version_no = p_plan_version),
         x.phase_id, v_edition, x.kind, x.learning_date,
         coalesce(x.lesson_refs, '{}'::uuid[]), coalesce(x.question_refs, '{}'::uuid[]),
         x.steps, x.bank_version, 'prepared', v_id
  from pg_catalog.jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb)) as x(
    id uuid, kind text, phase_id uuid, learning_date date, lesson_refs uuid[],
    question_refs uuid[], steps jsonb, bank_version integer);

  return query select v_id, true;
end;
$$;

revoke all on function public.app_create_offline_snapshot(
  uuid, integer, integer, uuid, jsonb, integer, integer, jsonb, jsonb, uuid)
  from public, anon, service_role, qatra_server;
grant execute on function public.app_create_offline_snapshot(
  uuid, integer, integer, uuid, jsonb, integer, integer, jsonb, jsonb, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Storage: no policy for bucket `sources` (§9, §11 item 6)
-- ---------------------------------------------------------------------------
-- The bucket stays private because storage.objects carries no policy that could reach it:
-- fail loudly if a policy names the bucket or is not restricted to a bucket at all.
do $$
declare
  v_policy text;
begin
  select p.policyname into v_policy
  from pg_catalog.pg_policies p
  where p.schemaname = 'storage'
    and p.tablename = 'objects'
    and (   coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') like '%sources%'
         or coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') not like '%bucket_id%')
  limit 1;

  if v_policy is not null then
    raise exception 'storage.objects policy "%" could expose bucket "sources"; none may exist', v_policy;
  end if;
end;
$$;
