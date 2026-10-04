-- checks_0003.sql
--
-- LOCAL VALIDATION ONLY. Assertions for supabase/migrations/0003_plans_sessions.sql, run by
-- run_local.sh right after that migration on a scratch database. Every "-- CHECK:" line
-- starts one independent chunk; a chunk passes when psql finishes it without an error.
-- Rows are synthetic placeholders (qa.make_fixture, qa.make_users, qa.make_plan) created
-- inside transactions that are rolled back; the one chunk that must test a real COMMIT
-- cleans up after itself. Expected values are written out here from
-- docs/Database-schema.md v1.1 (§3.3, §4.2, §4.3, §4.4, §6.3, §10, §11 `0003_plans_sessions`,
-- §14 checks 1, 7, 8, 13, 16, 17), not read back from the migration.

-- CHECK: 01 the seven tables exist, with row level security enabled (not forced), no policy, and no privilege for anon, authenticated and service_role
begin;
-- control: the platform default privileges are active, so the revoke is not vacuous
create table public.qa_default_privilege_probe (id integer);
do $$
begin
  if not has_table_privilege('anon', 'public.qa_default_privilege_probe', 'SELECT')
     or not has_table_privilege('authenticated', 'public.qa_default_privilege_probe', 'INSERT')
     or not has_table_privilege('service_role', 'public.qa_default_privilege_probe', 'DELETE') then
    raise exception 'control failed: the shim default privileges are not active, so this check would be vacuous';
  end if;
end;
$$;
rollback;
do $$
declare
  r record;
begin
  for r in
    select t from unnest(array['master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots',
                               'learning_sessions', 'attempts', 'session_activity_intervals']) as t
  loop
    if to_regclass('public.' || r.t) is null then
      raise exception 'missing table public.%', r.t;
    end if;
    if not exists (select 1 from pg_class c where c.oid = ('public.' || r.t)::regclass
                   and c.relrowsecurity and not c.relforcerowsecurity) then
      raise exception 'RLS not enabled (or forced) on public.%', r.t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.t) then
      raise exception 'a policy exists on public.% before 0005', r.t;
    end if;
  end loop;
  for r in
    select t, rol, p
    from unnest(array['master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots',
                      'learning_sessions', 'attempts', 'session_activity_intervals']) as t
    cross join unnest(array['anon', 'authenticated', 'service_role']) as rol
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
  loop
    if has_table_privilege(r.rol, 'public.' || r.t, r.p) then
      raise exception '% holds % on public.%', r.rol, r.p, r.t;
    end if;
  end loop;
  for r in
    select t, rol, p
    from unnest(array['master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots',
                      'learning_sessions', 'attempts', 'session_activity_intervals']) as t
    cross join unnest(array['anon', 'authenticated', 'service_role']) as rol
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p
  loop
    if has_any_column_privilege(r.rol, 'public.' || r.t, r.p) then
      raise exception '% holds column-level % on public.%', r.rol, r.p, r.t;
    end if;
  end loop;
end;
$$;

-- CHECK: 02 columns of the seven tables match §6.3 (type, nullability, default, order)
do $$
begin
  perform qa.assert_columns('public.master_plans'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'edition_id|uuid|NOT NULL|',
    'target_scope|jsonb|NOT NULL|',
    'paths|text[]|NOT NULL|',
    'plan_order|text|NOT NULL|''book''::text',
    'session_minutes|smallint|NOT NULL|',
    'preferred_date|date|NULL|',
    'agreed_estimate|jsonb|NOT NULL|',
    'current_version|integer|NOT NULL|1',
    'status|text|NOT NULL|''active''::text',
    'created_at|timestamp with time zone|NOT NULL|now()',
    'updated_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.plan_versions'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'plan_id|uuid|NOT NULL|',
    'user_id|uuid|NOT NULL|',
    'version_no|integer|NOT NULL|',
    'reason_code|text|NOT NULL|',
    'policy_json|jsonb|NOT NULL|''{}''::jsonb',
    'effective_learning_date|date|NOT NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.plan_phases'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'plan_version_id|uuid|NOT NULL|',
    'user_id|uuid|NOT NULL|',
    'ordinal|integer|NOT NULL|',
    'section_refs|jsonb|NOT NULL|',
    'unit_range|jsonb|NOT NULL|',
    'goal_size|integer|NOT NULL|',
    'estimated_window|daterange|NOT NULL|']);
  perform qa.assert_columns('public.offline_snapshots'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'plan_id|uuid|NOT NULL|',
    'plan_version|integer|NOT NULL|',
    'edition_id|uuid|NOT NULL|',
    'bank_version|integer|NOT NULL|',
    'client_operation_id|uuid|NOT NULL|',
    'download_target_refs|jsonb|NOT NULL|',
    'schema_version|integer|NOT NULL|',
    'protocol_version|integer|NOT NULL|',
    'payload|jsonb|NOT NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.learning_sessions'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'plan_id|uuid|NULL|',
    'plan_version_id|uuid|NULL|',
    'phase_id|uuid|NULL|',
    'edition_id|uuid|NOT NULL|',
    'kind|text|NOT NULL|',
    'learning_date|date|NOT NULL|',
    'lesson_refs|uuid[]|NOT NULL|''{}''::uuid[]',
    'question_refs|uuid[]|NOT NULL|''{}''::uuid[]',
    'steps|jsonb|NOT NULL|',
    'bank_version|integer|NOT NULL|',
    'self_rating|text|NULL|',
    'status|text|NOT NULL|',
    'elapsed_ms|bigint|NOT NULL|0',
    'offline_snapshot_id|uuid|NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()',
    'updated_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.attempts'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'session_id|uuid|NOT NULL|',
    'edition_id|uuid|NOT NULL|',
    'client_event_id|uuid|NOT NULL|',
    'question_id|uuid|NOT NULL|',
    'passage_id|uuid|NOT NULL|',
    'correct|boolean|NOT NULL|',
    'assisted|boolean|NOT NULL|false',
    'error_kind|text|NULL|',
    'wrong_token_ref|text|NULL|',
    'review_round_id|uuid|NULL|',
    'duration_ms|integer|NOT NULL|',
    'occurred_at|timestamp with time zone|NOT NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.session_activity_intervals'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'session_id|uuid|NOT NULL|',
    'client_event_id|uuid|NOT NULL|',
    'started_at|timestamp with time zone|NOT NULL|',
    'ended_at|timestamp with time zone|NOT NULL|',
    'active_ms|bigint|NOT NULL|',
    'learning_date|date|NOT NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()']);
end;
$$;

