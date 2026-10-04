-- checks_0006.sql
--
-- LOCAL VALIDATION ONLY. Assertions for supabase/migrations/0006_plan_chats.sql, run by
-- run_local.sh right after that migration (the database then holds 0001-0006). Every
-- "-- CHECK:" line starts one independent chunk; a chunk passes when psql finishes it
-- without an error. Rows are synthetic placeholders created inside transactions that are
-- rolled back (the last chunk, concurrency over dblink, commits for real and removes its
-- rows). Roles are exercised with SET ROLE (qa.as_user, qa.as_none, qa.as_anon,
-- qa.as_service, qa.as_server); no Data API runs. Expected values are written from
-- docs/Database-schema.md v1.2 (§4.4, §5.2, §6.3, §11 `0006_plan_chats`, §12.1, §14 check 18),
-- docs/Plan-conversation.md v1.1 §2.1/§2.9, docs/API-spec.md §4.10 (E30-E34) and the
-- pre-merge audit of 4 October 2026 (tamper guard).
--
-- Coverage (work package B2b, backend scope G3, D74):
--   01-06  tables and grants, function grants, two-account isolation, one open chat per
--          account, the tamper guard, app_resume_plan (the compact first set)
--   07-10  structure against §6.3 (columns, keys with delete classes A and B, indexes, RLS
--          not forced); the rules of both tables (defaults, value sets, text limit,
--          counters, closed_at coupling, composite keys, ordinal key, learner privileges
--          at run time); the five P-OWN policies and the triggers; updated_at; no seed rows
--   11-14  app_plan_chat_open: first conversation, replacement, revision conversations,
--          invalid input
--   15-17  app_plan_chat_append: messages and ordinals, proposal and counters, refusals
--   18-23  app_plan_chat_confirm: creation, proposal version, closed and foreign chats,
--          revision, plan version, rollback of failing steps
--   24-26  interplay with app_resume_plan; the execution boundary at run time (no token
--          subject, anon, service_role, qatra_server); account deletion and cascades
--   27     concurrency over dblink (needs the contrib module dblink, like checks_0005 chunk 27):
--          parallel opens, parallel appends, a confirm against a replacing open, a double confirm
-- Refusals are asserted by SQLSTATE, and by constraint name for CHECK, UNIQUE and FOREIGN KEY
-- violations: QT002 stale proposal version or a plan that moved, QT003 chat not open (or no
-- proposal yet), P0002 unknown or foreign chat, 22023 unusable arguments, 42501 no subject or no
-- privilege. Every refusal of a function is followed by a check that nothing was saved or changed.
--
-- Deliberately not asserted:
--   * A completed plan is accepted by app_plan_chat_open (as the plan of a revision
--     conversation) and by the revision path of app_plan_chat_confirm, while API-spec E31
--     and E34 name 409 `plan_not_active` for it. None of the three functions tests the plan's
--     status (only app_resume_plan does, QT003), so that refusal currently depends on the
--     service layer. No check pins either outcome until it is decided where the rule lives.
--   * The turn pipeline, the model caps, ai_usage and the HTTP mapping of the SQLSTATEs
--     (service layer, not database).
--   * A purge of abandoned conversations: no DELETE path exists (OPEN-18, Plan-conversation §2.9 item 8).

-- CHECK: 01 tables exist with row level security, nothing for anon or service_role, authenticated holds only the §5.2 privileges
do $$
declare
  t text;
begin
  foreach t in array array['plan_chats', 'plan_chat_messages'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = t and c.relkind = 'r' and c.relrowsecurity) then
      raise exception 'public.% is missing or has no row level security', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete')
       or has_table_privilege('service_role', 'public.' || t, 'select,insert,update,delete')
       or has_table_privilege('qatra_server', 'public.' || t, 'select') then
      raise exception 'anon, service_role or qatra_server hold a privilege on public.%', t;
    end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select,insert')
       or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'authenticated privileges on public.% differ from select+insert without delete', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.plan_chat_messages', 'update') then
    raise exception 'plan_chat_messages must be append-only';
  end if;
  if has_column_privilege('authenticated', 'public.plan_chats', 'user_id', 'update')
     or has_column_privilege('authenticated', 'public.plan_chats', 'plan_id', 'update')
     or has_column_privilege('authenticated', 'public.plan_chats', 'language', 'update') then
    raise exception 'user_id, plan_id and language of plan_chats must not be updatable';
  end if;
end $$;

-- CHECK: 02 the four learner functions are executable by authenticated only, security invoker, search_path empty
do $$
declare
  f text;
begin
  foreach f in array array['app_resume_plan(uuid)',
                           'app_plan_chat_open(text,text,jsonb,uuid,jsonb)',
                           'app_plan_chat_append(uuid,jsonb,jsonb,integer)',
                           'app_plan_chat_confirm(uuid,integer,jsonb)'] loop
    if not has_function_privilege('authenticated', 'public.' || f, 'execute') then
      raise exception 'authenticated cannot execute %', f;
    end if;
    if has_function_privilege('anon', 'public.' || f, 'execute')
       or has_function_privilege('service_role', 'public.' || f, 'execute')
       or has_function_privilege('qatra_server', 'public.' || f, 'execute') then
      raise exception 'anon, service_role or qatra_server can execute %', f;
    end if;
    if exists (select 1 from pg_proc p where p.oid = ('public.' || f)::regprocedure and (p.prosecdef or p.proconfig is null
               or not (p.proconfig @> array['search_path=""']))) then
      raise exception '% must be security invoker with an empty search_path', f;
    end if;
  end loop;
end $$;

-- CHECK: 03 two-account isolation: B sees none of A's chats or messages and cannot touch or forge them
begin;
select qa.make_fixture();
select qa.publish_fixture();
select qa.make_users();
do $$
declare
  v_chat uuid;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into v_chat
  from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"text","text":"synthetic reply","source":"rules"}') o;
  perform qa.as_owner();

  perform qa.as_user(qa.id(902));
  if (select count(*) from public.plan_chats) <> 0 or (select count(*) from public.plan_chat_messages) <> 0 then
    raise exception 'B sees A''s chat rows';
  end if;
  if qa.rowcount(format('update public.plan_chats set model_turns = 1 where id = %L', v_chat)) <> 0 then
    raise exception 'B updated A''s chat';
  end if;
  perform qa.expect_error(format('delete from public.plan_chats where id = %L', v_chat), '42501', 'B deletes A''s chat');
  perform qa.expect_error(format($q$insert into public.plan_chats (user_id, status, language) values (%L, 'open', 'ar')$q$, qa.id(901)),
                          '42501', 'B forges a chat for A');
  perform qa.expect_error(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source)
                                    values (%L, %L, 99, 'learner', 'text', 'x', 'learner')$q$, v_chat, qa.id(901)),
                          '42501', 'B forges a message for A');
  perform qa.expect_error(format('select public.app_plan_chat_append(%L, %L::jsonb)', v_chat,
                                 '[{"role":"learner","kind":"text","text":"x","source":"learner"}]'), 'P0002',
                          'B appends to A''s chat (chat_not_found, never revealing that it exists)');
  perform qa.as_owner();

  perform qa.as_user(qa.id(901));
  if (select count(*) from public.plan_chats) <> 1 or (select count(*) from public.plan_chat_messages) <> 2 then
    raise exception 'A does not see its own chat and its two messages';
  end if;
  perform qa.as_owner();
end $$;
rollback;

-- CHECK: 04 one open chat per account: opening a second abandons the first and reports it
begin;
select qa.make_fixture();
select qa.publish_fixture();
select qa.make_users();
do $$
declare
  v_first  uuid;
  v_second uuid;
  v_repl   uuid;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into v_first from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"a","source":"rules"}') o;
  select o.chat_id, o.replaced_chat_id into v_second, v_repl
  from public.app_plan_chat_open('en', null, '{"kind":"text","text":"b","source":"rules"}') o;
  perform qa.as_owner();
  if v_repl is distinct from v_first then
    raise exception 'the replaced chat id is not the first chat';
  end if;
  if (select status from public.plan_chats where id = v_first) <> 'abandoned'
     or (select closed_at from public.plan_chats where id = v_first) is null
     or (select status from public.plan_chats where id = v_second) <> 'open' then
    raise exception 'statuses after replacement are wrong';
  end if;
  perform qa.expect_unique(format($q$insert into public.plan_chats (user_id, status, language) values (%L, 'open', 'ar')$q$, qa.id(901)),
                           'plan_chats_user_id_open_key');
end $$;
rollback;

-- CHECK: 05 tamper guard: a learner token cannot lower the counters, reopen or change a closed chat
begin;
select qa.make_fixture();
select qa.publish_fixture();
select qa.make_users();
do $$
declare
  v_chat uuid;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into v_chat
  from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"text","text":"r","source":"rules"}', null, qa.proposal_json()) o;
  perform public.app_plan_chat_append(v_chat, '[{"role":"assistant","kind":"text","text":"m","source":"model"}]', null, 2);
  if (select model_turns from public.plan_chats where id = v_chat) <> 2 then
    raise exception 'the model-turn counter was not incremented by the function';
  end if;
  perform qa.expect_error(format('update public.plan_chats set model_turns = 0 where id = %L', v_chat), 'QT003', 'lowering model_turns');
  perform qa.expect_error(format('update public.plan_chats set proposal_version = 0 where id = %L', v_chat), 'QT003', 'lowering proposal_version');
  perform qa.as_owner();

  -- a closed chat accepts no update at all (the owner role is subject to the trigger too)
  update public.plan_chats set status = 'abandoned', closed_at = now() where id = v_chat;
  perform qa.expect_error(format($q$update public.plan_chats set status = 'open', closed_at = null where id = %L$q$, v_chat), 'QT003', 'reopening');
  perform qa.expect_error(format('update public.plan_chats set model_turns = 5 where id = %L', v_chat), 'QT003', 'updating a closed chat');
end $$;
rollback;

-- CHECK: 06 app_resume_plan: paused becomes active and the current plan pauses; completed is refused; a foreign plan is not found
begin;
select qa.make_fixture();
select qa.publish_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
select qa.make_plan(qa.id(1002), qa.id(901), 'paused');
select qa.make_plan(qa.id(1003), qa.id(902), 'active');
select qa.make_plan(qa.id(1004), qa.id(901), 'completed');
do $$
declare
  v_version integer;
begin
  perform qa.as_user(qa.id(901));
  v_version := public.app_resume_plan(qa.id(1002));
  if v_version <> 1 then
    raise exception 'resume returned version % instead of 1', v_version;
  end if;
  perform qa.as_owner();
  if (select status from public.master_plans where id = qa.id(1002)) <> 'active'
     or (select status from public.master_plans where id = qa.id(1001)) <> 'paused' then
    raise exception 'the two plans did not swap status';
  end if;
  if (select status from public.master_plans where id = qa.id(1003)) <> 'active' then
    raise exception 'the resume touched another account''s plan';
  end if;
  perform qa.as_user(qa.id(901));
  perform qa.expect_error(format('select public.app_resume_plan(%L)', qa.id(1004)), 'QT003', 'resuming a completed plan');
  perform qa.expect_error(format('select public.app_resume_plan(%L)', qa.id(1003)), 'P0002', 'resuming a foreign plan');
  if public.app_resume_plan(qa.id(1002)) <> 1 then
    raise exception 'resuming an already active plan must return its version unchanged';
  end if;
  perform qa.as_owner();
end $$;
rollback;

-- CHECK: 07 structure of the two tables matches §6.3: columns (type, nullability, default, order), keys with their delete actions (classes A and B), indexes; row level security is on and not forced
do $$
begin
  perform qa.assert_columns('public.plan_chats'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'plan_id|uuid|NULL|',
    'status|text|NOT NULL|',
    'language|text|NOT NULL|',
    'proposal|jsonb|NULL|',
    'proposal_version|integer|NOT NULL|0',
    'model_turns|integer|NOT NULL|0',
    'created_at|timestamp with time zone|NOT NULL|now()',
    'updated_at|timestamp with time zone|NOT NULL|now()',
    'closed_at|timestamp with time zone|NULL|']);
  perform qa.assert_columns('public.plan_chat_messages'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'chat_id|uuid|NOT NULL|',
    'user_id|uuid|NOT NULL|',
    'ordinal|integer|NOT NULL|',
    'role|text|NOT NULL|',
    'kind|text|NOT NULL|',
    'text|text|NOT NULL|',
    'source|text|NOT NULL|',
    'payload|jsonb|NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()']);

  perform qa.assert_same_set('plan_chats keys', qa.key_defs('public.plan_chats'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    -- class B; MATCH SIMPLE, so the key is not checked while plan_id is NULL
    'FOREIGN KEY (plan_id, user_id) REFERENCES master_plans(id, user_id) ON DELETE CASCADE',
    'UNIQUE (id, user_id)']);
  perform qa.assert_same_set('plan_chats indexes', qa.index_defs('public.plan_chats'::regclass), array[
    'CREATE UNIQUE INDEX ON public.plan_chats USING btree (user_id) WHERE (status = ''open''::text)',
    'CREATE INDEX ON public.plan_chats USING btree (plan_id) WHERE (plan_id IS NOT NULL)']);

  perform qa.assert_same_set('plan_chat_messages keys', qa.key_defs('public.plan_chat_messages'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (chat_id, user_id) REFERENCES plan_chats(id, user_id) ON DELETE CASCADE',
    'UNIQUE (chat_id, ordinal)']);
  -- the unique key (chat_id, ordinal) serves the reading order and the composite key: no further index
  perform qa.assert_same_set('plan_chat_messages indexes', qa.index_defs('public.plan_chat_messages'::regclass), array[]::text[]);

  -- row level security is enabled and not forced (§5.2 item 9: the srv_* functions rely on the owner bypassing it)
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('plan_chats', 'plan_chat_messages') and c.relrowsecurity and not c.relforcerowsecurity) <> 2 then
    raise exception 'row level security must be enabled and not forced on both tables';
  end if;
end $$;

-- CHECK: 08 plan_chats rules: defaults, value sets, proposal type, counters, the closed_at coupling and the composite keys; closed conversations are accepted in any number beside one open one
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
select qa.make_plan(qa.id(1003), qa.id(902), 'active');
do $$
declare
  v_open uuid;
