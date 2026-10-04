-- 01_check_helpers.sql
--
-- LOCAL VALIDATION ONLY. Helper functions for the checks_*.sql files, created in a
-- throwaway schema `qa` of the scratch database. Applied by run_local.sh right after
-- the shim and before the first migration (the functions only name tables at run time).
-- Synthetic placeholder rows only: no source text is ever used.

create schema if not exists qa;
grant usage on schema qa to public;

-- Deterministic synthetic ids.
create function qa.id(n integer)
returns uuid
language sql
immutable
as $$
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- Runs p_sql and requires that it fails with SQLSTATE p_sqlstate (inside a subtransaction)
-- and, when p_constraint is given, on exactly that constraint.
create function qa.expect_error(
  p_sql text, p_sqlstate text, p_label text, p_constraint text default null)
returns void
language plpgsql
as $$
declare
  v_state      text;
  v_message    text;
  v_constraint text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_constraint = constraint_name;
    v_state := sqlstate;
    v_message := sqlerrm;
    if v_state = p_sqlstate and (p_constraint is null or v_constraint = p_constraint) then
      return;
    end if;
    raise exception 'FAIL [%]: expected SQLSTATE % (constraint %) but got % (constraint %): %',
      p_label, p_sqlstate, coalesce(p_constraint, 'any'), v_state, coalesce(v_constraint, 'none'), v_message;
  end;
  raise exception 'FAIL [%]: statement succeeded but SQLSTATE % was expected', p_label, p_sqlstate;
end;
$$;

-- Shorthands: 23514 check_violation, 23505 unique_violation, 23503 foreign_key_violation,
-- 23001 restrict_violation (also raised by the guard triggers of 0001).
create function qa.expect_check(p_sql text, p_constraint text)
returns void language sql as $$ select qa.expect_error(p_sql, '23514', p_constraint, p_constraint) $$;
create function qa.expect_unique(p_sql text, p_constraint text)
returns void language sql as $$ select qa.expect_error(p_sql, '23505', p_constraint, p_constraint) $$;
create function qa.expect_fk(p_sql text, p_constraint text)
returns void language sql as $$ select qa.expect_error(p_sql, '23503', p_constraint, p_constraint) $$;
create function qa.expect_restrict(p_sql text, p_label text, p_constraint text default null)
returns void language sql as $$ select qa.expect_error(p_sql, '23001', p_label, p_constraint) $$;

-- The 17 content tables of 0001_content, in dependency order.
create function qa.content_tables()
returns text[]
language sql
immutable
as $$
  select array[
    'categories', 'approved_source_rules', 'sources', 'books', 'book_editions',
    'edition_pages', 'book_sections', 'units', 'unit_page_spans', 'passages',
    'passage_parts', 'lessons', 'lesson_units', 'question_items', 'unit_embeddings',
    'content_jobs', 'generic_plan_templates'
  ]
$$;