-- CHECK: 03 keys, composite parent-ownership keys, foreign keys with their delete classes (A, B, C, F, G) and indexes match §4.2, §4.3 and §6.3
do $$
begin
  perform qa.assert_same_set('master_plans keys', qa.key_defs('public.master_plans'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (edition_id) REFERENCES book_editions(id) ON DELETE RESTRICT',
    -- class G: NO ACTION, deferrable, initially deferred
    'FOREIGN KEY (id, current_version) REFERENCES plan_versions(plan_id, version_no) DEFERRABLE INITIALLY DEFERRED',
    'UNIQUE (id, user_id)',
    'UNIQUE (id, user_id, edition_id)']);
  perform qa.assert_same_set('master_plans indexes', qa.index_defs('public.master_plans'::regclass), array[
    'CREATE UNIQUE INDEX ON public.master_plans USING btree (user_id) WHERE (status = ''active''::text)',
    'CREATE INDEX ON public.master_plans USING btree (user_id, status)',
    'CREATE INDEX ON public.master_plans USING btree (edition_id)']);

  perform qa.assert_same_set('plan_versions keys', qa.key_defs('public.plan_versions'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (plan_id, user_id) REFERENCES master_plans(id, user_id) ON DELETE CASCADE',
    'UNIQUE (plan_id, version_no)',
    'UNIQUE (id, user_id)',
    'UNIQUE (id, plan_id, user_id)']);
  perform qa.assert_same_set('plan_versions indexes', qa.index_defs('public.plan_versions'::regclass), array[
    'CREATE INDEX ON public.plan_versions USING btree (user_id, plan_id)']);

  perform qa.assert_same_set('plan_phases keys', qa.key_defs('public.plan_phases'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (plan_version_id, user_id) REFERENCES plan_versions(id, user_id) ON DELETE CASCADE',
    'UNIQUE (plan_version_id, ordinal)',
    'UNIQUE (id, plan_version_id, user_id)']);
  perform qa.assert_same_set('plan_phases indexes', qa.index_defs('public.plan_phases'::regclass), array[
    'CREATE INDEX ON public.plan_phases USING btree (user_id, plan_version_id)']);

  perform qa.assert_same_set('offline_snapshots keys', qa.key_defs('public.offline_snapshots'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (plan_id, user_id, edition_id) REFERENCES master_plans(id, user_id, edition_id) ON DELETE CASCADE',
    'FOREIGN KEY (plan_id, plan_version) REFERENCES plan_versions(plan_id, version_no) ON DELETE CASCADE',
    'UNIQUE (user_id, client_operation_id)',
    'UNIQUE (id, user_id)']);
  perform qa.assert_same_set('offline_snapshots indexes', qa.index_defs('public.offline_snapshots'::regclass), array[
    'CREATE INDEX ON public.offline_snapshots USING btree (user_id, plan_id, created_at)']);

  perform qa.assert_same_set('learning_sessions keys', qa.key_defs('public.learning_sessions'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (edition_id) REFERENCES book_editions(id) ON DELETE RESTRICT',
    'FOREIGN KEY (plan_id, user_id, edition_id) REFERENCES master_plans(id, user_id, edition_id) ON DELETE CASCADE',
    'FOREIGN KEY (plan_version_id, plan_id, user_id) REFERENCES plan_versions(id, plan_id, user_id) ON DELETE CASCADE',
    'FOREIGN KEY (phase_id, plan_version_id, user_id) REFERENCES plan_phases(id, plan_version_id, user_id) ON DELETE CASCADE',
    -- class F: SET NULL on the link column only
    'FOREIGN KEY (offline_snapshot_id, user_id) REFERENCES offline_snapshots(id, user_id) ON DELETE SET NULL (offline_snapshot_id)',
    'UNIQUE (id, user_id)',
    'UNIQUE (id, user_id, edition_id)']);
  perform qa.assert_same_set('learning_sessions indexes', qa.index_defs('public.learning_sessions'::regclass), array[
    'CREATE INDEX ON public.learning_sessions USING btree (user_id, learning_date)',
    'CREATE INDEX ON public.learning_sessions USING btree (user_id, plan_id, learning_date)',
    'CREATE INDEX ON public.learning_sessions USING btree (user_id) WHERE (status <> ''completed''::text)',
    'CREATE INDEX ON public.learning_sessions USING btree (offline_snapshot_id) WHERE (offline_snapshot_id IS NOT NULL)',
    'CREATE INDEX ON public.learning_sessions USING btree (plan_version_id)',
    'CREATE INDEX ON public.learning_sessions USING btree (phase_id)',
    -- A-01: at most one server-side daily session per account and learning date
    'CREATE UNIQUE INDEX ON public.learning_sessions USING btree (user_id, learning_date) WHERE ((kind = ''daily''::text) AND (status = ANY (ARRAY[''prepared''::text, ''open''::text])) AND (offline_snapshot_id IS NULL))']);

  perform qa.assert_same_set('attempts keys', qa.key_defs('public.attempts'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (session_id, user_id, edition_id) REFERENCES learning_sessions(id, user_id, edition_id) ON DELETE CASCADE',
    'FOREIGN KEY (question_id, edition_id, passage_id) REFERENCES question_items(id, edition_id, passage_id) ON DELETE RESTRICT',
    'UNIQUE (user_id, client_event_id)',
    'UNIQUE (id, user_id, passage_id)']);
  perform qa.assert_same_set('attempts indexes', qa.index_defs('public.attempts'::regclass), array[
    'CREATE INDEX ON public.attempts USING btree (session_id, created_at)',
    'CREATE INDEX ON public.attempts USING btree (user_id, passage_id, created_at)']);

  perform qa.assert_same_set('session_activity_intervals keys', qa.key_defs('public.session_activity_intervals'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (session_id, user_id) REFERENCES learning_sessions(id, user_id) ON DELETE CASCADE',
    'UNIQUE (user_id, client_event_id)']);
  perform qa.assert_same_set('session_activity_intervals indexes', qa.index_defs('public.session_activity_intervals'::regclass), array[
    'CREATE INDEX ON public.session_activity_intervals USING btree (user_id, learning_date, started_at)',
    'CREATE INDEX ON public.session_activity_intervals USING btree (session_id)']);
end;
$$;

-- CHECK: 04 one active plan per account: a second active plan fails, pausing and inserting in one transaction succeeds (§14 check 8)
begin;
select qa.make_fixture();
select qa.make_users();
do $$
begin
  perform qa.make_plan(qa.id(101), qa.id(901), 'active');

  -- a second active plan of the same account is refused
  perform qa.expect_unique($q$select qa.make_plan(qa.id(102), qa.id(901), 'active')$q$, 'master_plans_user_id_active_key');

  -- paused and completed plans may accumulate, and another account has its own active plan
  perform qa.expect_ok($q$select qa.make_plan(qa.id(103), qa.id(901), 'paused')$q$, 'a paused plan');
  perform qa.expect_ok($q$select qa.make_plan(qa.id(104), qa.id(901), 'paused')$q$, 'a second paused plan');
  perform qa.expect_ok($q$select qa.make_plan(qa.id(105), qa.id(901), 'completed')$q$, 'a completed plan');
  perform qa.expect_ok($q$select qa.make_plan(qa.id(106), qa.id(902), 'active')$q$, 'an active plan of another account');

  -- activating a paused plan while another is active is refused; pausing first succeeds
  perform qa.expect_unique($q$update public.master_plans set status = 'active' where id = qa.id(103)$q$, 'master_plans_user_id_active_key');
  update public.master_plans set status = 'paused' where user_id = qa.id(901) and status = 'active';
  perform qa.expect_ok($q$select qa.make_plan(qa.id(107), qa.id(901), 'active')$q$, 'a new active plan after pausing');
  update public.master_plans set status = 'paused' where user_id = qa.id(901) and status = 'active';
  perform qa.expect_ok($q$update public.master_plans set status = 'active' where id = qa.id(103)$q$, 'resuming a paused plan after pausing the active one');

  -- the whole set passes the deferred key check
  set constraints all immediate;
  set constraints all deferred;