begin
  -- defaults of §6.3 (status and language are set explicitly): a creation conversation without a proposal
  insert into public.plan_chats (user_id, status, language) values (qa.id(901), 'open', 'ar') returning id into v_open;
  if (select (proposal is null, proposal_version, model_turns, plan_id is null, closed_at is null, created_at is not null)::text
      from public.plan_chats where id = v_open) <> '(t,0,0,t,t,t)' then
    raise exception 'the defaults of plan_chats differ';
  end if;

  -- value sets and bounds, each refused by exactly the intended rule (a closed status carries closed_at, so that only one rule is broken)
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language, closed_at) values (%L, 'bogus', 'ar', now())$q$, qa.id(902)),
                          'plan_chats_status_check');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language) values (%L, 'open', 'fr')$q$, qa.id(902)),
                          'plan_chats_language_check');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language) values (%L, 'open', '')$q$, qa.id(902)),
                          'plan_chats_language_check');
  perform qa.expect_error(format($q$insert into public.plan_chats (user_id, status, language) values (%L, 'open', null)$q$, qa.id(902)),
                          '23502', 'language is required');
  perform qa.expect_error(format($q$insert into public.plan_chats (user_id, status, language) values (%L, null, 'ar')$q$, qa.id(902)),
                          '23502', 'status is required');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language, proposal) values (%L, 'open', 'ar', '[]')$q$, qa.id(902)),
                          'plan_chats_proposal_check');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language, proposal) values (%L, 'open', 'ar', '"x"')$q$, qa.id(902)),
                          'plan_chats_proposal_check');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language, proposal) values (%L, 'open', 'ar', 'null')$q$, qa.id(902)),
                          'plan_chats_proposal_check');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language, proposal_version) values (%L, 'open', 'ar', -1)$q$, qa.id(902)),
                          'plan_chats_proposal_version_check');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language, model_turns) values (%L, 'open', 'ar', -1)$q$, qa.id(902)),
                          'plan_chats_model_turns_check');
  -- a proposal object and the language 'en' are accepted
  insert into public.plan_chats (user_id, status, language, proposal, proposal_version, model_turns)
  values (qa.id(902), 'open', 'en', '{"proposalVersion": 1}', 1, 6);
  delete from public.plan_chats where user_id = qa.id(902);

  -- closed_at is set exactly when the conversation is not open (§6.3, proposed rule)
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language, closed_at) values (%L, 'open', 'ar', now())$q$, qa.id(902)),
                          'plan_chats_closed_at_check');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language) values (%L, 'confirmed', 'ar')$q$, qa.id(902)),
                          'plan_chats_closed_at_check');
  perform qa.expect_check(format($q$insert into public.plan_chats (user_id, status, language) values (%L, 'abandoned', 'ar')$q$, qa.id(902)),
                          'plan_chats_closed_at_check');
  perform qa.expect_check(format($q$update public.plan_chats set status = 'confirmed' where id = %L$q$, v_open), 'plan_chats_closed_at_check');
  perform qa.expect_check(format($q$update public.plan_chats set closed_at = now() where id = %L$q$, v_open), 'plan_chats_closed_at_check');
  perform qa.expect_check(format($q$update public.plan_chats set proposal = '[]' where id = %L$q$, v_open), 'plan_chats_proposal_check');
  if (select (status, closed_at is null)::text from public.plan_chats where id = v_open) <> '(open,t)' then
    raise exception 'a refused update changed the open conversation';
  end if;

  -- any number of closed conversations beside the one open conversation of the account; a second open one is refused
  insert into public.plan_chats (user_id, status, language, closed_at)
  select qa.id(901), s, 'ar', now() from unnest(array['abandoned', 'confirmed', 'abandoned', 'confirmed']) as s;
  if (select count(*) from public.plan_chats where user_id = qa.id(901)) <> 5
     or (select count(*) from public.plan_chats where user_id = qa.id(901) and status = 'open') <> 1 then
    raise exception 'closed conversations are not accepted beside the open one';
  end if;
  perform qa.expect_unique(format($q$insert into public.plan_chats (user_id, status, language) values (%L, 'open', 'en')$q$, qa.id(901)),
                           'plan_chats_user_id_open_key');
  -- another account has its own open conversation
  insert into public.plan_chats (user_id, status, language) values (qa.id(902), 'open', 'en');

  -- composite keys: the account's own plan is accepted, a plan of another account and an unknown plan are not (forged plan_id, §14 check 18)
  insert into public.plan_chats (user_id, status, language, plan_id, closed_at)
  values (qa.id(901), 'abandoned', 'ar', qa.id(1001), now());
  perform qa.expect_fk(format($q$insert into public.plan_chats (user_id, status, language, plan_id, closed_at) values (%L, 'abandoned', 'ar', %L, now())$q$,
                              qa.id(901), qa.id(1003)), 'plan_chats_plan_id_user_id_fkey');
  perform qa.expect_fk(format($q$insert into public.plan_chats (user_id, status, language, plan_id, closed_at) values (%L, 'abandoned', 'ar', %L, now())$q$,
                              qa.id(901), qa.id(9999)), 'plan_chats_plan_id_user_id_fkey');
  perform qa.expect_fk($q$insert into public.plan_chats (user_id, status, language, closed_at) values (gen_random_uuid(), 'abandoned', 'ar', now())$q$,
                       'plan_chats_user_id_fkey');
end $$;
rollback;

-- CHECK: 09 plan_chat_messages rules: role, kind and source value sets, text of at most 2000 characters, one ordinal per position, composite key to the chat; a learner can only read and insert, and the tamper guard binds a learner token on a closed chat
begin;
select qa.make_fixture();
select qa.make_users();
insert into public.plan_chats (id, user_id, status, language) values (qa.id(2101), qa.id(901), 'open', 'ar');
insert into public.plan_chats (id, user_id, status, language) values (qa.id(2102), qa.id(902), 'open', 'en');
do $$
declare
  v text;
  n integer := 0;
begin
  -- every value of the three sets is accepted
  foreach v in array array['learner', 'assistant'] loop
    n := n + 1;
    insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (qa.id(2101), qa.id(901), n, v, 'text', 't', 'learner');
  end loop;
  foreach v in array array['text', 'proposal', 'refusal', 'redirect', 'fallback', 'quick_reply'] loop
    n := n + 1;
    insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (qa.id(2101), qa.id(901), n, 'assistant', v, 't', 'rules');
  end loop;
  foreach v in array array['learner', 'rules', 'model', 'fixed'] loop
    n := n + 1;
    insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (qa.id(2101), qa.id(901), n, 'assistant', 'text', 't', v);
  end loop;
  if (select count(*) from public.plan_chat_messages) <> 12 then raise exception 'not every allowed value was accepted'; end if;

  -- values outside the sets, each refused by exactly the intended rule
  perform qa.expect_check(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 50, 'system', 'text', 't', 'rules')$q$, qa.id(2101), qa.id(901)),
                          'plan_chat_messages_role_check');
  perform qa.expect_check(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 50, 'assistant', 'bogus', 't', 'rules')$q$, qa.id(2101), qa.id(901)),
                          'plan_chat_messages_kind_check');
  perform qa.expect_check(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 50, 'assistant', 'text', 't', 'bogus')$q$, qa.id(2101), qa.id(901)),
                          'plan_chat_messages_source_check');
  perform qa.expect_error(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 50, 'assistant', 'text', null, 'rules')$q$, qa.id(2101), qa.id(901)),
                          '23502', 'text is required');

  -- the text limit counts characters (the check is on char_length): 2000 are accepted, 2001 are refused, also for two-byte characters
  insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (qa.id(2101), qa.id(901), 51, 'learner', 'text', repeat('x', 2000), 'learner');
  insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (qa.id(2101), qa.id(901), 52, 'learner', 'text', repeat(chr(233), 2000), 'learner');
  perform qa.expect_check(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 53, 'learner', 'text', repeat('x', 2001), 'learner')$q$, qa.id(2101), qa.id(901)),
                          'plan_chat_messages_text_check');
  perform qa.expect_check(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 53, 'learner', 'text', repeat(chr(233), 2001), 'learner')$q$, qa.id(2101), qa.id(901)),
                          'plan_chat_messages_text_check');

  -- one message per ordinal and chat; the same ordinal in another chat is fine
  perform qa.expect_unique(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 1, 'learner', 'text', 't', 'learner')$q$, qa.id(2101), qa.id(901)),
                           'plan_chat_messages_chat_id_ordinal_key');
  insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (qa.id(2102), qa.id(902), 1, 'learner', 'text', 't', 'learner');

  -- the composite key keeps a message inside the chat of its own account (forged chat_id, §14 check 18)
  perform qa.expect_fk(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 60, 'learner', 'text', 't', 'learner')$q$, qa.id(2101), qa.id(902)),
                       'plan_chat_messages_chat_id_user_id_fkey');
  perform qa.expect_fk(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 60, 'learner', 'text', 't', 'learner')$q$, qa.id(9999), qa.id(901)),
                       'plan_chat_messages_chat_id_user_id_fkey');

  -- a learner token reads and inserts only: no update or delete of messages, no delete of chats, and none of the columns outside the update grant
  insert into public.plan_chats (id, user_id, status, language, closed_at) values (qa.id(2103), qa.id(901), 'abandoned', 'ar', now());
  perform qa.as_user(qa.id(901));
  perform qa.expect_error($q$update public.plan_chat_messages set text = 'x'$q$, '42501', 'a learner updates a message');
  perform qa.expect_error($q$delete from public.plan_chat_messages$q$, '42501', 'a learner deletes a message');
  perform qa.expect_error($q$delete from public.plan_chats$q$, '42501', 'a learner deletes a chat');
  perform qa.expect_error($q$update public.plan_chats set language = 'en'$q$, '42501', 'a learner changes the language');
  perform qa.expect_error(format($q$update public.plan_chats set plan_id = %L$q$, qa.id(9999)), '42501', 'a learner changes plan_id');
  perform qa.expect_error(format($q$update public.plan_chats set user_id = %L$q$, qa.id(902)), '42501', 'a learner changes user_id');
  perform qa.expect_error($q$update public.plan_chats set created_at = now()$q$, '42501', 'a learner changes created_at');
  perform qa.expect_error($q$update public.plan_chats set id = gen_random_uuid()$q$, '42501', 'a learner changes id');
  perform qa.expect_error($q$update public.plan_chats set updated_at = now()$q$, '42501', 'a learner changes updated_at');
  -- the tamper guard binds the learner token too: a closed chat cannot be reopened, closed differently or have its counters changed
  perform qa.expect_error(format($q$update public.plan_chats set status = 'open', closed_at = null where id = %L$q$, qa.id(2103)), 'QT003', 'a learner reopens a closed chat');
  perform qa.expect_error(format($q$update public.plan_chats set status = 'confirmed' where id = %L$q$, qa.id(2103)), 'QT003', 'a learner changes the status of a closed chat');
  perform qa.expect_error(format($q$update public.plan_chats set model_turns = 9, proposal_version = 9 where id = %L$q$, qa.id(2103)), 'QT003', 'a learner changes the counters of a closed chat');
  if (select (status, model_turns, proposal_version, closed_at is not null)::text from public.plan_chats where id = qa.id(2103)) <> '(abandoned,0,0,t)' then
    raise exception 'a refused update changed the closed chat';
  end if;
  if (select count(*) from public.plan_chat_messages) <> 14 or (select count(*) from public.plan_chats) <> 2 then
    raise exception 'A does not see exactly its two chats and its 14 messages';
  end if;
  perform qa.as_owner();
end $$;
rollback;

-- CHECK: 10 policies and triggers of the two tables: exactly the five P-OWN policies, the two update triggers of plan_chats and none on the messages, the guard closed to the API roles, updated_at maintained; no seed rows
begin;
select qa.make_users();
insert into public.plan_chats (id, user_id, status, language, updated_at) values (qa.id(2101), qa.id(901), 'open', 'ar', timestamptz '2000-01-01 00:00:00+00');
update public.plan_chats set model_turns = 1 where id = qa.id(2101);
do $$
declare
  c_own constant text := '(user_id = ( SELECT auth.uid() AS uid))';
  r record;
  v_missing text[];
  v_extra   text[];
begin
  if (select updated_at from public.plan_chats where id = qa.id(2101)) < now() - interval '1 minute' then
    raise exception 'plan_chats.updated_at was not refreshed';
  end if;

  perform qa.assert_same_set('policies of the conversation tables',
    (select coalesce(array_agg(p.tablename || '|' || p.policyname || '|' || p.cmd || '|' || p.roles::text || '|' || p.permissive), '{}')
     from pg_policies p where p.schemaname = 'public' and p.tablename in ('plan_chats', 'plan_chat_messages')),
    array['plan_chats|plan_chats__authenticated__select|SELECT|{authenticated}|PERMISSIVE',
          'plan_chats|plan_chats__authenticated__insert|INSERT|{authenticated}|PERMISSIVE',
          'plan_chats|plan_chats__authenticated__update|UPDATE|{authenticated}|PERMISSIVE',
          'plan_chat_messages|plan_chat_messages__authenticated__select|SELECT|{authenticated}|PERMISSIVE',
          'plan_chat_messages|plan_chat_messages__authenticated__insert|INSERT|{authenticated}|PERMISSIVE']);
  for r in
    select p.policyname, p.cmd, regexp_replace(coalesce(p.qual, ''), '\s+', ' ', 'g') as qual,
           regexp_replace(coalesce(p.with_check, ''), '\s+', ' ', 'g') as with_check
    from pg_policies p
    where p.schemaname = 'public' and p.tablename in ('plan_chats', 'plan_chat_messages')
  loop
    if r.cmd = 'SELECT' and (r.qual <> c_own or r.with_check <> '') then
      raise exception 'policy %: a select policy must be USING %, got USING [%] CHECK [%]', r.policyname, c_own, r.qual, r.with_check;
    elsif r.cmd = 'INSERT' and (r.qual <> '' or r.with_check <> c_own) then
      raise exception 'policy %: an insert policy must be WITH CHECK % only, got USING [%] CHECK [%]', r.policyname, c_own, r.qual, r.with_check;
    elsif r.cmd = 'UPDATE' and (r.qual <> c_own or r.with_check <> c_own) then
      raise exception 'policy %: an update policy must be USING and WITH CHECK %, got USING [%] CHECK [%]', r.policyname, c_own, r.qual, r.with_check;
    end if;
  end loop;
  -- 42 policies of 0001-0004 plus these five; no restrictive policy anywhere in public
  if (select count(*) from pg_policies where schemaname = 'public') <> 47
     or exists (select 1 from pg_policies where schemaname = 'public' and permissive <> 'PERMISSIVE') then
    raise exception 'schema public does not hold exactly 47 permissive policies';
  end if;

  with expected(tbl, trg, fn, timing_events) as (
    values ('plan_chats', 'plan_chats_set_updated_at', 'set_updated_at',          'BEFORE UPDATE'),
           ('plan_chats', 'plan_chats_guard_update',   'guard_plan_chat_update', 'BEFORE UPDATE')
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
      and c.relname in ('plan_chats', 'plan_chat_messages')
  )
  select
    (select array_agg(e.trg) from expected e where not exists (select 1 from actual a where a.trg = e.trg and a.tbl = e.tbl and a.fn = e.fn and a.timing_events = e.timing_events)),
    (select array_agg(a.trg) from actual a where not exists (select 1 from expected e where a.trg = e.trg and a.tbl = e.tbl and a.fn = e.fn and a.timing_events = e.timing_events))
  into v_missing, v_extra;
  if v_missing is not null or v_extra is not null then
    raise exception 'trigger mismatch: missing %, unexpected %', v_missing, v_extra;
  end if;
  -- the guard is an invoker function with an empty search_path that no API role can execute (the trigger fires regardless)
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'guard_plan_chat_update' and not p.prosecdef
      and p.proconfig @> array['search_path=""']) then
    raise exception 'private.guard_plan_chat_update is not an invoker function with an empty search_path';
  end if;
  if has_function_privilege('anon', 'private.guard_plan_chat_update()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.guard_plan_chat_update()', 'EXECUTE')
     or has_function_privilege('service_role', 'private.guard_plan_chat_update()', 'EXECUTE')
     or has_function_privilege('qatra_server', 'private.guard_plan_chat_update()', 'EXECUTE') then
    raise exception 'an API role can execute private.guard_plan_chat_update';
  end if;
