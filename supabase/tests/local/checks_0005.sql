-- checks_0005.sql
--
-- LOCAL VALIDATION ONLY. Assertions for supabase/migrations/0005_rls_functions.sql, run by
-- run_local.sh right after that migration (the database then holds 0001-0005). Every
-- "-- CHECK:" line starts one independent chunk; a chunk passes when psql finishes it
-- without an error. Rows are synthetic placeholders created inside transactions that are
-- rolled back; the last chunk (concurrency over dblink) must commit for real and removes
-- its rows. Roles are exercised with SET ROLE (qa.as_user, qa.as_anon, qa.as_service,
-- qa.as_server); no Data API runs. Expected values are written out here from
-- docs/Database-schema.md v1.1 (§4.5, §5, §7, §8, §9, §11 `0005_rls_functions`, §12, §14),
-- not read back from the migration.

-- CHECK: 01 policy inventory: every table of 0001-0004 has exactly the expected policies (names, commands, role authenticated); the other tables have none
do $$
declare
  v_expected text[];
  v_actual   text[];
begin
  select array_agg(t || '|' || t || '__authenticated__' || lower(op) || '|' || op || '|{authenticated}')
    into v_expected
  from (values
    -- published content (P-CAT, P-SRC, P-BOOK, P-ED, P-PUB-CHILD, P-PUB-BANK, P-VIA-PARENT, P-PUB-ITEM, P-TPL)
    ('categories', 'SELECT'), ('sources', 'SELECT'), ('books', 'SELECT'), ('book_editions', 'SELECT'),
    ('edition_pages', 'SELECT'), ('book_sections', 'SELECT'), ('units', 'SELECT'),
    ('unit_page_spans', 'SELECT'), ('passages', 'SELECT'), ('passage_parts', 'SELECT'),
    ('lessons', 'SELECT'), ('lesson_units', 'SELECT'), ('question_items', 'SELECT'),
    ('generic_plan_templates', 'SELECT'),
    -- personal rows (P-OWN)
    ('profiles', 'SELECT'), ('profiles', 'UPDATE'),
    ('master_plans', 'SELECT'), ('master_plans', 'INSERT'), ('master_plans', 'UPDATE'),
    ('plan_versions', 'SELECT'), ('plan_versions', 'INSERT'),
    ('plan_phases', 'SELECT'), ('plan_phases', 'INSERT'),
    ('offline_snapshots', 'SELECT'), ('offline_snapshots', 'INSERT'),
    ('learning_sessions', 'SELECT'), ('learning_sessions', 'INSERT'), ('learning_sessions', 'UPDATE'),
    ('attempts', 'SELECT'), ('attempts', 'INSERT'),
    ('session_activity_intervals', 'SELECT'), ('session_activity_intervals', 'INSERT'),
    ('daily_progress', 'SELECT'), ('daily_progress', 'INSERT'), ('daily_progress', 'UPDATE'),
    ('daily_completions', 'SELECT'), ('daily_completions', 'INSERT'),
    ('target_mastery', 'SELECT'), ('target_mastery', 'INSERT'), ('target_mastery', 'UPDATE'),
    ('target_part_evidence', 'SELECT'), ('target_part_evidence', 'INSERT')
  ) as e(t, op);

  select array_agg(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.roles::text)
    into v_actual
  from pg_policies p
  where p.schemaname = 'public';

  perform qa.assert_same_set('policies of schema public', v_actual, v_expected);
  if cardinality(v_expected) <> 42 then
    raise exception 'the expected list must hold 42 policies, holds %', cardinality(v_expected);
  end if;

  -- all permissive; no policy for anon, service_role or qatra_server; none on private tables or storage
  if exists (select 1 from pg_policies where schemaname = 'public' and permissive <> 'PERMISSIVE') then
    raise exception 'a restrictive policy exists';
  end if;
  if exists (select 1 from pg_policies where schemaname in ('private', 'storage')) then
    raise exception 'a policy exists in schema private or storage';
  end if;
  -- approved_source_rules, unit_embeddings and content_jobs: row level security on, no policy (default deny)
  if exists (select 1 from pg_policies where tablename in ('approved_source_rules', 'unit_embeddings', 'content_jobs', 'ai_usage')) then
    raise exception 'a policy exists on a table that learners must not reach';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'a table without row level security exists';
  end if;
end;
$$;


-- CHECK: 02 policy predicates: personal rows use (select auth.uid()) as USING and WITH CHECK, insert has WITH CHECK only; content policies never mention the user
do $$
declare
  r record;
  c_own constant text := '(user_id = ( SELECT auth.uid() AS uid))';
begin
  for r in
    select p.tablename, p.policyname, p.cmd, regexp_replace(coalesce(p.qual, ''), '\s+', ' ', 'g') as qual,
           regexp_replace(coalesce(p.with_check, ''), '\s+', ' ', 'g') as with_check
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('profiles', 'master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots',
                          'learning_sessions', 'attempts', 'session_activity_intervals', 'daily_progress',
                          'daily_completions', 'target_mastery', 'target_part_evidence')
  loop
    if r.cmd = 'SELECT' and (r.qual <> c_own or r.with_check <> '') then
      raise exception 'policy %: a select policy must be USING %, got USING [%] CHECK [%]', r.policyname, c_own, r.qual, r.with_check;
    elsif r.cmd = 'INSERT' and (r.qual <> '' or r.with_check <> c_own) then
      raise exception 'policy %: an insert policy must be WITH CHECK % only, got USING [%] CHECK [%]', r.policyname, c_own, r.qual, r.with_check;
    elsif r.cmd = 'UPDATE' and (r.qual <> c_own or r.with_check <> c_own) then
      raise exception 'policy %: an update policy must be USING and WITH CHECK %, got USING [%] CHECK [%]', r.policyname, c_own, r.qual, r.with_check;
    end if;
  end loop;

  for r in
    select p.policyname, coalesce(p.qual, '') || coalesce(p.with_check, '') as body
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('categories', 'sources', 'books', 'book_editions', 'edition_pages', 'book_sections',
                          'units', 'unit_page_spans', 'passages', 'passage_parts', 'lessons', 'lesson_units',
                          'question_items', 'generic_plan_templates')
  loop
    if r.body ~* '(user_id|auth\.uid)' then
      raise exception 'content policy % refers to the user: %', r.policyname, r.body;
    end if;
  end loop;

  -- the predicates of §4.5 that name the publication states
  if (select regexp_replace(qual, '\s+', ' ', 'g') from pg_policies where policyname = 'book_editions__authenticated__select')
     is distinct from '(status = ANY (ARRAY[''published''::text, ''superseded''::text]))' then
    raise exception 'P-ED differs: %', (select qual from pg_policies where policyname = 'book_editions__authenticated__select');
  end if;
  if (select regexp_replace(qual, '\s+', ' ', 'g') from pg_policies where policyname = 'generic_plan_templates__authenticated__select')
     is distinct from '(status = ''published''::text)' then
    raise exception 'P-TPL differs: %', (select qual from pg_policies where policyname = 'generic_plan_templates__authenticated__select');
  end if;
end;
$$;

-- CHECK: 03 grants of anon: nothing on any table, column or function; SELECT on the two catalog views only (§5.1, §14 check 2)
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass::text as rel, a.attname::text as col, c.relkind, p
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p')
  loop
    if has_column_privilege('anon', r.rel, r.col, r.p) then
      if not (r.p = 'SELECT' and r.rel in ('catalog_editions', 'catalog_sections')) then
        raise exception 'anon holds column-level % on %.%', r.p, r.rel, r.col;
      end if;
    elsif r.p = 'SELECT' and r.rel in ('catalog_editions', 'catalog_sections') then
      raise exception 'anon cannot select %.%', r.rel, r.col;
    end if;
  end loop;
  for r in
    select c.oid::regclass::text as rel, p
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['DELETE', 'TRUNCATE', 'TRIGGER', 'INSERT', 'UPDATE', 'REFERENCES']) as p
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p')
  loop
    if has_table_privilege('anon', r.rel, r.p) then
      raise exception 'anon holds % on %', r.p, r.rel;
    end if;
  end loop;
  -- sequences: none exist at all (all ids are UUIDs, §5.2 item 8)
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname in ('public', 'private') and c.relkind = 'S') then
    raise exception 'a sequence exists in public or private';
  end if;
  -- no function, public or private
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
  loop
    if has_function_privilege('anon', r.fn, 'EXECUTE') then
      raise exception 'anon can execute %', r.fn;
    end if;
  end loop;
  -- schema private stays locked
  if has_schema_privilege('anon', 'private', 'USAGE') or has_schema_privilege('authenticated', 'private', 'USAGE')
     or has_schema_privilege('service_role', 'private', 'USAGE') or has_schema_privilege('qatra_server', 'private', 'USAGE') then
    raise exception 'an API role has USAGE on schema private';
  end if;
end;
$$;

-- CHECK: 04 grants of authenticated: exactly the table and column grants of §5.2 (reads, inserts, column-limited updates, no delete)
do $$
declare
  v_sel_tables text[] := array[
    'categories', 'books', 'edition_pages', 'book_sections', 'units', 'unit_page_spans', 'passages',
    'passage_parts', 'lessons', 'lesson_units', 'question_items', 'generic_plan_templates',
    'profiles', 'master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots', 'learning_sessions',
    'attempts', 'session_activity_intervals', 'daily_progress', 'daily_completions', 'target_mastery',
    'target_part_evidence', 'catalog_editions', 'catalog_sections'];
  v_ins_tables text[] := array[
    'plan_versions', 'plan_phases', 'attempts', 'session_activity_intervals', 'daily_completions',
    'target_part_evidence', 'offline_snapshots', 'master_plans', 'learning_sessions', 'daily_progress',
    'target_mastery'];
  -- column-limited SELECT: every column of book_editions except raw_storage_path and review_record;
  -- sources only id, title, provider, source_url
  v_sel_cols jsonb := jsonb_build_object(
    'book_editions', jsonb_build_array('id', 'book_id', 'source_id', 'edition_key', 'edition_label', 'language',
      'version', 'bank_version', 'content_hash', 'pagination_record', 'status', 'catalog_hidden',
      'archived_at', 'created_at', 'updated_at'),
    'sources', jsonb_build_array('id', 'title', 'provider', 'source_url'));
  -- column-limited UPDATE
  v_upd jsonb := jsonb_build_object(
    'master_plans', jsonb_build_array('target_scope', 'paths', 'plan_order', 'session_minutes', 'preferred_date',
      'agreed_estimate', 'current_version', 'status', 'updated_at'),
    'learning_sessions', jsonb_build_array('status', 'elapsed_ms'),
    'daily_progress', jsonb_build_array('active_ms', 'goal_ms'),
    'target_mastery', jsonb_build_array('status', 'consecutive_correct', 'initial_success_at',
      'initial_learning_date', 'review_stage', 'next_review_due', 'last_review_date', 'confirmed_at',
      'first_confirmed_at', 'maintenance_stage', 'lapse_count', 'error_part_ids'),
    'profiles', jsonb_build_array('language', 'time_zone', 'session_minutes', 'reminder_settings', 'pending_settings'));
  r record;
  v_want boolean;
begin
  -- the JSON column lists name real columns
  for r in
    select j.key as tbl, e.value #>> '{}' as col
    from jsonb_each(v_sel_cols || v_upd) j, jsonb_array_elements(j.value) e
  loop
    if not exists (select 1 from pg_attribute where attrelid = ('public.' || r.tbl)::regclass and attname = r.col and not attisdropped) then
      raise exception 'the expected column list names a missing column %.%', r.tbl, r.col;
    end if;
  end loop;

  for r in
    select c.relname::text as rel, a.attname::text as col, p
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p
    where n.nspname = 'public' and c.relkind in ('r', 'v')
  loop
    v_want := case r.p
      when 'SELECT' then r.rel = any (v_sel_tables) or coalesce(v_sel_cols -> r.rel ? r.col, false)
      when 'INSERT' then r.rel = any (v_ins_tables)
      when 'UPDATE' then coalesce(v_upd -> r.rel ? r.col, false)
      else false
    end;
    if has_column_privilege('authenticated', 'public.' || r.rel, r.col, r.p) is distinct from v_want then
      raise exception 'authenticated %: % on %.% (expected %)',
        case when v_want then 'lacks' else 'holds' end, r.p, r.rel, r.col, v_want;
    end if;
  end loop;

  -- table-level DELETE, TRUNCATE, TRIGGER, REFERENCES nowhere; table-level UPDATE nowhere
  for r in
    select c.oid::regclass::text as rel, p
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES', 'UPDATE']) as p
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p')
  loop
    if has_table_privilege('authenticated', r.rel, r.p) then
      raise exception 'authenticated holds table-level % on %', r.p, r.rel;
    end if;
  end loop;

  -- tables with no grant at all
  for r in
    select t from unnest(array['approved_source_rules', 'unit_embeddings', 'content_jobs', 'ai_usage',
                               'private.account_handles', 'private.password_reset_grants', 'private.recovery_codes',
                               'private.app_sessions', 'private.auth_throttle']) as t
  loop
    if has_any_column_privilege('authenticated', case when r.t like 'private.%' then r.t else 'public.' || r.t end, 'SELECT, INSERT, UPDATE, REFERENCES') then
      raise exception 'authenticated holds a privilege on %', r.t;
    end if;
  end loop;

  -- the views: select only
  if not has_table_privilege('authenticated', 'public.catalog_editions', 'SELECT')
     or not has_table_privilege('authenticated', 'public.catalog_sections', 'SELECT') then
    raise exception 'authenticated cannot select the catalog views';
  end if;
end;
$$;

-- CHECK: 05 grants of service_role: select, insert, update, delete on the 17 content tables (no truncate, references, trigger); nothing on private tables, personal tables, ai_usage or the views
do $$
declare
  r record;