end;
$$;
rollback;

-- CHECK: 05 daily session uniqueness (A-01): a second server-side daily session is refused; offline-prepared, completed, game and placement sessions coexist (§14 check 16)
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
select qa.make_plan(qa.id(102), qa.id(902));
insert into public.offline_snapshots
  (id, user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id,
   download_target_refs, schema_version, protocol_version, payload)
values (qa.id(301), qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(401), '[]', 1, 1, '{}');
do $$
declare
  v_idx constant text := 'learning_sessions_user_id_learning_date_daily_key';
begin
  perform qa.make_session(qa.id(201), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'open');

  -- refused: another prepared or open daily session without a snapshot, same account and date
  perform qa.expect_unique($q$select qa.make_session(qa.id(202), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'open')$q$, v_idx);
  perform qa.expect_unique($q$select qa.make_session(qa.id(202), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'prepared')$q$, v_idx);

  -- accepted: outside the partial index
  perform qa.expect_ok($q$select qa.make_session(qa.id(203), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'completed')$q$, 'a completed daily session');
  perform qa.expect_ok($q$select qa.make_session(qa.id(204), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'completed')$q$, 'a second completed daily session');
  perform qa.expect_ok($q$select qa.make_session(qa.id(205), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'prepared', qa.id(301))$q$, 'an offline-prepared daily session');
  perform qa.expect_ok($q$select qa.make_session(qa.id(206), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'prepared', qa.id(301))$q$, 'a second offline-prepared daily session');
  perform qa.expect_ok($q$select qa.make_session(qa.id(207), qa.id(901), qa.id(101), 'game', date '2026-10-05', 'open')$q$, 'a game session');
  perform qa.expect_ok($q$select qa.make_session(qa.id(208), qa.id(901), qa.id(101), 'game', date '2026-10-05', 'open')$q$, 'a second game session');
  perform qa.expect_ok($q$insert into public.learning_sessions (id, user_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(209), qa.id(901), qa.id(5), 'placement', date '2026-10-05', '[]', 1, 'open')$q$, 'a placement session');
  perform qa.expect_ok($q$insert into public.learning_sessions (id, user_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(210), qa.id(901), qa.id(5), 'placement', date '2026-10-05', '[]', 1, 'open')$q$, 'a second placement session');
  perform qa.expect_ok($q$select qa.make_session(qa.id(211), qa.id(901), qa.id(101), 'daily', date '2026-10-06', 'open')$q$, 'another date');
  perform qa.expect_ok($q$select qa.make_session(qa.id(212), qa.id(902), qa.id(102), 'daily', date '2026-10-05', 'open')$q$, 'another account, same date');

  -- completing the open daily session frees the slot
  update public.learning_sessions set status = 'completed' where id = qa.id(201);
  perform qa.expect_ok($q$select qa.make_session(qa.id(213), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'open')$q$, 'a new daily session after completion');
end;
$$;
rollback;

-- CHECK: 06 the deferred cyclic key (class G): plan and first version together succeed; a plan without its version fails when the key is checked
begin;
select qa.make_fixture();
select qa.make_users();
do $$
begin
  -- plan + version 1 in one transaction: the key is satisfied at the check
  perform qa.make_plan(qa.id(101), qa.id(901));
  set constraints all immediate;
  set constraints all deferred;

  -- a plan alone: the insert itself passes (the key is deferred) ...
  insert into public.master_plans
    (id, user_id, edition_id, target_scope, paths, session_minutes, agreed_estimate, status)
  values (qa.id(102), qa.id(902), qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 10, '{}', 'paused');
  -- ... and fails when the constraint is checked
  perform qa.expect_error('set constraints all immediate', '23503', 'plan without a version',
                          'master_plans_id_current_version_fkey');
end;
$$;
rollback;
begin;
select qa.make_fixture();
select qa.make_users();
do $$
begin
  -- current_version must name an existing version: version 2 does not exist yet
  perform qa.make_plan(qa.id(101), qa.id(901));
  update public.master_plans set current_version = 2 where id = qa.id(101);
  perform qa.expect_error('set constraints all immediate', '23503', 'current_version 2 without a version 2',
                          'master_plans_id_current_version_fkey');
end;
$$;
rollback;
begin;
select qa.make_fixture();
select qa.make_users();
do $$
begin
  -- inserting the next version in the same transaction satisfies it
  perform qa.make_plan(qa.id(101), qa.id(901));
  update public.master_plans set current_version = 2 where id = qa.id(101);
  insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
  values (qa.id(101), qa.id(901), 2, 'test', date '2026-10-06');
  set constraints all immediate;
  set constraints all deferred;
  -- the current version cannot be deleted while the plan points at it (NO ACTION)
  delete from public.plan_versions where plan_id = qa.id(101) and version_no = 2;
  perform qa.expect_error('set constraints all immediate', '23503', 'deleting the current version',
                          'master_plans_id_current_version_fkey');
end;
$$;
rollback;

-- CHECK: 07 the deferred key at COMMIT: a transaction with a plan and its version commits; a plan without a version is refused at commit and leaves nothing behind
-- (this chunk commits for real and removes its rows at the end)
select qa.make_fixture();
select qa.make_users();
begin;
select qa.make_plan(qa.id(101), qa.id(901));
commit;
\set ON_ERROR_STOP off
begin;
insert into public.master_plans
  (id, user_id, edition_id, target_scope, paths, session_minutes, agreed_estimate, status)
values (qa.id(102), qa.id(902), qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 10, '{}', 'paused');
commit;
\set ON_ERROR_STOP on
do $$
begin
  if not exists (select 1 from public.master_plans where id = qa.id(101))
     or not exists (select 1 from public.plan_versions where plan_id = qa.id(101) and version_no = 1) then
    raise exception 'the committed plan and its version are missing';
  end if;
  if exists (select 1 from public.master_plans where id = qa.id(102)) then
    raise exception 'a plan without a version was committed';
  end if;