end $$;
rollback;
do $$
begin
  -- no seed rows (the migration inserts nothing)
  if (select count(*) from public.plan_chats) <> 0 or (select count(*) from public.plan_chat_messages) <> 0 then
    raise exception 'the conversation tables hold rows after the migration';
  end if;
end $$;

-- CHECK: 11 app_plan_chat_open, first conversation: an open chat in the requested language with the documented initial state; the learner's text and the assistant messages follow in order; no replaced chat is reported
begin;
select qa.make_fixture();
select qa.make_users();
insert into auth.users (id, email) values (qa.id(904), 'd@example.invalid');
do $$
declare
  v_ids   uuid[];
  v_repl  uuid[];
  v_chat  uuid;
begin
  -- A: the minimal call (no learner text, no proposal, one assistant message given as an object)
  perform qa.as_user(qa.id(901));
  select array_agg(o.chat_id), array_agg(o.replaced_chat_id) into v_ids, v_repl
  from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"synthetic reply","source":"rules"}') o;
  if cardinality(v_ids) <> 1 or v_repl[1] is not null then
    raise exception 'the first open must return exactly one row without a replaced chat (%, %)', v_ids, v_repl;
  end if;
  v_chat := v_ids[1];
  if (select (user_id = qa.id(901), plan_id is null, status, language, proposal is null, proposal_version, model_turns,
              closed_at is null, created_at is not null, updated_at is not null)::text
      from public.plan_chats where id = v_chat) <> '(t,t,open,ar,t,0,0,t,t,t)' then
    raise exception 'the initial state without a proposal differs: %', (select to_jsonb(c) from public.plan_chats c where id = v_chat);
  end if;
  if (select string_agg(ordinal || ':' || role || ':' || kind || ':' || source || ':' || text || ':' || coalesce(payload::text, '-'), ',' order by ordinal)
      from public.plan_chat_messages where chat_id = v_chat) <> '1:assistant:text:rules:synthetic reply:-' then
    raise exception 'the first assistant message differs';
  end if;
  perform qa.as_owner();

  -- B: the learner's goal text, a proposal (stored with version 1) and a proposal message that carries its snapshot
  perform qa.as_user(qa.id(902));
  select o.chat_id into v_chat from public.app_plan_chat_open('en', 'synthetic goal', jsonb_build_object(
    'kind', 'proposal', 'text', 'synthetic proposal', 'source', 'rules', 'payload', qa.proposal_json()), null, qa.proposal_json()) o;
  if (select (status, language, proposal = qa.proposal_json(), proposal_version, model_turns, plan_id is null, closed_at is null)::text
      from public.plan_chats where id = v_chat) <> '(open,en,t,1,0,t,t)' then
    raise exception 'the initial state with a proposal differs: %', (select to_jsonb(c) from public.plan_chats c where id = v_chat);
  end if;
  if (select string_agg(ordinal || ':' || role || ':' || kind || ':' || source || ':' || text || ':' || coalesce((payload = qa.proposal_json())::text, '-'), ',' order by ordinal)
      from public.plan_chat_messages where chat_id = v_chat)
     <> '1:learner:text:learner:synthetic goal:-,2:assistant:proposal:rules:synthetic proposal:true' then
    raise exception 'the learner text and the proposal message differ: %',
      (select jsonb_agg(to_jsonb(m) - 'id' - 'created_at' order by ordinal) from public.plan_chat_messages m where chat_id = v_chat);
  end if;
  perform qa.as_owner();

  -- C: the learner's text followed by a fixed refusal and then a rules proposal (Plan-conversation §2.9 item 5): ordinals 1, 2, 3
  perform qa.as_user(qa.id(903));
  select o.chat_id into v_chat from public.app_plan_chat_open('en', 'synthetic goal', jsonb_build_array(
    jsonb_build_object('kind', 'refusal', 'text', 'synthetic fixed refusal', 'source', 'fixed'),
    jsonb_build_object('kind', 'proposal', 'text', 'synthetic proposal', 'source', 'rules', 'payload', qa.proposal_json())), null, qa.proposal_json()) o;
  if (select string_agg(ordinal || ':' || role || ':' || kind || ':' || source, ',' order by ordinal)
      from public.plan_chat_messages where chat_id = v_chat)
     <> '1:learner:text:learner,2:assistant:refusal:fixed,3:assistant:proposal:rules' then
    raise exception 'the message order differs for a refusal followed by a proposal';
  end if;
  if (select (status, proposal_version, model_turns)::text from public.plan_chats where id = v_chat) <> '(open,1,0)' then
    raise exception 'the counters after a refusal plus proposal differ';
  end if;
  perform qa.as_owner();

  -- D: an array with a single message is the same as the object form (assistant ordinal 1 when no learner text is given)
  perform qa.as_user(qa.id(904));
  select o.chat_id into v_chat from public.app_plan_chat_open('ar', null, '[{"kind":"redirect","text":"synthetic fixed redirect","source":"fixed"}]') o;
  if (select string_agg(ordinal || ':' || role || ':' || kind || ':' || source, ',' order by ordinal)
      from public.plan_chat_messages where chat_id = v_chat) <> '1:assistant:redirect:fixed' then
    raise exception 'a one-element array differs from the object form';
  end if;
  perform qa.as_owner();

  -- nothing else was created, and each chat belongs to its caller only
  if (select count(*) from public.plan_chats) <> 4 or (select count(*) from public.plan_chat_messages) <> 1 + 2 + 3 + 1
     or exists (select 1 from public.plan_chat_messages m join public.plan_chats c on c.id = m.chat_id where m.user_id <> c.user_id)
     or (select count(*) from public.master_plans) <> 0 then
    raise exception 'unexpected rows after the four first opens';
  end if;
end $$;
rollback;

-- CHECK: 12 app_plan_chat_open, replacement: a new open abandons the caller's previous open chat (only that one), reports its id and keeps its messages; confirmed chats and other accounts are not touched
begin;
select qa.make_fixture();
select qa.make_users();
do $$
declare
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; cb uuid;
  v_repl uuid;
  v_closed timestamptz;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c1
  from public.app_plan_chat_open('ar', 'goal one', '{"kind":"proposal","text":"p1","source":"rules"}', null, qa.proposal_json()) o;
  perform public.app_plan_chat_append(c1, '[{"role":"learner","kind":"text","text":"more","source":"learner"}]', null, 1);
  perform qa.as_owner();

  -- B has its own open chat
  perform qa.as_user(qa.id(902));
  select o.chat_id into cb from public.app_plan_chat_open('en', null, '{"kind":"text","text":"rb","source":"rules"}') o;

  -- A opens a second chat: the first is abandoned and reported, with its content kept
  perform qa.as_user(qa.id(901));
  select o.chat_id, o.replaced_chat_id into c2, v_repl
  from public.app_plan_chat_open('en', null, '{"kind":"text","text":"r2","source":"rules"}') o;
  if v_repl is distinct from c1 or c2 = c1 then
    raise exception 'the second open must report the first chat as replaced';
  end if;
  perform qa.as_owner();
  if (select (status, closed_at is not null, proposal_version, model_turns, language)::text from public.plan_chats where id = c1) <> '(abandoned,t,1,1,ar)'
     or (select count(*) from public.plan_chat_messages where chat_id = c1) <> 3 then
    raise exception 'the replaced chat lost content or counters';
  end if;
  if (select (status, closed_at is null)::text from public.plan_chats where id = c2) <> '(open,t)' then
    raise exception 'the new chat is not open';
  end if;
  if (select (status, closed_at is null, model_turns)::text from public.plan_chats where id = cb) <> '(open,t,0)' then
    raise exception 'another account''s open chat was touched';
  end if;

  -- a third open replaces the second, not the first again
  perform qa.as_user(qa.id(901));
  select o.chat_id, o.replaced_chat_id into c3, v_repl
  from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"r3","source":"rules"}', null, qa.proposal_json()) o;
  if v_repl is distinct from c2 then raise exception 'the third open must report the second chat'; end if;
  perform qa.as_owner();
  if (select count(*) from public.plan_chats where user_id = qa.id(901) and status = 'open') <> 1
     or (select count(*) from public.plan_chats where user_id = qa.id(901) and status = 'abandoned') <> 2
     or (select count(*) from public.plan_chats where user_id = qa.id(902) and status = 'open') <> 1 then
    raise exception 'each account must hold exactly one open chat';
  end if;

  -- a confirmed chat is not replaced: the next open reports nothing and leaves it as it was
  perform qa.as_user(qa.id(901));
  perform public.app_plan_chat_confirm(c3, 1, qa.plan_args_json());
  perform qa.as_owner();
  v_closed := (select closed_at from public.plan_chats where id = c3);
  perform qa.as_user(qa.id(901));
  select o.chat_id, o.replaced_chat_id into c4, v_repl
  from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"r4","source":"rules"}') o;
  if v_repl is not null then raise exception 'a confirmed chat was reported as replaced'; end if;
  perform qa.as_owner();
  if (select (status, closed_at = v_closed)::text from public.plan_chats where id = c3) <> '(confirmed,t)'
     or (select status from public.plan_chats where id = c4) <> 'open' then
    raise exception 'the confirmed chat changed or the fourth chat is not open';
  end if;
  if (select count(*) from public.plan_chats where user_id = qa.id(901)) <> 4 then
    raise exception 'the chats of A are not the four that were opened';
  end if;
end $$;
rollback;

-- CHECK: 13 app_plan_chat_open, revision conversations: the account's active or paused plan is accepted and left as it is; another account's plan and an unknown plan are refused with 23503 and the previous chat stays open
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
select qa.make_plan(qa.id(1002), qa.id(901), 'paused');
select qa.make_plan(qa.id(1003), qa.id(902), 'active');
do $$
declare
  c1 uuid; c2 uuid; c3 uuid; cb uuid;
  v_repl uuid;
  v_plans text := (select string_agg(id || ':' || status || ':' || current_version, ',' order by id) from public.master_plans);
begin
  perform qa.as_user(qa.id(901));
  -- the account's active plan
  select o.chat_id into c1 from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"proposal","text":"p","source":"rules"}', qa.id(1001), qa.proposal_json()) o;
  if (select (plan_id = qa.id(1001), status, proposal_version, model_turns, language)::text from public.plan_chats where id = c1) <> '(t,open,1,0,ar)' then
    raise exception 'the revision chat of the active plan differs';
  end if;
  -- the account's paused plan: the previous conversation is replaced as usual
  select o.chat_id, o.replaced_chat_id into c2, v_repl from public.app_plan_chat_open('en', null, '{"kind":"proposal","text":"p","source":"rules"}', qa.id(1002), qa.proposal_json()) o;
  if v_repl is distinct from c1 or (select plan_id from public.plan_chats where id = c2) <> qa.id(1002) then
    raise exception 'the revision chat of the paused plan differs';
  end if;

  -- another account's plan and an unknown plan: refused on the composite key, nothing is abandoned
  perform qa.expect_fk(format($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"r","source":"rules"}', %L)$q$, qa.id(1003)),
                       'plan_chats_plan_id_user_id_fkey');
  perform qa.expect_fk(format($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"r","source":"rules"}', %L)$q$, qa.id(9999)),
                       'plan_chats_plan_id_user_id_fkey');
  perform qa.as_owner();
  if (select (status, closed_at is null)::text from public.plan_chats where id = c2) <> '(open,t)'
     or (select count(*) from public.plan_chats where user_id = qa.id(901)) <> 2
     or (select count(*) from public.plan_chat_messages where user_id = qa.id(901)) <> 3 then
    raise exception 'a refused revision open changed the account''s chats';
  end if;

  -- a creation conversation afterwards: no plan, and it replaces the revision chat
  perform qa.as_user(qa.id(901));
  select o.chat_id, o.replaced_chat_id into c3, v_repl from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"r","source":"rules"}') o;
  if v_repl is distinct from c2 or (select plan_id from public.plan_chats where id = c3) is not null then
    raise exception 'the creation chat differs';
  end if;

  -- B cannot attach A's plan to its own conversation; its own plan works and A's conversations are untouched
  perform qa.as_user(qa.id(902));
  select o.chat_id into cb from public.app_plan_chat_open('en', null, '{"kind":"text","text":"rb","source":"rules"}') o;
  perform qa.expect_fk(format($q$select * from public.app_plan_chat_open('en', null, '{"kind":"text","text":"r","source":"rules"}', %L)$q$, qa.id(1001)),
                       'plan_chats_plan_id_user_id_fkey');
  perform qa.expect_fk(format($q$select * from public.app_plan_chat_open('en', null, '{"kind":"text","text":"r","source":"rules"}', %L)$q$, qa.id(1002)),
                       'plan_chats_plan_id_user_id_fkey');
  if (select status from public.plan_chats where id = cb) <> 'open' then
    raise exception 'B''s open chat did not survive its refused revision opens';
  end if;
  select o.chat_id into c1 from public.app_plan_chat_open('en', null, '{"kind":"text","text":"rb2","source":"rules"}', qa.id(1003)) o;
  perform qa.as_owner();
  if (select plan_id from public.plan_chats where id = c1) <> qa.id(1003)
     or (select status from public.plan_chats where id = c3) <> 'open' then
    raise exception 'B''s revision chat or A''s open chat differs';
  end if;

  -- opening conversations never changes a plan
  if (select string_agg(id || ':' || status || ':' || current_version, ',' order by id) from public.master_plans) is distinct from v_plans then
    raise exception 'a plan changed while conversations were opened';
  end if;
end $$;
rollback;

