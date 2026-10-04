-- checks_0004.sql
--
-- LOCAL VALIDATION ONLY. Assertions for supabase/migrations/0004_progress.sql, run by
-- run_local.sh right after that migration on a scratch database. Every "-- CHECK:" line
-- starts one independent chunk; a chunk passes when psql finishes it without an error.
-- Rows are synthetic placeholders (qa.make_fixture, qa.make_passage2, qa.make_users,
-- qa.make_plan) created inside transactions that are rolled back. Expected values are
-- written out here from docs/Database-schema.md v1.1 (§3.4, §4.2, §4.3, §4.4, §6.3, §11
-- `0004_progress`, §14 checks 10, 12, 17), not read back from the migration.

-- CHECK: 01 the five tables exist, with row level security enabled (not forced), no policy, and no privilege for anon, authenticated and service_role
do $$
declare
  r record;
begin
  for r in
    select t from unnest(array['daily_progress', 'daily_completions', 'target_mastery',
                               'target_part_evidence', 'ai_usage']) as t
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
    from unnest(array['daily_progress', 'daily_completions', 'target_mastery',
                      'target_part_evidence', 'ai_usage']) as t
    cross join unnest(array['anon', 'authenticated', 'service_role']) as rol
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
  loop
    if has_table_privilege(r.rol, 'public.' || r.t, r.p) then
      raise exception '% holds % on public.%', r.rol, r.p, r.t;
    end if;
  end loop;
  for r in
    select t, rol, p
    from unnest(array['daily_progress', 'daily_completions', 'target_mastery',
                      'target_part_evidence', 'ai_usage']) as t
    cross join unnest(array['anon', 'authenticated', 'service_role']) as rol
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p
  loop
    if has_any_column_privilege(r.rol, 'public.' || r.t, r.p) then
      raise exception '% holds column-level % on public.%', r.rol, r.p, r.t;
    end if;
  end loop;
end;
$$;

-- CHECK: 02 there is no reviews table (§3.4, directive 3): no relation of that name in public or private
do $$
begin
  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p', 'f')
      and c.relname like '%review%'
  ) then
    raise exception 'a relation with "review" in its name exists: %', (
      select array_agg(c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'private') and c.relname like '%review%' and c.relkind in ('r', 'v', 'm', 'p', 'f'));
  end if;
  if to_regclass('public.reviews') is not null or to_regclass('private.reviews') is not null then
    raise exception 'the dropped reviews table exists';
  end if;
end;
$$;