end;
$$;
delete from auth.users where id in (qa.id(901), qa.id(902), qa.id(903));
delete from public.book_editions where id = qa.id(5);
delete from public.books where id = qa.id(4);
delete from public.sources where id = qa.id(3);
delete from public.approved_source_rules where id = qa.id(2);
delete from public.categories where id = qa.id(1);
do $$
begin
  if exists (select 1 from public.master_plans) or exists (select 1 from public.plan_versions)
     or exists (select 1 from public.book_editions) or exists (select 1 from auth.users) then
    raise exception 'cleanup left rows behind';
  end if;
end;
$$;

-- CHECK: 08 guard_plan_order: reverse is accepted for the Quran edition only (D72, §14 check 13)
begin;
select qa.make_fixture();
select qa.make_hadith_edition();
select qa.make_users();
do $$
declare
  c constant text := 'master_plans_plan_order_quran_only_check';
begin
  -- a Quran plan: both orders
  perform qa.make_plan(qa.id(101), qa.id(901), 'paused');
  perform qa.expect_ok($q$update public.master_plans set plan_order = 'reverse' where id = qa.id(101)$q$, 'reverse on a Quran edition');
  perform qa.expect_ok($q$update public.master_plans set plan_order = 'book' where id = qa.id(101)$q$, 'book on a Quran edition');
  perform qa.expect_ok($q$insert into public.master_plans (id, user_id, edition_id, target_scope, paths, plan_order, session_minutes, agreed_estimate, status)
    values (qa.id(102), qa.id(902), qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'reverse', 10, '{}', 'paused')$q$, 'insert reverse on a Quran edition');

  -- a hadith plan: book only
  perform qa.expect_check($q$insert into public.master_plans (id, user_id, edition_id, target_scope, paths, plan_order, session_minutes, agreed_estimate, status)
    values (qa.id(103), qa.id(901), qa.id(21), '{"sectionOrdinals":[1]}', array['matn'], 'reverse', 10, '{}', 'paused')$q$, c);
  perform qa.expect_ok($q$insert into public.master_plans (id, user_id, edition_id, target_scope, paths, plan_order, session_minutes, agreed_estimate, status)
    values (qa.id(103), qa.id(901), qa.id(21), '{"sectionOrdinals":[1]}', array['matn'], 'book', 10, '{}', 'paused')$q$, 'book on a hadith edition');
  perform qa.expect_check($q$update public.master_plans set plan_order = 'reverse' where id = qa.id(103)$q$, c);
  -- moving a reverse plan to a hadith edition is refused too (the trigger also watches edition_id)
  perform qa.expect_check($q$update public.master_plans set edition_id = qa.id(21) where id = qa.id(102)$q$, c);
  -- an unrelated update does not re-run the guard
  perform qa.expect_ok($q$update public.master_plans set session_minutes = 15 where id = qa.id(102)$q$, 'unrelated update');
  -- the guard is not a substitute for the value set
  perform qa.expect_check($q$update public.master_plans set plan_order = 'sideways' where id = qa.id(101)$q$, 'master_plans_plan_order_check');
end;
$$;
rollback;

-- CHECK: 09 value sets of §4.4 (A-05) and the four memorization paths: unknown values are rejected, every listed value is accepted
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
select qa.make_session(qa.id(201), qa.id(901), qa.id(101), 'daily', date '2026-10-05', 'open');
do $$
declare
  v text;
  n integer;
begin
  -- master_plans.status, plan_order, session_minutes
  foreach v in array array['paused', 'completed', 'active'] loop
    perform qa.expect_ok(format($q$update public.master_plans set status = %L where id = qa.id(101)$q$, v), 'plan status ' || v);
  end loop;
  perform qa.expect_check($q$update public.master_plans set status = 'archived' where id = qa.id(101)$q$, 'master_plans_status_check');
  perform qa.expect_check($q$update public.master_plans set plan_order = 'random' where id = qa.id(101)$q$, 'master_plans_plan_order_check');
  foreach n in array array[5, 10, 15] loop
    perform qa.expect_ok(format($q$update public.master_plans set session_minutes = %s where id = qa.id(101)$q$, n), 'plan minutes ' || n);
  end loop;
  foreach n in array array[0, 7, 20] loop
    perform qa.expect_check(format($q$update public.master_plans set session_minutes = %s where id = qa.id(101)$q$, n), 'master_plans_session_minutes_check');
  end loop;

  -- master_plans.paths: at least one element, each one of quran, matn, sanad, grade (§4.4)
  foreach v in array array['{quran}', '{matn}', '{sanad}', '{grade}', '{matn,sanad,grade}', '{matn,grade}'] loop
    perform qa.expect_ok(format($q$update public.master_plans set paths = %L where id = qa.id(101)$q$, v), 'paths ' || v);
  end loop;
  foreach v in array array['{}', '{bogus}', '{quran,bogus}', '{Quran}', '{hadith}', '{"matn "}', '{takhrij}', '{matn,takhrij}'] loop
    perform qa.expect_check(format($q$update public.master_plans set paths = %L where id = qa.id(101)$q$, v), 'master_plans_paths_check');
  end loop;
  perform qa.expect_check($q$update public.master_plans set paths = array[null]::text[] where id = qa.id(101)$q$, 'master_plans_paths_check');

  -- master_plans jsonb containers
  perform qa.expect_check($q$update public.master_plans set target_scope = '[]' where id = qa.id(101)$q$, 'master_plans_target_scope_check');
  perform qa.expect_check($q$update public.master_plans set target_scope = '{}' where id = qa.id(101)$q$, 'master_plans_target_scope_check');
  perform qa.expect_check($q$update public.master_plans set target_scope = '{"sectionOrdinals": 1}' where id = qa.id(101)$q$, 'master_plans_target_scope_check');
  perform qa.expect_check($q$update public.master_plans set agreed_estimate = '[]' where id = qa.id(101)$q$, 'master_plans_agreed_estimate_check');
  perform qa.expect_check($q$update public.master_plans set current_version = 0 where id = qa.id(101)$q$, 'master_plans_current_version_check');

  -- learning_sessions.kind, status, self_rating
  perform qa.expect_check($q$update public.learning_sessions set kind = 'review' where id = qa.id(201)$q$, 'learning_sessions_kind_check');
  foreach v in array array['prepared', 'completed', 'open'] loop
    perform qa.expect_ok(format($q$update public.learning_sessions set status = %L where id = qa.id(201)$q$, v), 'session status ' || v);
  end loop;
  perform qa.expect_check($q$update public.learning_sessions set status = 'closed' where id = qa.id(201)$q$, 'learning_sessions_status_check');
  foreach v in array array['none', 'some', 'most'] loop
    perform qa.expect_ok(format($q$update public.learning_sessions set kind = 'placement', self_rating = %L where id = qa.id(201)$q$, v), 'self_rating ' || v);
  end loop;
  perform qa.expect_check($q$update public.learning_sessions set kind = 'placement', self_rating = 'all' where id = qa.id(201)$q$, 'learning_sessions_self_rating_check');
  perform qa.expect_ok($q$update public.learning_sessions set kind = 'game', self_rating = null where id = qa.id(201)$q$, 'game kind');
  perform qa.expect_ok($q$update public.learning_sessions set kind = 'daily' where id = qa.id(201)$q$, 'daily kind');

  -- plan_versions, plan_phases, offline_snapshots containers and bounds
  perform qa.expect_check($q$insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
    values (qa.id(101), qa.id(901), 0, 'test', date '2026-10-06')$q$, 'plan_versions_version_no_check');
  perform qa.expect_check($q$insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
    values (qa.id(101), qa.id(901), 2, ' ', date '2026-10-06')$q$, 'plan_versions_reason_code_check');
  perform qa.expect_check($q$insert into public.plan_versions (plan_id, user_id, version_no, reason_code, policy_json, effective_learning_date)
    values (qa.id(101), qa.id(901), 2, 'test', '[]', date '2026-10-06')$q$, 'plan_versions_policy_json_check');
  perform qa.expect_unique($q$insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
    values (qa.id(101), qa.id(901), 1, 'test', date '2026-10-06')$q$, 'plan_versions_plan_id_version_no_key');