-- CHECK: 14 app_plan_chat_open, invalid input: unusable message lists (22023), messages without required fields (23502), values outside the sets or too long (23514), a proposal that is not an object, a bad language; nothing persists and the previous chat stays open
begin;
select qa.make_fixture();
select qa.make_users();
do $$
declare
  c0 uuid;
  v_len integer;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c0 from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"text","text":"first","source":"rules"}') o;

  -- the assistant messages must be one object or a non-empty array of objects
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, null)$q$, '22023', 'p_first_assistant is NULL');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, 'null')$q$, '22023', 'p_first_assistant is JSON null');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '"x"')$q$, '22023', 'p_first_assistant is a string');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '5')$q$, '22023', 'p_first_assistant is a number');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, 'true')$q$, '22023', 'p_first_assistant is a boolean');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '[]')$q$, '22023', 'p_first_assistant is an empty array');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '["x"]')$q$, '22023', 'an element is a string (refused by PostgreSQL''s own jsonb check)');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '[null]')$q$, '22023', 'an element is JSON null');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '[[]]')$q$, '22023', 'an element is an array');

  -- a message object needs kind, text and source
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '{}')$q$, '23502', 'an empty message object');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '{"text":"a","source":"rules"}')$q$, '23502', 'no kind');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","source":"rules"}')$q$, '23502', 'no text');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":null,"source":"rules"}')$q$, '23502', 'text is JSON null');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"a"}')$q$, '23502', 'no source');
  perform qa.expect_error($q$select * from public.app_plan_chat_open('ar', null, '[{"kind":"text","text":"a","source":"rules"},{"kind":"text","text":"b"}]')$q$, '23502', 'the second message has no source');

  -- value sets and the text limit (the learner's text and each assistant message)
  perform qa.expect_check($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"bogus","text":"a","source":"rules"}')$q$, 'plan_chat_messages_kind_check');
  perform qa.expect_check($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"a","source":"bogus"}')$q$, 'plan_chat_messages_source_check');
  perform qa.expect_check($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"Text","text":"a","source":"rules"}')$q$, 'plan_chat_messages_kind_check');
  perform qa.expect_check(format($q$select * from public.app_plan_chat_open('ar', null, %L::jsonb)$q$,
                                 jsonb_build_object('kind', 'text', 'text', repeat('x', 2001), 'source', 'rules')::text), 'plan_chat_messages_text_check');
  perform qa.expect_check(format($q$select * from public.app_plan_chat_open('ar', %L, '{"kind":"text","text":"a","source":"rules"}')$q$, repeat('x', 2001)),
                          'plan_chat_messages_text_check');
  perform qa.expect_check(format($q$select * from public.app_plan_chat_open('ar', %L, '{"kind":"text","text":"a","source":"rules"}')$q$, repeat(chr(233), 2001)),
                          'plan_chat_messages_text_check');

  -- the language and the proposal
  perform qa.expect_check($q$select * from public.app_plan_chat_open('fr', null, '{"kind":"text","text":"a","source":"rules"}')$q$, 'plan_chats_language_check');
  perform qa.expect_check($q$select * from public.app_plan_chat_open('AR', null, '{"kind":"text","text":"a","source":"rules"}')$q$, 'plan_chats_language_check');
  perform qa.expect_check($q$select * from public.app_plan_chat_open('', null, '{"kind":"text","text":"a","source":"rules"}')$q$, 'plan_chats_language_check');
  perform qa.expect_error($q$select * from public.app_plan_chat_open(null, null, '{"kind":"text","text":"a","source":"rules"}')$q$, '23502', 'language is NULL');
  perform qa.expect_check($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"a","source":"rules"}', null, '[]')$q$, 'plan_chats_proposal_check');
  perform qa.expect_check($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"a","source":"rules"}', null, '"x"')$q$, 'plan_chats_proposal_check');
  perform qa.expect_check($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"a","source":"rules"}', null, 'null')$q$, 'plan_chats_proposal_check');

  -- every refusal rolled back the whole call: the previous chat was not abandoned and nothing new exists
  perform qa.as_owner();
  if (select count(*) from public.plan_chats) <> 1 or (select count(*) from public.plan_chat_messages) <> 2
     or (select (status, closed_at is null, proposal is null, proposal_version, model_turns)::text from public.plan_chats where id = c0) <> '(open,t,t,0,0)' then
    raise exception 'a refused open left changes behind: % chats, % messages', (select count(*) from public.plan_chats), (select count(*) from public.plan_chat_messages);
  end if;

  -- the same inputs that are fine: the limits themselves are accepted (2000 characters), and the previous chat is then replaced
  perform qa.as_user(qa.id(901));
  select o.chat_id into c0 from public.app_plan_chat_open('en', repeat('x', 2000), jsonb_build_object('kind', 'text', 'text', repeat(chr(233), 2000), 'source', 'model')) o;
  perform qa.as_owner();
  select max(char_length(text)) into v_len from public.plan_chat_messages where chat_id = c0;
  if v_len <> 2000 or (select count(*) from public.plan_chats where status = 'abandoned') <> 1 then
    raise exception 'the 2000-character limits were not accepted or the previous chat was not replaced';
  end if;
end $$;
rollback;

-- CHECK: 15 app_plan_chat_append, messages: ordinals continue in array order across calls and restart in each chat; every role, kind and source is accepted; payloads are stored as given; without a proposal or increment the counters stay and the stored version is returned
begin;
select qa.make_fixture();
select qa.make_users();
do $$
declare
  c1 uuid; c2 uuid;
  v  integer;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c1
  from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"proposal","text":"p1","source":"rules"}', null, qa.proposal_json()) o;

  -- two messages in one call take the next two ordinals in array order (3 and 4); the learner's turn is a quick reply with its code in the payload
  v := public.app_plan_chat_append(c1, jsonb_build_array(
         jsonb_build_object('role', 'learner', 'kind', 'quick_reply', 'text', 'synthetic quick reply', 'source', 'learner', 'payload', jsonb_build_object('code', 'more_minutes')),
         jsonb_build_object('role', 'assistant', 'kind', 'text', 'text', 'synthetic answer', 'source', 'rules')));
  if v <> 1 then raise exception 'append without a proposal returned version %, expected the stored version 1', v; end if;
  -- a single message is the next ordinal
  perform public.app_plan_chat_append(c1, '[{"role":"learner","kind":"text","text":"third turn","source":"learner"}]');
  -- every value of the three sets, in one call
  perform public.app_plan_chat_append(c1, jsonb_build_array(
    jsonb_build_object('role', 'assistant', 'kind', 'text',        'text', 't', 'source', 'learner'),
    jsonb_build_object('role', 'assistant', 'kind', 'proposal',    'text', 't', 'source', 'rules',   'payload', qa.proposal_json()),
    jsonb_build_object('role', 'assistant', 'kind', 'refusal',     'text', 't', 'source', 'model'),
    jsonb_build_object('role', 'assistant', 'kind', 'redirect',    'text', 't', 'source', 'fixed'),
    jsonb_build_object('role', 'assistant', 'kind', 'fallback',    'text', 't', 'source', 'rules'),
    jsonb_build_object('role', 'learner',   'kind', 'quick_reply', 'text', 't', 'source', 'learner', 'payload', jsonb_build_object('code', 'confirm'))));
  -- the text limit is 2000 characters (counted as characters, not bytes), also here
  perform public.app_plan_chat_append(c1, jsonb_build_array(jsonb_build_object('role', 'assistant', 'kind', 'text', 'text', repeat(chr(233), 2000), 'source', 'model')));
  -- an empty list adds nothing
  perform public.app_plan_chat_append(c1, '[]');

  perform qa.as_owner();
  if (select string_agg(ordinal || ':' || role || ':' || kind || ':' || source, ',' order by ordinal) from public.plan_chat_messages where chat_id = c1)
     <> '1:learner:text:learner,2:assistant:proposal:rules,3:learner:quick_reply:learner,4:assistant:text:rules,5:learner:text:learner,'
        '6:assistant:text:learner,7:assistant:proposal:rules,8:assistant:refusal:model,9:assistant:redirect:fixed,10:assistant:fallback:rules,11:learner:quick_reply:learner,'
        '12:assistant:text:model' then
    raise exception 'the message order or values differ: %', (select string_agg(ordinal || ':' || role || ':' || kind || ':' || source, ',' order by ordinal) from public.plan_chat_messages where chat_id = c1);
  end if;
  if (select (min(ordinal), max(ordinal), count(*), count(distinct ordinal))::text from public.plan_chat_messages where chat_id = c1) <> '(1,12,12,12)'
     or (select char_length(text) from public.plan_chat_messages where chat_id = c1 and ordinal = 12) <> 2000 then
    raise exception 'the ordinals are not 1..12 without gaps or the 2000-character text was cut';
  end if;
  -- payloads are kept as given (and stay null when none is given)
  if (select payload ->> 'code' from public.plan_chat_messages where chat_id = c1 and ordinal = 3) <> 'more_minutes'
     or (select payload from public.plan_chat_messages where chat_id = c1 and ordinal = 7) is distinct from qa.proposal_json()
     or (select payload from public.plan_chat_messages where chat_id = c1 and ordinal = 4) is not null then
    raise exception 'the payloads were not stored as given';
  end if;
  if (select (user_id = qa.id(901), created_at is not null)::text from public.plan_chat_messages where chat_id = c1 and ordinal = 11) <> '(t,t)' then
    raise exception 'a message has the wrong owner or no creation time';
  end if;
  -- the counters and the proposal did not move
  if (select (proposal = qa.proposal_json(), proposal_version, model_turns)::text from public.plan_chats where id = c1) <> '(t,1,0)' then
    raise exception 'appending messages alone changed the counters or the proposal';
  end if;

  -- a new chat of the account starts again at 1; appending to it continues from there, and the old chat gets nothing
  perform qa.as_user(qa.id(901));
  select o.chat_id into c2 from public.app_plan_chat_open('en', null, '{"kind":"text","text":"second chat","source":"rules"}') o;
  perform public.app_plan_chat_append(c2, '[{"role":"learner","kind":"text","text":"a","source":"learner"},{"role":"assistant","kind":"text","text":"b","source":"rules"}]');
  perform qa.as_owner();
  if (select string_agg(ordinal::text, ',' order by ordinal) from public.plan_chat_messages where chat_id = c2) <> '1,2,3'
     or (select count(*) from public.plan_chat_messages where chat_id = c1) <> 12 then
    raise exception 'ordinals of a second chat are not independent';
  end if;

  -- another account's chat numbers its own messages from 1
  perform qa.as_user(qa.id(902));
  select o.chat_id into c1 from public.app_plan_chat_open('en', null, '{"kind":"text","text":"rb","source":"rules"}') o;
  perform public.app_plan_chat_append(c1, '[{"role":"learner","kind":"text","text":"a","source":"learner"}]');
  perform qa.as_owner();
  if (select string_agg(ordinal::text, ',' order by ordinal) from public.plan_chat_messages where chat_id = c1) <> '1,2'
     or (select count(*) from public.plan_chat_messages where chat_id = c2) <> 3 then
    raise exception 'an append of B reached A''s chat or was numbered wrongly';
  end if;
end $$;
rollback;