-- CHECK: 03 columns of the five tables match §6.3 (type, nullability, default, order)
do $$
begin
  perform qa.assert_columns('public.daily_progress'::regclass, array[
    'user_id|uuid|NOT NULL|',
    'learning_date|date|NOT NULL|',
    'active_ms|bigint|NOT NULL|0',
    'goal_ms|bigint|NOT NULL|',
    'updated_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.daily_completions'::regclass, array[
    'user_id|uuid|NOT NULL|',
    'learning_date|date|NOT NULL|',
    'reached_in_plan_id|uuid|NOT NULL|',
    'completed_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.target_mastery'::regclass, array[
    'user_id|uuid|NOT NULL|',
    'plan_id|uuid|NOT NULL|',
    'passage_id|uuid|NOT NULL|',
    'edition_id|uuid|NOT NULL|',
    'status|text|NOT NULL|''new''::text',
    'consecutive_correct|integer|NOT NULL|0',
    'initial_success_at|timestamp with time zone|NULL|',
    'initial_learning_date|date|NULL|',
    'review_stage|smallint|NOT NULL|0',
    'next_review_due|date|NULL|',
    'last_review_date|date|NULL|',
    'confirmed_at|timestamp with time zone|NULL|',
    'first_confirmed_at|timestamp with time zone|NULL|',
    'maintenance_stage|smallint|NOT NULL|0',
    'lapse_count|integer|NOT NULL|0',
    'error_part_ids|uuid[]|NOT NULL|''{}''::uuid[]',
    'created_at|timestamp with time zone|NOT NULL|now()',
    'updated_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.target_part_evidence'::regclass, array[
    'user_id|uuid|NOT NULL|',
    'plan_id|uuid|NOT NULL|',
    'passage_id|uuid|NOT NULL|',
    'part_id|uuid|NOT NULL|',
    'attempt_id|uuid|NOT NULL|',
    'learning_date|date|NOT NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('public.ai_usage'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'provider|text|NOT NULL|',
    'model|text|NOT NULL|',
    'prompt_version|text|NOT NULL|',
    'input_tokens|integer|NULL|',
    'output_tokens|integer|NULL|',
    'cost_usd|numeric|NULL|',
    'status|text|NOT NULL|',
    'quota_record|jsonb|NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()']);
end;
$$;

-- CHECK: 04 keys, foreign keys with their delete classes (A, B, C), the due-review index and the other indexes match §6.3
do $$
begin
  perform qa.assert_same_set('daily_progress keys', qa.key_defs('public.daily_progress'::regclass), array[
    'PRIMARY KEY (user_id, learning_date)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE']);
  perform qa.assert_same_set('daily_progress indexes', qa.index_defs('public.daily_progress'::regclass), '{}');

  perform qa.assert_same_set('daily_completions keys', qa.key_defs('public.daily_completions'::regclass), array[
    'PRIMARY KEY (user_id, learning_date)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (reached_in_plan_id, user_id) REFERENCES master_plans(id, user_id) ON DELETE CASCADE']);
  perform qa.assert_same_set('daily_completions indexes', qa.index_defs('public.daily_completions'::regclass), array[
    'CREATE INDEX ON public.daily_completions USING btree (reached_in_plan_id)']);

  perform qa.assert_same_set('target_mastery keys', qa.key_defs('public.target_mastery'::regclass), array[
    'PRIMARY KEY (user_id, plan_id, passage_id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (plan_id, user_id, edition_id) REFERENCES master_plans(id, user_id, edition_id) ON DELETE CASCADE',
    'FOREIGN KEY (passage_id, edition_id) REFERENCES passages(id, edition_id) ON DELETE RESTRICT']);
  perform qa.assert_same_set('target_mastery indexes', qa.index_defs('public.target_mastery'::regclass), array[
    -- the due-review query (replaces the dropped reviews (user_id, due_at) index)
    'CREATE INDEX ON public.target_mastery USING btree (user_id, plan_id, next_review_due) WHERE (next_review_due IS NOT NULL)',
    'CREATE INDEX ON public.target_mastery USING btree (passage_id)']);

  perform qa.assert_same_set('target_part_evidence keys', qa.key_defs('public.target_part_evidence'::regclass), array[
    'PRIMARY KEY (user_id, plan_id, part_id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (user_id, plan_id, passage_id) REFERENCES target_mastery(user_id, plan_id, passage_id) ON DELETE CASCADE',
    'FOREIGN KEY (part_id, passage_id) REFERENCES passage_parts(id, passage_id) ON DELETE RESTRICT',
    'FOREIGN KEY (attempt_id, user_id, passage_id) REFERENCES attempts(id, user_id, passage_id) ON DELETE CASCADE']);
  perform qa.assert_same_set('target_part_evidence indexes', qa.index_defs('public.target_part_evidence'::regclass), array[
    'CREATE INDEX ON public.target_part_evidence USING btree (user_id, plan_id, passage_id)',
    'CREATE INDEX ON public.target_part_evidence USING btree (attempt_id)']);

  perform qa.assert_same_set('ai_usage keys', qa.key_defs('public.ai_usage'::regclass), array['PRIMARY KEY (id)']);
  perform qa.assert_same_set('ai_usage indexes', qa.index_defs('public.ai_usage'::regclass), array[
    'CREATE INDEX ON public.ai_usage USING btree (created_at)']);
end;
$$;

-- CHECK: 05 target_mastery state consistency (contract §4): valid states are accepted, each inconsistent combination is rejected by its own check (§14 check 10)
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
do $$
declare
  -- one row of the fixture passage; the arguments are the extra columns and values
  c_ins constant text := 'insert into public.target_mastery (user_id, plan_id, passage_id, edition_id, %s) values (qa.id(901), qa.id(101), qa.id(9), qa.id(5), %s)';
  v_init constant text := 'initial_success_at = now()';
  v_row  text;
begin
  -- defaults: a new passage
  insert into public.target_mastery (user_id, plan_id, passage_id, edition_id)
  values (qa.id(901), qa.id(101), qa.id(9), qa.id(5));
  if (select (status, consecutive_correct, review_stage, maintenance_stage, lapse_count, error_part_ids, next_review_due)::text
      from public.target_mastery where passage_id = qa.id(9)) <> '(new,0,0,0,0,{},)' then
    raise exception 'target_mastery defaults differ from §6.3';
  end if;
  delete from public.target_mastery;

  -- accepted states
  perform qa.expect_ok(format(c_ins, 'status, consecutive_correct', '''learning'', 2'), 'learning');
  delete from public.target_mastery;
  perform qa.expect_ok(format(c_ins, 'status, consecutive_correct, initial_success_at, initial_learning_date', '''learning'', 3, now(), current_date'), 'learning with initial evidence');
  delete from public.target_mastery;
  for v_row in select s from unnest(array['1', '2', '3']) as s loop
    perform qa.expect_ok(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, next_review_due',
      format('''reviewing'', %s, now(), current_date, current_date + 1', v_row)), 'reviewing stage ' || v_row);
    delete from public.target_mastery;
  end loop;
  -- stage 3 passed before every part is covered: next_review_due is deliberately unconstrained
  perform qa.expect_ok(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, next_review_due', '''reviewing'', 3, now(), current_date, null'), 'reviewing stage 3 without a due date');
  delete from public.target_mastery;
  perform qa.expect_ok(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, confirmed_at, first_confirmed_at, maintenance_stage, next_review_due',
    '''confirmed'', 3, now(), current_date, now(), now(), 1, current_date + 14'), 'confirmed');
  delete from public.target_mastery;
  for v_row in select s from unnest(array['1', '2', '3']) as s loop
    perform qa.expect_ok(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, first_confirmed_at, lapse_count',
      format('''needs_refresh'', %s, now(), current_date, now(), 1', v_row)), 'needs_refresh stage ' || v_row);
    delete from public.target_mastery;
  end loop;

  -- (status = confirmed) = (confirmed_at is not null)
  perform qa.expect_check(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, first_confirmed_at',
    '''confirmed'', 3, now(), current_date, now()'), 'target_mastery_confirmed_state_check');
  perform qa.expect_check(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, confirmed_at, first_confirmed_at',
    '''reviewing'', 1, now(), current_date, now(), now()'), 'target_mastery_confirmed_state_check');
  perform qa.expect_check(format(c_ins, 'status, confirmed_at, first_confirmed_at', '''learning'', now(), now()'), 'target_mastery_confirmed_state_check');
  perform qa.expect_check(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, first_confirmed_at, confirmed_at',
    '''needs_refresh'', 1, now(), current_date, now(), now()'), 'target_mastery_confirmed_state_check');
  -- a current confirmation implies a first confirmation
  perform qa.expect_check(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, confirmed_at',
    '''confirmed'', 3, now(), current_date, now()'), 'target_mastery_first_confirmed_check');
  -- needs_refresh needs a first confirmation
  perform qa.expect_check(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date',
    '''needs_refresh'', 1, now(), current_date'), 'target_mastery_needs_refresh_check');
  -- reviewing and needs_refresh sit on the ladder: stage 1 to 3
  perform qa.expect_check(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date',
    '''reviewing'', 0, now(), current_date'), 'target_mastery_ladder_stage_check');
  perform qa.expect_check(format(c_ins, 'status, initial_success_at, initial_learning_date',
    '''reviewing'', now(), current_date'), 'target_mastery_ladder_stage_check');
  perform qa.expect_check(format(c_ins, 'status, review_stage, initial_success_at, initial_learning_date, first_confirmed_at',
    '''needs_refresh'', 0, now(), current_date, now()'), 'target_mastery_ladder_stage_check');
  -- initial success and its learning date together
  perform qa.expect_check(format(c_ins, 'status, initial_success_at', '''learning'', now()'), 'target_mastery_initial_pair_check');
  perform qa.expect_check(format(c_ins, 'status, initial_learning_date', '''learning'', current_date'), 'target_mastery_initial_pair_check');
  -- reviewing, confirmed and needs_refresh need the initial evidence
  perform qa.expect_check(format(c_ins, 'status, review_stage', '''reviewing'', 1'), 'target_mastery_initial_evidence_check');
  perform qa.expect_check(format(c_ins, 'status, review_stage, confirmed_at, first_confirmed_at', '''confirmed'', 3, now(), now()'), 'target_mastery_initial_evidence_check');
  perform qa.expect_check(format(c_ins, 'status, review_stage, first_confirmed_at', '''needs_refresh'', 1, now()'), 'target_mastery_initial_evidence_check');
  -- value set and numeric bounds
  perform qa.expect_check(format(c_ins, 'status', '''mastered'''), 'target_mastery_status_check');
  perform qa.expect_check(format(c_ins, 'consecutive_correct', '-1'), 'target_mastery_consecutive_correct_check');
  perform qa.expect_check(format(c_ins, 'review_stage', '4'), 'target_mastery_review_stage_check');
  perform qa.expect_check(format(c_ins, 'review_stage', '-1'), 'target_mastery_review_stage_check');
  perform qa.expect_check(format(c_ins, 'maintenance_stage', '-1'), 'target_mastery_maintenance_stage_check');
  perform qa.expect_check(format(c_ins, 'lapse_count', '-1'), 'target_mastery_lapse_count_check');
  perform qa.expect_ok(format(c_ins, 'maintenance_stage', '7'), 'maintenance_stage has no upper bound (14, 30, then every 60 days)');

  -- the same checks guard updates, not only inserts
  perform qa.expect_check($q$update public.target_mastery set status = 'confirmed' where passage_id = qa.id(9)$q$, 'target_mastery_confirmed_state_check');
end;
$$;
rollback;

-- CHECK: 06 target_part_evidence rejects a part or an attempt of a different passage; a part is covered once per plan (§14 check 10)
begin;
select qa.make_fixture();
select qa.make_passage2();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
select qa.make_plan(qa.id(103), qa.id(902));
select qa.make_session(qa.id(201), qa.id(901), qa.id(101));
select qa.make_session(qa.id(203), qa.id(902), qa.id(103));
insert into public.target_mastery (user_id, plan_id, passage_id, edition_id) values
  (qa.id(901), qa.id(101), qa.id(9), qa.id(5)),
  (qa.id(902), qa.id(103), qa.id(9), qa.id(5));
insert into public.attempts (id, user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at) values
  (qa.id(801), qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), true, 10, now()),
  (qa.id(802), qa.id(901), qa.id(201), qa.id(5), qa.id(602), qa.id(33), qa.id(31), true, 10, now()),
  (qa.id(803), qa.id(902), qa.id(203), qa.id(5), qa.id(603), qa.id(12), qa.id(9), true, 10, now());
do $$
begin
  -- (the foreign-key cases come first: a primary-key collision would be reported before them)
  -- a part of another passage (same edition) named under this passage
  perform qa.expect_fk($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(901), qa.id(101), qa.id(9), qa.id(32), qa.id(801), date '2026-10-05')$q$, 'target_part_evidence_part_id_passage_id_fkey');
  -- an attempt of another passage
  perform qa.expect_fk($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(901), qa.id(101), qa.id(9), qa.id(10), qa.id(802), date '2026-10-05')$q$, 'target_part_evidence_attempt_id_user_id_passage_id_fkey');
  -- an attempt of another account
  perform qa.expect_fk($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(902), qa.id(103), qa.id(9), qa.id(10), qa.id(801), date '2026-10-05')$q$, 'target_part_evidence_attempt_id_user_id_passage_id_fkey');
  -- no mastery row for that passage in the plan yet
  perform qa.expect_fk($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(901), qa.id(101), qa.id(31), qa.id(32), qa.id(802), date '2026-10-05')$q$, 'target_part_evidence_user_id_plan_id_passage_id_fkey');
  -- the matching part and attempt of the passage
  perform qa.expect_ok($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(901), qa.id(101), qa.id(9), qa.id(10), qa.id(801), date '2026-10-05')$q$, 'matching part and attempt');
  -- a part is covered once per plan, whatever the attempt
  perform qa.expect_error($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(901), qa.id(101), qa.id(9), qa.id(10), qa.id(801), date '2026-10-06')$q$, '23505', 'a part covered twice', 'target_part_evidence_pkey');
  -- the same part may be covered once in another account's plan
  perform qa.expect_ok($q$insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
    values (qa.id(902), qa.id(103), qa.id(9), qa.id(10), qa.id(803), date '2026-10-05')$q$, 'the same part in another account');
end;
$$;
rollback;

-- CHECK: 07 daily_progress and daily_completions: bounds, one row per account and date, the plan must belong to the same account
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
select qa.make_plan(qa.id(103), qa.id(902));
do $$
begin
  insert into public.daily_progress (user_id, learning_date, goal_ms) values (qa.id(901), date '2026-10-05', 600000);
  if (select active_ms from public.daily_progress where user_id = qa.id(901)) <> 0 then
    raise exception 'active_ms does not default to 0';
  end if;
  perform qa.expect_error($q$insert into public.daily_progress (user_id, learning_date, goal_ms) values (qa.id(901), date '2026-10-05', 600000)$q$, '23505', 'one row per account and date', 'daily_progress_pkey');
  perform qa.expect_ok($q$insert into public.daily_progress (user_id, learning_date, goal_ms) values (qa.id(901), date '2026-10-06', 600000)$q$, 'another date');
  perform qa.expect_ok($q$insert into public.daily_progress (user_id, learning_date, goal_ms) values (qa.id(902), date '2026-10-05', 300000)$q$, 'another account');
  perform qa.expect_check($q$insert into public.daily_progress (user_id, learning_date, active_ms, goal_ms) values (qa.id(901), date '2026-10-07', -1, 600000)$q$, 'daily_progress_active_ms_check');
  perform qa.expect_check($q$insert into public.daily_progress (user_id, learning_date, goal_ms) values (qa.id(901), date '2026-10-07', 0)$q$, 'daily_progress_goal_ms_check');
  perform qa.expect_error($q$insert into public.daily_progress (user_id, learning_date) values (qa.id(901), date '2026-10-07')$q$, '23502', 'goal_ms has no default');

  perform qa.expect_ok($q$insert into public.daily_completions (user_id, learning_date, reached_in_plan_id) values (qa.id(901), date '2026-10-05', qa.id(101))$q$, 'a completion');
  perform qa.expect_error($q$insert into public.daily_completions (user_id, learning_date, reached_in_plan_id) values (qa.id(901), date '2026-10-05', qa.id(101))$q$, '23505', 'one completion per account and date', 'daily_completions_pkey');
  perform qa.expect_fk($q$insert into public.daily_completions (user_id, learning_date, reached_in_plan_id) values (qa.id(901), date '2026-10-06', qa.id(103))$q$, 'daily_completions_reached_in_plan_id_user_id_fkey');
  perform qa.expect_fk($q$insert into public.daily_completions (user_id, learning_date, reached_in_plan_id) values (qa.id(901), date '2026-10-06', qa.id(999))$q$, 'daily_completions_reached_in_plan_id_user_id_fkey');
end;
$$;
rollback;

-- CHECK: 08 ai_usage holds no learner, account, plan or free-text column (D17); value set, bounds, nulls mean unknown
begin;
do $$
declare
  v text;
begin
  -- the full column list: nothing that could name a person, an account, a plan or a text
  if (select array_agg(attname::text order by attnum) from pg_attribute
      where attrelid = 'public.ai_usage'::regclass and attnum > 0 and not attisdropped)
     is distinct from array['id', 'provider', 'model', 'prompt_version', 'input_tokens', 'output_tokens',
                            'cost_usd', 'status', 'quota_record', 'created_at'] then
    raise exception 'ai_usage columns differ from §6.3';
  end if;
  if exists (select 1 from pg_attribute
             where attrelid = 'public.ai_usage'::regclass and attnum > 0 and not attisdropped
               and attname ~* '(user|account|learner|plan|session|text|message|answer|prompt$|input$|output$|content)') then
    raise exception 'ai_usage has a column that could hold learner data or text';
  end if;
  -- no foreign key at all: outside the account-deletion cascade
  if exists (select 1 from pg_constraint where conrelid = 'public.ai_usage'::regclass and contype = 'f') then
    raise exception 'ai_usage has a foreign key';
  end if;

  -- null means unknown and is accepted; zero is accepted; negative is not
  perform qa.expect_ok($q$insert into public.ai_usage (provider, model, prompt_version, status) values ('test', 'test', 'v1', 'succeeded')$q$, 'unknown tokens and cost');
  if (select (input_tokens is null and output_tokens is null and cost_usd is null and quota_record is null)
      from public.ai_usage limit 1) is not true then
    raise exception 'unknown values were not kept as NULL';
  end if;
  perform qa.expect_ok($q$insert into public.ai_usage (provider, model, prompt_version, input_tokens, output_tokens, cost_usd, status, quota_record)
    values ('test', 'test', 'v1', 0, 0, 0, 'succeeded', '{"checked": true}')$q$, 'measured zeros');
  perform qa.expect_check($q$insert into public.ai_usage (provider, model, prompt_version, input_tokens, status) values ('test', 'test', 'v1', -1, 'failed')$q$, 'ai_usage_input_tokens_check');
  perform qa.expect_check($q$insert into public.ai_usage (provider, model, prompt_version, output_tokens, status) values ('test', 'test', 'v1', -1, 'failed')$q$, 'ai_usage_output_tokens_check');
  perform qa.expect_check($q$insert into public.ai_usage (provider, model, prompt_version, cost_usd, status) values ('test', 'test', 'v1', -0.01, 'failed')$q$, 'ai_usage_cost_usd_check');
  perform qa.expect_check($q$insert into public.ai_usage (provider, model, prompt_version, status, quota_record) values ('test', 'test', 'v1', 'failed', '[]')$q$, 'ai_usage_quota_record_check');
  perform qa.expect_check($q$insert into public.ai_usage (provider, model, prompt_version, status) values (' ', 'test', 'v1', 'failed')$q$, 'ai_usage_provider_check');
  perform qa.expect_check($q$insert into public.ai_usage (provider, model, prompt_version, status) values ('test', '', 'v1', 'failed')$q$, 'ai_usage_model_check');
  perform qa.expect_check($q$insert into public.ai_usage (provider, model, prompt_version, status) values ('test', 'test', '', 'failed')$q$, 'ai_usage_prompt_version_check');

  -- status value set (A-05)
  foreach v in array array['succeeded', 'failed', 'timed_out', 'rules_fallback'] loop
    perform qa.expect_ok(format($q$insert into public.ai_usage (provider, model, prompt_version, status) values ('test', 'test', 'v1', %L)$q$, v), 'status ' || v);
  end loop;
  foreach v in array array['ok', 'error', 'Succeeded', ''] loop
    perform qa.expect_check(format($q$insert into public.ai_usage (provider, model, prompt_version, status) values ('test', 'test', 'v1', %L)$q$, v), 'ai_usage_status_check');
  end loop;
end;
$$;
rollback;

-- CHECK: 09 triggers: set_updated_at on daily_progress and target_mastery only
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
insert into public.daily_progress (user_id, learning_date, goal_ms, updated_at)
values (qa.id(901), date '2026-10-05', 600000, timestamptz '2000-01-01 00:00:00+00');
insert into public.target_mastery (user_id, plan_id, passage_id, edition_id, updated_at)
values (qa.id(901), qa.id(101), qa.id(9), qa.id(5), timestamptz '2000-01-01 00:00:00+00');
update public.daily_progress set active_ms = 1000;
update public.target_mastery set consecutive_correct = 1;
do $$
declare
  v_missing text[];
  v_extra   text[];
begin
  if (select updated_at from public.daily_progress) < now() - interval '1 minute' then
    raise exception 'daily_progress.updated_at was not refreshed';
  end if;
  if (select updated_at from public.target_mastery) < now() - interval '1 minute' then
    raise exception 'target_mastery.updated_at was not refreshed';
  end if;

  with expected(tbl, trg, fn, timing_events) as (
    values ('daily_progress', 'daily_progress_set_updated_at', 'set_updated_at', 'BEFORE UPDATE'),
           ('target_mastery', 'target_mastery_set_updated_at', 'set_updated_at', 'BEFORE UPDATE')
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
      and c.relname in ('daily_progress', 'daily_completions', 'target_mastery', 'target_part_evidence', 'ai_usage')
  )
  select
    (select array_agg(e.trg) from expected e where not exists (select 1 from actual a where a.trg = e.trg and a.tbl = e.tbl and a.fn = e.fn and a.timing_events = e.timing_events)),
    (select array_agg(a.trg) from actual a where not exists (select 1 from expected e where a.trg = e.trg and a.tbl = e.tbl and a.fn = e.fn and a.timing_events = e.timing_events))
  into v_missing, v_extra;
  if v_missing is not null or v_extra is not null then
    raise exception 'trigger mismatch: missing %, unexpected %', v_missing, v_extra;
  end if;
end;
$$;
rollback;

-- CHECK: 10 delete behaviour: class A and B cascades (and ai_usage untouched), class C RESTRICT on passages and parts
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901));
select qa.make_plan(qa.id(103), qa.id(902));
select qa.make_session(qa.id(201), qa.id(901), qa.id(101));
select qa.make_session(qa.id(203), qa.id(902), qa.id(103));
insert into public.target_mastery (user_id, plan_id, passage_id, edition_id) values
  (qa.id(901), qa.id(101), qa.id(9), qa.id(5)), (qa.id(902), qa.id(103), qa.id(9), qa.id(5));
insert into public.attempts (id, user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at) values
  (qa.id(801), qa.id(901), qa.id(201), qa.id(5), qa.id(601), qa.id(12), qa.id(9), true, 10, now()),
  (qa.id(803), qa.id(902), qa.id(203), qa.id(5), qa.id(603), qa.id(12), qa.id(9), true, 10, now());
insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date) values
  (qa.id(901), qa.id(101), qa.id(9), qa.id(10), qa.id(801), date '2026-10-05'),
  (qa.id(902), qa.id(103), qa.id(9), qa.id(10), qa.id(803), date '2026-10-05');
insert into public.daily_progress (user_id, learning_date, goal_ms) values
  (qa.id(901), date '2026-10-05', 600000), (qa.id(902), date '2026-10-05', 600000);
insert into public.daily_completions (user_id, learning_date, reached_in_plan_id) values
  (qa.id(901), date '2026-10-05', qa.id(101)), (qa.id(902), date '2026-10-05', qa.id(103));
insert into public.ai_usage (provider, model, prompt_version, status) values ('test', 'test', 'v1', 'succeeded');
do $$
begin
  -- class C: a passage or part with learner rows cannot be deleted
  perform qa.expect_fk($q$delete from public.passages where id = qa.id(9)$q$, 'target_mastery_passage_id_edition_id_fkey');
  perform qa.expect_fk($q$delete from public.passage_parts where id = qa.id(10)$q$, 'target_part_evidence_part_id_passage_id_fkey');

  -- class B: deleting an attempt removes its evidence only
  delete from public.attempts where id = qa.id(801);
  if exists (select 1 from public.target_part_evidence where user_id = qa.id(901))
     or not exists (select 1 from public.target_part_evidence where user_id = qa.id(902)) then
    raise exception 'class B: deleting an attempt did not remove exactly its evidence';
  end if;

  -- class B: deleting a plan removes its mastery, evidence and completions
  delete from public.master_plans where id = qa.id(103);
  if exists (select 1 from public.target_mastery where user_id = qa.id(902))
     or exists (select 1 from public.target_part_evidence where user_id = qa.id(902))
     or exists (select 1 from public.daily_completions where user_id = qa.id(902)) then
    raise exception 'class B: rows of the deleted plan remain';
  end if;
  if not exists (select 1 from public.target_mastery where user_id = qa.id(901))
     or not exists (select 1 from public.daily_completions where user_id = qa.id(901)) then
    raise exception 'class B: rows of another plan were removed';
  end if;
  -- daily_progress does not hang on a plan
  if not exists (select 1 from public.daily_progress where user_id = qa.id(902)) then
    raise exception 'daily_progress of the account disappeared with its plan';
  end if;

  -- class A: deleting the Auth user removes its progress rows, and ai_usage stays
  delete from auth.users where id = qa.id(902);
  if exists (select 1 from public.daily_progress where user_id = qa.id(902)) then
    raise exception 'class A: daily_progress of the deleted user remains';
  end if;
  delete from auth.users where id = qa.id(901);
  if exists (select 1 from public.daily_progress) or exists (select 1 from public.daily_completions)
     or exists (select 1 from public.target_mastery) or exists (select 1 from public.target_part_evidence) then
    raise exception 'class A: personal progress rows remain';
  end if;
  if (select count(*) from public.ai_usage) <> 1 then
    raise exception 'ai_usage changed with an account deletion';
  end if;
end;
$$;
rollback;

-- CHECK: 11 no seed rows: the five tables are empty
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array['daily_progress', 'daily_completions', 'target_mastery',
                           'target_part_evidence', 'ai_usage'] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'public.% holds % rows after the migration', t, n;
    end if;
  end loop;
end;
$$;