end;
$$;
rollback;

-- CHECK: 10 plan_phases and offline_snapshots rules: bounds, containers, unique keys
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
do $$
declare
  v_version uuid := (select id from public.plan_versions where plan_id = qa.id(101));
begin
  perform qa.expect_ok(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(901), 1, '[]', '{}', 10, '[2026-10-05,2026-10-12)')$q$, v_version), 'a valid phase');
  perform qa.expect_unique(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(901), 1, '[]', '{}', 10, '[2026-10-05,2026-10-12)')$q$, v_version), 'plan_phases_plan_version_id_ordinal_key');
  perform qa.expect_check(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(901), 0, '[]', '{}', 10, '[2026-10-05,2026-10-12)')$q$, v_version), 'plan_phases_ordinal_check');
  perform qa.expect_check(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(901), 2, '{}', '{}', 10, '[2026-10-05,2026-10-12)')$q$, v_version), 'plan_phases_section_refs_check');
  perform qa.expect_check(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(901), 2, '[]', '[]', 10, '[2026-10-05,2026-10-12)')$q$, v_version), 'plan_phases_unit_range_check');
  perform qa.expect_check(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(901), 2, '[]', '{}', 0, '[2026-10-05,2026-10-12)')$q$, v_version), 'plan_phases_goal_size_check');
  perform qa.expect_check(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(901), 2, '[]', '{}', 10, 'empty')$q$, v_version), 'plan_phases_estimated_window_check');

  perform qa.expect_ok($q$insert into public.offline_snapshots (id, user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(301), qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(401), '[]', 1, 1, '{}')$q$, 'a valid snapshot');
  perform qa.expect_unique($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(401), '[]', 1, 1, '{}')$q$, 'offline_snapshots_user_id_client_operation_id_key');
  perform qa.expect_check($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 0, qa.id(5), 1, qa.id(402), '[]', 1, 1, '{}')$q$, 'offline_snapshots_plan_version_check');
  perform qa.expect_check($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 1, qa.id(5), 0, qa.id(402), '[]', 1, 1, '{}')$q$, 'offline_snapshots_bank_version_check');
  perform qa.expect_check($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(402), '{}', 1, 1, '{}')$q$, 'offline_snapshots_download_target_refs_check');
  perform qa.expect_check($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(402), '[]', 0, 1, '{}')$q$, 'offline_snapshots_schema_version_check');
  perform qa.expect_check($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(402), '[]', 1, 0, '{}')$q$, 'offline_snapshots_protocol_version_check');
  perform qa.expect_check($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(402), '[]', 1, 1, '[]')$q$, 'offline_snapshots_payload_check');
end;
$$;
rollback;

-- CHECK: 11 learning_sessions couplings: plan pair, plan required unless placement, phase needs a version, rating only for placement, steps an array
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
do $$
declare
  v_version uuid := (select id from public.plan_versions where plan_id = qa.id(101));
begin
  -- plan_id and plan_version_id are null together
  perform qa.expect_check(format($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), null, %L, qa.id(5), 'placement', date '2026-10-05', '[]', 1, 'open')$q$, v_version), 'learning_sessions_plan_pair_check');
  perform qa.expect_check($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(101), null, qa.id(5), 'daily', date '2026-10-05', '[]', 1, 'open')$q$, 'learning_sessions_plan_pair_check');
  -- a plan is optional only for placement (D42)
  perform qa.expect_ok($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(5), 'placement', date '2026-10-05', '[]', 1, 'open')$q$, 'placement without a plan');
  perform qa.expect_check($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(5), 'daily', date '2026-10-05', '[]', 1, 'open')$q$, 'learning_sessions_plan_required_check');
  perform qa.expect_check($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(5), 'game', date '2026-10-05', '[]', 1, 'open')$q$, 'learning_sessions_plan_required_check');
  -- a phase needs a version
  perform qa.expect_check($q$insert into public.learning_sessions (user_id, phase_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(777), qa.id(5), 'placement', date '2026-10-05', '[]', 1, 'open')$q$, 'learning_sessions_phase_requires_version_check');
  -- a rating only for placement
  perform qa.expect_check($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status, self_rating)
    values (qa.id(901), qa.id(101), (select id from public.plan_versions where plan_id = qa.id(101)), qa.id(5), 'daily', date '2026-10-05', '[]', 1, 'open', 'some')$q$, 'learning_sessions_self_rating_placement_check');
  perform qa.expect_ok($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version, status, self_rating)
    values (qa.id(901), qa.id(5), 'placement', date '2026-10-06', '[]', 1, 'open', 'some')$q$, 'a rated placement');
  -- steps: an array; bank version and elapsed time bounds
  perform qa.expect_check($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(5), 'placement', date '2026-10-07', '{}', 1, 'open')$q$, 'learning_sessions_steps_check');
  perform qa.expect_check($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(5), 'placement', date '2026-10-07', '[]', 0, 'open')$q$, 'learning_sessions_bank_version_check');
  perform qa.expect_check($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version, status, elapsed_ms)
    values (qa.id(901), qa.id(5), 'placement', date '2026-10-07', '[]', 1, 'open', -1)$q$, 'learning_sessions_elapsed_ms_check');
  -- status has no default; the other defaults apply
  perform qa.expect_error($q$insert into public.learning_sessions (user_id, edition_id, kind, learning_date, steps, bank_version)
    values (qa.id(901), qa.id(5), 'placement', date '2026-10-07', '[]', 1)$q$, '23502', 'status has no default');
  insert into public.learning_sessions (id, user_id, edition_id, kind, learning_date, steps, bank_version, status)
  values (qa.id(299), qa.id(901), qa.id(5), 'placement', date '2026-10-08', '[]', 1, 'open');
  if (select (lesson_refs, question_refs, elapsed_ms)::text from public.learning_sessions where id = qa.id(299)) <> '({},{},0)' then
    raise exception 'learning_sessions defaults differ from §6.3';
  end if;