-- CHECK: 16 app_plan_chat_append, proposal and counters: a given proposal replaces the stored one and raises proposal_version by one per call (returned); model_turns grows by the increment; message kinds and sources alone move nothing
begin;
select qa.make_fixture();
select qa.make_users();
do $$
declare
  c uuid;
  v integer;
  v_p2 jsonb := qa.proposal_json(2, 15);
  v_p3 jsonb := qa.proposal_json(3, 5);
  v_p4 jsonb := qa.proposal_json(4, 10);
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c
  from public.app_plan_chat_open('en', 'synthetic goal', '{"kind":"proposal","text":"p1","source":"rules"}', null, qa.proposal_json(1, 10)) o;
  if (select (proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(1,0)' then raise exception 'start state differs'; end if;

  -- 1. a quick reply that changes the parameters: rules proposal, no model call
  v := public.app_plan_chat_append(c, jsonb_build_array(
         jsonb_build_object('role', 'learner', 'kind', 'quick_reply', 'text', 't', 'source', 'learner', 'payload', jsonb_build_object('code', 'more_minutes')),
         jsonb_build_object('role', 'assistant', 'kind', 'proposal', 'text', 't', 'source', 'rules', 'payload', v_p2)), v_p2);
  if v <> 2 then raise exception 'step 1 returned %', v; end if;
  if (select (proposal = v_p2, proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(t,2,0)' then raise exception 'step 1: state differs'; end if;

  -- 2. free text answered by the model, parameters unchanged: one model turn, no new proposal
  v := public.app_plan_chat_append(c, '[{"role":"learner","kind":"text","text":"t","source":"learner"},{"role":"assistant","kind":"text","text":"t","source":"model"}]', null, 1);
  if v <> 2 then raise exception 'step 2 returned %', v; end if;
  if (select (proposal = v_p2, proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(t,2,1)' then raise exception 'step 2: state differs'; end if;

  -- 3. free text answered by the model with changed parameters: a new proposal and one more model turn
  v := public.app_plan_chat_append(c, jsonb_build_array(
         jsonb_build_object('role', 'learner', 'kind', 'text', 'text', 't', 'source', 'learner'),
         jsonb_build_object('role', 'assistant', 'kind', 'proposal', 'text', 't', 'source', 'model', 'payload', v_p3)), v_p3, 1);
  if v <> 3 then raise exception 'step 3 returned %', v; end if;
  if (select (proposal = v_p3, proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(t,3,2)' then raise exception 'step 3: state differs'; end if;

  -- 4. a refusal, 5. the fallback after a cap, 6. a redirect: replies that change nothing
  v := public.app_plan_chat_append(c, '[{"role":"learner","kind":"text","text":"t","source":"learner"},{"role":"assistant","kind":"refusal","text":"t","source":"fixed"}]');
  if v <> 3 then raise exception 'step 4 returned %', v; end if;
  v := public.app_plan_chat_append(c, '[{"role":"learner","kind":"text","text":"t","source":"learner"},{"role":"assistant","kind":"fallback","text":"t","source":"rules"}]');
  if v <> 3 then raise exception 'step 5 returned %', v; end if;
  v := public.app_plan_chat_append(c, '[{"role":"learner","kind":"text","text":"t","source":"learner"},{"role":"assistant","kind":"redirect","text":"t","source":"fixed"}]');
  if v <> 3 then raise exception 'step 6 returned %', v; end if;
  if (select (proposal = v_p3, proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(t,3,2)' then raise exception 'steps 4-6: state differs'; end if;

  -- 7. the counters follow the arguments only: a proposal-kind message without a proposal and a model-sourced message without an increment move nothing
  v := public.app_plan_chat_append(c, jsonb_build_array(
         jsonb_build_object('role', 'assistant', 'kind', 'proposal', 'text', 't', 'source', 'model', 'payload', v_p4)));
  if v <> 3 or (select (proposal = v_p3, proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(t,3,2)' then
    raise exception 'step 7: a message kind or source moved a counter';
  end if;

  -- 8. an increment without messages (the model call that interpreted the first goal text) and 9. a proposal without messages
  v := public.app_plan_chat_append(c, '[]', null, 1);
  if v <> 3 or (select (proposal = v_p3, proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(t,3,3)' then
    raise exception 'step 8: an increment alone differs';
  end if;
  v := public.app_plan_chat_append(c, '[]', v_p4);
  if v <> 4 or (select (proposal = v_p4, proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(t,4,3)' then
    raise exception 'step 9: a proposal alone differs';
  end if;

  -- 10. a NULL increment counts as 0; an increment of 3 and a proposal in one call move both counters
  v := public.app_plan_chat_append(c, '[]', null, null);
  if v <> 4 or (select (proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(4,3)' then
    raise exception 'step 10: a NULL increment moved a counter';
  end if;
  v := public.app_plan_chat_append(c, '[]', v_p2, 3);
  if v <> 5 or (select (proposal = v_p2, proposal_version, model_turns)::text from public.plan_chats where id = c) <> '(t,5,6)' then
    raise exception 'step 11: a proposal with an increment of 3 differs';
  end if;

  perform qa.as_owner();
  -- the whole conversation: contiguous ordinals and every kind and source appeared
  if (select (min(ordinal), max(ordinal), count(*))::text from public.plan_chat_messages where chat_id = c) <> '(1,15,15)'
     or (select count(distinct kind) from public.plan_chat_messages where chat_id = c) <> 6
     or (select count(distinct source) from public.plan_chat_messages where chat_id = c) <> 4 then
    raise exception 'the message list of the conversation differs';
  end if;
end $$;
rollback;

-- CHECK: 17 app_plan_chat_append, refusals: a confirmed or abandoned chat is QT003, an unknown or foreign chat P0002, unusable lists or a negative increment 22023, bad messages 23502 or 23514, a bad proposal 23514; each leaves the chat as it was
begin;
select qa.make_fixture();
select qa.make_users();
do $$
declare
  c_conf uuid; c_aband uuid; c_open uuid;
  v_state text;
  v_p jsonb := qa.proposal_json(2, 15);
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c_conf from public.app_plan_chat_open('ar', null, '{"kind":"proposal","text":"p","source":"rules"}', null, qa.proposal_json()) o;
  perform public.app_plan_chat_confirm(c_conf, 1, qa.plan_args_json());
  select o.chat_id into c_aband from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"r","source":"rules"}', null, qa.proposal_json()) o;
  select o.chat_id into c_open from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"proposal","text":"p","source":"rules"}', null, qa.proposal_json()) o;
  perform public.app_plan_chat_append(c_open, '[{"role":"learner","kind":"text","text":"more","source":"learner"}]', null, 1);
  perform qa.as_owner();
  v_state := (select string_agg(c.id::text || ':' || c.status || ':' || c.proposal_version || ':' || c.model_turns || ':' ||
                                (select count(*) from public.plan_chat_messages m where m.chat_id = c.id), ',' order by c.id)
              from public.plan_chats c);
  if (select status from public.plan_chats where id = c_aband) <> 'abandoned' then raise exception 'setup: c_aband is not abandoned'; end if;

  perform qa.as_user(qa.id(901));
  -- a chat that is not open: QT003 (the conversation is closed)
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"x","source":"learner"}]')$q$, c_conf), 'QT003', 'append to a confirmed chat');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"x","source":"learner"}]')$q$, c_aband), 'QT003', 'append to an abandoned (replaced) chat');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[]', %L::jsonb, 1)$q$, c_conf, v_p), 'QT003', 'a proposal for a confirmed chat');
  -- unknown chats and NULL
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[]')$q$, qa.id(9999)), 'P0002', 'unknown chat');
  perform qa.expect_error($q$select public.app_plan_chat_append(null, '[]')$q$, 'P0002', 'NULL chat');

  -- unusable message lists and a negative increment (valid messages do not rescue them)
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, null)$q$, c_open), '22023', 'NULL list');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, 'null')$q$, c_open), '22023', 'JSON null list');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '{"role":"learner","kind":"text","text":"x","source":"learner"}')$q$, c_open), '22023', 'a single object instead of an array');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '"x"')$q$, c_open), '22023', 'a string list');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '["x"]')$q$, c_open), '22023', 'a scalar element');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"x","source":"learner"}]', null, -1)$q$, c_open), '22023', 'a negative increment');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[]', %L::jsonb, -5)$q$, c_open, v_p), '22023', 'a negative increment with a proposal');

  -- messages: required fields and the value sets
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{}]')$q$, c_open), '23502', 'an empty message');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{"kind":"text","text":"x","source":"learner"}]')$q$, c_open), '23502', 'no role');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","text":"x","source":"learner"}]')$q$, c_open), '23502', 'no kind');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","source":"learner"}]')$q$, c_open), '23502', 'no text');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"x"}]')$q$, c_open), '23502', 'no source');
  perform qa.expect_check(format($q$select public.app_plan_chat_append(%L, '[{"role":"system","kind":"text","text":"x","source":"learner"}]')$q$, c_open), 'plan_chat_messages_role_check');
  perform qa.expect_check(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"bogus","text":"x","source":"learner"}]')$q$, c_open), 'plan_chat_messages_kind_check');
  perform qa.expect_check(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"x","source":"bogus"}]')$q$, c_open), 'plan_chat_messages_source_check');
  perform qa.expect_check(format($q$select public.app_plan_chat_append(%L, %L::jsonb)$q$, c_open,
                                 jsonb_build_array(jsonb_build_object('role', 'learner', 'kind', 'text', 'text', repeat('x', 2001), 'source', 'learner'))::text),
                          'plan_chat_messages_text_check');
  -- one bad message among good ones, with a proposal and an increment: nothing at all is applied
  perform qa.expect_check(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"ok","source":"learner"},{"role":"assistant","kind":"bogus","text":"x","source":"rules"}]', %L::jsonb, 2)$q$, c_open, v_p),
                          'plan_chat_messages_kind_check');
  -- a proposal that is not an object: the message insert that came first is rolled back too
  perform qa.expect_check(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"ok","source":"learner"}]', '[]', 1)$q$, c_open), 'plan_chats_proposal_check');
  perform qa.expect_check(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"ok","source":"learner"}]', 'null', 1)$q$, c_open), 'plan_chats_proposal_check');
  perform qa.expect_check(format($q$select public.app_plan_chat_append(%L, '[]', '"x"')$q$, c_open), 'plan_chats_proposal_check');

  -- another account sees nothing: its chats are unknown to it, whatever their state
  perform qa.as_owner();
  perform qa.as_user(qa.id(902));
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"x","source":"learner"}]')$q$, c_open), 'P0002', 'B appends to A''s open chat');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[]')$q$, c_conf), 'P0002', 'B appends to A''s confirmed chat (not QT003: the chat is not revealed)');
  perform qa.expect_error(format($q$select public.app_plan_chat_append(%L, '[]')$q$, c_aband), 'P0002', 'B appends to A''s abandoned chat');
  perform qa.as_owner();

  -- every refusal left every chat exactly as it was
  if (select string_agg(c.id::text || ':' || c.status || ':' || c.proposal_version || ':' || c.model_turns || ':' ||
                        (select count(*) from public.plan_chat_messages m where m.chat_id = c.id), ',' order by c.id)
      from public.plan_chats c) is distinct from v_state then
    raise exception 'a refused append changed a chat';
  end if;
end $$;
rollback;

-- CHECK: 18 app_plan_chat_confirm, creation: the plan is built from the stored proposal and the plan arguments, the previous active plan pauses, the chat becomes confirmed with closed_at in the same transaction; a supplied plan id and prepared sessions pass through
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
select qa.make_plan(qa.id(1002), qa.id(901), 'paused');
select qa.make_plan(qa.id(1003), qa.id(902), 'active');
do $$
declare
  c1 uuid; c2 uuid;
  v_plan uuid;
  v_ver  uuid;
  v_prop jsonb := qa.proposal_json(1, 15) || jsonb_build_object(
                    'order', 'reverse', 'preferredDate', '2026-11-01',
                    'targetScope', jsonb_build_object('sectionOrdinals', jsonb_build_array(1, 2)),
                    'estimate', jsonb_build_object('days', 9, 'sessionMinutes', 15));
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c1
  from public.app_plan_chat_open('en', 'synthetic goal', jsonb_build_object('kind', 'proposal', 'text', 'p', 'source', 'rules', 'payload', v_prop), null, v_prop) o;

  -- the plan arguments name the plan id and one prepared session (creation only)
  v_plan := public.app_plan_chat_confirm(c1, 1, qa.plan_args_json(jsonb_build_object(
              'plan_id', qa.id(1102),
              'sessions', jsonb_build_array(jsonb_build_object('id', qa.id(2201), 'kind', 'daily', 'phase_ordinal', 1, 'learning_date', '2026-10-07',
                'lesson_refs', jsonb_build_array(qa.id(11)), 'question_refs', jsonb_build_array(qa.id(12)), 'steps', '[]'::jsonb, 'bank_version', 1)))));
  if v_plan <> qa.id(1102) then raise exception 'confirm returned %, not the supplied plan id', v_plan; end if;
  set constraints all immediate;
  set constraints all deferred;
  perform qa.as_owner();

  -- the plan: values of the stored proposal (scope, paths, order, minutes, preferred date, estimate as agreed_estimate), version 1, active
  if (select (status, current_version, edition_id = qa.id(5), paths::text, plan_order, session_minutes, preferred_date::text, agreed_estimate ->> 'days', target_scope::text)::text
      from public.master_plans where id = v_plan)
     <> '(active,1,t,{quran},reverse,15,2026-11-01,9,"{""sectionOrdinals"": [1, 2]}")' then
    raise exception 'the plan row differs: %', (select to_jsonb(m) from public.master_plans m where id = v_plan);
  end if;
  if (select agreed_estimate from public.master_plans where id = v_plan) is distinct from v_prop -> 'estimate' then
    raise exception 'agreed_estimate is not the estimate of the confirmed proposal';
  end if;
  -- version 1 with the reason, policy and day of the plan arguments, and its phase
  v_ver := (select id from public.plan_versions where plan_id = v_plan);
  if (select count(*) from public.plan_versions where plan_id = v_plan) <> 1
     or (select (version_no, reason_code, effective_learning_date, policy_json ->> 'planner')::text from public.plan_versions where id = v_ver) <> '(1,plan_chat,2026-10-05,rules)' then
    raise exception 'plan_versions row 1 differs';
  end if;
  if (select (ordinal, goal_size, estimated_window::text, user_id = qa.id(901))::text from public.plan_phases where plan_version_id = v_ver) <> '(1,10,"[2026-10-05,2026-10-12)",t)' then
    raise exception 'plan_phases row differs';
  end if;
  -- the prepared session
  if (select (s.status, s.kind, s.plan_id = v_plan, s.plan_version_id = v_ver, s.edition_id = qa.id(5), s.learning_date::text, s.user_id = qa.id(901))::text
      from public.learning_sessions s where s.id = qa.id(2201)) <> '(prepared,daily,t,t,t,2026-10-07,t)'
     or (select count(*) from public.learning_sessions) <> 1 then
    raise exception 'the prepared session differs';
  end if;
  -- the previous active plan paused, the paused one stayed, exactly one active plan; another account's plan untouched
  if (select string_agg(id || ':' || status, ',' order by id) from public.master_plans where user_id = qa.id(901))
     <> qa.id(1001) || ':paused,' || qa.id(1002) || ':paused,' || qa.id(1102) || ':active'
     or (select status from public.master_plans where id = qa.id(1003)) <> 'active' then
    raise exception 'the plans were not paused and activated as required';
  end if;
  -- the chat: confirmed and closed, proposal, counters and messages as they were, no plan linked (plan_id is for revisions)
  if (select (status, closed_at is not null, plan_id is null, proposal = v_prop, proposal_version, model_turns, language)::text from public.plan_chats where id = c1)
     <> '(confirmed,t,t,t,1,0,en)'
     or (select count(*) from public.plan_chat_messages where chat_id = c1) <> 2 then
    raise exception 'the confirmed chat differs: %', (select to_jsonb(c) from public.plan_chats c where id = c1);
  end if;

  -- a second conversation with the defaults: no plan id, no policy, no sessions; the plan id is generated and the policy is {}
  perform qa.as_user(qa.id(901));
  select o.chat_id into c2 from public.app_plan_chat_open('ar', null, '{"kind":"proposal","text":"p","source":"rules"}', null, qa.proposal_json(1, 5)) o;
  v_plan := public.app_plan_chat_confirm(c2, 1, jsonb_build_object('reason_code', 'plan_chat', 'effective_learning_date', '2026-10-06', 'phases', qa.phases_json()));
  set constraints all immediate;
  set constraints all deferred;
  perform qa.as_owner();
  if v_plan is null or v_plan = qa.id(1102) then raise exception 'no new plan id was generated'; end if;
  if (select (status, session_minutes, preferred_date is null, plan_order, agreed_estimate::text)::text from public.master_plans where id = v_plan)
     <> '(active,5,t,book,"{""days"": 5, ""sessionMinutes"": 5}")'
     or (select (reason_code, policy_json::text, effective_learning_date)::text from public.plan_versions where plan_id = v_plan) <> '(plan_chat,{},2026-10-06)'
     or (select count(*) from public.learning_sessions where plan_id = v_plan) <> 0
     or (select status from public.master_plans where id = qa.id(1102)) <> 'paused'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1 then
    raise exception 'the second creation differs';
  end if;
  if (select (status, plan_id is null)::text from public.plan_chats where id = c2) <> '(confirmed,t)' then
    raise exception 'the second chat is not confirmed';
  end if;
end $$;
rollback;

-- CHECK: 19 app_plan_chat_confirm, proposal version: an older, a later or no version is QT002, a chat without a proposal is QT003, nothing is saved; the plan is built from the current proposal, not from the first one
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
do $$
declare
  c1 uuid; c2 uuid;
  v_plan uuid;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c1 from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"proposal","text":"p1","source":"rules"}', null, qa.proposal_json(1, 10)) o;
  -- the learner changes the minutes: proposal version 2 (15 minutes)
  if public.app_plan_chat_append(c1, '[{"role":"assistant","kind":"proposal","text":"p2","source":"rules"}]', qa.proposal_json(2, 15)) <> 2 then
    raise exception 'the second proposal did not get version 2';
  end if;

  -- confirming what the learner saw earlier (1), something newer than the chat knows (3, 99), version 0, or no version: QT002 each time
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c1), 'QT002', 'the first proposal after a second one exists');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 3, qa.plan_args_json())$q$, c1), 'QT002', 'a later version');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 99, qa.plan_args_json())$q$, c1), 'QT002', 'a far later version');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 0, qa.plan_args_json())$q$, c1), 'QT002', 'version 0');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, -1, qa.plan_args_json())$q$, c1), 'QT002', 'a negative version');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, null, qa.plan_args_json())$q$, c1), 'QT002', 'no version');
  perform qa.as_owner();
  if (select (status, closed_at is null, proposal_version, model_turns)::text from public.plan_chats where id = c1) <> '(open,t,2,0)'
     or (select count(*) from public.master_plans) <> 1
     or (select status from public.master_plans where id = qa.id(1001)) <> 'active'
     or (select count(*) from public.plan_versions) <> 1 then
    raise exception 'a refused confirmation changed the chat or the plans';
  end if;

  -- the current version saves exactly the current proposal (15 minutes, the estimate of version 2)
  perform qa.as_user(qa.id(901));
  v_plan := public.app_plan_chat_confirm(c1, 2, qa.plan_args_json());
  perform qa.as_owner();
  if (select (session_minutes, agreed_estimate ->> 'sessionMinutes', status)::text from public.master_plans where id = v_plan) <> '(15,15,active)'
     or (select status from public.master_plans where id = qa.id(1001)) <> 'paused'
     or (select status from public.plan_chats where id = c1) <> 'confirmed' then
    raise exception 'the plan does not reflect the current proposal';
  end if;

  -- a chat that has no proposal yet cannot be confirmed, whatever version is quoted (QT003, the migration's rule)
  perform qa.as_user(qa.id(901));
  select o.chat_id into c2 from public.app_plan_chat_open('en', 'synthetic goal', '{"kind":"text","text":"no proposal yet","source":"rules"}') o;
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 0, qa.plan_args_json())$q$, c2), 'QT003', 'no proposal, version 0');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c2), 'QT003', 'no proposal, version 1');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, null, qa.plan_args_json())$q$, c2), 'QT003', 'no proposal, no version');
  perform qa.as_owner();
  if (select (status, proposal is null, proposal_version)::text from public.plan_chats where id = c2) <> '(open,t,0)'
     or (select count(*) from public.master_plans) <> 2 then
    raise exception 'a refused confirmation of a chat without proposal changed something';
  end if;
  -- once the first proposal arrives it confirms: the version it was given is the one to quote
  perform qa.as_user(qa.id(901));
  if public.app_plan_chat_append(c2, '[{"role":"assistant","kind":"proposal","text":"p","source":"rules"}]', qa.proposal_json(1, 5)) <> 1 then
    raise exception 'the first proposal did not get version 1';
  end if;
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 0, qa.plan_args_json())$q$, c2), 'QT002', 'version 0 after the first proposal');
  v_plan := public.app_plan_chat_confirm(c2, 1, qa.plan_args_json());
  perform qa.as_owner();
  if (select (status, session_minutes)::text from public.master_plans where id = v_plan) <> '(active,5)'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1 then
    raise exception 'the late first proposal did not confirm';
  end if;
  set constraints all immediate;
  set constraints all deferred;