begin
  for r in
    select t, p, (p in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')) as want
    from unnest(qa.content_tables()) as t
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
  loop
    if has_table_privilege('service_role', 'public.' || r.t, r.p) is distinct from r.want then
      raise exception 'service_role %: % on public.% (expected %)',
        case when r.want then 'lacks' else 'holds' end, r.p, r.t, r.want;
    end if;
  end loop;
  for r in
    select c.oid::regclass::text as rel, p
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p')
      and c.relname <> all (qa.content_tables())
  loop
    if has_table_privilege('service_role', r.rel, r.p) then
      raise exception 'service_role holds % on %', r.p, r.rel;
    end if;
    if has_any_column_privilege('service_role', r.rel, 'SELECT, INSERT, UPDATE, REFERENCES') then
      raise exception 'service_role holds a column-level privilege on %', r.rel;
    end if;
  end loop;
  -- the bypass attribute is the shim's stand-in for the platform's (policies are not needed for service_role)
  if not (select rolbypassrls from pg_roles where rolname = 'service_role') then
    raise exception 'the shim role service_role does not bypass RLS, so the publishing path would not be exercised';
  end if;
end;
$$;

-- CHECK: 06 grants of qatra_server: USAGE on schema public, EXECUTE on srv_* items 1-18 only, no table, view, sequence or storage privilege (§14 check 4)
do $$
declare
  r record;
begin
  if not has_schema_privilege('qatra_server', 'public', 'USAGE') then
    raise exception 'qatra_server lacks USAGE on schema public';
  end if;
  if has_schema_privilege('qatra_server', 'public', 'CREATE') then
    raise exception 'qatra_server can create objects in public';
  end if;
  for r in
    select c.oid::regclass::text as rel, p
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
    where n.nspname in ('public', 'private', 'storage', 'auth') and c.relkind in ('r', 'v', 'm', 'p', 'S')
  loop
    if has_table_privilege('qatra_server', r.rel, r.p) then
      raise exception 'qatra_server holds % on %', r.p, r.rel;
    end if;
  end loop;
  -- the functions it may execute: exactly srv_* 1-18
  perform qa.assert_same_set('functions executable by qatra_server',
    (select array_agg(p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('qatra_server', p.oid, 'EXECUTE')),
    qa.srv_functions());
  if has_function_privilege('qatra_server', 'public.srv_redact_revoked_content(uuid)', 'EXECUTE') then
    raise exception 'qatra_server can execute srv_redact_revoked_content';
  end if;
  -- still no membership
  if exists (select 1 from pg_auth_members m join pg_roles u on u.oid = m.member where u.rolname = 'qatra_server') then
    raise exception 'qatra_server is a member of another role';
  end if;
  -- the stand-in for the trivial readiness query needs no privilege
  perform 1;
end;
$$;

-- CHECK: 07 functions: exactly the 19 srv_* and 6 app_* functions in public; srv_* executable by qatra_server only (item 19 by service_role only), app_* by authenticated only; nothing by PUBLIC (§14 check 5)
do $$
declare
  r record;
  v_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'public.categories'::regclass);
  v_all text[] := qa.srv_functions() || array['srv_redact_revoked_content(uuid)'] || qa.app_functions();
begin
  if cardinality(qa.srv_functions()) <> 18 or cardinality(qa.app_functions()) <> 6 then
    raise exception 'the expected lists must hold 18 srv_ functions (+1) and 6 app_ functions';
  end if;
  perform qa.assert_same_set('functions in schema public',
    (select array_agg(p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
    v_all);

  for r in
    select p.oid, p.oid::regprocedure::text as sig, p.proname::text as name, p.prosecdef, p.proconfig,
           pg_get_userbyid(p.proowner) as owner, p.proacl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    -- owner is the migration owner (the owner of the tables)
    if r.owner <> v_owner then
      raise exception '% is owned by %, expected the migration owner %', r.sig, r.owner, v_owner;
    end if;
    -- a fixed, empty search path in the function's own definition
    if not coalesce(r.proconfig @> array['search_path=""'], false) then
      raise exception '% does not declare search_path = ''''', r.sig;
    end if;
    -- security definer for srv_*, security invoker for app_*
    if r.name like 'srv\_%' and not r.prosecdef then raise exception '% is not security definer', r.sig; end if;
    if r.name like 'app\_%' and r.prosecdef then raise exception '% is security definer', r.sig; end if;
    -- EXECUTE never reaches PUBLIC
    if r.proacl is null or exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception '% is executable by PUBLIC', r.sig;
    end if;
    -- grants per role
    if has_function_privilege('anon', r.oid, 'EXECUTE') then raise exception 'anon can execute %', r.sig; end if;
    if r.name like 'srv\_%' and r.name <> 'srv_redact_revoked_content' then
      if has_function_privilege('authenticated', r.oid, 'EXECUTE') then raise exception 'authenticated can execute %', r.sig; end if;
      if has_function_privilege('service_role', r.oid, 'EXECUTE') then raise exception 'service_role can execute %', r.sig; end if;
      if not has_function_privilege('qatra_server', r.oid, 'EXECUTE') then raise exception 'qatra_server cannot execute %', r.sig; end if;
    elsif r.name = 'srv_redact_revoked_content' then
      if has_function_privilege('authenticated', r.oid, 'EXECUTE') then raise exception 'authenticated can execute %', r.sig; end if;
      if has_function_privilege('qatra_server', r.oid, 'EXECUTE') then raise exception 'qatra_server can execute %', r.sig; end if;
      if not has_function_privilege('service_role', r.oid, 'EXECUTE') then raise exception 'service_role cannot execute %', r.sig; end if;
    else
      if not has_function_privilege('authenticated', r.oid, 'EXECUTE') then raise exception 'authenticated cannot execute %', r.sig; end if;
      if has_function_privilege('service_role', r.oid, 'EXECUTE') then raise exception 'service_role can execute %', r.sig; end if;
      if has_function_privilege('qatra_server', r.oid, 'EXECUTE') then raise exception 'qatra_server can execute %', r.sig; end if;
    end if;
  end loop;

  -- trigger helpers and the redaction helper in private: closed to every API role
  for r in
    select p.oid::regprocedure::text as sig, p.oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'
  loop
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('authenticated', r.oid, 'EXECUTE')
       or has_function_privilege('service_role', r.oid, 'EXECUTE') or has_function_privilege('qatra_server', r.oid, 'EXECUTE') then
      raise exception 'an API role can execute %', r.sig;
    end if;
  end loop;
end;
$$;

-- CHECK: 08 default function privileges are closed for the three API roles in schema public; every function carries an explicit grant list
begin;
do $$
declare
  r record;
begin
  -- the platform's per-schema default EXECUTE grants for the migration owner are gone
  if exists (
    select 1
    from pg_default_acl d, aclexplode(d.defaclacl) a
    where d.defaclobjtype = 'f'
      and d.defaclnamespace = 'public'::regnamespace
      and a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception 'a default EXECUTE grant on new functions in public remains for an API role';
  end if;
  -- control: the same query does see the table defaults of the shim (so it is not blind)
  if not exists (
    select 1
    from pg_default_acl d, aclexplode(d.defaclacl) a
    where d.defaclobjtype = 'r' and d.defaclnamespace = 'public'::regnamespace
      and a.grantee = (select oid from pg_roles where rolname = 'anon')
  ) then
    raise exception 'control failed: the default-ACL query does not see the shim table defaults';
  end if;
end;
$$;
-- a function created now by the migration owner is not granted to the API roles by default
create function public.qa_default_function_probe() returns integer language sql as 'select 1';
do $$
declare
  v_acl aclitem[] := (select proacl from pg_proc where proname = 'qa_default_function_probe');
begin
  if v_acl is not null and exists (
    select 1 from aclexplode(v_acl) a
    where a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))
  ) then
    raise exception 'a new function in public is granted to an API role by default';
  end if;
end;
$$;
rollback;

-- CHECK: 09 catalog views: owner's rights with security_barrier, exact columns (§7), no text, no source or internal columns, SELECT for anon and authenticated only
do $$
declare
  v_cols text[];
begin
  select array_agg(a.attname || '|' || format_type(a.atttypid, a.atttypmod) order by a.attnum) into v_cols
  from pg_attribute a where a.attrelid = 'public.catalog_editions'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from array[
    'edition_id|uuid', 'edition_key|text', 'edition_label|text', 'language|text', 'catalog_version|integer',
    'book_title_ar|text', 'book_title_en|text', 'author|text', 'content_format|text', 'category_slug|text',
    'category_label_ar|text', 'category_label_en|text', 'available_paths|text[]', 'path_word_counts|jsonb',
    'path_passage_counts|jsonb'] then
    raise exception 'catalog_editions columns differ from §7: %', v_cols;
  end if;

  select array_agg(a.attname || '|' || format_type(a.atttypid, a.atttypmod) order by a.attnum) into v_cols
  from pg_attribute a where a.attrelid = 'public.catalog_sections'::regclass and a.attnum > 0 and not a.attisdropped;
  if v_cols is distinct from array[
    'edition_id|uuid', 'section_id|uuid', 'ordinal|integer', 'kind|text', 'reference|text', 'title_ar|text',
    'title_en|text', 'available_paths|text[]', 'path_stats|jsonb'] then
    raise exception 'catalog_sections columns differ from §7: %', v_cols;
  end if;

  -- never exposed: any text, token, unit, lesson, question, source_url, raw_storage_path, content_hash,
  -- review_record, pagination_record or source record
  if exists (select 1 from pg_attribute a
             where a.attrelid in ('public.catalog_editions'::regclass, 'public.catalog_sections'::regclass)
               and a.attnum > 0 and not a.attisdropped
               and a.attname ~* '(canonical|text$|token|unit|lesson|question|source|raw_storage|content_hash|review|pagination|eligibility|license|url$)') then
    raise exception 'a catalog view exposes a forbidden column';
  end if;

  -- views are views, owned by the table owner, with the barrier on and not security_invoker
  if (select count(*) from pg_class c where c.oid in ('public.catalog_editions'::regclass, 'public.catalog_sections'::regclass) and c.relkind = 'v') <> 2 then
    raise exception 'the catalog objects are not both views';
  end if;
  if exists (select 1 from pg_class c where c.oid in ('public.catalog_editions'::regclass, 'public.catalog_sections'::regclass)
             and pg_get_userbyid(c.relowner) <> (select pg_get_userbyid(relowner) from pg_class where oid = 'public.categories'::regclass)) then
    raise exception 'a catalog view is not owned by the migration owner';
  end if;
  if exists (select 1 from pg_class c where c.oid in ('public.catalog_editions'::regclass, 'public.catalog_sections'::regclass)
             and not coalesce(c.reloptions @> array['security_barrier=true'], false)) then
    raise exception 'a catalog view lacks security_barrier';
  end if;
  if exists (select 1 from pg_class c where c.oid in ('public.catalog_editions'::regclass, 'public.catalog_sections'::regclass)
             and coalesce(c.reloptions::text ~ 'security_invoker', false)) then
    raise exception 'a catalog view is security_invoker (it must run with the owner''s rights)';
  end if;

  -- grants: SELECT for anon and authenticated, nothing else for anyone
  if not has_table_privilege('anon', 'public.catalog_editions', 'SELECT') or not has_table_privilege('anon', 'public.catalog_sections', 'SELECT')
     or not has_table_privilege('authenticated', 'public.catalog_editions', 'SELECT') or not has_table_privilege('authenticated', 'public.catalog_sections', 'SELECT') then
    raise exception 'anon or authenticated cannot select a catalog view';
  end if;
  if exists (
    select 1
    from unnest(array['public.catalog_editions', 'public.catalog_sections']) as v
    cross join unnest(array['anon', 'authenticated', 'service_role', 'qatra_server']) as rol
    cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
    where has_table_privilege(rol, v, p)
  ) then
    raise exception 'a role holds more than SELECT on a catalog view';
  end if;
  if has_table_privilege('service_role', 'public.catalog_editions', 'SELECT') or has_table_privilege('qatra_server', 'public.catalog_editions', 'SELECT') then
    raise exception 'service_role or qatra_server can select a catalog view';
  end if;
end;
$$;

-- CHECK: 09b catalog views at run time: rows only for published, visible, unarchived editions; metadata values and per-path counts of the current bank only; the same answer for anon and authenticated (§14 check 2)
begin;
select qa.make_fixture();
select qa.make_hadith_edition();
do $$
declare
  v_status text;
  v_role   text;
begin
  -- every status but published: no row in either view
  foreach v_status in array array['draft', 'validated', 'superseded', 'revoked'] loop
    perform qa.set_edition_status(v_status);
    foreach v_role in array array['anon', 'authenticated'] loop
      execute format('set local role %I', v_role);
      if (select count(*) from public.catalog_editions) <> 0 or (select count(*) from public.catalog_sections) <> 0 then
        raise exception '% sees a % edition through the catalog views', v_role, v_status;
      end if;
      reset role;
    end loop;
  end loop;

  -- published: one row with the metadata of §7
  perform qa.set_edition_status('published');
  foreach v_role in array array['anon', 'authenticated'] loop
    execute format('set local role %I', v_role);
    if (select count(*) from public.catalog_editions) <> 1 or (select count(*) from public.catalog_sections) <> 1 then
      raise exception '% does not see the published edition', v_role;
    end if;
    if (select (edition_id = qa.id(5), edition_key, edition_label, language, catalog_version, book_title_ar, book_title_en is null, author,
                content_format, category_slug, category_label_ar, category_label_en is null, available_paths = array['quran'],
                path_word_counts = '{"quran": 1}'::jsonb, path_passage_counts = '{"quran": 1}'::jsonb)::text
        from public.catalog_editions) <> '(t,test-edition,test,ar,1,test,t,test,quran,test-category,test,t,t,t,t)' then
      raise exception 'catalog_editions row differs: %', (select to_jsonb(c) from public.catalog_editions c);
    end if;
    if (select (edition_id = qa.id(5), section_id = qa.id(7), ordinal, kind, reference, title_ar, title_en,
                available_paths = array['quran'], path_stats = '{"quran": {"words": 1, "passages": 1}}'::jsonb)::text
        from public.catalog_sections) <> '(t,t,1,surah,1,test,"Test 1",t,t)' then
      raise exception 'catalog_sections row differs: %', (select to_jsonb(c) from public.catalog_sections c);
    end if;
    reset role;
  end loop;

  -- hidden or archived editions disappear from the catalog
  update public.book_editions set catalog_hidden = true where id = qa.id(5);
  if (select count(*) from public.catalog_editions) <> 0 or (select count(*) from public.catalog_sections) <> 0 then
    raise exception 'a hidden edition is in the catalog';
  end if;
  update public.book_editions set catalog_hidden = false, archived_at = now() where id = qa.id(5);
  if (select count(*) from public.catalog_editions) <> 0 or (select count(*) from public.catalog_sections) <> 0 then
    raise exception 'an archived edition is in the catalog';
  end if;
  update public.book_editions set archived_at = null where id = qa.id(5);
  if (select count(*) from public.catalog_editions) <> 1 then raise exception 'the edition did not come back'; end if;

  -- counts per path of the current bank only: a bank-2 passage and a draft hadith edition do not count
  insert into public.passages (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference) values
    (qa.id(31), qa.id(5), 1, qa.id(7), 2, 'quran', '1:1', '1:1', 1, '1:2'),
    (qa.id(33), qa.id(5), 1, qa.id(7), 1, 'grade', '1:2', '1:2', 7, '1:3'),
    (qa.id(41), qa.id(5), 2, qa.id(7), 1, 'matn', '1:3', '1:3', 99, '1:4');
  if (select (available_paths = array['grade', 'quran'], path_word_counts = '{"grade": 7, "quran": 2}'::jsonb,
              path_passage_counts = '{"grade": 1, "quran": 2}'::jsonb)::text from public.catalog_editions) <> '(t,t,t)' then
    raise exception 'catalog_editions counts differ: %', (select to_jsonb(c) from public.catalog_editions c);
  end if;
  if (select (available_paths = array['grade', 'quran'], path_stats = '{"grade": {"words": 7, "passages": 1}, "quran": {"words": 2, "passages": 2}}'::jsonb)::text
      from public.catalog_sections) <> '(t,t)' then
    raise exception 'catalog_sections counts differ: %', (select to_jsonb(c) from public.catalog_sections c);
  end if;

  -- a second published edition without passages: empty path arrays and objects, never NULL
  update public.book_editions
     set content_hash = repeat('c', 64), review_record = '{"approval": {"who": "test", "at": "2026-01-01T00:00:00Z", "note": "test"}}', status = 'published'
   where id = qa.id(21);
  if (select count(*) from public.catalog_editions) <> 2 then raise exception 'the second published edition is missing'; end if;
  if (select (available_paths = '{}', path_word_counts = '{}'::jsonb, path_passage_counts = '{}'::jsonb)::text
      from public.catalog_editions where edition_id = qa.id(21)) <> '(t,t,t)' then
    raise exception 'an edition without passages differs: %', (select to_jsonb(c) from public.catalog_editions c where edition_id = qa.id(21));
  end if;
  -- it has no sections, so the sections view still shows the first edition only
  if (select count(*) from public.catalog_sections) <> 1 then raise exception 'unexpected sections'; end if;
end;
$$;
rollback;

-- CHECK: 10 anon at run time: every base table, function and storage object is denied; only the two catalog views answer (§14 check 2)
begin;
select qa.make_fixture();
select qa.set_edition_status('published');
insert into storage.objects (bucket_id, name) values ('sources', 'test-edition/raw/synthetic.json');
select qa.as_anon();
do $$
declare
  t text;
  v_col text;
begin
  for t, v_col in
    select c.oid::regclass::text,
           (select a.attname::text from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped order by a.attnum limit 1)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r'
  loop
    perform qa.expect_error(format('select 1 from %s limit 1', t), '42501', 'anon select ' || t);
    perform qa.expect_error(format('insert into %s default values', t), '42501', 'anon insert ' || t);
    perform qa.expect_error(format('update %s set %I = %I', t, v_col, v_col), '42501', 'anon update ' || t);
    perform qa.expect_error(format('delete from %s', t), '42501', 'anon delete ' || t);
  end loop;
  -- functions: the Data API would expose them as RPC endpoints
  perform qa.expect_error($q$select public.srv_find_handle('x')$q$, '42501', 'anon srv_find_handle');
  perform qa.expect_error($q$select public.srv_redact_revoked_content(gen_random_uuid())$q$, '42501', 'anon srv_redact_revoked_content');
  perform qa.expect_error($q$select public.app_complete_session(gen_random_uuid(), 0)$q$, '42501', 'anon app_complete_session');
  perform qa.expect_error($q$select public.app_create_plan(gen_random_uuid(), '{}', array['quran'], 'book', 10::smallint, null, '{}', 'x', '{}', current_date, '[]')$q$, '42501', 'anon app_create_plan');
  -- the views answer, and are read-only
  if (select count(*) from public.catalog_editions) <> 1 or (select count(*) from public.catalog_sections) <> 1 then
    raise exception 'anon does not see the published edition through the catalog views';
  end if;
  -- (the views are not updatable, so a write is refused before any privilege matters; the grants are checked in 03 and 09)
  perform qa.expect_error($q$insert into public.catalog_editions (edition_id) values (gen_random_uuid())$q$, '55000', 'anon insert into a view');
  perform qa.expect_error($q$delete from public.catalog_sections$q$, '55000', 'anon delete from a view');
  -- storage: the bucket sources has no policy, so no object is visible and none can be written
  if (select count(*) from storage.objects) <> 0 then
    raise exception 'anon can read storage objects';
  end if;
  perform qa.expect_error($q$insert into storage.objects (bucket_id, name) values ('sources', 'x')$q$, '42501', 'anon insert object');
end;
$$;
select qa.as_owner();
rollback;

-- CHECK: 11 learner reads: authenticated sees rows of published and superseded editions only (never draft, validated or revoked), the pinned bank version, published items; columns and tables outside the grants are denied (§14 check 3)
begin;
select qa.make_fixture();
select qa.make_users();
do $$
declare
  v_status text;
  t        text;
  n        bigint;
  v_want   bigint;
  v_tables text[] := array['categories', 'sources', 'books', 'book_editions', 'edition_pages', 'book_sections',
                           'units', 'unit_page_spans', 'passages', 'passage_parts', 'lessons', 'lesson_units',
                           'question_items'];
begin
  perform qa.publish_fixture();   -- lesson and question published
  foreach v_status in array array['draft', 'validated', 'published', 'superseded', 'revoked', 'published'] loop
    perform qa.set_edition_status(v_status);
    perform qa.as_user(qa.id(901));
    v_want := case when v_status in ('published', 'superseded') then 1 else 0 end;
    foreach t in array v_tables loop
      execute format('select count(*) from public.%I', t) into n;
      if n <> v_want then
        raise exception 'edition %: authenticated sees % rows of % (expected %)', v_status, n, t, v_want;
      end if;
    end loop;
    perform qa.as_owner();
  end loop;

  -- hidden and archived editions stay readable for pinned plans (D44, P-ED)
  update public.book_editions set catalog_hidden = true where id = qa.id(5);
  perform qa.as_user(qa.id(901));
  if (select count(*) from public.book_editions) <> 1 or (select count(*) from public.units) <> 1 then
    raise exception 'a hidden edition is not readable';
  end if;
  perform qa.as_owner();
  update public.book_editions set archived_at = now() where id = qa.id(5);
  perform qa.as_user(qa.id(901));
  if (select count(*) from public.book_editions) <> 1 or (select count(*) from public.passages) <> 1 then
    raise exception 'an archived edition is not readable';
  end if;
  perform qa.as_owner();

  -- items that are not published stay invisible although their edition is published
  update public.lessons set status = 'validated' where id = qa.id(11);
  update public.question_items set status = 'draft' where id = qa.id(12);
  perform qa.as_user(qa.id(901));
  foreach t in array array['lessons', 'lesson_units', 'question_items'] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then raise exception 'an unpublished item is visible in %', t; end if;
  end loop;
  perform qa.as_owner();
  update public.lessons set status = 'published' where id = qa.id(11);
  update public.question_items set status = 'published' where id = qa.id(12);

  -- only the bank version of the edition is readable (P-PUB-BANK): a bank-2 passage and lesson stay hidden
  insert into public.passages (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
  values (qa.id(41), qa.id(5), 2, qa.id(7), 1, 'quran', '1:0', '1:0', 1, '1:1');
  insert into public.passage_parts (id, passage_id, edition_id, ordinal, start_ref, end_ref, word_count)
  values (qa.id(42), qa.id(41), qa.id(5), 1, '1:0', '1:0', 1);
  insert into public.lessons (id, edition_id, bank_version, passage_id, ordinal, duration_estimate_sec, status)
  values (qa.id(51), qa.id(5), 2, qa.id(41), 1, 60, 'published');
  perform qa.as_user(qa.id(901));
  if (select count(*) from public.passages) <> 1 or (select count(*) from public.lessons) <> 1
     or (select count(*) from public.passage_parts) <> 1 then
    raise exception 'a passage, part or lesson of a bank version other than the edition''s is readable';
  end if;
  perform qa.as_owner();

  -- templates: P-TPL looks at the template status only
  perform qa.set_edition_status('draft');
  perform qa.as_user(qa.id(901));
  if (select count(*) from public.generic_plan_templates) <> 0 then raise exception 'a draft template is visible'; end if;
  perform qa.as_owner();
  update public.generic_plan_templates set status = 'published';
  perform qa.as_user(qa.id(901));
  if (select count(*) from public.generic_plan_templates) <> 1 then raise exception 'a published template is not visible'; end if;
  perform qa.as_owner();
  perform qa.set_edition_status('published');
end;
$$;
-- columns outside the grants and tables outside the grants
select qa.as_user(qa.id(901));
do $$
declare
  t text;
begin
  perform qa.expect_ok($q$select id, book_id, source_id, edition_key, edition_label, language, version, bank_version, content_hash, pagination_record, status, catalog_hidden, archived_at, created_at, updated_at from public.book_editions$q$, 'granted book_editions columns');
  perform qa.expect_error($q$select raw_storage_path from public.book_editions$q$, '42501', 'raw_storage_path');
  perform qa.expect_error($q$select review_record from public.book_editions$q$, '42501', 'review_record');
  perform qa.expect_error($q$select * from public.book_editions$q$, '42501', 'select * from book_editions');
  perform qa.expect_ok($q$select id, title, provider, source_url from public.sources$q$, 'granted sources columns');
  foreach t in array array['approved_source_rules_id', 'eligibility_record', 'license_url', 'license_record', 'checked_at', 'rights_status', 'approved_rule_id'] loop
    perform qa.expect_error(format('select %s from public.sources', replace(t, 'approved_source_rules_id', 'approved_rule_id')), '42501', 'sources.' || t);
  end loop;
  perform qa.expect_error($q$select * from public.sources$q$, '42501', 'select * from sources');
  -- tables with no grant
  foreach t in array array['public.approved_source_rules', 'public.unit_embeddings', 'public.content_jobs', 'public.ai_usage',
                           'private.account_handles', 'private.recovery_codes', 'private.password_reset_grants',
                           'private.app_sessions', 'private.auth_throttle'] loop
    perform qa.expect_error(format('select 1 from %s limit 1', t), '42501', 'authenticated select ' || t);
  end loop;
  -- content is read-only
  foreach t in array qa.content_tables() loop
    perform qa.expect_error(format('insert into public.%I default values', t), '42501', 'authenticated insert ' || t);
    perform qa.expect_error(format('delete from public.%I', t), '42501', 'authenticated delete ' || t);
  end loop;
  perform qa.expect_error($q$update public.book_editions set status = 'revoked'$q$, '42501', 'authenticated update book_editions');
  perform qa.expect_error($q$update public.units set canonical_text = 'x'$q$, '42501', 'authenticated update units');
end;
$$;
select qa.as_owner();
-- service_role publishes and sees every status (it bypasses RLS)
select qa.set_edition_status('draft');
select qa.as_service();
do $$
begin
  if (select count(*) from public.book_editions) <> 1 or (select count(*) from public.units) <> 1 then
    raise exception 'service_role does not see a draft edition';
  end if;
end;
$$;
select qa.as_owner();
rollback;

-- CHECK: 12 two-account isolation (mandatory): account B sees none of A's rows, cannot update, delete or forge them, and cannot name A's parents (§14 check 1)
begin;
select qa.make_fixture();
select qa.publish_fixture();
select qa.make_users();
select qa.populate_user(qa.id(901), 1);
select qa.populate_user(qa.id(902), 2);
insert into public.plan_phases (id, plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
select qa.id((8000 + row_number() over ())::integer), pv.id, pv.user_id, 1, '[]', '{}', 10, '[2026-10-05,2026-10-12)'
from public.plan_versions pv;
do $$
declare
  t         text;
  v_tables  text[] := array['profiles', 'master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots',
                            'learning_sessions', 'attempts', 'session_activity_intervals', 'daily_progress',
                            'daily_completions', 'target_mastery', 'target_part_evidence'];
  v_user    uuid;
  v_other   uuid;
  v_mine    bigint;
  v_theirs  bigint;
  v_ver_a   uuid := (select id from public.plan_versions where user_id = qa.id(901));
begin
  -- the owner sees both accounts in every personal table (the fixture is real)
  foreach t in array v_tables loop
    execute format('select count(*) from public.%I where user_id = qa.id(901)', t) into v_mine;
    execute format('select count(*) from public.%I where user_id = qa.id(902)', t) into v_theirs;
    if v_mine <> 1 or v_theirs <> 1 then
      raise exception 'fixture: public.% holds % rows of A and % rows of B', t, v_mine, v_theirs;
    end if;
  end loop;

  -- each account sees its own rows and nobody else's
  foreach v_user in array array[qa.id(901), qa.id(902)] loop
    v_other := case when v_user = qa.id(901) then qa.id(902) else qa.id(901) end;
    perform qa.as_user(v_user);
    foreach t in array v_tables loop
      execute format('select count(*) filter (where user_id = %L), count(*) filter (where user_id <> %L) from public.%I', v_user, v_user, t)
        into v_mine, v_theirs;
      if v_mine <> 1 or v_theirs <> 0 then
        raise exception '%: sees % own and % foreign rows in public.%', v_user, v_mine, v_theirs, t;
      end if;
    end loop;
    perform qa.as_owner();
  end loop;

  -- A writes its own rows
  perform qa.as_user(qa.id(901));
  if qa.rowcount($q$update public.profiles set language = 'en' where user_id = qa.id(901)$q$) <> 1 then
    raise exception 'A cannot update its own profile';
  end if;
  perform qa.expect_ok($q$insert into public.master_plans (id, user_id, edition_id, target_scope, paths, session_minutes, agreed_estimate, status)
    values (qa.id(1101), qa.id(901), qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 10, '{}', 'paused')$q$, 'A inserts a plan');
  perform qa.expect_ok($q$insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
    values (qa.id(1101), qa.id(901), 1, 'test', date '2026-10-05')$q$, 'A inserts its first plan version');
  perform qa.as_owner();

  -- B: no row of A is visible, updatable or deletable
  perform qa.as_user(qa.id(902));
  if (select count(*) from public.master_plans where id in (qa.id(1001), qa.id(1101))) <> 0 then
    raise exception 'B sees A''s plans';
  end if;
  if qa.rowcount($q$update public.profiles set language = 'fr' where user_id = qa.id(901)$q$) <> 0
     or qa.rowcount($q$update public.master_plans set status = 'paused' where user_id = qa.id(901)$q$) <> 0
     or qa.rowcount($q$update public.learning_sessions set status = 'completed' where user_id = qa.id(901)$q$) <> 0
     or qa.rowcount($q$update public.daily_progress set active_ms = 5 where user_id = qa.id(901)$q$) <> 0
     or qa.rowcount($q$update public.target_mastery set status = 'learning' where user_id = qa.id(901)$q$) <> 0 then
    raise exception 'B updated rows of A';
  end if;
  foreach t in array v_tables loop
    perform qa.expect_error(format('delete from public.%I where user_id = qa.id(901)', t), '42501', 'B deletes A''s rows in ' || t);
    perform qa.expect_error(format('delete from public.%I', t), '42501', 'B deletes in ' || t);
  end loop;

  -- B cannot insert a row carrying A's user_id (WITH CHECK of P-OWN)
  perform qa.expect_error($q$insert into public.master_plans (user_id, edition_id, target_scope, paths, session_minutes, agreed_estimate, status)
    values (qa.id(901), qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 10, '{}', 'paused')$q$, '42501', 'B master_plans for A');
  perform qa.expect_error($q$insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
    values (qa.id(1001), qa.id(901), 2, 'test', date '2026-10-06')$q$, '42501', 'B plan_versions for A');
  perform qa.expect_error(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(901), 2, '[]', '{}', 10, '[2026-10-05,2026-10-12)')$q$, v_ver_a), '42501', 'B plan_phases for A');
  perform qa.expect_error($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(1001), 1, qa.id(5), 1, gen_random_uuid(), '[]', 1, 1, '{}')$q$, '42501', 'B offline_snapshots for A');
  perform qa.expect_error($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(5), 'placement', date '2026-10-05', '[]', 1, 'open')$q$, '42501', 'B learning_sessions for A');
  perform qa.expect_error($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(901), qa.id(2001), qa.id(5), gen_random_uuid(), qa.id(12), qa.id(9), true, 1, now())$q$, '42501', 'B attempts for A');
  perform qa.expect_error($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(2001), gen_random_uuid(), now() - interval '1 minute', now(), 1000, date '2026-10-06')$q$, '42501', 'B intervals for A');
  perform qa.expect_error($q$insert into public.daily_progress (user_id, learning_date, goal_ms) values (qa.id(901), date '2026-10-06', 600000)$q$, '42501', 'B daily_progress for A');
  perform qa.expect_error($q$insert into public.daily_completions (user_id, learning_date, reached_in_plan_id) values (qa.id(901), date '2026-10-06', qa.id(1001))$q$, '42501', 'B daily_completions for A');
  perform qa.expect_error($q$insert into public.target_mastery (user_id, plan_id, passage_id, edition_id) values (qa.id(901), qa.id(1001), qa.id(9), qa.id(5))$q$, '42501', 'B target_mastery for A');
  perform qa.expect_error($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(901), qa.id(1001), qa.id(9), qa.id(10), qa.id(4001), date '2026-10-06')$q$, '42501', 'B target_part_evidence for A');
  -- profiles have no INSERT grant at all (srv_register_account creates the row)
  perform qa.expect_error($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at) values (qa.id(902), 'UTC', 'x', now())$q$, '42501', 'B inserts a profile');

  -- forged parent identifiers with B's own user_id: the composite keys refuse them (FK checks run without RLS)
  perform qa.expect_fk($q$insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
    values (qa.id(1001), qa.id(902), 2, 'test', date '2026-10-06')$q$, 'plan_versions_plan_id_user_id_fkey');
  perform qa.expect_fk(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(902), 2, '[]', '{}', 10, '[2026-10-05,2026-10-12)')$q$, v_ver_a), 'plan_phases_plan_version_id_user_id_fkey');
  perform qa.expect_fk($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(902), qa.id(1001), 1, qa.id(5), 1, gen_random_uuid(), '[]', 1, 1, '{}')$q$, 'offline_snapshots_plan_id_user_id_edition_id_fkey');
  perform qa.expect_fk(format($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(902), qa.id(1001), %L, qa.id(5), 'game', date '2026-10-05', '[]', 1, 'open')$q$, v_ver_a), 'learning_sessions_plan_id_user_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(902), qa.id(2001), qa.id(5), gen_random_uuid(), qa.id(12), qa.id(9), true, 1, now())$q$, 'attempts_session_id_user_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(902), qa.id(2001), gen_random_uuid(), now() - interval '1 minute', now(), 1000, date '2026-10-06')$q$, 'session_activity_intervals_session_id_user_id_fkey');
  perform qa.expect_fk($q$insert into public.daily_completions (user_id, learning_date, reached_in_plan_id) values (qa.id(902), date '2026-10-06', qa.id(1001))$q$, 'daily_completions_reached_in_plan_id_user_id_fkey');
  perform qa.expect_fk($q$insert into public.target_mastery (user_id, plan_id, passage_id, edition_id) values (qa.id(902), qa.id(1001), qa.id(9), qa.id(5))$q$, 'target_mastery_plan_id_user_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(902), qa.id(1001), qa.id(9), qa.id(10), qa.id(4001), date '2026-10-06')$q$, 'target_part_evidence_user_id_plan_id_passage_id_fkey');

  -- B cannot move its own rows to A or touch columns outside the update grants (§5.2 item 5)
  perform qa.expect_error($q$update public.master_plans set user_id = qa.id(901) where user_id = qa.id(902)$q$, '42501', 'move a plan to A');
  perform qa.expect_error($q$update public.master_plans set edition_id = qa.id(5) where user_id = qa.id(902)$q$, '42501', 'master_plans.edition_id');
  perform qa.expect_error($q$update public.master_plans set created_at = now() where user_id = qa.id(902)$q$, '42501', 'master_plans.created_at');
  perform qa.expect_error($q$update public.profiles set terms_version = 'x' where user_id = qa.id(902)$q$, '42501', 'profiles.terms_version');
  perform qa.expect_error($q$update public.profiles set terms_accepted_at = now() where user_id = qa.id(902)$q$, '42501', 'profiles.terms_accepted_at');
  perform qa.expect_error($q$update public.profiles set is_demo = true where user_id = qa.id(902)$q$, '42501', 'profiles.is_demo');
  perform qa.expect_error($q$update public.profiles set user_id = qa.id(901) where user_id = qa.id(902)$q$, '42501', 'profiles.user_id');
  perform qa.expect_error($q$update public.learning_sessions set steps = '[]' where user_id = qa.id(902)$q$, '42501', 'learning_sessions.steps');
  perform qa.expect_error($q$update public.learning_sessions set learning_date = date '2026-10-09' where user_id = qa.id(902)$q$, '42501', 'learning_sessions.learning_date');
  perform qa.expect_error($q$update public.target_mastery set edition_id = qa.id(5) where user_id = qa.id(902)$q$, '42501', 'target_mastery.edition_id');
  perform qa.expect_error($q$update public.target_mastery set passage_id = qa.id(9) where user_id = qa.id(902)$q$, '42501', 'target_mastery.passage_id');
  perform qa.expect_error($q$update public.daily_progress set learning_date = date '2026-10-09' where user_id = qa.id(902)$q$, '42501', 'daily_progress.learning_date');
  foreach t in array array['plan_versions', 'plan_phases', 'offline_snapshots', 'attempts', 'session_activity_intervals',
                           'daily_completions', 'target_part_evidence'] loop
    perform qa.expect_error(format('update public.%I set user_id = user_id where user_id = qa.id(902)', t), '42501', 'append-only ' || t);
  end loop;
  -- own row updates work where granted
  if qa.rowcount($q$update public.learning_sessions set status = 'completed', elapsed_ms = 5 where user_id = qa.id(902)$q$) <> 1
     or qa.rowcount($q$update public.daily_progress set active_ms = 5, goal_ms = 600000 where user_id = qa.id(902)$q$) <> 1
     or qa.rowcount($q$update public.target_mastery set status = 'learning', consecutive_correct = 1 where user_id = qa.id(902)$q$) <> 1
     or qa.rowcount($q$update public.master_plans set session_minutes = 15 where user_id = qa.id(902)$q$) <> 1
     or qa.rowcount($q$update public.profiles set session_minutes = 5, time_zone = 'Asia/Dubai', language = 'en' where user_id = qa.id(902)$q$) <> 1 then
    raise exception 'B cannot update its own rows within the granted columns';
  end if;
  perform qa.as_owner();

  -- A's rows are untouched by everything B tried
  if (select language from public.profiles where user_id = qa.id(901)) <> 'en'
     or (select count(*) from public.master_plans where user_id = qa.id(901)) <> 2
     or (select status from public.learning_sessions where user_id = qa.id(901)) <> 'open'
     or (select active_ms from public.daily_progress where user_id = qa.id(901)) <> 0 then
    raise exception 'A''s rows changed';
  end if;

  -- the authenticated role without a subject (no valid token) sees and writes nothing
  perform qa.as_none();
  foreach t in array v_tables loop
    execute format('select count(*) from public.%I', t) into v_mine;
    if v_mine <> 0 then raise exception 'a subject-less token sees % rows of public.%', v_mine, t; end if;
  end loop;
  perform qa.expect_error($q$insert into public.daily_progress (user_id, learning_date, goal_ms) values (qa.id(901), date '2026-10-06', 600000)$q$, '42501', 'no subject: insert');
  perform qa.expect_error($q$insert into public.daily_progress (user_id, learning_date, goal_ms) values (null, date '2026-10-06', 600000)$q$, '42501', 'no subject: insert with a null user');
  perform qa.as_owner();
end;
$$;
rollback;

-- CHECK: 13 app_create_plan: pauses the active plan, inserts plan, version 1 and phases (and optional prepared sessions) in one transaction; any failing step rolls everything back
begin;
select qa.make_fixture();
select qa.make_hadith_edition();
select qa.make_users();
select qa.as_user(qa.id(901));
do $$
declare
  c_phases constant jsonb := '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-05,2026-10-12)"}]';
  v_p1 uuid;
  v_p2 uuid;
  v_p3 uuid;
  v_ver1 uuid;
begin
  -- a first plan
  v_p1 := public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null,
                                 '{"days": 5}', 'initial', '{"planner": "rules"}', date '2026-10-05', c_phases);
  if (select (status, current_version, edition_id = qa.id(5), paths::text, plan_order, session_minutes, preferred_date is null, agreed_estimate ->> 'days')::text
      from public.master_plans where id = v_p1) <> '(active,1,t,{quran},book,10,t,5)' then
    raise exception 'the plan row differs: %', (select to_jsonb(m) from public.master_plans m where id = v_p1);
  end if;
  if (select count(*) from public.plan_versions where plan_id = v_p1) <> 1
     or (select (version_no, reason_code, effective_learning_date, policy_json ->> 'planner')::text from public.plan_versions where plan_id = v_p1) <> '(1,initial,2026-10-05,rules)' then
    raise exception 'plan_versions row 1 differs';
  end if;
  v_ver1 := (select id from public.plan_versions where plan_id = v_p1);
  if (select (ordinal, goal_size, estimated_window::text, plan_version_id = v_ver1, user_id = qa.id(901))::text from public.plan_phases where plan_version_id = v_ver1)
     <> '(1,10,"[2026-10-05,2026-10-12)",t,t)' then
    raise exception 'plan_phases row differs';
  end if;
  set constraints all immediate;
  set constraints all deferred;

  -- a second plan pauses the first; the supplied plan id is used
  v_p2 := public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1,2]}', array['quran'], 'reverse', 15::smallint, date '2026-11-01',
                                 '{"days": 9}', 'initial', '{}', date '2026-10-06', c_phases, null, qa.id(1102));
  if v_p2 <> qa.id(1102) then raise exception 'the supplied plan id was not used'; end if;
  if (select status from public.master_plans where id = v_p1) <> 'paused'
     or (select status from public.master_plans where id = v_p2) <> 'active'
     or (select count(*) from public.master_plans where status = 'active') <> 1 then
    raise exception 'the first plan was not paused or two plans are active';
  end if;
  if (select plan_order from public.master_plans where id = v_p2) <> 'reverse' then
    raise exception 'reverse was not stored for the Quran edition';
  end if;

  -- failing steps roll back everything, including the pause of the active plan
  perform qa.expect_check(format($q$select public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'x', '{}', date '2026-10-07',
    '[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":0,"estimated_window":"[2026-10-05,2026-10-12)"}]'::jsonb, null, %L)$q$, qa.id(1103)), 'plan_phases_goal_size_check');
  if (select count(*) from public.master_plans) <> 2 or (select status from public.master_plans where id = v_p2) <> 'active'
     or exists (select 1 from public.master_plans where id = qa.id(1103)) then
    raise exception 'a failed app_create_plan left changes behind (plans: %)', (select jsonb_agg(status) from public.master_plans);
  end if;
  perform qa.expect_check($q$select public.app_create_plan(qa.id(21), '{"sectionOrdinals":[1]}', array['matn'], 'reverse', 10::smallint, null, '{}', 'x', '{}', date '2026-10-07',
    '[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":5,"estimated_window":"[2026-10-05,2026-10-12)"}]'::jsonb)$q$, 'master_plans_plan_order_quran_only_check');
  perform qa.expect_check($q$select public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['takhrij'], 'book', 10::smallint, null, '{}', 'x', '{}', date '2026-10-07',
    '[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":5,"estimated_window":"[2026-10-05,2026-10-12)"}]'::jsonb)$q$, 'master_plans_paths_check');
  perform qa.expect_check($q$select public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 7::smallint, null, '{}', 'x', '{}', date '2026-10-07',
    '[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":5,"estimated_window":"[2026-10-05,2026-10-12)"}]'::jsonb)$q$, 'master_plans_session_minutes_check');
  if (select status from public.master_plans where id = v_p2) <> 'active' or (select count(*) from public.master_plans) <> 2 then
    raise exception 'a rejected plan changed the account''s plans';
  end if;
  -- a failing prepared session also rolls the whole plan back
  perform qa.expect_check($q$select public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'x', '{}', date '2026-10-07',
    '[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":5,"estimated_window":"[2026-10-05,2026-10-12)"}]'::jsonb,
    '[{"kind":"bogus","learning_date":"2026-10-07","steps":[],"bank_version":1}]'::jsonb)$q$, 'learning_sessions_kind_check');
  if (select status from public.master_plans where id = v_p2) <> 'active' or (select count(*) from public.master_plans) <> 2 then
    raise exception 'a failed prepared session left plan changes behind';
  end if;

  -- a plan with prepared sessions: version and phase resolved by the function
  v_p3 := public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'initial', '{}', date '2026-10-07',
    c_phases,
    jsonb_build_array(jsonb_build_object('id', qa.id(2201), 'kind', 'daily', 'phase_ordinal', 1, 'learning_date', '2026-10-07',
      'lesson_refs', jsonb_build_array(qa.id(11)), 'question_refs', jsonb_build_array(qa.id(12)), 'steps', '[]'::jsonb, 'bank_version', 1)));
  if (select (s.status, s.kind, s.plan_id = v_p3, s.edition_id = qa.id(5), s.offline_snapshot_id is null,
              s.plan_version_id = (select id from public.plan_versions where plan_id = v_p3),
              s.phase_id = (select ph.id from public.plan_phases ph join public.plan_versions pv on pv.id = ph.plan_version_id where pv.plan_id = v_p3),
              s.lesson_refs = array[qa.id(11)], s.question_refs = array[qa.id(12)])::text
      from public.learning_sessions s where s.id = qa.id(2201)) <> '(prepared,daily,t,t,t,t,t,t,t)' then
    raise exception 'the prepared session row differs';
  end if;
  if (select count(*) from public.master_plans where status = 'active') <> 1 or (select status from public.master_plans where id = v_p2) <> 'paused' then
    raise exception 'the third plan did not pause the second';
  end if;
  set constraints all immediate;
  set constraints all deferred;

  -- no token subject: refused
  perform qa.as_none();
  perform qa.expect_error($q$select public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'x', '{}', date '2026-10-07',
    '[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":5,"estimated_window":"[2026-10-05,2026-10-12)"}]'::jsonb)$q$, '42501', 'no subject');
  perform qa.as_user(qa.id(902));
  -- another account has its own single active plan and does not touch A's
  perform public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 5::smallint, null, '{}', 'initial', '{}', date '2026-10-07', c_phases);
  if (select count(*) from public.master_plans) <> 1 then raise exception 'B sees plans of A'; end if;
  perform qa.as_owner();
  if (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1
     or (select count(*) from public.master_plans where user_id = qa.id(902) and status = 'active') <> 1
     or (select count(*) from public.master_plans where user_id = qa.id(901)) <> 3 then
    raise exception 'plans of the two accounts are mixed up';
  end if;
end;
$$;
rollback;

-- CHECK: 14 app_revise_plan: checks the expected version, appends the next version and its phases, mirrors the values on master_plans, keeps the status; a stale version or a failing step changes nothing
begin;
select qa.make_fixture();
select qa.make_hadith_edition();
select qa.make_users();
select qa.as_user(qa.id(901));
do $$
declare
  c_phases constant jsonb := '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-05,2026-10-12)"}]';
  c_phases2 constant jsonb := '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-06,2026-10-09)"},{"ordinal":2,"section_refs":[2],"unit_range":{},"goal_size":6,"estimated_window":"[2026-10-09,2026-10-12)"}]';
  v_p1 uuid;
  v_p2 uuid;
  v_h  uuid;
  v_new integer;
begin
  v_p1 := public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{"days": 5}', 'initial', '{"v": 1}', date '2026-10-05', c_phases);

  v_new := public.app_revise_plan(v_p1, 1, '{"sectionOrdinals":[1,2]}', array['quran'], 'reverse', 15::smallint, date '2026-10-30',
                                  '{"days": 9}', 'revision', '{"v": 2}', date '2026-10-06', c_phases2);
  if v_new <> 2 then raise exception 'app_revise_plan returned %', v_new; end if;
  if (select (current_version, plan_order, session_minutes, preferred_date, target_scope::text, agreed_estimate ->> 'days', status)::text
      from public.master_plans where id = v_p1) <> '(2,reverse,15,2026-10-30,"{""sectionOrdinals"": [1, 2]}",9,active)' then
    raise exception 'the mirrored plan values differ: %', (select to_jsonb(m) from public.master_plans m where id = v_p1);
  end if;
  if (select count(*) from public.plan_versions where plan_id = v_p1) <> 2
     or (select (reason_code, effective_learning_date, policy_json ->> 'v')::text from public.plan_versions where plan_id = v_p1 and version_no = 2) <> '(revision,2026-10-06,2)'
     or (select (reason_code, effective_learning_date, policy_json ->> 'v')::text from public.plan_versions where plan_id = v_p1 and version_no = 1) <> '(initial,2026-10-05,1)' then
    raise exception 'plan_versions history differs (version 1 must stay as it was)';
  end if;
  if (select count(*) from public.plan_phases ph join public.plan_versions pv on pv.id = ph.plan_version_id where pv.plan_id = v_p1 and pv.version_no = 2) <> 2
     or (select count(*) from public.plan_phases ph join public.plan_versions pv on pv.id = ph.plan_version_id where pv.plan_id = v_p1 and pv.version_no = 1) <> 1 then
    raise exception 'the phases of the versions differ';
  end if;
  set constraints all immediate;
  set constraints all deferred;

  -- a stale expected version is a conflict and changes nothing
  perform qa.expect_error($q$select public.app_revise_plan(qa.id(1), 1, '{"sectionOrdinals":[1]}', array['quran'], 'book', 5::smallint, null, '{}', 'x', '{}', date '2026-10-07', '[]'::jsonb)$q$, 'P0002', 'unknown plan');
  perform qa.expect_error(format($q$select public.app_revise_plan(%L, 1, '{"sectionOrdinals":[1]}', array['quran'], 'book', 5::smallint, null, '{}', 'x', '{}', date '2026-10-07', '[]'::jsonb)$q$, v_p1), 'QT002', 'stale version');
  if (select current_version from public.master_plans where id = v_p1) <> 2 or (select count(*) from public.plan_versions where plan_id = v_p1) <> 2 then
    raise exception 'a stale revision changed the plan';
  end if;

  -- failing steps roll back everything
  perform qa.expect_check(format($q$select public.app_revise_plan(%L, 2, '{"sectionOrdinals":[1]}', array['quran'], 'book', 5::smallint, null, '{}', 'x', '{}', date '2026-10-07',
    '[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":0,"estimated_window":"[2026-10-05,2026-10-12)"}]'::jsonb)$q$, v_p1), 'plan_phases_goal_size_check');
  perform qa.expect_check(format($q$select public.app_revise_plan(%L, 2, '{"sectionOrdinals":[1]}', array['takhrij'], 'book', 5::smallint, null, '{}', 'x', '{}', date '2026-10-07', '[]'::jsonb)$q$, v_p1), 'master_plans_paths_check');
  if (select (current_version, plan_order, session_minutes)::text from public.master_plans where id = v_p1) <> '(2,reverse,15)'
     or (select count(*) from public.plan_versions where plan_id = v_p1) <> 2 then
    raise exception 'a failed revision left changes behind';
  end if;

  -- a hadith plan cannot be revised to the reverse order (guard_plan_order)
  v_h := public.app_create_plan(qa.id(21), '{"sectionOrdinals":[1]}', array['matn'], 'book', 10::smallint, null, '{}', 'initial', '{}', date '2026-10-05', c_phases);
  perform qa.expect_check(format($q$select public.app_revise_plan(%L, 1, '{"sectionOrdinals":[1]}', array['matn'], 'reverse', 10::smallint, null, '{}', 'x', '{}', date '2026-10-07', '[]'::jsonb)$q$, v_h), 'master_plans_plan_order_quran_only_check');
  if (select current_version from public.master_plans where id = v_h) <> 1 then raise exception 'the hadith plan changed'; end if;

  -- creating the hadith plan paused the Quran plan; a paused plan can be revised and stays paused
  if (select status from public.master_plans where id = v_p1) <> 'paused' then raise exception 'the Quran plan is not paused'; end if;
  v_new := public.app_revise_plan(v_p1, 2, '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'revision', '{}', date '2026-10-08', c_phases);
  if v_new <> 3 or (select status from public.master_plans where id = v_p1) <> 'paused' then
    raise exception 'revising a paused plan did not keep it paused (version %)', v_new;
  end if;
  set constraints all immediate;
  set constraints all deferred;

  -- another account cannot revise this plan; no token subject is refused
  perform qa.as_user(qa.id(902));
  perform qa.expect_error(format($q$select public.app_revise_plan(%L, 3, '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'x', '{}', date '2026-10-09', '[]'::jsonb)$q$, v_p1), 'P0002', 'revising another account''s plan');
  perform qa.as_none();
  perform qa.expect_error(format($q$select public.app_revise_plan(%L, 3, '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'x', '{}', date '2026-10-09', '[]'::jsonb)$q$, v_p1), '42501', 'no subject');
  perform qa.as_owner();
  if (select current_version from public.master_plans where id = v_p1) <> 3 then raise exception 'the plan changed'; end if;
end;
$$;
rollback;

-- CHECK: 15 app_open_session: the daily session is an atomic get-or-create (A-01); game and placement always create; the plan version must be the one in force
begin;
select qa.make_fixture();
select qa.make_users();
select qa.as_user(qa.id(901));
do $$
declare
  c_phases constant jsonb := '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-05,2026-10-12)"}]';
  v_p1 uuid;
  v_ver1 uuid;
  v_ver2 uuid;
  v_id1 uuid;
  v_id2 uuid;
  v_new boolean;
  v_g1 uuid;
  v_g2 uuid;
begin
  v_p1 := public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'initial', '{}', date '2026-10-05', c_phases);
  v_ver1 := (select id from public.plan_versions where plan_id = v_p1 and version_no = 1);

  -- first call creates (201), second returns the existing session (200)
  select s.session_id, s.created into v_id1, v_new
  from public.app_open_session('daily', v_p1, v_ver1, null, qa.id(5), date '2026-10-05', array[qa.id(11)], array[qa.id(12)], '[{"type":"learn"}]', 1) s;
  if v_new is not true then raise exception 'the first daily call did not create'; end if;
  select s.session_id, s.created into v_id2, v_new
  from public.app_open_session('daily', v_p1, v_ver1, null, qa.id(5), date '2026-10-05', '{}', '{}', '[]', 1) s;
  if v_new is not false or v_id2 <> v_id1 then raise exception 'the second daily call did not return the existing session'; end if;
  if (select count(*) from public.learning_sessions where kind = 'daily') <> 1 then raise exception 'two daily sessions exist'; end if;
  -- the stored row is the first call's snapshot (the second call wrote nothing)
  if (select (status, steps::text, lesson_refs = array[qa.id(11)], question_refs = array[qa.id(12)], bank_version, elapsed_ms, offline_snapshot_id is null, plan_version_id = v_ver1)::text
      from public.learning_sessions where id = v_id1) <> '(open,"[{""type"": ""learn""}]",t,t,1,0,t,t)' then
    raise exception 'the daily session row differs: %', (select to_jsonb(s) from public.learning_sessions s where id = v_id1);
  end if;

  -- another date creates; a supplied id is used
  select s.session_id, s.created into v_id2, v_new
  from public.app_open_session('daily', v_p1, v_ver1, null, qa.id(5), date '2026-10-06', '{}', '{}', '[]', 1, null, qa.id(2301)) s;
  if v_new is not true or v_id2 <> qa.id(2301) then raise exception 'a daily session of another date was not created with the supplied id'; end if;

  -- game: always a new session; placement: no plan, with a rating
  select s.session_id into v_g1 from public.app_open_session('game', v_p1, v_ver1, null, qa.id(5), date '2026-10-05', '{}', '{}', '[]', 1) s;
  select s.session_id into v_g2 from public.app_open_session('game', v_p1, v_ver1, null, qa.id(5), date '2026-10-05', '{}', '{}', '[]', 1) s;
  if v_g1 = v_g2 then raise exception 'two game calls returned one session'; end if;
  select s.session_id, s.created into v_id2, v_new
  from public.app_open_session('placement', null, null, null, qa.id(5), date '2026-10-05', '{}', '{}', '[]', 1, 'some') s;
  if v_new is not true or (select (kind, self_rating, plan_id is null, status)::text from public.learning_sessions where id = v_id2) <> '(placement,some,t,open)' then
    raise exception 'the placement session differs';
  end if;
  perform qa.expect_check($q$select public.app_open_session('game', null, null, null, qa.id(5), date '2026-10-05', '{}', '{}', '[]', 1)$q$, 'learning_sessions_plan_required_check');

  -- completing the daily session lets a new one be created for the same date
  if public.app_complete_session(v_id1, 1000) is not true then raise exception 'completion failed'; end if;
  select s.session_id, s.created into v_id2, v_new
  from public.app_open_session('daily', v_p1, v_ver1, null, qa.id(5), date '2026-10-05', '{}', '{}', '[]', 1) s;
  if v_new is not true or v_id2 = v_id1 then raise exception 'no new daily session after completion'; end if;
  if (select count(*) from public.learning_sessions where kind = 'daily' and learning_date = date '2026-10-05') <> 2 then
    raise exception 'expected one completed and one open daily session';
  end if;

  -- after a revision the old version is stale (QT002), the new one works
  perform public.app_revise_plan(v_p1, 1, '{"sectionOrdinals":[1]}', array['quran'], 'book', 15::smallint, null, '{}', 'revision', '{}', date '2026-10-07', c_phases);
  v_ver2 := (select id from public.plan_versions where plan_id = v_p1 and version_no = 2);
  perform qa.expect_error(format($q$select public.app_open_session('daily', %L, %L, null, qa.id(5), date '2026-10-08', '{}', '{}', '[]', 1)$q$, v_p1, v_ver1), 'QT002', 'stale plan version');
  select s.created into v_new from public.app_open_session('daily', v_p1, v_ver2, null, qa.id(5), date '2026-10-08', '{}', '{}', '[]', 1) s;
  if v_new is not true then raise exception 'the current version was refused'; end if;
  -- a version of another plan is refused as well
  perform qa.expect_error(format($q$select public.app_open_session('daily', %L, qa.id(999), null, qa.id(5), date '2026-10-09', '{}', '{}', '[]', 1)$q$, v_p1), 'QT002', 'unknown version of the plan');

  -- another account cannot open a session on this plan; no subject is refused
  perform qa.as_user(qa.id(902));
  perform qa.expect_error(format($q$select public.app_open_session('daily', %L, %L, null, qa.id(5), date '2026-10-09', '{}', '{}', '[]', 1)$q$, v_p1, v_ver2), 'P0002', 'another account''s plan');
  perform qa.as_none();
  perform qa.expect_error(format($q$select public.app_open_session('daily', %L, %L, null, qa.id(5), date '2026-10-09', '{}', '{}', '[]', 1)$q$, v_p1, v_ver2), '42501', 'no subject');
  perform qa.as_owner();
end;
$$;
rollback;

-- CHECK: 16 app_apply_events: attempts, intervals, mastery, evidence, daily progress and completion commit together; duplicates change nothing; a failing step rolls back everything (§14 checks 7 and 10)
begin;
select qa.make_fixture();
select qa.make_passage2();
select qa.make_users();
select qa.as_user(qa.id(901));
do $$
declare
  c_phases constant jsonb := '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-05,2026-10-12)"}]';
  v_p1 uuid;
  v_ver1 uuid;
  v_sid uuid;
  v_res jsonb;
  v_e1 jsonb; v_e2 jsonb; v_daily jsonb;
  v_dup jsonb;
  v_before_attempts bigint;
begin
  v_p1 := public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'initial', '{}', date '2026-10-05', c_phases);
  v_ver1 := (select id from public.plan_versions where plan_id = v_p1 and version_no = 1);
  select s.session_id into v_sid from public.app_open_session('daily', v_p1, v_ver1, null, qa.id(5), date '2026-10-05', '{}', '{}', '[]', 1) s;

  v_e1 := jsonb_build_object(
    'attempt', jsonb_build_object('client_event_id', qa.id(9001), 'question_id', qa.id(12), 'passage_id', qa.id(9),
      'correct', true, 'assisted', false, 'duration_ms', 1500, 'occurred_at', '2026-10-05T07:03:10Z'),
    'mastery', jsonb_build_object('plan_id', v_p1, 'passage_id', qa.id(9), 'status', 'learning', 'consecutive_correct', 1,
      'initial_success_at', null, 'initial_learning_date', null, 'review_stage', 0, 'next_review_due', null,
      'last_review_date', null, 'confirmed_at', null, 'first_confirmed_at', null, 'maintenance_stage', 0,
      'lapse_count', 0, 'error_part_ids', '[]'::jsonb),
    'evidence', jsonb_build_array(jsonb_build_object('plan_id', v_p1, 'passage_id', qa.id(9), 'part_id', qa.id(10), 'learning_date', '2026-10-05')));
  v_e2 := jsonb_build_object('interval', jsonb_build_object('client_event_id', qa.id(9002),
      'started_at', '2026-10-05T07:00:05Z', 'ended_at', '2026-10-05T07:03:05Z', 'active_ms', 180000, 'learning_date', '2026-10-05'));
  v_daily := jsonb_build_object('learning_date', '2026-10-05', 'active_ms', 180000, 'goal_ms', 180000, 'completed', true, 'reached_in_plan_id', v_p1);

  v_res := public.app_apply_events(v_sid, jsonb_build_array(v_e1, v_e2), v_daily);
  if v_res <> '{"outcomes": ["acknowledged", "acknowledged"], "daily_completion_inserted": true}'::jsonb then
    raise exception 'unexpected result %', v_res;
  end if;
  if (select count(*) from public.attempts) <> 1 or (select count(*) from public.session_activity_intervals) <> 1
     or (select count(*) from public.target_mastery) <> 1 or (select count(*) from public.target_part_evidence) <> 1
     or (select count(*) from public.daily_progress) <> 1 or (select count(*) from public.daily_completions) <> 1 then
    raise exception 'the batch did not commit every row';
  end if;
  if (select (a.correct, a.assisted, a.edition_id = qa.id(5), a.session_id = v_sid, a.duration_ms, a.error_kind is null)::text from public.attempts a) <> '(t,f,t,t,1500,t)'
     or (select (status, consecutive_correct, edition_id = qa.id(5))::text from public.target_mastery) <> '(learning,1,t)'
     or (select (active_ms, goal_ms)::text from public.daily_progress) <> '(180000,180000)'
     or (select (part_id = qa.id(10), attempt_id = (select id from public.attempts))::text from public.target_part_evidence) <> '(t,t)'
     or (select reached_in_plan_id from public.daily_completions) <> v_p1 then
    raise exception 'the committed rows differ';
  end if;

  -- the same batch again: duplicates, no second effect; a different mastery payload for a duplicate is ignored
  v_dup := jsonb_set(v_e1, '{mastery,consecutive_correct}', '5');
  v_res := public.app_apply_events(v_sid, jsonb_build_array(v_dup, v_e2),
             jsonb_build_object('learning_date', '2026-10-05', 'active_ms', 1000, 'goal_ms', 180000, 'completed', true, 'reached_in_plan_id', v_p1));
  if v_res <> '{"outcomes": ["duplicate", "duplicate"], "daily_completion_inserted": false}'::jsonb then
    raise exception 'a repeated batch: unexpected result %', v_res;
  end if;
  if (select count(*) from public.attempts) <> 1 or (select consecutive_correct from public.target_mastery) <> 1
     or (select count(*) from public.target_part_evidence) <> 1 or (select count(*) from public.daily_completions) <> 1
     or (select active_ms from public.daily_progress) <> 180000 then
    raise exception 'a repeated batch changed totals';
  end if;

  -- a failing step rolls back the whole call: attempt, mastery, evidence, interval, daily rows
  v_before_attempts := (select count(*) from public.attempts);
  perform qa.expect_check(format($q$select public.app_apply_events(%L, %L::jsonb)$q$, v_sid,
    jsonb_build_array(
      jsonb_set(jsonb_set(v_e1, '{attempt,client_event_id}', to_jsonb(qa.id(9003)::text)), '{mastery,consecutive_correct}', '2'),
      jsonb_build_object('interval', jsonb_build_object('client_event_id', qa.id(9004), 'started_at', '2026-10-05T07:00:00Z',
        'ended_at', '2026-10-05T07:01:00Z', 'active_ms', 99999999, 'learning_date', '2026-10-05')))::text),
    'session_activity_intervals_active_ms_range_check');
  perform qa.expect_fk(format($q$select public.app_apply_events(%L, %L::jsonb)$q$, v_sid,
    jsonb_build_array(jsonb_build_object(
      'attempt', jsonb_build_object('client_event_id', qa.id(9005), 'question_id', qa.id(12), 'passage_id', qa.id(9),
        'correct', true, 'duration_ms', 1, 'occurred_at', '2026-10-05T07:04:00Z'),
      'mastery', v_e1 -> 'mastery',
      'evidence', jsonb_build_array(jsonb_build_object('plan_id', v_p1, 'passage_id', qa.id(9), 'part_id', qa.id(32), 'learning_date', '2026-10-05'))))::text),
    'target_part_evidence_part_id_passage_id_fkey');
  perform qa.expect_check(format($q$select public.app_apply_events(%L, %L::jsonb, %L::jsonb)$q$, v_sid,
    jsonb_build_array(v_e2 || jsonb_build_object('interval', jsonb_build_object('client_event_id', qa.id(9006),
      'started_at', '2026-10-05T08:00:00Z', 'ended_at', '2026-10-05T08:01:00Z', 'active_ms', 60000, 'learning_date', '2026-10-05')))::text,
    jsonb_build_object('learning_date', '2026-10-05', 'active_ms', 240000, 'goal_ms', 0)::text),
    'daily_progress_goal_ms_check');
  if (select count(*) from public.attempts) <> v_before_attempts or (select count(*) from public.session_activity_intervals) <> 1
     or (select consecutive_correct from public.target_mastery) <> 1 or (select active_ms from public.daily_progress) <> 180000
     or exists (select 1 from public.attempts where client_event_id in (qa.id(9003), qa.id(9005)))
     or exists (select 1 from public.session_activity_intervals where client_event_id in (qa.id(9004), qa.id(9006))) then
    raise exception 'a failed app_apply_events left changes behind';
  end if;

  -- the upsert path: a second answer updates the mastery row; evidence of an already covered part is ignored
  v_res := public.app_apply_events(v_sid, jsonb_build_array(
    jsonb_set(jsonb_set(v_e1, '{attempt,client_event_id}', to_jsonb(qa.id(9007)::text)), '{mastery,consecutive_correct}', '2')));
  if v_res -> 'outcomes' <> '["acknowledged"]'::jsonb or (select consecutive_correct from public.target_mastery) <> 2
     or (select count(*) from public.target_part_evidence) <> 1 or (select count(*) from public.attempts) <> 2 then
    raise exception 'the second answer was not applied as an update (%)', v_res;
  end if;
  -- daily progress only grows; goal updates; a later larger figure replaces
  perform public.app_apply_events(v_sid, '[]'::jsonb, jsonb_build_object('learning_date', '2026-10-05', 'active_ms', 200000, 'goal_ms', 180000));
  if (select active_ms from public.daily_progress) <> 200000 then raise exception 'daily progress did not grow'; end if;

  -- malformed input
  perform qa.expect_error(format($q$select public.app_apply_events(%L, '{"attempt": {}}'::jsonb)$q$, v_sid), '22023', 'p_events not an array');
  perform qa.expect_error(format($q$select public.app_apply_events(%L, jsonb_build_array(%L::jsonb))$q$, v_sid, (v_e1 || v_e2)::text), '22023', 'attempt and interval together');
  perform qa.expect_error(format($q$select public.app_apply_events(%L, jsonb_build_array('{}'::jsonb))$q$, v_sid), '22023', 'neither attempt nor interval');

  -- another account's session, an unknown session and no subject
  perform qa.as_user(qa.id(902));
  perform qa.expect_error(format($q$select public.app_apply_events(%L, '[]'::jsonb)$q$, v_sid), 'P0002', 'another account''s session');
  perform qa.as_none();
  perform qa.expect_error(format($q$select public.app_apply_events(%L, '[]'::jsonb)$q$, v_sid), '42501', 'no subject');
  perform qa.as_owner();
end;
$$;
rollback;
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
select qa.make_session(qa.id(2401), qa.id(901), qa.id(101), 'game', date '2026-10-05', 'prepared');
select qa.as_user(qa.id(901));
do $$
declare
  v_res jsonb;
begin
  -- the first accepted event opens a prepared session (A-12)
  v_res := public.app_apply_events(qa.id(2401), jsonb_build_array(jsonb_build_object('interval', jsonb_build_object(
    'client_event_id', qa.id(9101), 'started_at', '2026-10-05T07:00:00Z', 'ended_at', '2026-10-05T07:01:00Z', 'active_ms', 60000, 'learning_date', '2026-10-05'))),
    null, true);
  if (select status from public.learning_sessions where id = qa.id(2401)) <> 'open' then raise exception 'the prepared session was not opened'; end if;
  -- without the flag the status is left alone
  update public.learning_sessions set status = 'completed' where id = qa.id(2401);
  perform public.app_apply_events(qa.id(2401), '[]'::jsonb, null, false);
  if (select status from public.learning_sessions where id = qa.id(2401)) <> 'completed' then raise exception 'the status changed without p_open_session'; end if;
end;
$$;
select qa.as_owner();
rollback;

-- CHECK: 17 app_complete_session and app_create_offline_snapshot: idempotent completion; the snapshot and its prepared sessions commit together and a repeated operation id returns the same snapshot (§14 check 7)
begin;
select qa.make_fixture();
select qa.make_users();
select qa.as_user(qa.id(901));
do $$
declare
  c_phases constant jsonb := '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-05,2026-10-12)"}]';
  v_p1 uuid;
  v_ver1 uuid;
  v_phase uuid;
  v_sid uuid;
  v_snap uuid;
  v_new boolean;
  v_refs constant jsonb := '["00000000-0000-4000-8000-000000000009"]';
  v_sessions jsonb;
begin
  v_p1 := public.app_create_plan(qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10::smallint, null, '{}', 'initial', '{}', date '2026-10-05', c_phases);
  v_ver1 := (select id from public.plan_versions where plan_id = v_p1 and version_no = 1);
  v_phase := (select id from public.plan_phases where plan_version_id = v_ver1);

  -- app_complete_session: sets status and elapsed_ms once; repeating returns false and changes nothing
  select s.session_id into v_sid from public.app_open_session('daily', v_p1, v_ver1, null, qa.id(5), date '2026-10-05', '{}', '{}', '[]', 1) s;
  if public.app_complete_session(v_sid, 540000) is not true then raise exception 'the first completion did not report true'; end if;
  if (select (status, elapsed_ms)::text from public.learning_sessions where id = v_sid) <> '(completed,540000)' then raise exception 'completion did not store status and elapsed_ms'; end if;
  v_new := public.app_complete_session(v_sid, 1);
  if v_new is not false or (select elapsed_ms from public.learning_sessions where id = v_sid) <> 540000 then
    raise exception 'a repeated completion changed the session';
  end if;
  perform qa.expect_error($q$select public.app_complete_session(gen_random_uuid(), 0)$q$, 'P0002', 'unknown session');
  select s.session_id into v_sid from public.app_open_session('daily', v_p1, v_ver1, null, qa.id(5), date '2026-10-09', '{}', '{}', '[]', 1) s;
  perform qa.expect_check(format($q$select public.app_complete_session(%L, -1)$q$, v_sid), 'learning_sessions_elapsed_ms_check');
  if (select status from public.learning_sessions where id = v_sid) <> 'open' then raise exception 'a failed completion changed the session'; end if;

  -- an open daily session to coexist with the offline-prepared daily session below
  perform public.app_open_session('daily', v_p1, v_ver1, null, qa.id(5), date '2026-10-06', '{}', '{}', '[]', 1);

  v_sessions := jsonb_build_array(
    jsonb_build_object('id', qa.id(2501), 'kind', 'daily', 'phase_id', v_phase, 'learning_date', '2026-10-06',
      'lesson_refs', jsonb_build_array(qa.id(11)), 'question_refs', jsonb_build_array(qa.id(12)), 'steps', '[]'::jsonb, 'bank_version', 1),
    jsonb_build_object('id', qa.id(2502), 'kind', 'game', 'learning_date', '2026-10-06', 'steps', '[]'::jsonb, 'bank_version', 1));
  select s.snapshot_id, s.created into v_snap, v_new
  from public.app_create_offline_snapshot(v_p1, 1, 1, qa.id(401), v_refs, 1, 1, '{"preparedSessions": []}', v_sessions, qa.id(3501)) s;
  if v_snap <> qa.id(3501) or v_new is not true then raise exception 'the snapshot was not created with the supplied id'; end if;
  if (select (plan_version, bank_version, edition_id = qa.id(5), client_operation_id = qa.id(401), schema_version, protocol_version, download_target_refs = v_refs)::text
      from public.offline_snapshots where id = v_snap) <> '(1,1,t,t,1,1,t)' then
    raise exception 'the snapshot row differs';
  end if;
  if (select count(*) from public.learning_sessions where offline_snapshot_id = v_snap and status = 'prepared' and plan_version_id = v_ver1 and edition_id = qa.id(5)) <> 2
     or (select phase_id from public.learning_sessions where id = qa.id(2501)) is distinct from v_phase then
    raise exception 'the prepared sessions differ';
  end if;
  -- the offline-prepared daily session coexists with the open daily session of the same date
  if (select count(*) from public.learning_sessions where kind = 'daily' and learning_date = date '2026-10-06') <> 2 then
    raise exception 'the offline-prepared daily session does not coexist with the open one';
  end if;

  -- the same operation id and input: the same snapshot, no new session
  select s.snapshot_id, s.created into v_snap, v_new
  from public.app_create_offline_snapshot(v_p1, 1, 1, qa.id(401), v_refs, 1, 1, '{"preparedSessions": []}', v_sessions, qa.id(3502)) s;
  if v_snap <> qa.id(3501) or v_new is not false then raise exception 'a repeated operation did not return the same snapshot'; end if;
  if (select count(*) from public.offline_snapshots) <> 1 or (select count(*) from public.learning_sessions where offline_snapshot_id is not null) <> 2 then
    raise exception 'a repeated operation created rows';
  end if;
  -- the same operation id with another input is a conflict
  perform qa.expect_error(format($q$select public.app_create_offline_snapshot(%L, 1, 1, qa.id(401), '["00000000-0000-4000-8000-000000000031"]'::jsonb, 1, 1, '{}'::jsonb)$q$, v_p1), 'QT004', 'changed input');

  -- failing steps roll the snapshot back
  perform qa.expect_check(format($q$select public.app_create_offline_snapshot(%L, 1, 1, qa.id(402), '[]'::jsonb, 1, 1, '{}'::jsonb,
    '[{"kind":"bogus","learning_date":"2026-10-07","steps":[],"bank_version":1}]'::jsonb)$q$, v_p1), 'learning_sessions_kind_check');
  perform qa.expect_check(format($q$select public.app_create_offline_snapshot(%L, 1, 1, qa.id(403), '[]'::jsonb, 1, 1, '[]'::jsonb)$q$, v_p1), 'offline_snapshots_payload_check');
  if exists (select 1 from public.offline_snapshots where client_operation_id in (qa.id(402), qa.id(403))) then
    raise exception 'a failed snapshot left a row behind';
  end if;

  -- a revised plan: the old version is stale for a new snapshot
  perform public.app_revise_plan(v_p1, 1, '{"sectionOrdinals":[1]}', array['quran'], 'book', 15::smallint, null, '{}', 'revision', '{}', date '2026-10-07', c_phases);
  perform qa.expect_error(format($q$select public.app_create_offline_snapshot(%L, 1, 1, qa.id(404), '[]'::jsonb, 1, 1, '{}'::jsonb)$q$, v_p1), 'QT002', 'stale plan version');
  select s.created into v_new from public.app_create_offline_snapshot(v_p1, 2, 1, qa.id(405), '[]'::jsonb, 1, 1, '{}'::jsonb) s;
  if v_new is not true then raise exception 'a snapshot for the version in force was refused'; end if;

  -- another account, unknown plan, no subject
  perform qa.as_user(qa.id(902));
  perform qa.expect_error(format($q$select public.app_create_offline_snapshot(%L, 2, 1, qa.id(406), '[]'::jsonb, 1, 1, '{}'::jsonb)$q$, v_p1), 'P0002', 'another account''s plan');
  perform qa.expect_error(format($q$select public.app_complete_session(%L, 1)$q$, v_sid), 'P0002', 'another account''s session');
  perform qa.as_none();
  perform qa.expect_error(format($q$select public.app_create_offline_snapshot(%L, 2, 1, qa.id(406), '[]'::jsonb, 1, 1, '{}'::jsonb)$q$, v_p1), '42501', 'no subject');
  perform qa.expect_error(format($q$select public.app_complete_session(%L, 1)$q$, v_sid), '42501', 'complete: no subject');
  perform qa.as_owner();
end;
$$;
rollback;

-- CHECK: 18 srv_register_account, srv_find_handle, srv_accept_terms: one transaction, quiet lookups, SQLSTATEs for duplicates and invalid values, no partial rows
begin;
select qa.make_users();
do $$
declare
  c_alias1 constant text := 'u.11111111-1111-4111-8111-111111111111@qatra.invalid';
  c_alias2 constant text := 'u.22222222-2222-4222-8222-222222222222@qatra.invalid';
  c_alias3 constant text := 'u.33333333-3333-4333-8333-333333333333@qatra.invalid';
  v_ts timestamptz;
  v_before timestamptz;
begin
  perform public.srv_register_account(qa.id(901), 'Alice', 'alice', c_alias1, false, '2026-10-04', 'ar', 'Asia/Dubai', decode(repeat('a1', 32), 'hex'));
  perform public.srv_register_account(qa.id(902), 'Demo', 'demo', c_alias2, true, '2026-10-04', 'en', 'UTC', decode(repeat('a2', 32), 'hex'));

  if (select (username_display, username_normalized, internal_auth_alias, auth_epoch, is_demo)::text from private.account_handles where user_id = qa.id(901))
     <> '(Alice,alice,' || c_alias1 || ',0,f)' then
    raise exception 'the handle row differs';
  end if;
  if (select (language, time_zone, session_minutes, terms_version, terms_accepted_at > now() - interval '1 minute', is_demo, pending_settings is null, reminder_settings::text)::text
      from public.profiles where user_id = qa.id(901)) <> '(ar,Asia/Dubai,10,2026-10-04,t,f,t,{})' then
    raise exception 'the profile row differs';
  end if;
  if (select count(*) from private.recovery_codes where user_id = qa.id(901) and consumed_at is null and code_hash = decode(repeat('a1', 32), 'hex')) <> 1 then
    raise exception 'the first active recovery code is missing';
  end if;
  -- the demo flag is set by the server and mirrored in the profile
  if not (select is_demo from private.account_handles where user_id = qa.id(902)) or not (select is_demo from public.profiles where user_id = qa.id(902))
     or (select language from public.profiles where user_id = qa.id(902)) <> 'en' then
    raise exception 'the demo account differs';
  end if;

  -- srv_find_handle: by the normalized name only; unknown names answer zero rows
  if (select count(*) from public.srv_find_handle('alice')) <> 1
     or (select (user_id, username_display, internal_auth_alias, auth_epoch, is_demo)::text from public.srv_find_handle('alice')) <> '(' || qa.id(901) || ',Alice,' || c_alias1 || ',0,f)' then
    raise exception 'srv_find_handle differs';
  end if;
  if exists (select 1 from public.srv_find_handle('nobody')) or exists (select 1 from public.srv_find_handle('Alice')) or exists (select 1 from public.srv_find_handle('')) then
    raise exception 'srv_find_handle answered for an unknown name';
  end if;
  if not (select is_demo from public.srv_find_handle('demo')) then raise exception 'the demo flag is not returned'; end if;

  -- duplicates and invalid values: the SQLSTATE the backend maps, and no partial rows of the failed account
  perform qa.expect_unique(format($q$select public.srv_register_account(qa.id(903), 'Alice2', 'alice', %L, false, '2026-10-04', 'ar', 'UTC', decode(repeat('a3', 32), 'hex'))$q$, c_alias3), 'account_handles_username_normalized_key');
  perform qa.expect_unique($q$select public.srv_register_account(qa.id(903), 'Carol', 'carol', 'u.11111111-1111-4111-8111-111111111111@qatra.invalid', false, '2026-10-04', 'ar', 'UTC', decode(repeat('a3', 32), 'hex'))$q$, 'account_handles_internal_auth_alias_key');
  perform qa.expect_check(format($q$select public.srv_register_account(qa.id(903), 'Carol', 'carol', %L, false, '2026-10-04', 'ar', 'Mars/Olympus', decode(repeat('a3', 32), 'hex'))$q$, c_alias3), 'profiles_time_zone_known_check');
  perform qa.expect_check(format($q$select public.srv_register_account(qa.id(903), 'Carol', 'carol', %L, false, '2026-10-04', 'fr', 'UTC', decode(repeat('a3', 32), 'hex'))$q$, c_alias3), 'profiles_language_check');
  perform qa.expect_check(format($q$select public.srv_register_account(qa.id(903), 'Carol', 'carol', %L, false, '', 'ar', 'UTC', decode(repeat('a3', 32), 'hex'))$q$, c_alias3), 'profiles_terms_version_check');
  perform qa.expect_check(format($q$select public.srv_register_account(qa.id(903), 'Carol', 'carol', %L, false, '2026-10-04', 'ar', 'UTC', decode(repeat('a3', 16), 'hex'))$q$, c_alias3), 'recovery_codes_code_hash_length_check');
  perform qa.expect_check(format($q$select public.srv_register_account(qa.id(903), 'ca', 'ca', %L, false, '2026-10-04', 'ar', 'UTC', decode(repeat('a3', 32), 'hex'))$q$, c_alias3), 'account_handles_username_display_length_check');
  perform qa.expect_fk(format($q$select public.srv_register_account(qa.id(950), 'Dave', 'dave', %L, false, '2026-10-04', 'ar', 'UTC', decode(repeat('a4', 32), 'hex'))$q$, c_alias3), 'account_handles_user_id_fkey');
  if exists (select 1 from private.account_handles where user_id in (qa.id(903), qa.id(950)))
     or exists (select 1 from public.profiles where user_id in (qa.id(903), qa.id(950)))
     or exists (select 1 from private.recovery_codes where user_id in (qa.id(903), qa.id(950)))
     or (select count(*) from private.account_handles) <> 2 or (select count(*) from private.recovery_codes) <> 2 then
    raise exception 'a failed registration left partial rows';
  end if;
  -- the same user twice
  perform qa.expect_error(format($q$select public.srv_register_account(qa.id(901), 'Other', 'other', %L, false, '2026-10-04', 'ar', 'UTC', decode(repeat('a5', 32), 'hex'))$q$, c_alias3), '23505', 'the same user twice', 'account_handles_pkey');

  -- srv_accept_terms: server time, the new version
  v_before := (select terms_accepted_at from public.profiles where user_id = qa.id(901));
  v_ts := public.srv_accept_terms(qa.id(901), '2026-11-01');
  if (select (terms_version, terms_accepted_at = v_ts)::text from public.profiles where user_id = qa.id(901)) <> '(2026-11-01,t)' or v_ts < v_before then
    raise exception 'srv_accept_terms did not store the version and server time';
  end if;
  if (select terms_version from public.profiles where user_id = qa.id(902)) <> '2026-10-04' then raise exception 'another account''s consent changed'; end if;
  perform qa.expect_error($q$select public.srv_accept_terms(qa.id(950), '2026-11-01')$q$, 'P0002', 'unknown account');
  perform qa.expect_check($q$select public.srv_accept_terms(qa.id(901), '')$q$, 'profiles_terms_version_check');
end;
$$;
rollback;

-- CHECK: 19 recovery functions: verify, atomic reservation (one winner), grant execution, consume (new code, epoch, sessions revoked, a second consume fails), release, expiry, rotation (§14 check 14)
begin;
select qa.make_users();
select public.srv_register_account(qa.id(901), 'Alice', 'alice', 'u.11111111-1111-4111-8111-111111111111@qatra.invalid', false, '2026-10-04', 'ar', 'UTC', decode(repeat('a1', 32), 'hex'));
select public.srv_register_account(qa.id(902), 'Bob', 'bob', 'u.22222222-2222-4222-8222-222222222222@qatra.invalid', false, '2026-10-04', 'ar', 'UTC', decode(repeat('a2', 32), 'hex'));
do $$
declare
  v_code uuid;
  v_hash bytea;
  v_ok boolean;
  v_epoch integer;
  v_grant uuid;
  v_user uuid;
  v_s1 bytea := decode(repeat('c1', 32), 'hex');
  g1 constant uuid := qa.id(1201); g2 constant uuid := qa.id(1202); g3 constant uuid := qa.id(1203);
  g4 constant uuid := qa.id(1204); g5 constant uuid := qa.id(1205); g6 constant uuid := qa.id(1206);
  g7 constant uuid := qa.id(1207); g8 constant uuid := qa.id(1208);
begin
  perform public.srv_create_app_session(qa.id(901), v_s1, '\x01', 0, now() + interval '30 days');

  -- verify: the single active code
  select c.code_id, c.code_hash into v_code, v_hash from public.srv_recovery_active_code(qa.id(901)) c;
  if v_hash <> decode(repeat('a1', 32), 'hex') or (select count(*) from public.srv_recovery_active_code(qa.id(901))) <> 1 then
    raise exception 'the active code differs';
  end if;
  if exists (select 1 from public.srv_recovery_active_code(qa.id(950))) then raise exception 'an unknown account has an active code'; end if;

  -- reserve: the first request wins, a parallel one does not get a second grant
  v_ok := public.srv_recovery_reserve(qa.id(901), v_code, g1, decode(repeat('b1', 32), 'hex'), now() + interval '10 minutes');
  if v_ok is not true then raise exception 'the first reservation failed'; end if;
  if (select (status, user_id = qa.id(901), expires_at > now() + interval '9 minutes')::text from private.password_reset_grants where id = g1) <> '(active,t,t)'
     or (select (reserved_grant_id = g1, reserved_until > now() + interval '9 minutes')::text from private.recovery_codes where id = v_code) <> '(t,t)' then
    raise exception 'the reservation rows differ';
  end if;
  if exists (select 1 from public.srv_recovery_active_code(qa.id(901))) then raise exception 'a reserved code is still returned as active'; end if;
  v_ok := public.srv_recovery_reserve(qa.id(901), v_code, g2, decode(repeat('b2', 32), 'hex'), now() + interval '10 minutes');
  if v_ok is not false
     or exists (select 1 from private.password_reset_grants where id = g2) or (select count(*) from private.password_reset_grants where user_id = qa.id(901)) <> 1 then
    raise exception 'a second reservation was not refused';
  end if;
  -- another account cannot reserve this code
  v_ok := public.srv_recovery_reserve(qa.id(902), v_code, g3, decode(repeat('b3', 32), 'hex'), now() + interval '10 minutes');
  if v_ok is not false
     or exists (select 1 from private.password_reset_grants where id = g3) then
    raise exception 'a reservation under another account was not refused';
  end if;

  -- begin: one winner, then zero rows
  select b.grant_id, b.user_id into v_grant, v_user from public.srv_recovery_begin(decode(repeat('b1', 32), 'hex')) b;
  if v_grant <> g1 or v_user <> qa.id(901) or (select status from private.password_reset_grants where id = g1) <> 'executing' then
    raise exception 'srv_recovery_begin differs';
  end if;
  if exists (select 1 from public.srv_recovery_begin(decode(repeat('b1', 32), 'hex')))
     or exists (select 1 from public.srv_recovery_begin(decode(repeat('ff', 32), 'hex'))) then
    raise exception 'begin answered for an executing or unknown grant';
  end if;
  -- no new reservation while a grant is executing
  if public.srv_recovery_reserve(qa.id(901), v_code, g3, decode(repeat('b3', 32), 'hex'), now() + interval '10 minutes') is not false then
    raise exception 'a reservation was accepted while a grant is executing';
  end if;

  -- consume: new code, epoch + 1, sessions revoked; a second consume fails
  v_epoch := public.srv_recovery_consume(g1, decode(repeat('a3', 32), 'hex'));
  if v_epoch <> 1 or (select auth_epoch from private.account_handles where user_id = qa.id(901)) <> 1 then raise exception 'the epoch was not incremented'; end if;
  if (select status from private.password_reset_grants where id = g1) <> 'consumed'
     or not (select consumed_at is not null from private.recovery_codes where id = v_code)
     or (select count(*) from private.recovery_codes where user_id = qa.id(901) and consumed_at is null and code_hash = decode(repeat('a3', 32), 'hex')) <> 1
     or (select count(*) from private.recovery_codes where user_id = qa.id(901) and consumed_at is null) <> 1 then
    raise exception 'consume left the code and grant rows in a wrong state';
  end if;
  if (select revoked_at is null from private.app_sessions where session_hash = v_s1) or exists (select 1 from public.srv_read_app_session(v_s1)) then
    raise exception 'consume did not revoke the sessions';
  end if;
  perform qa.expect_error(format($q$select public.srv_recovery_consume(%L, decode(repeat('a4', 32), 'hex'))$q$, g1), 'QT003', 'a second consume');
  perform qa.expect_error(format($q$select public.srv_recovery_consume(%L, decode(repeat('a4', 32), 'hex'))$q$, g2), 'QT003', 'consume of a grant that never executed');
  if (select count(*) from private.recovery_codes where user_id = qa.id(901)) <> 2 then raise exception 'a failed consume created a code'; end if;
  if (select auth_epoch from private.account_handles where user_id = qa.id(902)) <> 0 then raise exception 'another account''s epoch changed'; end if;

  -- release: a reserved (and an executing) grant is cancelled and the code is free again
  select c.code_id into v_code from public.srv_recovery_active_code(qa.id(901)) c;
  if public.srv_recovery_reserve(qa.id(901), v_code, g4, decode(repeat('b4', 32), 'hex'), now() + interval '10 minutes') is not true then raise exception 'reserve g4'; end if;
  perform public.srv_recovery_release(g4);
  if (select status from private.password_reset_grants where id = g4) <> 'cancelled'
     or (select (reserved_grant_id is null and reserved_until is null) from private.recovery_codes where id = v_code) is not true
     or (select count(*) from public.srv_recovery_active_code(qa.id(901))) <> 1 then
    raise exception 'release did not free the code';
  end if;
  if public.srv_recovery_reserve(qa.id(901), v_code, g5, decode(repeat('b5', 32), 'hex'), now() + interval '10 minutes') is not true then raise exception 'reserve g5 after a release'; end if;
  perform public.srv_recovery_begin(decode(repeat('b5', 32), 'hex'));
  perform public.srv_recovery_release(g5);
  if (select status from private.password_reset_grants where id = g5) <> 'cancelled' or (select reserved_grant_id from private.recovery_codes where id = v_code) is not null then
    raise exception 'release of an executing grant failed';
  end if;
  perform public.srv_recovery_release(g5);   -- repeating is harmless
  perform public.srv_recovery_release(gen_random_uuid());

  -- expiry: an active grant that expired cannot begin; its reservation counts as released; a new request replaces it
  if public.srv_recovery_reserve(qa.id(901), v_code, g6, decode(repeat('b6', 32), 'hex'), now() + interval '10 minutes') is not true then raise exception 'reserve g6'; end if;
  update private.password_reset_grants set created_at = now() - interval '1 hour', expires_at = now() - interval '1 minute' where id = g6;
  update private.recovery_codes set reserved_until = now() - interval '1 minute' where id = v_code;
  if exists (select 1 from public.srv_recovery_begin(decode(repeat('b6', 32), 'hex'))) then raise exception 'an expired grant began'; end if;
  if (select count(*) from public.srv_recovery_active_code(qa.id(901))) <> 1 then raise exception 'a lapsed reservation still blocks the code'; end if;
  v_ok := public.srv_recovery_reserve(qa.id(901), v_code, g7, decode(repeat('b7', 32), 'hex'), now() + interval '10 minutes');
  if v_ok is not true
     or (select status from private.password_reset_grants where id = g6) <> 'cancelled' then
    raise exception 'a new reservation did not replace the expired grant';
  end if;

  -- an executing grant keeps its slot even after it expired (an uncertain outcome is reviewed, step 5)
  perform public.srv_recovery_begin(decode(repeat('b7', 32), 'hex'));
  update private.password_reset_grants set created_at = now() - interval '1 hour', expires_at = now() - interval '1 minute' where id = g7;
  update private.recovery_codes set reserved_until = now() - interval '1 minute' where id = v_code;
  v_ok := public.srv_recovery_reserve(qa.id(901), v_code, g8, decode(repeat('b8', 32), 'hex'), now() + interval '10 minutes');
  if v_ok is not false
     or (select status from private.password_reset_grants where id = g7) <> 'executing' then
    raise exception 'an expired executing grant lost its slot';
  end if;
  perform public.srv_recovery_release(g7);
  if public.srv_recovery_reserve(qa.id(901), v_code, g8, decode(repeat('b8', 32), 'hex'), now() + interval '10 minutes') is not true then
    raise exception 'reserve g8 after releasing the executing grant';
  end if;

  -- rotation: the old code is consumed, the new one is active, a grant that was only reserved is cancelled
  perform public.srv_recovery_rotate(qa.id(901), decode(repeat('a5', 32), 'hex'));
  if (select count(*) from private.recovery_codes where user_id = qa.id(901) and consumed_at is null) <> 1
     or (select code_hash from public.srv_recovery_active_code(qa.id(901))) <> decode(repeat('a5', 32), 'hex')
     or (select status from private.password_reset_grants where id = g8) <> 'cancelled' then
    raise exception 'rotation left the code or grant rows in a wrong state';
  end if;
  perform qa.expect_check($q$select public.srv_recovery_rotate(qa.id(901), decode(repeat('a6', 16), 'hex'))$q$, 'recovery_codes_code_hash_length_check');
  if (select count(*) from private.recovery_codes where user_id = qa.id(901) and consumed_at is null) <> 1 then
    raise exception 'a failed rotation consumed the active code';
  end if;
end;
$$;
rollback;

-- CHECK: 20 app session functions: create only for the current epoch, read only live sessions (not revoked, not expired, current epoch), refresh tokens, revoke, bump the epoch (§14 check 14)
begin;
select qa.make_users();
select public.srv_register_account(qa.id(901), 'Alice', 'alice', 'u.11111111-1111-4111-8111-111111111111@qatra.invalid', false, '2026-10-04', 'ar', 'UTC', decode(repeat('a1', 32), 'hex'));
select public.srv_register_account(qa.id(902), 'Demo', 'demo', 'u.22222222-2222-4222-8222-222222222222@qatra.invalid', true, '2026-10-04', 'ar', 'UTC', decode(repeat('a2', 32), 'hex'));
do $$
declare
  s1 constant bytea := decode(repeat('c1', 32), 'hex');
  s2 constant bytea := decode(repeat('c2', 32), 'hex');
  s3 constant bytea := decode(repeat('c3', 32), 'hex');
  s4 constant bytea := decode(repeat('c4', 32), 'hex');
  s5 constant bytea := decode(repeat('c5', 32), 'hex');
  s6 constant bytea := decode(repeat('c6', 32), 'hex');
  v_id uuid;
  v_revoked timestamptz;
  r record;
begin
  v_id := public.srv_create_app_session(qa.id(901), s1, '\x0102', 0, now() + interval '30 days');
  -- read: the fields of §8.2 item 11
  select * into r from public.srv_read_app_session(s1);
  if r.session_id is distinct from v_id or r.user_id is distinct from qa.id(901) or r.username_display is distinct from 'Alice'
     or r.internal_auth_alias is distinct from 'u.11111111-1111-4111-8111-111111111111@qatra.invalid'
     or r.auth_epoch is distinct from 0 or r.encrypted_auth_tokens is distinct from '\x0102'::bytea
     or r.expires_at < now() + interval '29 days' or r.is_demo is not false then
    raise exception 'srv_read_app_session differs: %', to_jsonb(r);
  end if;
  if exists (select 1 from public.srv_read_app_session(decode(repeat('ff', 32), 'hex'))) then raise exception 'an unknown session was found'; end if;
  perform public.srv_create_app_session(qa.id(902), s5, '\x05', 0, now() + interval '30 days');
  if not (select is_demo from public.srv_read_app_session(s5)) then raise exception 'is_demo is not returned for a demo session'; end if;

  -- create: only for the account's current epoch; the failure leaves no row
  perform qa.expect_error(format($q$select public.srv_create_app_session(%L, %L, '\x01', 5, now() + interval '30 days')$q$, qa.id(901), s2), 'QT001', 'a wrong epoch');
  perform qa.expect_error(format($q$select public.srv_create_app_session(%L, %L, '\x01', 0, now() + interval '30 days')$q$, qa.id(950), s2), 'QT001', 'an unknown account');
  perform qa.expect_check(format($q$select public.srv_create_app_session(%L, decode(repeat('c2', 31), 'hex'), '\x01', 0, now() + interval '30 days')$q$, qa.id(901)), 'app_sessions_session_hash_length_check');
  perform qa.expect_unique(format($q$select public.srv_create_app_session(%L, %L, '\x01', 0, now() + interval '30 days')$q$, qa.id(901), s1), 'app_sessions_session_hash_key');
  if (select count(*) from private.app_sessions) <> 2 then raise exception 'a failed creation left a session'; end if;

  -- refresh the tokens of a live session
  perform public.srv_update_app_session_tokens(v_id, '\x0304');
  if (select encrypted_auth_tokens::text from public.srv_read_app_session(s1)) <> '\x0304' then raise exception 'the tokens were not refreshed'; end if;

  -- revoke: logout; read answers nothing; a revoked session cannot refresh; repeating keeps the first time
  perform public.srv_create_app_session(qa.id(901), s2, '\x02', 0, now() + interval '30 days');
  perform public.srv_revoke_app_session(s2);
  v_revoked := (select revoked_at from private.app_sessions where session_hash = s2);
  if v_revoked is null or exists (select 1 from public.srv_read_app_session(s2)) then raise exception 'revoke did not stop the session'; end if;
  perform public.srv_update_app_session_tokens((select id from private.app_sessions where session_hash = s2), '\x99');
  if (select encrypted_auth_tokens::text from private.app_sessions where session_hash = s2) <> '\x02' then raise exception 'a revoked session was refreshed'; end if;
  perform public.srv_revoke_app_session(s2);
  perform public.srv_revoke_app_session(decode(repeat('ff', 32), 'hex'));
  if (select revoked_at from private.app_sessions where session_hash = s2) <> v_revoked then raise exception 'revoked_at moved on a repeated revoke'; end if;

  -- expired: read and refresh answer nothing
  perform public.srv_create_app_session(qa.id(901), s3, '\x03', 0, now() + interval '30 days');
  update private.app_sessions set created_at = now() - interval '31 days', expires_at = now() - interval '1 day' where session_hash = s3;
  if exists (select 1 from public.srv_read_app_session(s3)) then raise exception 'an expired session was found'; end if;
  perform public.srv_update_app_session_tokens((select id from private.app_sessions where session_hash = s3), '\x99');
  if (select encrypted_auth_tokens::text from private.app_sessions where session_hash = s3) <> '\x03' then raise exception 'an expired session was refreshed'; end if;

  -- a stale epoch (not revoked): read and refresh answer nothing
  update private.account_handles set auth_epoch = 7 where user_id = qa.id(901);
  if exists (select 1 from public.srv_read_app_session(s1)) then raise exception 'a stale-epoch session was found'; end if;
  perform public.srv_update_app_session_tokens(v_id, '\x99');
  if (select encrypted_auth_tokens::text from private.app_sessions where id = v_id) <> '\x0304' then raise exception 'a stale-epoch session was refreshed'; end if;
  update private.account_handles set auth_epoch = 0 where user_id = qa.id(901);
  if not exists (select 1 from public.srv_read_app_session(s1)) then raise exception 'the session is not live again after restoring the epoch'; end if;

  -- bump: the new epoch, every session of the account revoked, other accounts untouched
  perform public.srv_create_app_session(qa.id(901), s4, '\x04', 0, now() + interval '30 days');
  if public.srv_bump_auth_epoch(qa.id(901)) <> 1 then raise exception 'the new epoch is not 1'; end if;
  if exists (select 1 from public.srv_read_app_session(s1)) or exists (select 1 from public.srv_read_app_session(s4))
     or exists (select 1 from private.app_sessions where user_id = qa.id(901) and revoked_at is null and session_hash <> s3) then
    raise exception 'the bump did not revoke every session of the account';
  end if;
  if not exists (select 1 from public.srv_read_app_session(s5)) then raise exception 'the bump revoked another account''s session'; end if;
  perform qa.expect_error(format($q$select public.srv_create_app_session(%L, %L, '\x06', 0, now() + interval '30 days')$q$, qa.id(901), s6), 'QT001', 'the old epoch after a bump');
  perform public.srv_create_app_session(qa.id(901), s6, '\x06', 1, now() + interval '30 days');
  if (select auth_epoch from public.srv_read_app_session(s6)) <> 1 then raise exception 'the fresh session does not carry the new epoch'; end if;
  if public.srv_bump_auth_epoch(qa.id(901)) <> 2 then raise exception 'a second bump did not give epoch 2'; end if;
  perform qa.expect_error($q$select public.srv_bump_auth_epoch(qa.id(950))$q$, 'P0002', 'an unknown account');
end;
$$;
rollback;

-- CHECK: 21 throttle functions: one-minute buckets summed over the trailing 15 minutes, failure counts per key, success clears the given keys, bounded 24-hour purge (A-03, §14 check 15)
begin;
do $$
declare
  k1 constant bytea := decode(repeat('d1', 32), 'hex');
  k2 constant bytea := decode(repeat('d2', 32), 'hex');
  k3 constant bytea := decode(repeat('d3', 32), 'hex');
  i integer;
  v_old integer;
  v_left integer;
  v_calls integer := 0;
begin
  -- counts after the 1st to the 21st failure: the figures the service turns into the delay
  -- sequence (after the 5th failure 1, 2, 4, 8 s, then 10 s per failure; HTTP 429 at 20). The
  -- database only counts; it returns nothing from srv_throttle_record.
  for i in 1..21 loop
    perform public.srv_throttle_record(array[k1], 'failure');
    if (select attempts from public.srv_throttle_check(array[k1])) <> i then
      raise exception 'after % failures the count is %', i, (select attempts from public.srv_throttle_check(array[k1]));
    end if;
  end loop;
  -- all of them sit in one one-minute bucket
  if (select count(*) from private.auth_throttle where key_hash = k1) <> 1
     or (select window_start from private.auth_throttle where key_hash = k1) <> date_trunc('minute', now()) then
    raise exception 'the failures are not in one bucket of the current minute';
  end if;
  delete from private.auth_throttle;

  -- two keys per call (username and IP prefix), duplicates in the array count once, NULLs are ignored
  perform public.srv_throttle_record(array[k1, k2, k1, null], 'failure');
  perform public.srv_throttle_record(array[k1], 'failure');
  if (select count(*) from public.srv_throttle_check(array[k1, k2, k3, k3, null])) <> 3
     or (select attempts from public.srv_throttle_check(array[k1, k2, k3]) where key_hash = k1) <> 2
     or (select attempts from public.srv_throttle_check(array[k1, k2, k3]) where key_hash = k2) <> 1
     or (select attempts from public.srv_throttle_check(array[k1, k2, k3]) where key_hash = k3) <> 0 then
    raise exception 'srv_throttle_check does not answer one row per distinct key with the right counts';
  end if;
  if (select count(*) from public.srv_throttle_check(array[]::bytea[])) <> 0 or (select count(*) from public.srv_throttle_check(null)) <> 0 then
    raise exception 'srv_throttle_check answered for no keys';
  end if;

  -- the window: the current bucket and the 14 before it count; older buckets do not
  delete from private.auth_throttle;
  insert into private.auth_throttle (key_hash, window_start, attempts) values
    (k1, date_trunc('minute', now()), 1),
    (k1, date_trunc('minute', now()) - interval '14 minutes', 2),
    (k1, date_trunc('minute', now()) - interval '15 minutes', 4),
    (k1, date_trunc('minute', now()) - interval '16 minutes', 8);
  if (select attempts from public.srv_throttle_check(array[k1])) <> 3 then
    raise exception 'the 15-bucket window sums % instead of 3', (select attempts from public.srv_throttle_check(array[k1]));
  end if;

  -- success clears every bucket of the given keys, not of the others
  perform public.srv_throttle_record(array[k2], 'failure');
  perform public.srv_throttle_record(array[k1], 'success');
  if (select attempts from public.srv_throttle_check(array[k1])) <> 0 or exists (select 1 from private.auth_throttle where key_hash = k1)
     or (select attempts from public.srv_throttle_check(array[k2])) <> 1 then
    raise exception 'success did not clear exactly the given key';
  end if;
  perform qa.expect_error($q$select public.srv_throttle_record(array[decode(repeat('d1', 32), 'hex')], 'bogus')$q$, '22023', 'an unknown outcome');
  perform qa.expect_error($q$select public.srv_throttle_record(array[decode(repeat('d1', 32), 'hex')], null)$q$, '22023', 'a null outcome');
  perform qa.expect_check($q$select public.srv_throttle_record(array[decode(repeat('d1', 31), 'hex')], 'failure')$q$, 'auth_throttle_key_hash_length_check');

  -- purge: at most 100 rows older than 24 hours per call, fresh rows stay
  delete from private.auth_throttle;
  insert into private.auth_throttle (key_hash, window_start, attempts)
  select decode(md5(g::text) || md5(g::text), 'hex'), now() - interval '25 hours' - (g || ' seconds')::interval, 1
  from generate_series(1, 250) g;
  insert into private.auth_throttle (key_hash, window_start, attempts) values
    (k3, now() - interval '23 hours 59 minutes', 1), (k3, now() - interval '1 hour', 1);
  v_old := (select count(*) from private.auth_throttle where window_start < now() - interval '24 hours');
  if v_old <> 250 then raise exception 'purge fixture: % old rows', v_old; end if;
  loop
    perform public.srv_throttle_record(array[k2], 'failure');
    v_calls := v_calls + 1;
    v_left := (select count(*) from private.auth_throttle where window_start < now() - interval '24 hours');
    if v_old - v_left > 100 then raise exception 'one call purged % rows (the bound is 100)', v_old - v_left; end if;
    if v_left > 0 and v_old - v_left <> 100 then raise exception 'a call purged % rows before the old rows ran out', v_old - v_left; end if;
    v_old := v_left;
    exit when v_left = 0 or v_calls > 10;
  end loop;
  if v_calls <> 3 then raise exception 'the 250 old rows needed % calls instead of 3', v_calls; end if;
  if (select count(*) from private.auth_throttle where key_hash = k3) <> 2 then raise exception 'rows younger than 24 hours were purged'; end if;
  -- a success call purges as well
  insert into private.auth_throttle (key_hash, window_start, attempts) values (k1, now() - interval '24 hours 1 minute', 1);
  perform public.srv_throttle_record(array[k3], 'success');
  if exists (select 1 from private.auth_throttle where key_hash = k1) then raise exception 'a success call did not purge'; end if;
end;
$$;
rollback;

-- CHECK: 22 srv_delete_personal_rows: removes every row of the account from the private and personal tables (and its username throttle key), keeps content, ai_usage and other accounts; a cascade from auth.users removes the same rows (§14 check 12)
begin;
select qa.make_fixture();
select qa.make_users();
select qa.populate_user(qa.id(901), 1);
select qa.populate_user(qa.id(902), 2);
select qa.populate_user(qa.id(903), 3);
insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
select pv.id, pv.user_id, 1, '[]', '{}', 10, '[2026-10-05,2026-10-12)' from public.plan_versions pv;
insert into private.auth_throttle (key_hash, window_start, attempts) values
  (decode(repeat('d1', 32), 'hex'), now(), 3), (decode(repeat('d2', 32), 'hex'), now(), 1), (decode(repeat('d3', 32), 'hex'), now(), 2);
insert into public.ai_usage (provider, model, prompt_version, status) values ('test', 'test', 'v1', 'succeeded');
do $$
declare
  v_t text;
  n bigint;
  v_tables text[];
begin
  select array_agg(c.table_schema || '.' || c.table_name order by c.table_schema, c.table_name) into v_tables
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.column_name = 'user_id' and c.table_schema in ('public', 'private');
  -- every table of §12.1 is in the list: 4 private + profiles + 11 personal learning tables
  if cardinality(v_tables) <> 16 then raise exception 'expected 16 tables with a user_id column, found %: %', cardinality(v_tables), v_tables; end if;

  perform public.srv_delete_personal_rows(qa.id(901), decode(repeat('d1', 32), 'hex'));
  set constraints all immediate;
  set constraints all deferred;

  foreach v_t in array v_tables loop
    execute format('select count(*) from %s where user_id = qa.id(901)', v_t) into n;
    if n <> 0 then raise exception '% still holds % rows of the deleted account', v_t, n; end if;
    execute format('select count(*) from %s where user_id = qa.id(902)', v_t) into n;
    if n <> 1 then raise exception '% holds % rows of another account (expected 1)', v_t, n; end if;
  end loop;
  -- the username key is gone, the other keys (an IP prefix is not linked to the account) stay
  if exists (select 1 from private.auth_throttle where key_hash = decode(repeat('d1', 32), 'hex'))
     or (select count(*) from private.auth_throttle) <> 2 then
    raise exception 'the throttle rows differ after the deletion';
  end if;
  -- content, ai_usage and the Auth user are untouched
  if (select count(*) from public.ai_usage) <> 1 or (select count(*) from public.units) <> 1 or (select count(*) from public.passages) <> 1
     or (select count(*) from public.book_editions) <> 1 or not exists (select 1 from auth.users where id = qa.id(901)) then
    raise exception 'content, ai_usage or the Auth user changed';
  end if;
  -- repeating, and a null throttle key, are harmless
  perform public.srv_delete_personal_rows(qa.id(901), decode(repeat('d1', 32), 'hex'));
  perform public.srv_delete_personal_rows(qa.id(902), null);
  foreach v_t in array v_tables loop
    execute format('select count(*) from %s where user_id = qa.id(902)', v_t) into n;
    if n <> 0 then raise exception '% still holds rows after the second deletion', v_t; end if;
  end loop;
  if (select count(*) from private.auth_throttle) <> 2 then raise exception 'a null key deleted throttle rows'; end if;

  -- a cascade from auth.users alone removes the same rows
  delete from auth.users where id = qa.id(903);
  foreach v_t in array v_tables loop
    execute format('select count(*) from %s where user_id = qa.id(903)', v_t) into n;
    if n <> 0 then raise exception '% still holds % rows after the cascade from auth.users', v_t, n; end if;
  end loop;
  if (select count(*) from public.ai_usage) <> 1 or (select count(*) from public.units) <> 1 then raise exception 'the cascade touched content or ai_usage'; end if;
end;
$$;
rollback;

-- CHECK: 23 srv_record_ai_usage: unknown token and cost values stay NULL, no learner data, value set enforced
begin;
select public.srv_record_ai_usage('test', 'test-model', 'v1', null, null, null, 'rules_fallback', null);
select public.srv_record_ai_usage('test', 'test-model', 'v1', 10, 20, 0, 'succeeded', '{"free": true}');
do $$
begin
  if (select count(*) from public.ai_usage) <> 2 then raise exception 'two usage rows expected'; end if;
  if (select (input_tokens is null and output_tokens is null and cost_usd is null and quota_record is null)
      from public.ai_usage where status = 'rules_fallback') is not true then
    raise exception 'unknown values were stored as something else than NULL';
  end if;
  if (select (input_tokens, output_tokens, cost_usd::text, quota_record ->> 'free')::text from public.ai_usage where status = 'succeeded') <> '(10,20,0,true)' then
    raise exception 'the measured row differs';
  end if;
  perform qa.expect_check($q$select public.srv_record_ai_usage('test', 'test-model', 'v1', null, null, null, 'ok', null)$q$, 'ai_usage_status_check');
  perform qa.expect_check($q$select public.srv_record_ai_usage('test', 'test-model', 'v1', -1, null, null, 'failed', null)$q$, 'ai_usage_input_tokens_check');
  perform qa.expect_check($q$select public.srv_record_ai_usage('', 'test-model', 'v1', null, null, null, 'failed', null)$q$, 'ai_usage_provider_check');
  if (select count(*) from public.ai_usage) <> 2 then raise exception 'a failed call stored a row'; end if;
end;
$$;
rollback;

-- CHECK: 24 srv_redact_revoked_content: only service_role may run it, only for a revoked edition; it removes text and answer keys from payload and steps and keeps structure and ids; repeating changes nothing (§14 check 14)
begin;
select qa.make_fixture();
select qa.make_hadith_edition();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
select qa.set_edition_status('published');
do $$
declare
  c_steps constant jsonb := jsonb_build_array(
    jsonb_build_object('type', 'learn', 'passage', jsonb_build_object(
      'passageId', qa.id(9), 'path', 'quran', 'reference', '1:1',
      'units', jsonb_build_array(jsonb_build_object('unitRef', 1, 'kind', 'ayah', 'reference', '1:1', 'text', 'synthetic text')),
      'highlight', jsonb_build_object('startRef', '1:0', 'endRef', '1:0'),
      'takhrij', jsonb_build_object('text', 'synthetic takhrij'), 'grade', 'synthetic grade',
      'source', jsonb_build_object('publisher', 'p', 'url', 'https://example.invalid/x'))),
    jsonb_build_object('type', 'question', 'question', jsonb_build_object(
      'questionId', qa.id(12), 'type', 'word_choice', 'passageId', qa.id(9),
      'context', jsonb_build_object('before', jsonb_build_array(jsonb_build_object('ref', '1:0', 'text', 'w'))),
      'options', jsonb_build_array(jsonb_build_object('optionId', 'opt-a', 'text', 't1'), jsonb_build_object('optionId', 'opt-b', 'text', 't2')),
      'answerKey', jsonb_build_object('optionId', 'opt-a'))));
  c_steps_redacted constant jsonb := jsonb_build_array(
    jsonb_build_object('type', 'learn', 'passage', jsonb_build_object(
      'passageId', qa.id(9), 'path', 'quran', 'reference', '1:1',
      'units', jsonb_build_array(jsonb_build_object('unitRef', 1, 'kind', 'ayah', 'reference', '1:1', 'text', null)),
      'highlight', jsonb_build_object('startRef', '1:0', 'endRef', '1:0'),
      'takhrij', null, 'grade', null,
      'source', jsonb_build_object('publisher', 'p', 'url', 'https://example.invalid/x'))),
    jsonb_build_object('type', 'question', 'question', jsonb_build_object(
      'questionId', qa.id(12), 'type', 'word_choice', 'passageId', qa.id(9),
      'context', jsonb_build_object('before', jsonb_build_array(jsonb_build_object('ref', '1:0', 'text', null))),
      'options', jsonb_build_array(jsonb_build_object('optionId', 'opt-a', 'text', null), jsonb_build_object('optionId', 'opt-b', 'text', null)),
      'answerKey', null)));
  v_payload jsonb;
  v_updated timestamptz;
begin
  v_payload := jsonb_build_object('snapshotId', qa.id(3001), 'preparedSessions', jsonb_build_array(jsonb_build_object('sessionId', qa.id(2001), 'steps', c_steps)),
    'lessons', jsonb_build_array(jsonb_build_object('passageId', qa.id(9), 'units', jsonb_build_array(jsonb_build_object('unitRef', 1, 'text', 'synthetic')))),
    'games', jsonb_build_array(jsonb_build_object('questionId', qa.id(12), 'answerKey', jsonb_build_object('optionId', 'opt-a'))));
  insert into public.learning_sessions (id, user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status)
  select qa.id(2001), qa.id(901), qa.id(101), pv.id, qa.id(5), 'daily', date '2026-10-05', c_steps, 1, 'open' from public.plan_versions pv where pv.plan_id = qa.id(101);
  insert into public.offline_snapshots (id, user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
  values (qa.id(3001), qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(401), '[]', 1, 1, v_payload);
  -- another edition's session keeps its text
  insert into public.learning_sessions (id, user_id, edition_id, kind, learning_date, steps, bank_version, status)
  values (qa.id(2002), qa.id(901), qa.id(21), 'placement', date '2026-10-05', c_steps, 1, 'open');

  -- not revoked: refused, nothing changes; unknown edition
  perform qa.expect_error(format($q$select public.srv_redact_revoked_content(%L)$q$, qa.id(5)), 'QT003', 'a published edition');
  perform qa.set_edition_status('superseded');
  perform qa.expect_error(format($q$select public.srv_redact_revoked_content(%L)$q$, qa.id(5)), 'QT003', 'a superseded edition');
  perform qa.expect_error(format($q$select public.srv_redact_revoked_content(%L)$q$, qa.id(21)), 'QT003', 'a draft edition');
  perform qa.expect_error($q$select public.srv_redact_revoked_content(gen_random_uuid())$q$, 'P0002', 'an unknown edition');
  if (select steps from public.learning_sessions where id = qa.id(2001)) <> c_steps or (select payload from public.offline_snapshots where id = qa.id(3001)) <> v_payload then
    raise exception 'a refused call changed the stored copies';
  end if;

  -- revoked: service_role redacts
  perform qa.set_edition_status('revoked');
  perform qa.as_service();
  perform public.srv_redact_revoked_content(qa.id(5));
  perform qa.as_owner();
  if (select steps from public.learning_sessions where id = qa.id(2001)) <> c_steps_redacted then
    raise exception 'steps after redaction: %', (select steps from public.learning_sessions where id = qa.id(2001));
  end if;
  if (select payload from public.offline_snapshots where id = qa.id(3001)) <> jsonb_build_object(
       'snapshotId', qa.id(3001),
       'preparedSessions', jsonb_build_array(jsonb_build_object('sessionId', qa.id(2001), 'steps', c_steps_redacted)),
       'lessons', jsonb_build_array(jsonb_build_object('passageId', qa.id(9), 'units', jsonb_build_array(jsonb_build_object('unitRef', 1, 'text', null)))),
       'games', jsonb_build_array(jsonb_build_object('questionId', qa.id(12), 'answerKey', null))) then
    raise exception 'payload after redaction: %', (select payload from public.offline_snapshots where id = qa.id(3001));
  end if;
  -- another edition untouched
  if (select steps from public.learning_sessions where id = qa.id(2002)) <> c_steps then raise exception 'another edition''s session was redacted'; end if;
  -- structure: same length, ids kept
  if jsonb_array_length((select steps from public.learning_sessions where id = qa.id(2001))) <> 2 then raise exception 'the steps lost an element'; end if;

  -- repeating changes nothing (not even updated_at)
  v_updated := (select updated_at from public.learning_sessions where id = qa.id(2001));
  perform qa.as_service();
  perform public.srv_redact_revoked_content(qa.id(5));
  perform qa.as_owner();
  if (select steps from public.learning_sessions where id = qa.id(2001)) <> c_steps_redacted or (select updated_at from public.learning_sessions where id = qa.id(2001)) <> v_updated then
    raise exception 'a repeated redaction changed the rows';
  end if;

  -- who can run it
  perform qa.as_server();
  perform qa.expect_error(format($q$select public.srv_redact_revoked_content(%L)$q$, qa.id(5)), '42501', 'qatra_server');
  perform qa.as_owner();
  perform qa.as_user(qa.id(901));
  perform qa.expect_error(format($q$select public.srv_redact_revoked_content(%L)$q$, qa.id(5)), '42501', 'authenticated');
  -- and the learner cannot change steps themselves: the redaction is the only writer
  perform qa.expect_error($q$update public.learning_sessions set steps = '[]' where id = qa.id(2001)$q$, '42501', 'authenticated update steps');
  perform qa.as_owner();
  perform qa.as_anon();
  perform qa.expect_error(format($q$select public.srv_redact_revoked_content(%L)$q$, qa.id(5)), '42501', 'anon');
  perform qa.as_owner();
end;
$$;
rollback;

-- CHECK: 25 storage: no storage.objects policy exists for bucket sources (none at all); anon, authenticated and qatra_server are denied, service_role is the only reader (§9, §14 check 11)
begin;
do $$
begin
  if exists (select 1 from storage.buckets where id = 'sources' and public is distinct from false) or not exists (select 1 from storage.buckets where id = 'sources') then
    raise exception 'bucket sources is missing or public';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects') then
    raise exception 'a storage.objects policy exists (bucket sources must have none): %',
      (select array_agg(policyname) from pg_policies where schemaname = 'storage' and tablename = 'objects');
  end if;
  if exists (select 1 from pg_policies where schemaname = 'storage' and coalesce(qual, '') || coalesce(with_check, '') ilike '%sources%') then
    raise exception 'a policy names the bucket sources';
  end if;
end;
$$;
insert into storage.objects (bucket_id, name) values ('sources', 'test-edition/raw/synthetic.json');
select qa.as_anon();
do $$
begin
  if (select count(*) from storage.objects) <> 0 then raise exception 'anon can read storage objects'; end if;
  perform qa.expect_error($q$insert into storage.objects (bucket_id, name) values ('sources', 'x')$q$, '42501', 'anon insert');
end;
$$;
select qa.as_owner();
select qa.as_user(qa.id(901));
do $$
begin
  if (select count(*) from storage.objects) <> 0 then raise exception 'authenticated can read storage objects'; end if;
  perform qa.expect_error($q$insert into storage.objects (bucket_id, name) values ('sources', 'x')$q$, '42501', 'authenticated insert');
  -- no policy: an update or delete finds no row to touch
  if qa.rowcount($q$update storage.objects set name = 'y'$q$) <> 0 or qa.rowcount($q$delete from storage.objects$q$) <> 0 then
    raise exception 'authenticated changed a storage object';
  end if;
end;
$$;
select qa.as_owner();
select qa.as_server();
do $$
begin
  perform qa.expect_error($q$select 1 from storage.objects limit 1$q$, '42501', 'qatra_server select');
  perform qa.expect_error($q$select 1 from storage.buckets limit 1$q$, '42501', 'qatra_server select buckets');
end;
$$;
select qa.as_owner();
select qa.as_service();
do $$
begin
  if (select count(*) from storage.objects) <> 1 then raise exception 'service_role cannot reach the object (bypass RLS)'; end if;
end;
$$;
select qa.as_owner();
rollback;

-- CHECK: 26 qatra_server at run time: it runs srv_* functions 1-18 and a trivial query and nothing else; the other roles cannot run them
begin;
select qa.make_users();
select public.srv_register_account(qa.id(902), 'Bob', 'bob', 'u.22222222-2222-4222-8222-222222222222@qatra.invalid', false, '2026-10-04', 'ar', 'UTC', decode(repeat('a2', 32), 'hex'));
select qa.as_server();
do $$
declare
  v_code uuid;
  v_grant uuid;
  v_epoch integer;
  v_id uuid;
  t text;
begin
  -- the readiness query needs no privilege
  perform 1 from (select 1) q;
  perform qa.expect_ok($q$select 1$q$, 'select 1');

  -- items 1-18, in a realistic order
  perform public.srv_register_account(qa.id(901), 'Alice', 'alice', 'u.11111111-1111-4111-8111-111111111111@qatra.invalid', false, '2026-10-04', 'ar', 'UTC', decode(repeat('a1', 32), 'hex'));
  if (select count(*) from public.srv_find_handle('alice')) <> 1 then raise exception 'srv_find_handle'; end if;
  perform public.srv_accept_terms(qa.id(901), '2026-10-05');
  select c.code_id into v_code from public.srv_recovery_active_code(qa.id(901)) c;
  if public.srv_recovery_reserve(qa.id(901), v_code, qa.id(1301), decode(repeat('b1', 32), 'hex'), now() + interval '10 minutes') is not true then raise exception 'srv_recovery_reserve'; end if;
  select b.grant_id into v_grant from public.srv_recovery_begin(decode(repeat('b1', 32), 'hex')) b;
  perform public.srv_recovery_release(v_grant);
  if public.srv_recovery_reserve(qa.id(901), v_code, qa.id(1302), decode(repeat('b2', 32), 'hex'), now() + interval '10 minutes') is not true then raise exception 'reserve again'; end if;
  perform public.srv_recovery_begin(decode(repeat('b2', 32), 'hex'));
  v_epoch := public.srv_recovery_consume(qa.id(1302), decode(repeat('a3', 32), 'hex'));
  perform public.srv_recovery_rotate(qa.id(901), decode(repeat('a4', 32), 'hex'));
  v_id := public.srv_create_app_session(qa.id(901), decode(repeat('c1', 32), 'hex'), '\x01', v_epoch, now() + interval '30 days');
  if (select count(*) from public.srv_read_app_session(decode(repeat('c1', 32), 'hex'))) <> 1 then raise exception 'srv_read_app_session'; end if;
  perform public.srv_update_app_session_tokens(v_id, '\x02');
  perform public.srv_revoke_app_session(decode(repeat('c1', 32), 'hex'));
  if public.srv_bump_auth_epoch(qa.id(901)) <> v_epoch + 1 then raise exception 'srv_bump_auth_epoch'; end if;
  perform public.srv_throttle_record(array[decode(repeat('d1', 32), 'hex')], 'failure');
  if (select attempts from public.srv_throttle_check(array[decode(repeat('d1', 32), 'hex')])) <> 1 then raise exception 'throttle'; end if;
  perform public.srv_record_ai_usage('test', 'test', 'v1', null, null, null, 'failed', null);
  perform public.srv_delete_personal_rows(qa.id(901), decode(repeat('d1', 32), 'hex'));

  -- nothing else: no table, view, content, storage; no redaction function; no app_* function
  foreach t in array array['private.account_handles', 'private.recovery_codes', 'private.password_reset_grants', 'private.app_sessions',
                           'private.auth_throttle', 'public.profiles', 'public.master_plans', 'public.ai_usage', 'public.categories',
                           'public.units', 'public.catalog_editions', 'public.catalog_sections', 'storage.objects', 'auth.users'] loop
    perform qa.expect_error(format('select 1 from %s limit 1', t), '42501', 'qatra_server select ' || t);
  end loop;
  perform qa.expect_error($q$insert into public.ai_usage (provider, model, prompt_version, status) values ('a', 'b', 'c', 'failed')$q$, '42501', 'qatra_server insert ai_usage');
  perform qa.expect_error($q$select public.srv_redact_revoked_content(gen_random_uuid())$q$, '42501', 'qatra_server srv_redact_revoked_content');
  perform qa.expect_error($q$select public.app_complete_session(gen_random_uuid(), 0)$q$, '42501', 'qatra_server app_complete_session');
  perform qa.expect_error($q$select private.redact_json('{}'::jsonb)$q$, '42501', 'qatra_server private function');
end;
$$;
select qa.as_owner();
-- the other roles cannot run the srv_* functions
select qa.as_user(qa.id(901));
do $$
begin
  perform qa.expect_error($q$select public.srv_find_handle('bob')$q$, '42501', 'authenticated srv_find_handle');
  perform qa.expect_error($q$select public.srv_read_app_session(decode(repeat('c1', 32), 'hex'))$q$, '42501', 'authenticated srv_read_app_session');
  perform qa.expect_error($q$select public.srv_delete_personal_rows(gen_random_uuid(), null)$q$, '42501', 'authenticated srv_delete_personal_rows');
  perform qa.expect_error($q$select public.srv_record_ai_usage('a', 'b', 'c', null, null, null, 'failed', null)$q$, '42501', 'authenticated srv_record_ai_usage');
end;
$$;
select qa.as_owner();
select qa.as_service();
do $$
begin
  perform qa.expect_error($q$select public.srv_find_handle('bob')$q$, '42501', 'service_role srv_find_handle');
  perform qa.expect_error($q$select public.srv_throttle_record(array[decode(repeat('d1', 32), 'hex')], 'success')$q$, '42501', 'service_role srv_throttle_record');
  perform qa.expect_error($q$select public.app_complete_session(gen_random_uuid(), 0)$q$, '42501', 'service_role app_complete_session');
  perform qa.expect_error($q$select 1 from private.account_handles limit 1$q$, '42501', 'service_role private table');
  perform qa.expect_error($q$select 1 from public.master_plans limit 1$q$, '42501', 'service_role personal table');
end;
$$;
select qa.as_owner();
rollback;


-- CHECK: 27 concurrency over dblink (needs the contrib module dblink; commits for real and cleans up): one winner for parallel recovery reservations, one daily session, one revision, one active plan, no lost throttle increment
set statement_timeout = '120s';
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901), 'active');
select qa.make_plan(qa.id(103), qa.id(902), 'active');
select public.srv_register_account(qa.id(903), 'Carol', 'carol', 'u.33333333-3333-4333-8333-333333333333@qatra.invalid', false, '2026-10-04', 'ar', 'UTC', decode(repeat('a3', 32), 'hex'));
create extension if not exists dblink with schema extensions;
do $$
declare
  c_phases constant text := '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-05,2026-10-12)"}]';
  v_conn constant text := 'dbname=' || current_database();
  v_code uuid;
  v_ver uuid := (select id from public.plan_versions where plan_id = qa.id(101));
  v_r boolean;
  v_sid1 text; v_sid2 text; v_new1 boolean; v_new2 boolean;
  v_state text;
  v_x text;
  v_n integer;
  k1 constant bytea := decode(repeat('d1', 32), 'hex');
begin
  perform extensions.dblink_connect('c1', v_conn);
  perform extensions.dblink_connect('c2', v_conn);
  perform extensions.dblink_exec('c1', 'set statement_timeout = ''60s''');
  perform extensions.dblink_exec('c2', 'set statement_timeout = ''60s''');

  ---------------------------------------------------------------------------
  -- 1. parallel recovery reservations: exactly one winner
  ---------------------------------------------------------------------------
  select code_id into v_code from public.srv_recovery_active_code(qa.id(903));
  perform extensions.dblink_exec('c1', 'begin');
  select t.r into v_r from extensions.dblink('c1', format(
    'select public.srv_recovery_reserve(%L, %L, %L, decode(repeat(''b1'', 32), ''hex''), now() + interval ''10 minutes'')',
    qa.id(903), v_code, qa.id(1401))) as t(r boolean);
  if v_r is not true then raise exception 'the first reservation did not win'; end if;
  perform extensions.dblink_send_query('c2', format(
    'select public.srv_recovery_reserve(%L, %L, %L, decode(repeat(''b2'', 32), ''hex''), now() + interval ''10 minutes'')',
    qa.id(903), v_code, qa.id(1402)));
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the second reservation did not wait for the first transaction'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  select t.r into v_r from extensions.dblink_get_result('c2') as t(r boolean);
  perform * from extensions.dblink_get_result('c2') as t(r boolean);
  if v_r is not false then raise exception 'the second reservation won as well'; end if;
  if (select count(*) from private.password_reset_grants where user_id = qa.id(903)) <> 1
     or not exists (select 1 from private.password_reset_grants where id = qa.id(1401) and status = 'active') then
    raise exception 'exactly one grant must exist after the race';
  end if;

  ---------------------------------------------------------------------------
  -- 2. two parallel requests for the daily session of one date: one creates, the other gets the same session
  ---------------------------------------------------------------------------
  perform extensions.dblink_exec('c1', 'begin');
  perform extensions.dblink_exec('c1', 'set local role authenticated');
  perform * from extensions.dblink('c1', format('select set_config(''request.jwt.claim.sub'', %L, true)', qa.id(901)::text)) as t(x text);
  perform extensions.dblink_exec('c2', 'begin');
  perform extensions.dblink_exec('c2', 'set local role authenticated');
  perform * from extensions.dblink('c2', format('select set_config(''request.jwt.claim.sub'', %L, true)', qa.id(901)::text)) as t(x text);

  select t.sid, t.created into v_sid1, v_new1 from extensions.dblink('c1', format(
    'select session_id::text, created from public.app_open_session(''daily'', %L, %L, null, %L, date ''2026-10-05'', ''{}'', ''{}'', ''[]'', 1)',
    qa.id(101), v_ver, qa.id(5))) as t(sid text, created boolean);
  perform extensions.dblink_send_query('c2', format(
    'select session_id::text, created from public.app_open_session(''daily'', %L, %L, null, %L, date ''2026-10-05'', ''{}'', ''{}'', ''[]'', 1)',
    qa.id(101), v_ver, qa.id(5)));
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the second daily request did not wait on the unique index'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  select t.sid, t.created into v_sid2, v_new2 from extensions.dblink_get_result('c2') as t(sid text, created boolean);
  perform * from extensions.dblink_get_result('c2') as t(sid text, created boolean);
  perform extensions.dblink_exec('c2', 'commit');
  if v_new1 is not true or v_new2 is not false or v_sid1 <> v_sid2 then
    raise exception 'daily get-or-create: first (%, %), second (%, %)', v_sid1, v_new1, v_sid2, v_new2;
  end if;
  if (select count(*) from public.learning_sessions where user_id = qa.id(901) and kind = 'daily' and learning_date = date '2026-10-05') <> 1 then
    raise exception 'two daily sessions exist after the race';
  end if;

  ---------------------------------------------------------------------------
  -- 3. two parallel revisions with the same expected version: one wins, the other gets version_conflict
  ---------------------------------------------------------------------------
  perform extensions.dblink_exec('c1', 'begin');
  perform extensions.dblink_exec('c1', 'set local role authenticated');
  perform * from extensions.dblink('c1', format('select set_config(''request.jwt.claim.sub'', %L, true)', qa.id(901)::text)) as t(x text);
  perform extensions.dblink_exec('c2', 'begin');
  perform extensions.dblink_exec('c2', 'set local role authenticated');
  perform * from extensions.dblink('c2', format('select set_config(''request.jwt.claim.sub'', %L, true)', qa.id(901)::text)) as t(x text);
  select t.v into v_n from extensions.dblink('c1', format(
    'select public.app_revise_plan(%L, 1, ''{"sectionOrdinals":[1]}'', array[''quran''], ''book'', 15::smallint, null, ''{}'', ''rev-a'', ''{}'', date ''2026-10-06'', %L::jsonb)',
    qa.id(101), c_phases)) as t(v integer);
  if v_n <> 2 then raise exception 'the first revision returned %', v_n; end if;
  perform extensions.dblink_send_query('c2', format(
    'select public.app_revise_plan(%L, 1, ''{"sectionOrdinals":[1]}'', array[''quran''], ''book'', 5::smallint, null, ''{}'', ''rev-b'', ''{}'', date ''2026-10-06'', %L::jsonb)',
    qa.id(101), c_phases));
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the second revision did not wait for the row lock'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  v_state := null;
  begin
    perform * from extensions.dblink_get_result('c2') as t(v integer);
  exception when others then
    v_state := sqlstate;
  end;
  begin   -- drain the connection after the remote error, then end its transaction
    perform * from extensions.dblink_get_result('c2') as t(v integer);
  exception when others then null;
  end;
  perform extensions.dblink_exec('c2', 'rollback');
  if v_state is distinct from 'QT002' then raise exception 'the second revision ended with SQLSTATE %, expected QT002', v_state; end if;
  if (select current_version from public.master_plans where id = qa.id(101)) <> 2
     or (select count(*) from public.plan_versions where plan_id = qa.id(101)) <> 2
     or (select session_minutes from public.master_plans where id = qa.id(101)) <> 15 then
    raise exception 'exactly the first revision must have been applied';
  end if;

  ---------------------------------------------------------------------------
  -- 4. two parallel plan creations: one active plan remains, the other fails on the one-active-plan key
  ---------------------------------------------------------------------------
  perform extensions.dblink_exec('c1', 'begin');
  perform extensions.dblink_exec('c1', 'set local role authenticated');
  perform * from extensions.dblink('c1', format('select set_config(''request.jwt.claim.sub'', %L, true)', qa.id(901)::text)) as t(x text);
  perform extensions.dblink_exec('c2', 'begin');
  perform extensions.dblink_exec('c2', 'set local role authenticated');
  perform * from extensions.dblink('c2', format('select set_config(''request.jwt.claim.sub'', %L, true)', qa.id(901)::text)) as t(x text);
  perform * from extensions.dblink('c1', format(
    'select public.app_create_plan(%L, ''{"sectionOrdinals":[1]}'', array[''quran''], ''book'', 10::smallint, null, ''{}'', ''x'', ''{}'', date ''2026-10-07'', %L::jsonb, null, %L)',
    qa.id(5), c_phases, qa.id(1501))) as t(v uuid);
  perform extensions.dblink_send_query('c2', format(
    'select public.app_create_plan(%L, ''{"sectionOrdinals":[1]}'', array[''quran''], ''book'', 10::smallint, null, ''{}'', ''x'', ''{}'', date ''2026-10-07'', %L::jsonb, null, %L)',
    qa.id(5), c_phases, qa.id(1502)));
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the second plan creation did not wait for the row lock'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  v_state := null;
  begin
    perform * from extensions.dblink_get_result('c2') as t(v uuid);
  exception when others then
    v_state := sqlstate;
    get stacked diagnostics v_x = constraint_name;
  end;
  begin
    perform * from extensions.dblink_get_result('c2') as t(v uuid);
  exception when others then null;
  end;
  perform extensions.dblink_exec('c2', 'rollback');
  if v_state is distinct from '23505' then raise exception 'the second plan creation ended with SQLSTATE %, expected 23505', v_state; end if;
  if (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1
     or not exists (select 1 from public.master_plans where id = qa.id(1501) and status = 'active')
     or exists (select 1 from public.master_plans where id = qa.id(1502)) then
    raise exception 'exactly the first plan creation must have won';
  end if;

  ---------------------------------------------------------------------------
  -- 5. two parallel failures of one throttle key: no lost increment
  ---------------------------------------------------------------------------
  perform extensions.dblink_exec('c1', 'begin');
  perform * from extensions.dblink('c1', format('select public.srv_throttle_record(array[%L::bytea], ''failure'')', k1)) as t(x text);
  perform extensions.dblink_send_query('c2', format('select public.srv_throttle_record(array[%L::bytea], ''failure'')', k1));
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the second failure did not wait for the bucket row'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  perform * from extensions.dblink_get_result('c2') as t(x text);
  perform * from extensions.dblink_get_result('c2') as t(x text);
  if (select attempts from public.srv_throttle_check(array[k1])) <> 2 then
    raise exception 'two parallel failures counted % (a lost update)', (select attempts from public.srv_throttle_check(array[k1]));
  end if;

  perform extensions.dblink_disconnect('c1');
  perform extensions.dblink_disconnect('c2');
end;
$$;
-- cleanup of everything this chunk committed
drop extension dblink;
delete from private.auth_throttle;
delete from auth.users where id in (qa.id(901), qa.id(902), qa.id(903));
delete from public.book_editions where id = qa.id(5);
delete from public.books where id = qa.id(4);
delete from public.sources where id = qa.id(3);
delete from public.approved_source_rules where id = qa.id(2);
delete from public.categories where id = qa.id(1);
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array['public.master_plans', 'public.plan_versions', 'public.plan_phases', 'public.learning_sessions',
                           'public.profiles', 'private.account_handles', 'private.recovery_codes', 'private.password_reset_grants',
                           'private.app_sessions', 'private.auth_throttle', 'public.book_editions', 'auth.users'] loop
    execute format('select count(*) from %s', t) into n;
    if n <> 0 then raise exception 'cleanup left % rows in %', n, t; end if;
  end loop;
  if exists (select 1 from pg_extension where extname = 'dblink') then raise exception 'dblink is still installed'; end if;
end;
$$;