end;
$$;
rollback;

-- CHECK: 12 composite parent-ownership keys: a row cannot name another account's parent, another plan's version or another edition's plan (§4.3, §14 check 1)
begin;
select qa.make_fixture();
select qa.make_hadith_edition();
select qa.make_passage2();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901), 'active');
select qa.make_plan(qa.id(102), qa.id(901), 'paused');
select qa.make_plan(qa.id(103), qa.id(902), 'active');
select qa.make_session(qa.id(201), qa.id(901), qa.id(101));
select qa.make_session(qa.id(203), qa.id(902), qa.id(103));
insert into public.plan_phases (id, plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
select qa.id(501), pv.id, qa.id(901), 1, '[]', '{}', 10, '[2026-10-05,2026-10-12)'
from public.plan_versions pv where pv.plan_id = qa.id(101);
insert into public.offline_snapshots
  (id, user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id,
   download_target_refs, schema_version, protocol_version, payload)
values (qa.id(301), qa.id(902), qa.id(103), 1, qa.id(5), 1, qa.id(401), '[]', 1, 1, '{}');
do $$
declare
  v_ver101 uuid := (select id from public.plan_versions where plan_id = qa.id(101));
  v_ver102 uuid := (select id from public.plan_versions where plan_id = qa.id(102));
begin
  -- plan_versions: the plan must belong to the same user
  perform qa.expect_fk($q$insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
    values (qa.id(101), qa.id(902), 2, 'test', date '2026-10-06')$q$, 'plan_versions_plan_id_user_id_fkey');
  -- plan_phases: the version must belong to the same user
  perform qa.expect_fk(format($q$insert into public.plan_phases (plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
    values (%L, qa.id(902), 2, '[]', '{}', 10, '[2026-10-05,2026-10-12)')$q$, v_ver101), 'plan_phases_plan_version_id_user_id_fkey');
  -- learning_sessions: the plan of another account
  perform qa.expect_fk(format($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(902), qa.id(101), %L, qa.id(5), 'game', date '2026-10-05', '[]', 1, 'open')$q$, v_ver101), 'learning_sessions_plan_id_user_id_edition_id_fkey');
  -- the plan's edition must equal the session's edition
  perform qa.expect_fk(format($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(101), %L, qa.id(21), 'game', date '2026-10-05', '[]', 1, 'open')$q$, v_ver101), 'learning_sessions_plan_id_user_id_edition_id_fkey');
  -- a version of another plan
  perform qa.expect_fk(format($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(101), %L, qa.id(5), 'game', date '2026-10-05', '[]', 1, 'open')$q$, v_ver102), 'learning_sessions_plan_version_id_plan_id_user_id_fkey');
  -- a phase of another version
  perform qa.expect_fk(format($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, phase_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(102), %L, qa.id(501), qa.id(5), 'game', date '2026-10-05', '[]', 1, 'open')$q$, v_ver102), 'learning_sessions_phase_id_plan_version_id_user_id_fkey');
  perform qa.expect_ok(format($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, phase_id, edition_id, kind, learning_date, steps, bank_version, status)
    values (qa.id(901), qa.id(101), %L, qa.id(501), qa.id(5), 'game', date '2026-10-05', '[]', 1, 'open')$q$, v_ver101), 'a phase of its own version');
  -- an offline snapshot of another account
  perform qa.expect_fk(format($q$insert into public.learning_sessions (user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps, bank_version, status, offline_snapshot_id)
    values (qa.id(901), qa.id(101), %L, qa.id(5), 'game', date '2026-10-05', '[]', 1, 'prepared', qa.id(301))$q$, v_ver101), 'learning_sessions_offline_snapshot_id_user_id_fkey');

  -- offline_snapshots: another account's plan, another edition than the plan's, a version that does not exist
  perform qa.expect_fk($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(103), 1, qa.id(5), 1, qa.id(402), '[]', 1, 1, '{}')$q$, 'offline_snapshots_plan_id_user_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 1, qa.id(21), 1, qa.id(402), '[]', 1, 1, '{}')$q$, 'offline_snapshots_plan_id_user_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.offline_snapshots (user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id, download_target_refs, schema_version, protocol_version, payload)
    values (qa.id(901), qa.id(101), 2, qa.id(5), 1, qa.id(402), '[]', 1, 1, '{}')$q$, 'offline_snapshots_plan_id_plan_version_fkey');

  -- attempts: a session of another account, another edition than the session's, a question of another passage
  perform qa.expect_fk($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(902), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), true, 10, now())$q$, 'attempts_session_id_user_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(901), qa.id(201), qa.id(21), qa.id(601), qa.id(12), qa.id(9), true, 10, now())$q$, 'attempts_session_id_user_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(31), true, 10, now())$q$, 'attempts_question_id_edition_id_passage_id_fkey');
  perform qa.expect_ok($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), true, 10, now())$q$, 'a matching attempt');

  -- session_activity_intervals: a session of another account
  perform qa.expect_fk($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(902), qa.id(201), qa.id(701), now() - interval '1 minute', now(), 1000, date '2026-10-05')$q$, 'session_activity_intervals_session_id_user_id_fkey');
  perform qa.expect_ok($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(701), now() - interval '1 minute', now(), 1000, date '2026-10-05')$q$, 'a matching interval');
end;
$$;
rollback;

-- CHECK: 13 delete behaviour: class A and B cascades, class C RESTRICT, class F SET NULL on the link only, class G NO ACTION
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901), 'active');
select qa.make_plan(qa.id(103), qa.id(902), 'active');
select qa.make_session(qa.id(201), qa.id(901), qa.id(101));
select qa.make_session(qa.id(203), qa.id(902), qa.id(103));
insert into public.plan_phases (id, plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
select qa.id(501), pv.id, qa.id(901), 1, '[]', '{}', 10, '[2026-10-05,2026-10-12)'
from public.plan_versions pv where pv.plan_id = qa.id(101);
insert into public.offline_snapshots
  (id, user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id,
   download_target_refs, schema_version, protocol_version, payload)
values (qa.id(301), qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(401), '[]', 1, 1, '{}');
insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
values (qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), true, 10, now()),
       (qa.id(902), qa.id(203), qa.id(5), qa.id(602), qa.id(12), qa.id(9), true, 10, now());
insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
values (qa.id(901), qa.id(201), qa.id(701), now() - interval '1 minute', now(), 1000, date '2026-10-05');
do $$
begin
  -- class F: deleting an offline snapshot detaches the sessions (link column only)
  perform qa.make_session(qa.id(202), qa.id(901), qa.id(101), 'game', date '2026-10-05', 'prepared', qa.id(301));
  delete from public.offline_snapshots where id = qa.id(301);
  if not exists (select 1 from public.learning_sessions
                 where id = qa.id(202) and offline_snapshot_id is null and user_id = qa.id(901) and plan_id = qa.id(101)) then
    raise exception 'class F: the session was lost or user_id/plan_id changed when its snapshot was deleted';
  end if;

  -- class C: published content is never deleted from under a learner row
  perform qa.expect_fk($q$delete from public.question_items where id = qa.id(12)$q$, 'attempts_question_id_edition_id_passage_id_fkey');
  perform qa.expect_fk($q$delete from public.book_editions where id = qa.id(5)$q$, 'master_plans_edition_id_fkey');

  -- class G: the plan's current version cannot be deleted
  delete from public.plan_versions where plan_id = qa.id(103) and version_no = 1;
  perform qa.expect_error('set constraints all immediate', '23503', 'deleting a current version', 'master_plans_id_current_version_fkey');
end;
$$;
rollback;
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901), 'active');
select qa.make_plan(qa.id(103), qa.id(902), 'active');
select qa.make_session(qa.id(201), qa.id(901), qa.id(101));
select qa.make_session(qa.id(203), qa.id(902), qa.id(103));
insert into public.plan_phases (id, plan_version_id, user_id, ordinal, section_refs, unit_range, goal_size, estimated_window)
select qa.id(501), pv.id, qa.id(901), 1, '[]', '{}', 10, '[2026-10-05,2026-10-12)'
from public.plan_versions pv where pv.plan_id = qa.id(101);
insert into public.offline_snapshots
  (id, user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id,
   download_target_refs, schema_version, protocol_version, payload)
values (qa.id(301), qa.id(901), qa.id(101), 1, qa.id(5), 1, qa.id(401), '[]', 1, 1, '{}');
insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
values (qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), true, 10, now()),
       (qa.id(902), qa.id(203), qa.id(5), qa.id(602), qa.id(12), qa.id(9), true, 10, now());
insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
values (qa.id(901), qa.id(201), qa.id(701), now() - interval '1 minute', now(), 1000, date '2026-10-05');
do $$
begin
  -- class B: deleting a plan removes its versions, phases, snapshots, sessions and their children
  delete from public.master_plans where id = qa.id(101);
  if exists (select 1 from public.plan_versions where plan_id = qa.id(101))
     or exists (select 1 from public.plan_phases where user_id = qa.id(901))
     or exists (select 1 from public.offline_snapshots where user_id = qa.id(901))
     or exists (select 1 from public.learning_sessions where user_id = qa.id(901))
     or exists (select 1 from public.attempts where user_id = qa.id(901))
     or exists (select 1 from public.session_activity_intervals where user_id = qa.id(901)) then
    raise exception 'class B: children of the deleted plan remain';
  end if;
  if (select count(*) from public.learning_sessions where user_id = qa.id(902)) <> 1
     or (select count(*) from public.attempts where user_id = qa.id(902)) <> 1
     or (select count(*) from public.plan_versions where user_id = qa.id(902)) <> 1 then
    raise exception 'class B: rows of another account were removed';
  end if;
  set constraints all immediate;
end;
$$;
rollback;
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901), 'active');
select qa.make_plan(qa.id(103), qa.id(902), 'active');
select qa.make_session(qa.id(201), qa.id(901), qa.id(101));
select qa.make_session(qa.id(203), qa.id(902), qa.id(103));
insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
values (qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), true, 10, now()),
       (qa.id(902), qa.id(203), qa.id(5), qa.id(602), qa.id(12), qa.id(9), true, 10, now());
do $$
begin
  -- class A: deleting the Auth user removes every personal row of that user and only those
  delete from auth.users where id = qa.id(901);
  if exists (select 1 from public.master_plans where user_id = qa.id(901))
     or exists (select 1 from public.plan_versions where user_id = qa.id(901))
     or exists (select 1 from public.learning_sessions where user_id = qa.id(901))
     or exists (select 1 from public.attempts where user_id = qa.id(901)) then
    raise exception 'class A: rows of the deleted user remain';
  end if;
  if (select count(*) from public.master_plans) <> 1 or (select count(*) from public.attempts) <> 1 then
    raise exception 'class A: rows of another account were removed';
  end if;
  -- the content stays
  if not exists (select 1 from public.question_items where id = qa.id(12))
     or not exists (select 1 from public.book_editions where id = qa.id(5)) then
    raise exception 'class A: content was removed with the learner';
  end if;
end;
$$;
rollback;

-- CHECK: 14 attempts and activity intervals: idempotency keys, error kinds, token reference format, bounds (§14 checks 7 and 17)
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
select qa.make_plan(qa.id(103), qa.id(902));
select qa.make_session(qa.id(201), qa.id(901), qa.id(101));
select qa.make_session(qa.id(203), qa.id(902), qa.id(103));
do $$
declare
  v text;
  n integer := 0;