end $$;
rollback;

-- CHECK: 20 app_plan_chat_confirm, closed and foreign chats: a repeated confirm, a replaced chat (and a stale version on a closed chat) are QT003; a foreign or unknown chat is P0002; unusable plan arguments are 22023; none of them saves anything
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1003), qa.id(902), 'active');
do $$
declare
  c1 uuid; c2 uuid; c3 uuid;
  v_plan uuid;
  v_closed timestamptz;
  v_plans text;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c1 from public.app_plan_chat_open('ar', null, '{"kind":"proposal","text":"p","source":"rules"}', null, qa.proposal_json()) o;
  v_plan := public.app_plan_chat_confirm(c1, 1, qa.plan_args_json());
  perform qa.as_owner();
  v_closed := (select closed_at from public.plan_chats where id = c1);
  v_plans := (select string_agg(id || ':' || status || ':' || current_version, ',' order by id) from public.master_plans);

  -- a repeated confirm is refused (not idempotent, API-spec §4.10.3 item 4) and saves no second plan
  perform qa.as_user(qa.id(901));
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c1), 'QT003', 'a repeated confirm');
  -- the closed state is reported before a version problem
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 99, qa.plan_args_json())$q$, c1), 'QT003', 'a stale version on a confirmed chat');
  perform qa.as_owner();
  if (select count(*) from public.master_plans where user_id = qa.id(901)) <> 1
     or (select (status, closed_at = v_closed)::text from public.plan_chats where id = c1) <> '(confirmed,t)' then
    raise exception 'a repeated confirm changed the plan or the chat';
  end if;

  -- a chat replaced by a newer one cannot be confirmed any more
  perform qa.as_user(qa.id(901));
  select o.chat_id into c2 from public.app_plan_chat_open('en', null, '{"kind":"proposal","text":"p","source":"rules"}', null, qa.proposal_json()) o;
  select o.chat_id into c3 from public.app_plan_chat_open('en', null, '{"kind":"proposal","text":"p","source":"rules"}', null, qa.proposal_json()) o;
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c2), 'QT003', 'a replaced (abandoned) chat');

  -- unusable plan arguments
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, null)$q$, c3), '22023', 'NULL arguments');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, '[]')$q$, c3), '22023', 'arguments as an array');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, '"x"')$q$, c3), '22023', 'arguments as a string');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, '{"reason_code":"x"}')$q$, c3), '22023', 'arguments without phases');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, '{"phases":{}}')$q$, c3), '22023', 'phases as an object');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, '{"phases":null}')$q$, c3), '22023', 'phases as JSON null');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, '{"phases":"x"}')$q$, c3), '22023', 'phases as a string');

  -- unknown chats and NULL are not found
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, qa.id(9999)), 'P0002', 'an unknown chat');
  perform qa.expect_error($q$select public.app_plan_chat_confirm(null, 1, qa.plan_args_json())$q$, 'P0002', 'NULL chat');

  -- another account cannot confirm A's chats in any state: the answer is the same, so nothing is revealed
  perform qa.as_owner();
  perform qa.as_user(qa.id(902));
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c3), 'P0002', 'B confirms A''s open chat');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c1), 'P0002', 'B confirms A''s confirmed chat');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c2), 'P0002', 'B confirms A''s abandoned chat');
  perform qa.as_owner();

  -- nothing was saved by any of the refusals, and the open chat is untouched and still confirms
  if (select string_agg(id || ':' || status || ':' || current_version, ',' order by id) from public.master_plans) is distinct from v_plans
     or (select (status, closed_at is null, proposal_version)::text from public.plan_chats where id = c3) <> '(open,t,1)'
     or (select (status, closed_at is null)::text from public.plan_chats where id = c2) <> '(abandoned,f)' then
    raise exception 'a refused confirmation saved something or changed a chat';
  end if;
  perform qa.as_user(qa.id(901));
  v_plan := public.app_plan_chat_confirm(c3, 1, qa.plan_args_json());
  perform qa.as_owner();
  if (select status from public.plan_chats where id = c3) <> 'confirmed'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1
     or (select count(*) from public.master_plans where user_id = qa.id(901)) <> 2
     or (select status from public.master_plans where id = qa.id(1003)) <> 'active' then
    raise exception 'the open chat did not confirm normally after the refusals';
  end if;
  set constraints all immediate;
  set constraints all deferred;
end $$;
rollback;

-- CHECK: 21 app_plan_chat_confirm, revision: the plan moves to its next version with the proposal's values and the new phases, keeps its status and history, ignores the creation-only arguments; the chat is confirmed and keeps its plan link
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
select qa.make_plan(qa.id(1002), qa.id(901), 'paused');
select qa.make_plan(qa.id(1003), qa.id(902), 'active');
do $$
declare
  c1 uuid; c2 uuid; c3 uuid;
  v_ret  uuid;
  v_prop jsonb := qa.proposal_json(1, 15) || jsonb_build_object(
                    'order', 'reverse', 'preferredDate', '2026-11-01',
                    'targetScope', jsonb_build_object('sectionOrdinals', jsonb_build_array(1, 2)),
                    'estimate', jsonb_build_object('days', 9, 'sessionMinutes', 15));
  c_phases2 constant jsonb := '[{"ordinal":1,"section_refs":[1],"unit_range":{},"goal_size":10,"estimated_window":"[2026-10-06,2026-10-09)"},{"ordinal":2,"section_refs":[2],"unit_range":{},"goal_size":6,"estimated_window":"[2026-10-09,2026-10-12)"}]';
begin
  -- (1) a paused plan, default expected version (the plan's current one); creation-only arguments (plan_id, sessions) are ignored
  perform qa.as_user(qa.id(901));
  select o.chat_id into c1
  from public.app_plan_chat_open('ar', 'synthetic goal', jsonb_build_object('kind', 'proposal', 'text', 'p', 'source', 'rules', 'payload', v_prop), qa.id(1002), v_prop) o;
  v_ret := public.app_plan_chat_confirm(c1, 1, qa.plan_args_json(jsonb_build_object(
             'phases', c_phases2, 'plan_id', qa.id(9999),
             'sessions', jsonb_build_array(jsonb_build_object('kind', 'daily', 'phase_ordinal', 1, 'learning_date', '2026-10-07', 'steps', '[]'::jsonb, 'bank_version', 1)))));
  if v_ret <> qa.id(1002) then raise exception 'a revision must return the conversation''s plan, got %', v_ret; end if;
  set constraints all immediate;
  set constraints all deferred;
  perform qa.as_owner();
  if (select (status, current_version, plan_order, session_minutes, preferred_date::text, target_scope::text, agreed_estimate ->> 'days', paths::text, edition_id = qa.id(5))::text
      from public.master_plans where id = qa.id(1002))
     <> '(paused,2,reverse,15,2026-11-01,"{""sectionOrdinals"": [1, 2]}",9,{quran},t)' then
    raise exception 'the revised plan differs (it must stay paused): %', (select to_jsonb(m) from public.master_plans m where id = qa.id(1002));
  end if;
  if (select string_agg(version_no || ':' || reason_code, ',' order by version_no) from public.plan_versions where plan_id = qa.id(1002)) <> '1:test,2:plan_chat'
     or (select (effective_learning_date::text, policy_json ->> 'planner')::text from public.plan_versions where plan_id = qa.id(1002) and version_no = 2) <> '(2026-10-05,rules)' then
    raise exception 'the version history differs (version 1 must stay as it was)';
  end if;
  if (select count(*) from public.plan_phases ph join public.plan_versions pv on pv.id = ph.plan_version_id where pv.plan_id = qa.id(1002) and pv.version_no = 1) <> 0
     or (select string_agg(ph.ordinal::text, ',' order by ph.ordinal) from public.plan_phases ph join public.plan_versions pv on pv.id = ph.plan_version_id where pv.plan_id = qa.id(1002) and pv.version_no = 2) <> '1,2' then
    raise exception 'the phases of the versions differ';
  end if;
  if (select count(*) from public.learning_sessions) <> 0 then raise exception 'a revision created prepared sessions'; end if;
  if (select (status, current_version)::text from public.master_plans where id = qa.id(1001)) <> '(active,1)'
     or (select (status, current_version)::text from public.master_plans where id = qa.id(1003)) <> '(active,1)' then
    raise exception 'another plan changed';
  end if;
  if (select (status, closed_at is not null, plan_id = qa.id(1002), proposal_version, model_turns)::text from public.plan_chats where id = c1) <> '(confirmed,t,t,1,0)' then
    raise exception 'the confirmed revision chat differs: %', (select to_jsonb(c) from public.plan_chats c where id = c1);
  end if;

  -- (2) the active plan with an explicit expected version that matches: it moves to version 2 and stays active
  perform qa.as_user(qa.id(901));
  select o.chat_id into c2 from public.app_plan_chat_open('en', null, '{"kind":"proposal","text":"p","source":"rules"}', qa.id(1001), qa.proposal_json(1, 5)) o;
  v_ret := public.app_plan_chat_confirm(c2, 1, qa.plan_args_json('{"expected_version": 1}'));
  perform qa.as_owner();
  if v_ret <> qa.id(1001)
     or (select (status, current_version, session_minutes)::text from public.master_plans where id = qa.id(1001)) <> '(active,2,5)'
     or (select status from public.plan_chats where id = c2) <> 'confirmed'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1 then
    raise exception 'the revision of the active plan differs';
  end if;

  -- (3) the same paused plan again: the default expected version follows the plan to version 3
  perform qa.as_user(qa.id(901));
  select o.chat_id into c3 from public.app_plan_chat_open('en', null, '{"kind":"proposal","text":"p","source":"rules"}', qa.id(1002), qa.proposal_json(1, 10)) o;
  perform public.app_plan_chat_confirm(c3, 1, qa.plan_args_json());
  perform qa.as_owner();
  if (select (status, current_version, session_minutes)::text from public.master_plans where id = qa.id(1002)) <> '(paused,3,10)'
     or (select count(*) from public.plan_versions where plan_id = qa.id(1002)) <> 3 then
    raise exception 'the second revision of the paused plan differs';
  end if;
  set constraints all immediate;
  set constraints all deferred;
end $$;
rollback;

-- CHECK: 22 app_plan_chat_confirm, revision conflicts and failing steps: a plan that moved since the conversation began is QT002 (plan_version); a failing step of the revision rolls everything back, so the chat is never closed without its plan change
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
do $$
declare
  c uuid;
  v_snap text;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"proposal","text":"p","source":"rules"}', qa.id(1001), qa.proposal_json(1, 15)) o;

  -- (a) the plan moves to version 2 outside the conversation; the snapshot of the conversation (version 1, the service passes it as expected_version) is stale
  if public.app_revise_plan(qa.id(1001), 1, '{"sectionOrdinals":[1]}', array['quran'], 'book', 5::smallint, null, '{}', 'other', '{}', date '2026-10-06', qa.phases_json()) <> 2 then
    raise exception 'the plan did not move to version 2';
  end if;
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"expected_version": 1}'))$q$, c), 'QT002', 'the plan moved since the conversation began');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"expected_version": 3}'))$q$, c), 'QT002', 'an expected version ahead of the plan');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"expected_version": 0}'))$q$, c), 'QT002', 'expected version 0');
  perform qa.as_owner();
  if (select (status, closed_at is null, proposal_version)::text from public.plan_chats where id = c) <> '(open,t,1)'
     or (select (current_version, session_minutes, status)::text from public.master_plans where id = qa.id(1001)) <> '(2,5,active)'
     or (select count(*) from public.plan_versions where plan_id = qa.id(1001)) <> 2 then
    raise exception 'a refused revision confirmation changed the chat or the plan';
  end if;

  -- (b) failing steps: a phase that breaks its rule, a proposal value that breaks a plan rule; each rolls back the version, the phases and the chat update
  perform qa.as_user(qa.id(901));
  v_snap := (select (current_version, session_minutes, plan_order, status)::text from public.master_plans where id = qa.id(1001));
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"expected_version": 2, "phases":[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":0,"estimated_window":"[2026-10-05,2026-10-12)"}]}'))$q$, c),
                          'plan_phases_goal_size_check');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"expected_version": 2, "reason_code": null}'))$q$, c), '23502', 'no reason code');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"expected_version": 2, "effective_learning_date": null}'))$q$, c), '23502', 'no effective learning date');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"expected_version": 2, "effective_learning_date": "nope"}'))$q$, c), '22007', 'an invalid date');
  -- proposals whose values break a plan rule: the stored proposal is replaced by a bad one, then confirmed at its version
  if public.app_plan_chat_append(c, '[]', qa.proposal_json(2, 7)) <> 2 then raise exception 'the bad proposal did not get version 2'; end if;
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 2, qa.plan_args_json('{"expected_version": 2}'))$q$, c), 'master_plans_session_minutes_check');
  if public.app_plan_chat_append(c, '[]', qa.proposal_json(3, 10) || '{"paths":["takhrij"]}') <> 3 then raise exception 'the bad proposal did not get version 3'; end if;
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 3, qa.plan_args_json('{"expected_version": 2}'))$q$, c), 'master_plans_paths_check');
  if public.app_plan_chat_append(c, '[]', qa.proposal_json(4, 10) || '{"order":"sideways"}') <> 4 then raise exception 'the bad proposal did not get version 4'; end if;
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 4, qa.plan_args_json('{"expected_version": 2}'))$q$, c), 'master_plans_plan_order_check');
  perform qa.as_owner();
  if (select (current_version, session_minutes, plan_order, status)::text from public.master_plans where id = qa.id(1001)) is distinct from v_snap
     or (select count(*) from public.plan_versions where plan_id = qa.id(1001)) <> 2
     or (select count(*) from public.plan_phases ph join public.plan_versions pv on pv.id = ph.plan_version_id where pv.plan_id = qa.id(1001)) <> 1
     or (select (status, closed_at is null, proposal_version)::text from public.plan_chats where id = c) <> '(open,t,4)' then
    raise exception 'a failing step left changes behind';
  end if;

  -- (c) the same chat confirms once the proposal is right and the plan version is the plan's own: version 3
  perform qa.as_user(qa.id(901));
  if public.app_plan_chat_append(c, '[]', qa.proposal_json(5, 10)) <> 5 then raise exception 'the good proposal did not get version 5'; end if;
  if public.app_plan_chat_confirm(c, 5, qa.plan_args_json('{"expected_version": 2}')) <> qa.id(1001) then raise exception 'the revision did not return the plan'; end if;
  perform qa.as_owner();
  if (select (current_version, session_minutes, status)::text from public.master_plans where id = qa.id(1001)) <> '(3,10,active)'
     or (select status from public.plan_chats where id = c) <> 'confirmed' then
    raise exception 'the corrected revision did not apply';
  end if;
  set constraints all immediate;
  set constraints all deferred;