-- Runs p_sql and requires that it succeeds.
create function qa.expect_ok(p_sql text, p_label text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL [%]: expected success but got SQLSTATE % (%)', p_label, sqlstate, sqlerrm;
end;
$$;

-- Minimal valid synthetic row graph for the 0001 content tables (one draft edition).
-- Ids: 1 category, 2 rule, 3 source, 4 book, 5 edition, 6 page, 7 section, 8 unit,
-- 9 passage, 10 part, 11 lesson, 12 question, 13 job, 14 template.
create function qa.make_fixture()
returns void
language plpgsql
as $$
begin
  insert into public.categories (id, slug, label_ar, label_en)
  values (qa.id(1), 'test-category', 'test', null);

  insert into public.approved_source_rules
    (id, policy_version, domain_or_book_family, field, eligibility_rule, policy_reference)
  values (qa.id(2), 'test', 'test', 'test', 'test', 'test');

  insert into public.sources (id, approved_rule_id, title, provider, source_url, rights_status)
  values (qa.id(3), qa.id(2), 'test', 'test', 'https://example.invalid/test',
          'owner_accepted_pending_verification');

  insert into public.books (id, category_id, title_ar, author, content_format)
  values (qa.id(4), qa.id(1), 'test', 'test', 'quran');

  insert into public.book_editions
    (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
  values (qa.id(5), qa.id(4), qa.id(3), 'test-edition', 'test', 'ar', 1, 1);

  insert into public.edition_pages (id, edition_id, printed_page_label, file_page_no, page_hash)
  values (qa.id(6), qa.id(5), '1', 1, repeat('a', 64));

  insert into public.book_sections (id, edition_id, ordinal, kind, reference, title_ar, title_en)
  values (qa.id(7), qa.id(5), 1, 'surah', '1', 'test', 'Test 1');

  insert into public.units
    (id, edition_id, section_id, ordinal, kind, reference, canonical_text, token_spans, text_hash)
  values (qa.id(8), qa.id(5), qa.id(7), 1, 'ayah', '1:1', 'test',
          '[{"i":0,"s":0,"e":4,"k":"word","n":"test"}]', repeat('b', 64));

  insert into public.unit_page_spans (unit_id, ordinal, edition_id, page_id, start_offset, end_offset)
  values (qa.id(8), 1, qa.id(5), qa.id(6), 0, 4);

  insert into public.passages
    (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
  values (qa.id(9), qa.id(5), 1, qa.id(7), 1, 'quran', '1:0', '1:0', 1, '1:1');

  insert into public.passage_parts (id, passage_id, edition_id, ordinal, start_ref, end_ref, word_count)
  values (qa.id(10), qa.id(9), qa.id(5), 1, '1:0', '1:0', 1);

  insert into public.lessons (id, edition_id, bank_version, passage_id, ordinal, duration_estimate_sec)
  values (qa.id(11), qa.id(5), 1, qa.id(9), 1, 60);

  insert into public.lesson_units (lesson_id, ordinal, edition_id, unit_id, start_offset, end_offset)
  values (qa.id(11), 1, qa.id(5), qa.id(8), 0, 4);

  insert into public.question_items
    (id, edition_id, bank_version, passage_id, lesson_id, unit_id, type, variant,
     covered_part_ids, token_refs, option_refs, correct_ref, reference)
  values (qa.id(12), qa.id(5), 1, qa.id(9), qa.id(11), qa.id(8), 'word_choice', 'word',
          array[qa.id(10)], '["1:0"]', '[["1:0"],["1:0"]]', '["1:0"]', '1:1');

  insert into public.unit_embeddings (unit_id, bank_version, model, edition_id, embedding)
  values (qa.id(8), 1, 'test', qa.id(5), array_fill(0.1::real, array[384])::extensions.vector(384));

  insert into public.content_jobs (id, edition_id, bank_version, pipeline_version, step)
  values (qa.id(13), qa.id(5), 1, 'test', 'acquired');

  insert into public.generic_plan_templates
    (id, edition_id, catalog_version, scenario_key, policy_json, generator_version)
  values (qa.id(14), qa.id(5), 1, 'test', '{}', 'test');
end;
$$;

-- Moves the fixture edition to a status that its CHECK constraints accept.
create function qa.set_edition_status(p_status text)
returns void
language plpgsql
as $$
begin
  update public.book_editions
     set content_hash  = repeat('c', 64),
         review_record = '{"approval": {"who": "test", "at": "2026-01-01T00:00:00Z", "note": "test"}}',
         status        = p_status
   where id = qa.id(5);
end;
$$;

grant execute on all functions in schema qa to public;

-- ---------------------------------------------------------------------------
-- Added for checks_0002 .. checks_0005 (work package B2): users, roles, plan and session
-- fixtures, and catalog comparison helpers. Functions are plpgsql (or catalog-only SQL) so
-- that they can name tables of later migrations.
-- ---------------------------------------------------------------------------

-- Synthetic accounts: A = 901, B = 902, C = 903 (rows of auth.users only).
create function qa.make_users()
returns void
language plpgsql
as $$
begin
  insert into auth.users (id, email) values
    (qa.id(901), 'a@example.invalid'),
    (qa.id(902), 'b@example.invalid'),
    (qa.id(903), 'c@example.invalid');
end;
$$;

-- Role switches for the rest of the transaction. as_user also sets the JWT subject that
-- auth.uid() reads; as_none is the authenticated role without a subject.
create function qa.as_user(p_user uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
end;
$$;

create function qa.as_none()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role authenticated';
end;
$$;

create function qa.as_anon() returns void language plpgsql as $$ begin execute 'set local role anon'; end; $$;
create function qa.as_service() returns void language plpgsql as $$ begin execute 'set local role service_role'; end; $$;
create function qa.as_server() returns void language plpgsql as $$ begin execute 'set local role qatra_server'; end; $$;
create function qa.as_owner() returns void language plpgsql as $$ begin execute 'reset role'; end; $$;

-- Publishes the fixture edition (id 5) and its lesson (11) and question (12), so that the
-- published-content policies show them to authenticated.
create function qa.publish_fixture()
returns void
language plpgsql
as $$
begin
  perform qa.set_edition_status('published');
  update public.lessons set status = 'published' where id = qa.id(11);
  update public.question_items set status = 'published' where id = qa.id(12);
end;
$$;

-- A second passage with a part and a question in the fixture edition (ids 31, 32, 33), for
-- tests that must tell two passages of one edition apart.
create function qa.make_passage2()
returns void
language plpgsql
as $$
begin
  insert into public.passages
    (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
  values (qa.id(31), qa.id(5), 1, qa.id(7), 2, 'quran', '1:1', '1:1', 1, '1:2');
  insert into public.passage_parts (id, passage_id, edition_id, ordinal, start_ref, end_ref, word_count)
  values (qa.id(32), qa.id(31), qa.id(5), 1, '1:1', '1:1', 1);
  insert into public.question_items
    (id, edition_id, bank_version, passage_id, lesson_id, unit_id, type, variant,
     covered_part_ids, token_refs, option_refs, correct_ref, reference)
  values (qa.id(33), qa.id(5), 1, qa.id(31), null, qa.id(8), 'word_choice', 'word',
          array[qa.id(32)], '["1:1"]', '[["1:1"],["1:1"]]', '["1:1"]', '1:2');
end;
$$;

-- A hadith book (20) with a draft edition (21), for the plan-order guard.
create function qa.make_hadith_edition()
returns void
language plpgsql
as $$
begin
  insert into public.books (id, category_id, title_ar, author, content_format)
  values (qa.id(20), qa.id(1), 'test', 'test', 'hadith_collection');
  insert into public.book_editions
    (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
  values (qa.id(21), qa.id(20), qa.id(3), 'test-hadith-edition', 'test', 'ar', 1, 1);
end;
$$;

-- A plan of p_user over the fixture edition with its version 1 (inserted together, because
-- master_plans.current_version is a deferred key to plan_versions).
create function qa.make_plan(p_plan uuid, p_user uuid, p_status text default 'active')
returns void
language plpgsql
as $$
begin
  insert into public.master_plans
    (id, user_id, edition_id, target_scope, paths, plan_order, session_minutes,
     agreed_estimate, current_version, status)
  values (p_plan, p_user, qa.id(5), '{"sectionOrdinals":[1]}', array['quran'], 'book', 10,
          '{}', 1, p_status);
  insert into public.plan_versions (plan_id, user_id, version_no, reason_code, effective_learning_date)
  values (p_plan, p_user, 1, 'test', date '2026-10-05');
end;
$$;

-- A session of a plan (version 1 in force).
create function qa.make_session(
  p_session uuid, p_user uuid, p_plan uuid, p_kind text default 'daily',
  p_date date default date '2026-10-05', p_status text default 'open', p_snapshot uuid default null)
returns void
language plpgsql
as $$
begin
  insert into public.learning_sessions
    (id, user_id, plan_id, plan_version_id, edition_id, kind, learning_date, steps,
     bank_version, status, offline_snapshot_id)
  values (p_session, p_user, p_plan,
          (select pv.id from public.plan_versions pv where pv.plan_id = p_plan and pv.version_no = 1),
          qa.id(5), p_kind, p_date, '[]', 1, p_status, p_snapshot);
end;
$$;

-- Catalog comparison helpers. columns_of: "name|type|NULL or NOT NULL|default" in column order.
create function qa.columns_of(p_rel regclass)
returns text[]
language sql
stable
as $$
  select array_agg(
           a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|'
           || case when a.attnotnull then 'NOT NULL' else 'NULL' end || '|'
           || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
           order by a.attnum)
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = p_rel and a.attnum > 0 and not a.attisdropped
$$;

create function qa.assert_columns(p_rel regclass, p_expected text[])
returns void
language plpgsql
as $$
declare
  v_actual text[] := qa.columns_of(p_rel);
begin
  if v_actual is distinct from p_expected then
    raise exception 'columns of % differ; expected only: %; actual only: %',
      p_rel,
      (select array_agg(e) from unnest(p_expected) e where e <> all (coalesce(v_actual, '{}'))),
      (select array_agg(a) from unnest(v_actual) a where a <> all (coalesce(p_expected, '{}')));
  end if;
end;
$$;

-- key_defs: definitions (without names) of the primary key, unique and foreign-key
-- constraints of a table, sorted. Unique indexes that are not constraints come from index_defs.
create function qa.key_defs(p_rel regclass)
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(pg_get_constraintdef(c.oid) order by pg_get_constraintdef(c.oid)), '{}')
  from pg_constraint c
  where c.conrelid = p_rel and c.contype in ('p', 'u', 'f')
$$;

-- index_defs: every index that is not backed by a constraint, name removed, sorted.
create function qa.index_defs(p_rel regclass)
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(
           regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON ', 'CREATE \1INDEX ON ')
           order by regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \S+ ON ', 'CREATE \1INDEX ON ')),
         '{}')
  from pg_index i
  where i.indrelid = p_rel
    and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid and c.conrelid = p_rel)
$$;

create function qa.assert_same_set(p_label text, p_actual text[], p_expected text[])
returns void
language plpgsql
as $$
declare
  v_missing text[];
  v_extra   text[];
begin
  select array_agg(e) into v_missing from unnest(p_expected) e where e <> all (p_actual);
  select array_agg(a) into v_extra from unnest(p_actual) a where a <> all (p_expected);
  if v_missing is not null or v_extra is not null then
    raise exception '%: missing %, unexpected %', p_label, v_missing, v_extra;
  end if;
end;
$$;

-- The 25 learner and server functions of 0005 (public schema), by identity arguments.
create function qa.srv_functions()
returns text[]
language sql
immutable
as $$
  select array[
    'srv_find_handle(text)',
    'srv_register_account(uuid,text,text,text,boolean,text,text,text,bytea)',
    'srv_accept_terms(uuid,text)',
    'srv_recovery_active_code(uuid)',
    'srv_recovery_reserve(uuid,uuid,uuid,bytea,timestamp with time zone)',
    'srv_recovery_begin(bytea)',
    'srv_recovery_release(uuid)',
    'srv_recovery_consume(uuid,bytea)',
    'srv_recovery_rotate(uuid,bytea)',
    'srv_create_app_session(uuid,bytea,bytea,integer,timestamp with time zone)',
    'srv_read_app_session(bytea)',
    'srv_update_app_session_tokens(uuid,bytea)',
    'srv_revoke_app_session(bytea)',
    'srv_bump_auth_epoch(uuid)',
    'srv_throttle_check(bytea[])',
    'srv_throttle_record(bytea[],text)',
    'srv_delete_personal_rows(uuid,bytea)',
    'srv_record_ai_usage(text,text,text,integer,integer,numeric,text,jsonb)'
  ]
$$;

create function qa.app_functions()
returns text[]
language sql
immutable
as $$
  select array[
    'app_create_plan(uuid,jsonb,text[],text,smallint,date,jsonb,text,jsonb,date,jsonb,jsonb,uuid)',
    'app_revise_plan(uuid,integer,jsonb,text[],text,smallint,date,jsonb,text,jsonb,date,jsonb)',
    'app_open_session(text,uuid,uuid,uuid,uuid,date,uuid[],uuid[],jsonb,integer,text,uuid)',
    'app_apply_events(uuid,jsonb,jsonb,boolean)',
    'app_complete_session(uuid,bigint)',
    'app_create_offline_snapshot(uuid,integer,integer,uuid,jsonb,integer,integer,jsonb,jsonb,uuid)'
  ]
$$;

-- Number of rows an INSERT, UPDATE or DELETE touched (0 for a statement that RLS filtered out).
create function qa.rowcount(p_sql text)
returns bigint
language plpgsql
as $$
declare
  n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- A full set of personal rows for one account (fixture edition 5 must exist, published or not;
-- qa.make_users must have created the Auth user). p_n (1..99) keeps every unique value apart:
-- handle, profile, recovery code, reset grant, app session, plan with version 1, daily session,
-- offline snapshot, attempt, interval, mastery, part evidence, daily progress and completion.
-- Ids: plan 1000+n, session 2000+n, snapshot 3000+n, attempt 4000+n.
create function qa.populate_user(p_user uuid, p_n integer)
returns void
language plpgsql
as $$
declare
  v_hash bytea := decode(lpad(to_hex(p_n), 64, '0'), 'hex');
begin
  insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
  values (p_user, 'user' || p_n, 'user' || p_n,
          'u.00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0') || '@qatra.invalid');
  insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
  values (p_user, 'UTC', '2026-10-04', now());
  insert into private.recovery_codes (user_id, code_hash) values (p_user, v_hash);
  insert into private.password_reset_grants (user_id, grant_hash, expires_at)
  values (p_user, v_hash, now() + interval '10 minutes');
  insert into private.app_sessions (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at)
  values (p_user, v_hash, 0, '\x01', now() + interval '30 days');
  perform qa.make_plan(qa.id(1000 + p_n), p_user, 'active');
  perform qa.make_session(qa.id(2000 + p_n), p_user, qa.id(1000 + p_n));
  insert into public.offline_snapshots
    (id, user_id, plan_id, plan_version, edition_id, bank_version, client_operation_id,
     download_target_refs, schema_version, protocol_version, payload)
  values (qa.id(3000 + p_n), p_user, qa.id(1000 + p_n), 1, qa.id(5), 1, qa.id(5000 + p_n), '[]', 1, 1, '{}');
  insert into public.attempts
    (id, user_id, session_id, edition_id, client_event_id, question_id, passage_id, correct, duration_ms, occurred_at)
  values (qa.id(4000 + p_n), p_user, qa.id(2000 + p_n), qa.id(5), qa.id(6000 + p_n), qa.id(12), qa.id(9), true, 10, now());
  insert into public.session_activity_intervals
    (user_id, session_id, client_event_id, started_at, ended_at, active_ms, learning_date)
  values (p_user, qa.id(2000 + p_n), qa.id(7000 + p_n), now() - interval '1 minute', now(), 1000, date '2026-10-05');
  insert into public.target_mastery (user_id, plan_id, passage_id, edition_id)
  values (p_user, qa.id(1000 + p_n), qa.id(9), qa.id(5));
  insert into public.target_part_evidence (user_id, plan_id, passage_id, part_id, attempt_id, learning_date)
  values (p_user, qa.id(1000 + p_n), qa.id(9), qa.id(10), qa.id(4000 + p_n), date '2026-10-05');
  insert into public.daily_progress (user_id, learning_date, goal_ms) values (p_user, date '2026-10-05', 600000);
  insert into public.daily_completions (user_id, learning_date, reached_in_plan_id)
  values (p_user, date '2026-10-05', qa.id(1000 + p_n));
end;
$$;

-- Added for checks_0006 (work package B2b).
-- A valid PlanProposal object for the fixture edition (id 5), as stored by the plan conversation.
create function qa.proposal_json(p_version integer default 1, p_minutes integer default 10)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'proposalVersion', p_version, 'editionId', qa.id(5),
    'targetScope', jsonb_build_object('sectionOrdinals', jsonb_build_array(1)),
    'paths', jsonb_build_array('quran'), 'order', 'book', 'sessionMinutes', p_minutes,
    'preferredDate', null, 'estimate', jsonb_build_object('days', 5, 'sessionMinutes', p_minutes))
$$;

-- One phase array as app_create_plan, app_revise_plan and app_plan_chat_confirm expect it.
create function qa.phases_json()
returns jsonb
language sql
immutable
as $$
  select '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-05,2026-10-12)"}]'::jsonb
$$;

-- The plan arguments of app_plan_chat_confirm.
create function qa.plan_args_json(p_extra jsonb default '{}')
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('reason_code', 'plan_chat', 'policy_json', '{"planner": "rules"}'::jsonb,
                            'effective_learning_date', '2026-10-05', 'phases', qa.phases_json()) || p_extra
$$;

grant execute on all functions in schema qa to public;