begin
  -- attempts: error_kind set (null accepted), unique (user, client_event_id)
  foreach v in array array['none', 'wrong_choice', 'wrong_order', 'wrong_recall', 'similar_confusion', 'timeout', 'skipped'] loop
    n := n + 1;
    perform qa.expect_ok(format($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at, error_kind)
      values (qa.id(901), qa.id(201), qa.id(5), gen_random_uuid(), qa.id(12), qa.id(9), false, 10, now(), %L)$q$, v), 'error_kind ' || v);
  end loop;
  perform qa.expect_ok($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at, error_kind)
    values (qa.id(901), qa.id(201), qa.id(5), gen_random_uuid(), qa.id(12), qa.id(9), true, 10, now(), null)$q$, 'error_kind null');
  foreach v in array array['bogus', 'wrong', '', 'None'] loop
    perform qa.expect_check(format($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at, error_kind)
      values (qa.id(901), qa.id(201), qa.id(5), gen_random_uuid(), qa.id(12), qa.id(9), false, 10, now(), %L)$q$, v), 'attempts_error_kind_check');
  end loop;

  insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
  values (qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), true, 10, now());
  if (select assisted from public.attempts where client_event_id = qa.id(601)) then
    raise exception 'assisted does not default to false';
  end if;
  -- a repeated (user, client_event_id) is rejected; another account may use the same id
  perform qa.expect_unique($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), false, 99, now())$q$, 'attempts_user_id_client_event_id_key');
  perform qa.expect_ok($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(902), qa.id(203), qa.id(5), qa.id(601), qa.id(12), qa.id(9), false, 99, now())$q$, 'the same client_event_id for another account');

  -- wrong_token_ref: null or <unitOrdinal>:<tokenIndex>
  perform qa.expect_ok($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at, wrong_token_ref)
    values (qa.id(901), qa.id(201), qa.id(5), gen_random_uuid(), qa.id(12), qa.id(9), false, 10, now(), '12:3')$q$, 'wrong_token_ref 12:3');
  foreach v in array array['abc', '12', '12:', ':3', '1:2:3', '12:x', ' 1:2'] loop
    perform qa.expect_check(format($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at, wrong_token_ref)
      values (qa.id(901), qa.id(201), qa.id(5), gen_random_uuid(), qa.id(12), qa.id(9), false, 10, now(), %L)$q$, v), 'attempts_wrong_token_ref_check');
  end loop;
  perform qa.expect_check($q$insert into public.attempts (user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
    values (qa.id(901), qa.id(201), qa.id(5), gen_random_uuid(), qa.id(12), qa.id(9), true, -1, now())$q$, 'attempts_duration_ms_check');

  -- session_activity_intervals: ordering, at most 30 minutes, at most the window plus 1,000 ms
  perform qa.expect_ok($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(701), timestamptz '2026-10-05 07:00:00+00', timestamptz '2026-10-05 07:01:00+00', 61000, date '2026-10-05')$q$, 'active_ms = window + 1000');
  perform qa.expect_check($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(702), timestamptz '2026-10-05 07:00:00+00', timestamptz '2026-10-05 07:01:00+00', 61001, date '2026-10-05')$q$, 'session_activity_intervals_active_ms_window_check');
  perform qa.expect_ok($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(703), timestamptz '2026-10-05 07:00:00+00', timestamptz '2026-10-05 07:00:00+00', 0, date '2026-10-05')$q$, 'an empty interval');
  perform qa.expect_check($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(704), timestamptz '2026-10-05 07:00:00.5+00', timestamptz '2026-10-05 07:00:00+00', 0, date '2026-10-05')$q$, 'session_activity_intervals_ended_at_check');
  perform qa.expect_check($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(705), timestamptz '2026-10-05 07:00:00+00', timestamptz '2026-10-05 07:01:00+00', -1, date '2026-10-05')$q$, 'session_activity_intervals_active_ms_range_check');
  perform qa.expect_ok($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(706), timestamptz '2026-10-05 07:00:00+00', timestamptz '2026-10-05 09:00:00+00', 1800000, date '2026-10-05')$q$, 'exactly 30 minutes');
  perform qa.expect_check($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(707), timestamptz '2026-10-05 07:00:00+00', timestamptz '2026-10-05 09:00:00+00', 1800001, date '2026-10-05')$q$, 'session_activity_intervals_active_ms_range_check');
  -- a repeated (user, client_event_id) is rejected
  perform qa.expect_unique($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(901), qa.id(201), qa.id(701), timestamptz '2026-10-05 07:00:00+00', timestamptz '2026-10-05 07:01:00+00', 1000, date '2026-10-05')$q$, 'session_activity_intervals_user_id_client_event_id_key');
  perform qa.expect_ok($q$insert into public.session_activity_intervals (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
    values (qa.id(902), qa.id(203), qa.id(701), timestamptz '2026-10-05 07:00:00+00', timestamptz '2026-10-05 07:01:00+00', 1000, date '2026-10-05')$q$, 'the same client_event_id for another account');
end;
$$;
rollback;

-- CHECK: 15 triggers: set_updated_at on master_plans and learning_sessions, guard_plan_order on master_plans; guard_plan_order is security definer with an empty search path and closed to the API roles
begin;
select qa.make_fixture();
select qa.make_users();
insert into public.master_plans
  (id, user_id, edition_id, target_scope, paths, session_minutes, agreed_estimate, status, updated_at)
values (qa.id(101), qa.id(901), qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 10, '{}', 'paused', timestamptz '2000-01-01 00:00:00+00');
insert into public.learning_sessions (id, user_id, edition_id, kind, learning_date, steps, bank_version, status, updated_at)
values (qa.id(299), qa.id(901), qa.id(5), 'placement', date '2026-10-05', '[]', 1, 'open', timestamptz '2000-01-01 00:00:00+00');
update public.master_plans set session_minutes = 15 where id = qa.id(101);
update public.learning_sessions set status = 'completed' where id = qa.id(299);
do $$
declare
  v_missing text[];
  v_extra   text[];
begin
  if (select updated_at from public.master_plans where id = qa.id(101)) < now() - interval '1 minute' then
    raise exception 'master_plans.updated_at was not refreshed';
  end if;
  if (select updated_at from public.learning_sessions where id = qa.id(299)) < now() - interval '1 minute' then
    raise exception 'learning_sessions.updated_at was not refreshed';
  end if;

  with expected(tbl, trg, fn, timing_events) as (
    values ('master_plans',     'master_plans_set_updated_at',     'set_updated_at',  'BEFORE UPDATE'),
           ('master_plans',     'master_plans_guard_plan_order',   'guard_plan_order', 'BEFORE INSERT OR UPDATE'),
           ('learning_sessions', 'learning_sessions_set_updated_at', 'set_updated_at', 'BEFORE UPDATE')
  ), actual as (
    select c.relname::text as tbl, t.tgname::text as trg, p.proname::text as fn,
           case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end
           || ' ' || concat_ws(' OR ',
                case when (t.tgtype & 4) <> 0 then 'INSERT' end,
                case when (t.tgtype & 16) <> 0 then 'UPDATE' end,
                case when (t.tgtype & 8) <> 0 then 'DELETE' end) as timing_events
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal
      and c.relname in ('master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots',
                        'learning_sessions', 'attempts', 'session_activity_intervals')
  )
  select
    (select array_agg(e.trg) from expected e where not exists (select 1 from actual a where a.trg = e.trg and a.tbl = e.tbl and a.fn = e.fn and a.timing_events = e.timing_events)),
    (select array_agg(a.trg) from actual a where not exists (select 1 from expected e where a.trg = e.trg and a.tbl = e.tbl and a.fn = e.fn and a.timing_events = e.timing_events))
  into v_missing, v_extra;
  if v_missing is not null or v_extra is not null then
    raise exception 'trigger mismatch: missing %, unexpected %', v_missing, v_extra;
  end if;

  -- guard_plan_order watches exactly plan_order and edition_id of master_plans
  if (select array_agg(a.attname order by a.attname)
      from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr)
      where t.tgname = 'master_plans_guard_plan_order') is distinct from array['edition_id', 'plan_order']::name[] then
    raise exception 'guard_plan_order does not fire on exactly plan_order and edition_id';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'guard_plan_order' and p.prosecdef
      and p.proconfig @> array['search_path=""']) then
    raise exception 'private.guard_plan_order is not security definer with an empty search_path';
  end if;
  if has_function_privilege('anon', 'private.guard_plan_order()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.guard_plan_order()', 'EXECUTE')
     or has_function_privilege('service_role', 'private.guard_plan_order()', 'EXECUTE') then
    raise exception 'an API role can execute private.guard_plan_order';
  end if;
end;
$$;
rollback;

-- CHECK: 16 no seed rows: the seven tables are empty
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array['master_plans', 'plan_versions', 'plan_phases', 'offline_snapshots',
                           'learning_sessions', 'attempts', 'session_activity_intervals'] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'public.% holds % rows after the migration', t, n;
    end if;
  end loop;
end;
$$;