end $$;
rollback;

-- CHECK: 23 app_plan_chat_confirm, creation rollback: a failing step (arguments, proposal values, prepared sessions) saves no plan, does not pause the active plan and does not close the chat
begin;
select qa.make_fixture();
select qa.make_hadith_edition();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
do $$
declare
  c uuid;
  v_snap text;
  v_good jsonb := qa.proposal_json(1, 10);
begin
  perform qa.as_user(qa.id(901));
  -- (a) bad plan arguments, with the open chat's good proposal
  select o.chat_id into c from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"proposal","text":"p","source":"rules"}', null, v_good) o;
  perform qa.as_owner();
  v_snap := (select string_agg(id || ':' || status || ':' || current_version, ',' order by id) from public.master_plans) || '/' ||
            (select count(*) from public.plan_versions) || '/' || (select count(*) from public.plan_phases) || '/' || (select count(*) from public.learning_sessions);
  perform qa.as_user(qa.id(901));
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"phases":[{"ordinal":1,"section_refs":[],"unit_range":{},"goal_size":0,"estimated_window":"[2026-10-05,2026-10-12)"}]}'))$q$, c),
                          'plan_phases_goal_size_check');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"reason_code": null}'))$q$, c), '23502', 'no reason code');
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"reason_code": "  "}'))$q$, c), 'plan_versions_reason_code_check');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"effective_learning_date": null}'))$q$, c), '23502', 'no effective learning date');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"effective_learning_date": "nope"}'))$q$, c), '22007', 'an invalid date');
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"policy_json": "x"}'))$q$, c), 'plan_versions_policy_json_check');
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json('{"sessions":[{"kind":"bogus","learning_date":"2026-10-07","steps":[],"bank_version":1}]}'))$q$, c),
                          'learning_sessions_kind_check');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json(jsonb_build_object('plan_id', %L)))$q$, c, qa.id(1001)), '23505', 'a plan id that is already taken');

  -- (b) stored proposals whose values break a plan rule or are incomplete (the proposal is replaced by a new version each time)
  perform public.app_plan_chat_append(c, '[]', '{}');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 2, qa.plan_args_json())$q$, c), '23502', 'a proposal without an edition');
  perform public.app_plan_chat_append(c, '[]', v_good || jsonb_build_object('editionId', qa.id(9999)));
  perform qa.expect_fk(format($q$select public.app_plan_chat_confirm(%L, 3, qa.plan_args_json())$q$, c), 'master_plans_edition_id_fkey');
  perform public.app_plan_chat_append(c, '[]', qa.proposal_json(1, 7));
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 4, qa.plan_args_json())$q$, c), 'master_plans_session_minutes_check');
  perform public.app_plan_chat_append(c, '[]', v_good || '{"paths":["takhrij"]}');
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 5, qa.plan_args_json())$q$, c), 'master_plans_paths_check');
  perform public.app_plan_chat_append(c, '[]', v_good || jsonb_build_object('editionId', qa.id(21), 'paths', jsonb_build_array('matn'), 'order', 'reverse'));
  perform qa.expect_check(format($q$select public.app_plan_chat_confirm(%L, 6, qa.plan_args_json())$q$, c), 'master_plans_plan_order_quran_only_check');
  perform public.app_plan_chat_append(c, '[]', v_good - 'estimate');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 7, qa.plan_args_json())$q$, c), '23502', 'a proposal without an estimate');

  -- no refusal changed anything: the active plan was not paused, no plan, version, phase or session exists, the chat is open
  perform qa.as_owner();
  if (select string_agg(id || ':' || status || ':' || current_version, ',' order by id) from public.master_plans) || '/' ||
     (select count(*) from public.plan_versions) || '/' || (select count(*) from public.plan_phases) || '/' || (select count(*) from public.learning_sessions) is distinct from v_snap
     or (select (status, closed_at is null, proposal_version)::text from public.plan_chats where id = c) <> '(open,t,7)' then
    raise exception 'a failing creation step left changes behind';
  end if;

  -- (c) with a good proposal and good arguments the same chat confirms at its current version
  perform qa.as_user(qa.id(901));
  if public.app_plan_chat_append(c, '[]', v_good) <> 8 then raise exception 'the good proposal did not get version 8'; end if;
  perform public.app_plan_chat_confirm(c, 8, qa.plan_args_json());
  perform qa.as_owner();
  if (select status from public.master_plans where id = qa.id(1001)) <> 'paused'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1
     or (select status from public.plan_chats where id = c) <> 'confirmed' then
    raise exception 'the corrected creation did not apply';
  end if;
  set constraints all immediate;
  set constraints all deferred;
end $$;
rollback;

-- CHECK: 24 plan conversations with app_resume_plan: a confirmed creation pauses the previous plan and a resume swaps back; a revision keeps the plan's status and a resume then reports the revised version; resuming never touches an open chat; one active plan at every step
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
select qa.make_plan(qa.id(1002), qa.id(901), 'paused');
select qa.make_plan(qa.id(1003), qa.id(902), 'active');
do $$
declare
  c1 uuid; c2 uuid; c3 uuid;
  v_new uuid;
  v_ver integer;
  v_b   text := (select (status, current_version)::text from public.master_plans where id = qa.id(1003));
begin
  -- 1. the learner confirms a new plan: it becomes active, the active plan (P1) pauses, the paused plan (P2) stays paused
  perform qa.as_user(qa.id(901));
  select o.chat_id into c1 from public.app_plan_chat_open('ar', 'synthetic goal', '{"kind":"proposal","text":"p","source":"rules"}', null, qa.proposal_json()) o;
  v_new := public.app_plan_chat_confirm(c1, 1, qa.plan_args_json());
  if ((select status from public.master_plans where id = qa.id(1001)),
      (select status from public.master_plans where id = qa.id(1002)),
      (select status from public.master_plans where id = v_new))::text <> '(paused,paused,active)'
     or (select count(*) from public.master_plans where user_id = qa.id(901)) <> 3 then
    raise exception 'step 1: the creation did not leave exactly the new plan active';
  end if;

  -- 2. resuming P1 swaps: P1 active, the new plan paused (version 1 returned)
  v_ver := public.app_resume_plan(qa.id(1001));
  if v_ver <> 1 or (select status from public.master_plans where id = qa.id(1001)) <> 'active'
     or (select status from public.master_plans where id = v_new) <> 'paused'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1 then
    raise exception 'step 2: the resume did not swap the active plan';
  end if;

  -- 3. a revision conversation on the paused new plan: opening changes no status; resuming P2 meanwhile does not touch the open chat
  select o.chat_id into c2 from public.app_plan_chat_open('en', null, '{"kind":"proposal","text":"p","source":"rules"}', v_new, qa.proposal_json(1, 15)) o;
  if (select status from public.master_plans where id = v_new) <> 'paused' or (select status from public.master_plans where id = qa.id(1001)) <> 'active' then
    raise exception 'step 3: opening a revision chat changed a plan status';
  end if;
  v_ver := public.app_resume_plan(qa.id(1002));
  if v_ver <> 1 or (select status from public.master_plans where id = qa.id(1002)) <> 'active'
     or (select status from public.master_plans where id = qa.id(1001)) <> 'paused'
     or (select (status, closed_at is null, plan_id = v_new)::text from public.plan_chats where id = c2) <> '(open,t,t)' then
    raise exception 'step 3: the resume changed the open chat or did not swap';
  end if;

  -- 4. confirming the revision: version 2, the plan stays paused and the active plan (P2) stays active
  perform public.app_plan_chat_confirm(c2, 1, qa.plan_args_json());
  if (select (status, current_version, session_minutes)::text from public.master_plans where id = v_new) <> '(paused,2,15)'
     or (select status from public.master_plans where id = qa.id(1002)) <> 'active'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1 then
    raise exception 'step 4: the revision changed a status';
  end if;

  -- 5. resuming the revised plan reports its current version (2) and swaps with P2
  v_ver := public.app_resume_plan(v_new);
  if v_ver <> 2 or (select status from public.master_plans where id = v_new) <> 'active'
     or (select status from public.master_plans where id = qa.id(1002)) <> 'paused'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1 then
    raise exception 'step 5: the resume of the revised plan reported % or did not swap', v_ver;
  end if;

  -- 6. a revision of the active plan keeps it active; resuming it again returns the new version and changes nothing
  select o.chat_id into c3 from public.app_plan_chat_open('en', null, '{"kind":"proposal","text":"p","source":"rules"}', v_new, qa.proposal_json(1, 5)) o;
  perform public.app_plan_chat_confirm(c3, 1, qa.plan_args_json());
  if public.app_resume_plan(v_new) <> 3
     or (select (status, current_version, session_minutes)::text from public.master_plans where id = v_new) <> '(active,3,5)'
     or (select count(*) from public.master_plans where user_id = qa.id(901) and status = 'active') <> 1 then
    raise exception 'step 6: the active plan was not revised in place';
  end if;
  set constraints all immediate;
  set constraints all deferred;

  -- B is untouched by all of it and cannot resume or revise A's plans through a conversation
  perform qa.as_owner();
  if (select (status, current_version)::text from public.master_plans where id = qa.id(1003)) is distinct from v_b then
    raise exception 'another account''s plan changed';
  end if;
  perform qa.as_user(qa.id(902));
  perform qa.expect_error(format('select public.app_resume_plan(%L)', v_new), 'P0002', 'B resumes A''s plan');
  perform qa.expect_fk(format($q$select * from public.app_plan_chat_open('en', null, '{"kind":"text","text":"r","source":"rules"}', %L)$q$, v_new), 'plan_chats_plan_id_user_id_fkey');
  perform qa.expect_error(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c3), 'P0002', 'B confirms A''s revision chat');
  perform qa.as_owner();
  if (select (status, current_version)::text from public.master_plans where id = v_new) <> '(active,3)' then
    raise exception 'a refused action of B changed A''s plan';
  end if;
end $$;
rollback;

-- CHECK: 25 execution boundary at run time: without a token subject all four functions refuse ("not authenticated"); anon, service_role and qatra_server lack the privilege to execute them or to touch the two tables; nothing changes
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'paused');
-- SQLSTATE 42501 is both the functions' own refusal of a call without a token subject and PostgreSQL's missing-privilege error: the message tells them apart
create function pg_temp.expect_42501(p_sql text, p_label text, p_message_prefix text)
returns void
language plpgsql
as $f$
begin
  begin
    execute p_sql;
  exception when insufficient_privilege then
    if sqlerrm like p_message_prefix || '%' then
      return;
    end if;
    raise exception 'FAIL [%]: SQLSTATE 42501 but the message is "%", expected one starting "%"', p_label, sqlerrm, p_message_prefix;
  end;
  raise exception 'FAIL [%]: statement succeeded but SQLSTATE 42501 was expected', p_label;
end
$f$;
do $$
declare
  c uuid;
  r text;
  v_snap text;
begin
  perform qa.as_user(qa.id(901));
  select o.chat_id into c from public.app_plan_chat_open('ar', null, '{"kind":"proposal","text":"p","source":"rules"}', null, qa.proposal_json()) o;
  perform qa.as_owner();
  v_snap := (select string_agg(id || ':' || status || ':' || proposal_version || ':' || model_turns, ',' order by id) from public.plan_chats) || '/' ||
            (select count(*) from public.plan_chat_messages) || '/' || (select string_agg(id || ':' || status, ',' order by id) from public.master_plans);

  -- the authenticated role without a subject (an empty claim) is refused by every function, by the function itself
  perform qa.as_none();
  perform pg_temp.expect_42501($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"a","source":"rules"}')$q$, 'open without a subject', 'not authenticated');
  perform pg_temp.expect_42501(format($q$select public.app_plan_chat_append(%L, '[]')$q$, c), 'append without a subject', 'not authenticated');
  perform pg_temp.expect_42501(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c), 'confirm without a subject', 'not authenticated');
  perform pg_temp.expect_42501(format('select public.app_resume_plan(%L)', qa.id(1001)), 'resume without a subject', 'not authenticated');
  perform qa.as_owner();

  -- the other roles hold no EXECUTE and no table privilege: PostgreSQL refuses before any function body or policy runs
  foreach r in array array['anon', 'service_role', 'qatra_server'] loop
    execute format('set local role %I', r);
    perform pg_temp.expect_42501($q$select * from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"a","source":"rules"}')$q$, r || ' opens a chat', 'permission denied for function');
    perform pg_temp.expect_42501(format($q$select public.app_plan_chat_append(%L, '[]')$q$, c), r || ' appends', 'permission denied for function');
    perform pg_temp.expect_42501(format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())$q$, c), r || ' confirms', 'permission denied for function');
    perform pg_temp.expect_42501(format('select public.app_resume_plan(%L)', qa.id(1001)), r || ' resumes a plan', 'permission denied for function');
    perform pg_temp.expect_42501('select count(*) from public.plan_chats', r || ' reads plan_chats', 'permission denied for table');
    perform pg_temp.expect_42501('select count(*) from public.plan_chat_messages', r || ' reads plan_chat_messages', 'permission denied for table');
    perform pg_temp.expect_42501(format($q$insert into public.plan_chats (user_id, status, language, closed_at) values (%L, 'abandoned', 'ar', now())$q$, qa.id(901)), r || ' inserts a chat', 'permission denied for table');
    perform pg_temp.expect_42501(format($q$insert into public.plan_chat_messages (chat_id, user_id, ordinal, role, kind, text, source) values (%L, %L, 99, 'learner', 'text', 'x', 'learner')$q$, c, qa.id(901)), r || ' inserts a message', 'permission denied for table');
    perform qa.as_owner();
  end loop;

  if (select string_agg(id || ':' || status || ':' || proposal_version || ':' || model_turns, ',' order by id) from public.plan_chats) || '/' ||
     (select count(*) from public.plan_chat_messages) || '/' || (select string_agg(id || ':' || status, ',' order by id) from public.master_plans) is distinct from v_snap then
    raise exception 'a refused call changed data';
  end if;
