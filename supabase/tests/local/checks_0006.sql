-- checks_0006.sql
--
-- LOCAL VALIDATION ONLY. Assertions for supabase/migrations/0006_plan_chats.sql, run by
-- run_local.sh right after that migration (the database then holds 0001-0006). Every
-- "-- CHECK:" line starts one independent chunk; a chunk passes when psql finishes it
-- without an error. Rows are synthetic placeholders created inside transactions that are
-- rolled back. Expected values are written from docs/Database-schema.md v1.2 (§4.4, §5.2,
-- §6.3, §11 `0006_plan_chats`), docs/Plan-conversation.md §2.1/§2.9 and the pre-merge
-- audit of 4 October 2026 (tamper guard). Coverage is deliberately compact: the full
-- open/append/confirm matrix of the three app_plan_chat_* functions is NOT covered yet.

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