end $$;
rollback;

-- CHECK: 26 account deletion and cascades: srv_delete_personal_rows (replaced by 0006, run as qatra_server) removes the chats and messages of the account only, a cascade from auth.users does the same, deleting a plan removes its revision chats and keeps creation chats (§12.1, §14 check 18)
begin;
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(1001), qa.id(901), 'active');
select qa.make_plan(qa.id(1002), qa.id(902), 'active');
select qa.make_plan(qa.id(1003), qa.id(903), 'active');
do $$
declare
  u integer;
  c1 uuid; c2 uuid;
begin
  -- every account: an abandoned creation chat (replaced by the next open) and an open revision chat with one more message each
  foreach u in array array[901, 902, 903] loop
    perform qa.as_user(qa.id(u));
    select o.chat_id into c1 from public.app_plan_chat_open('ar', 'goal', '{"kind":"text","text":"creation","source":"rules"}') o;
    select o.chat_id into c2 from public.app_plan_chat_open('en', null, '{"kind":"proposal","text":"revision","source":"rules"}', qa.id(u + 100), qa.proposal_json()) o;
    perform public.app_plan_chat_append(c2, '[{"role":"learner","kind":"text","text":"more","source":"learner"}]');
    perform qa.as_owner();
  end loop;
  if (select count(*) from public.plan_chats) <> 6 or (select count(*) from public.plan_chat_messages) <> 3 * (2 + 2)
     or (select count(*) from public.plan_chats where status = 'abandoned' and plan_id is null) <> 3
     or (select count(*) from public.plan_chats where status = 'open' and plan_id is not null) <> 3 then
    raise exception 'the setup differs: % chats, % messages', (select count(*) from public.plan_chats), (select count(*) from public.plan_chat_messages);
  end if;

  -- the function that 0006 replaced keeps its definer rights, empty search_path and grants: qatra_server only
  if not exists (select 1 from pg_proc p where p.oid = 'public.srv_delete_personal_rows(uuid,bytea)'::regprocedure and p.prosecdef and p.proconfig @> array['search_path=""']) then
    raise exception 'srv_delete_personal_rows is not security definer with an empty search_path';
  end if;
  if not has_function_privilege('qatra_server', 'public.srv_delete_personal_rows(uuid,bytea)', 'EXECUTE')
     or has_function_privilege('anon', 'public.srv_delete_personal_rows(uuid,bytea)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.srv_delete_personal_rows(uuid,bytea)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.srv_delete_personal_rows(uuid,bytea)', 'EXECUTE') then
    raise exception 'srv_delete_personal_rows is not executable by qatra_server only';
  end if;

  -- the explicit deletion list (§12.1), run as the backend's role (which holds no table privilege): the account's chats and messages go, the others stay
  perform qa.as_server();
  perform public.srv_delete_personal_rows(qa.id(901), null);
  perform qa.as_owner();
  if (select count(*) from public.plan_chats where user_id = qa.id(901)) <> 0 or (select count(*) from public.plan_chat_messages where user_id = qa.id(901)) <> 0
     or (select count(*) from public.plan_chats where user_id in (qa.id(902), qa.id(903))) <> 4
     or (select count(*) from public.plan_chat_messages where user_id in (qa.id(902), qa.id(903))) <> 8 then
    raise exception 'srv_delete_personal_rows did not remove exactly the account''s conversation rows';
  end if;
  -- repeating changes nothing
  perform qa.as_server();
  perform public.srv_delete_personal_rows(qa.id(901), null);
  perform qa.as_owner();
  if (select count(*) from public.plan_chats) <> 4 then raise exception 'a repeated deletion changed other rows'; end if;

  -- a cascade from auth.users alone removes the same rows of that account
  delete from auth.users where id = qa.id(903);
  if (select count(*) from public.plan_chats where user_id = qa.id(903)) <> 0 or (select count(*) from public.plan_chat_messages where user_id = qa.id(903)) <> 0
     or (select count(*) from public.plan_chats where user_id = qa.id(902)) <> 2
     or (select count(*) from public.plan_chat_messages where user_id = qa.id(902)) <> 4 then
    raise exception 'the cascade from auth.users removed the wrong rows';
  end if;

  -- deleting a plan removes the revision chats that point at it and their messages (class B), and keeps the account's creation chat
  delete from public.master_plans where id = qa.id(1002);
  if (select count(*) from public.plan_chats where user_id = qa.id(902) and plan_id is not null) <> 0
     or (select count(*) from public.plan_chats where user_id = qa.id(902) and plan_id is null and status = 'abandoned') <> 1
     or (select count(*) from public.plan_chat_messages where user_id = qa.id(902)) <> 2
     or (select count(*) from public.plan_chat_messages m where m.user_id = qa.id(902) and not exists (select 1 from public.plan_chats c where c.id = m.chat_id)) <> 0 then
    raise exception 'deleting the plan did not remove exactly its revision chat and messages';
  end if;
end $$;
rollback;

-- CHECK: 27 concurrency over dblink (needs the contrib module dblink; commits for real and cleans up): a parallel second open loses on the one-open-chat index, parallel appends keep distinct ordinals and every increment, a confirm and a replacing open serialize in either order, a double confirm saves one plan
set statement_timeout = '120s';
select qa.make_fixture();
select qa.make_users();
select qa.make_plan(qa.id(101), qa.id(901), 'active');
create extension if not exists dblink with schema extensions;
-- helpers for the two remote connections (session-local, gone with this chunk)
create function pg_temp.dl_begin(p_conn text, p_user uuid) returns void language plpgsql as $f$
begin
  perform extensions.dblink_exec(p_conn, 'begin');
  perform extensions.dblink_exec(p_conn, 'set local role authenticated');
  perform * from extensions.dblink(p_conn, format('select set_config(''request.jwt.claim.sub'', %L, true)', p_user::text)) as t(x text);
end $f$;
create function pg_temp.dl_query(p_conn text, p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  select t.r into v from extensions.dblink(p_conn, p_sql) as t(r text);
  return v;
end $f$;
-- the result of a statement sent with dblink_send_query: its text, or the error it ended with
create function pg_temp.dl_result(p_conn text, out res text, out err_state text, out err_message text) language plpgsql as $f$
begin
  begin
    select t.r into res from extensions.dblink_get_result(p_conn) as t(r text);
  exception when others then
    err_state := sqlstate;
    err_message := sqlerrm;
  end;
  begin   -- drain the connection
    perform * from extensions.dblink_get_result(p_conn) as t(r text);
  exception when others then null;
  end;
end $f$;
do $$
declare
  v_conn constant text := 'dbname=' || current_database();
  a constant uuid := qa.id(901);
  x uuid; y uuid; z uuid;
  e record;
begin
  perform extensions.dblink_connect('c1', v_conn);
  perform extensions.dblink_connect('c2', v_conn);
  perform extensions.dblink_exec('c1', 'set statement_timeout = ''60s''');
  perform extensions.dblink_exec('c2', 'set statement_timeout = ''60s''');

  ---------------------------------------------------------------------------
  -- 1. two parallel opens of one account: the second waits on the one-open-chat index and then fails with 23505
  ---------------------------------------------------------------------------
  perform pg_temp.dl_begin('c1', a);
  perform pg_temp.dl_begin('c2', a);
  x := pg_temp.dl_query('c1', $q$select (select o.chat_id from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"c1","source":"rules"}') o)::text$q$)::uuid;
  perform extensions.dblink_send_query('c2', $q$select (select o.chat_id from public.app_plan_chat_open('en', null, '{"kind":"text","text":"c2","source":"rules"}') o)::text$q$);
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the second open did not wait on the one-open-chat index'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  select * into e from pg_temp.dl_result('c2');
  perform extensions.dblink_exec('c2', 'rollback');
  if e.err_state is distinct from '23505' or e.err_message not like '%plan_chats_user_id_open_key%' then
    raise exception 'the losing open ended with % (%), expected 23505 on plan_chats_user_id_open_key', e.err_state, e.err_message;
  end if;
  if (select count(*) from public.plan_chats where user_id = a) <> 1
     or (select (status, language)::text from public.plan_chats where id = x) <> '(open,ar)'
     or (select count(*) from public.plan_chat_messages where chat_id = x) <> 1 then
    raise exception 'exactly the first open must have won';
  end if;

  ---------------------------------------------------------------------------
  -- 2. two parallel appends to one chat: the second waits for the row lock, then continues the ordinals; both increments count
  ---------------------------------------------------------------------------
  perform pg_temp.dl_begin('c1', a);
  perform pg_temp.dl_begin('c2', a);
  perform pg_temp.dl_query('c1', format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"a","source":"learner"}]', null, 1)::text$q$, x));
  perform extensions.dblink_send_query('c2', format($q$select public.app_plan_chat_append(%L, '[{"role":"learner","kind":"text","text":"b","source":"learner"}]', null, 1)::text$q$, x));
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the second append did not wait for the chat row'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  select * into e from pg_temp.dl_result('c2');
  if e.err_state is not null then raise exception 'the second append failed with % (%)', e.err_state, e.err_message; end if;
  perform extensions.dblink_exec('c2', 'commit');
  if (select string_agg(ordinal::text, ',' order by ordinal) from public.plan_chat_messages where chat_id = x) <> '1,2,3'
     or (select model_turns from public.plan_chats where id = x) <> 2 then
    raise exception 'parallel appends lost an ordinal or an increment: ordinals %, model_turns %',
      (select string_agg(ordinal::text, ',' order by ordinal) from public.plan_chat_messages where chat_id = x), (select model_turns from public.plan_chats where id = x);
  end if;

  ---------------------------------------------------------------------------
  -- 3a. a confirm holds the chat while another open wants to replace it: the confirm wins, the open then replaces nothing
  ---------------------------------------------------------------------------
  perform pg_temp.dl_begin('c1', a);
  perform pg_temp.dl_query('c1', format($q$select public.app_plan_chat_append(%L, '[]', qa.proposal_json(1, 10))::text$q$, x));
  perform extensions.dblink_exec('c1', 'commit');
  perform pg_temp.dl_begin('c1', a);
  perform pg_temp.dl_begin('c2', a);
  perform pg_temp.dl_query('c1', format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())::text$q$, x));
  perform extensions.dblink_send_query('c2', $q$select o::text from public.app_plan_chat_open('en', null, '{"kind":"text","text":"c3","source":"rules"}') o$q$);
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the replacing open did not wait for the confirm'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  select * into e from pg_temp.dl_result('c2');
  if e.err_state is not null then raise exception 'the replacing open failed with % (%)', e.err_state, e.err_message; end if;
  perform extensions.dblink_exec('c2', 'commit');
  y := split_part(trim(both '()' from e.res), ',', 1)::uuid;
  if e.res not like '(%,)' then raise exception 'the open must report no replaced chat after a confirm: %', e.res; end if;
  if (select status from public.plan_chats where id = x) <> 'confirmed'
     or (select status from public.plan_chats where id = y) <> 'open'
     or (select count(*) from public.master_plans where user_id = a) <> 2
     or (select count(*) from public.master_plans where user_id = a and status = 'active') <> 1 then
    raise exception 'confirm then open: the chat, the plan or the new chat differs';
  end if;

  ---------------------------------------------------------------------------
  -- 3b. an open holds the chat (it replaces it) while a confirm of that chat waits: the confirm then finds it closed and saves nothing
  ---------------------------------------------------------------------------
  perform pg_temp.dl_begin('c1', a);
  perform pg_temp.dl_query('c1', format($q$select public.app_plan_chat_append(%L, '[]', qa.proposal_json(1, 10))::text$q$, y));
  perform extensions.dblink_exec('c1', 'commit');
  perform pg_temp.dl_begin('c1', a);
  perform pg_temp.dl_begin('c2', a);
  z := split_part(trim(both '()' from pg_temp.dl_query('c1', $q$select o::text from public.app_plan_chat_open('ar', null, '{"kind":"text","text":"c4","source":"rules"}') o$q$)), ',', 1)::uuid;
  perform extensions.dblink_send_query('c2', format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())::text$q$, y));
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the confirm did not wait for the replacing open'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  select * into e from pg_temp.dl_result('c2');
  perform extensions.dblink_exec('c2', 'rollback');
  if e.err_state is distinct from 'QT003' then raise exception 'the confirm of the replaced chat ended with %, expected QT003', e.err_state; end if;
  if (select status from public.plan_chats where id = y) <> 'abandoned'
     or (select status from public.plan_chats where id = z) <> 'open'
     or (select count(*) from public.master_plans where user_id = a) <> 2 then
    raise exception 'open then confirm: a plan was saved or the chats differ';
  end if;

  ---------------------------------------------------------------------------
  -- 4. a double submit of the same confirmation: one plan, the second sees the chat closed
  ---------------------------------------------------------------------------
  perform pg_temp.dl_begin('c1', a);
  perform pg_temp.dl_query('c1', format($q$select public.app_plan_chat_append(%L, '[]', qa.proposal_json(1, 10))::text$q$, z));
  perform extensions.dblink_exec('c1', 'commit');
  perform pg_temp.dl_begin('c1', a);
  perform pg_temp.dl_begin('c2', a);
  perform pg_temp.dl_query('c1', format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())::text$q$, z));
  perform extensions.dblink_send_query('c2', format($q$select public.app_plan_chat_confirm(%L, 1, qa.plan_args_json())::text$q$, z));
  perform pg_sleep(0.7);
  if extensions.dblink_is_busy('c2') <> 1 then raise exception 'the second confirm did not wait for the first'; end if;
  perform extensions.dblink_exec('c1', 'commit');
  select * into e from pg_temp.dl_result('c2');
  perform extensions.dblink_exec('c2', 'rollback');
  if e.err_state is distinct from 'QT003' then raise exception 'the second confirm ended with %, expected QT003', e.err_state; end if;
  if (select status from public.plan_chats where id = z) <> 'confirmed'
     or (select count(*) from public.master_plans where user_id = a) <> 3
     or (select count(*) from public.master_plans where user_id = a and status = 'active') <> 1 then
    raise exception 'a double confirm saved more than one plan';
  end if;

  perform extensions.dblink_disconnect('c1');
  perform extensions.dblink_disconnect('c2');
end $$;
-- cleanup of everything this chunk committed
drop extension dblink;
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
  foreach t in array array['public.plan_chats', 'public.plan_chat_messages', 'public.master_plans', 'public.plan_versions', 'public.plan_phases',
                           'public.book_editions', 'auth.users'] loop
    execute format('select count(*) from %s', t) into n;
    if n <> 0 then raise exception 'cleanup left % rows in %', n, t; end if;
  end loop;
  if exists (select 1 from pg_extension where extname = 'dblink') then raise exception 'dblink is still installed'; end if;
end;
$$;
