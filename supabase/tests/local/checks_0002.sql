-- checks_0002.sql
--
-- LOCAL VALIDATION ONLY. Assertions for supabase/migrations/0002_identity.sql, run by
-- run_local.sh right after that migration on a scratch database. Every "-- CHECK:" line
-- starts one independent chunk; a chunk passes when psql finishes it without an error.
-- Rows are synthetic placeholders created inside transactions that are rolled back.
-- Expected values are written out here from docs/Database-schema.md v1.1 (§3.2, §4.4,
-- §5.1, §5.2, §6.2, §10, §11 `0002_identity`, §14 checks 3, 4, 6, 17), not read back from
-- the migration.

-- CHECK: 01 the five private tables and public.profiles exist, with row level security enabled (not forced) and no policy
do $$
declare
  v_missing text[];
  v_bad     text[];
begin
  select array_agg(t order by t) into v_missing
  from unnest(array['private.account_handles', 'private.password_reset_grants',
                    'private.recovery_codes', 'private.app_sessions',
                    'private.auth_throttle', 'public.profiles']) as t
  where to_regclass(t) is null;
  if v_missing is not null then
    raise exception 'missing tables: %', v_missing;
  end if;

  select array_agg(c.oid::regclass::text order by c.oid::regclass::text) into v_bad
  from pg_class c
  where c.oid in ('private.account_handles'::regclass, 'private.password_reset_grants'::regclass,
                  'private.recovery_codes'::regclass, 'private.app_sessions'::regclass,
                  'private.auth_throttle'::regclass, 'public.profiles'::regclass)
    and not (c.relrowsecurity and not c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'RLS not enabled (or forced) on: %', v_bad;
  end if;

  -- the policies belong to 0005; the private tables never get one
  if exists (select 1 from pg_policies where schemaname = 'private') then
    raise exception 'a policy exists on a private table';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles') then
    raise exception 'a policy exists on profiles before 0005';
  end if;
end;
$$;

-- CHECK: 02 anon, authenticated and service_role hold no privilege on the six tables (control: grants are detected)
begin;
-- control 1: the shim's default privileges would have given public.profiles to the API roles;
-- the probe proves that those defaults are active, so the revoke below is not vacuous
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
-- control 2: a grant on a private table is detected by the function used below
grant select on private.account_handles to authenticated;
do $$
begin
  if not has_table_privilege('authenticated', 'private.account_handles', 'SELECT') then
    raise exception 'control failed: has_table_privilege does not see a grant on a private table';
  end if;
end;
$$;
rollback;
do $$
declare
  r record;
begin
  for r in
    select t, rol, p
    from unnest(array['private.account_handles', 'private.password_reset_grants',
                      'private.recovery_codes', 'private.app_sessions',
                      'private.auth_throttle', 'public.profiles']) as t
    cross join unnest(array['anon', 'authenticated', 'service_role']) as rol
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
  loop
    if has_table_privilege(r.rol, r.t, r.p) then
      raise exception '% holds % on %', r.rol, r.p, r.t;
    end if;
  end loop;
  for r in
    select t, rol, p
    from unnest(array['private.account_handles', 'private.password_reset_grants',
                      'private.recovery_codes', 'private.app_sessions',
                      'private.auth_throttle', 'public.profiles']) as t
    cross join unnest(array['anon', 'authenticated', 'service_role']) as rol
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p
  loop
    if has_any_column_privilege(r.rol, r.t, r.p) then
      raise exception '% holds column-level % on %', r.rol, r.p, r.t;
    end if;
  end loop;
end;
$$;

-- CHECK: 03 runtime: the three API roles are denied on the six tables
begin;
select qa.as_anon();
do $$
declare
  t text;
begin
  foreach t in array array['private.account_handles', 'private.password_reset_grants',
                           'private.recovery_codes', 'private.app_sessions',
                           'private.auth_throttle', 'public.profiles'] loop
    perform qa.expect_error(format('select 1 from %s limit 1', t), '42501', 'anon select ' || t);
  end loop;
end;
$$;
select qa.as_owner();
select qa.as_user(qa.id(901));
do $$
declare
  t text;
begin
  foreach t in array array['private.account_handles', 'private.password_reset_grants',
                           'private.recovery_codes', 'private.app_sessions',
                           'private.auth_throttle', 'public.profiles'] loop
    perform qa.expect_error(format('select 1 from %s limit 1', t), '42501', 'authenticated select ' || t);
    perform qa.expect_error(format('delete from %s', t), '42501', 'authenticated delete ' || t);
  end loop;
end;
$$;
select qa.as_owner();
select qa.as_service();
do $$
declare
  t text;
begin
  foreach t in array array['private.account_handles', 'private.password_reset_grants',
                           'private.recovery_codes', 'private.app_sessions',
                           'private.auth_throttle', 'public.profiles'] loop
    perform qa.expect_error(format('select 1 from %s limit 1', t), '42501', 'service_role select ' || t);
    perform qa.expect_error(format('insert into %s default values', t), '42501', 'service_role insert ' || t);
  end loop;
end;
$$;
select qa.as_owner();
rollback;

-- CHECK: 04 role qatra_server: login role with the attributes of §5.1, no password, no membership, no privilege yet
do $$
declare
  v_role  pg_catalog.pg_roles%rowtype;
  v_pw    text;
  r       record;
begin
  select * into v_role from pg_roles where rolname = 'qatra_server';
  if not found then
    raise exception 'role qatra_server does not exist';
  end if;
  if not v_role.rolcanlogin then raise exception 'qatra_server cannot log in'; end if;
  if v_role.rolsuper then raise exception 'qatra_server is a superuser'; end if;
  if v_role.rolcreatedb then raise exception 'qatra_server has CREATEDB'; end if;
  if v_role.rolcreaterole then raise exception 'qatra_server has CREATEROLE'; end if;
  if v_role.rolreplication then raise exception 'qatra_server has REPLICATION'; end if;
  if v_role.rolbypassrls then raise exception 'qatra_server has BYPASSRLS'; end if;

  -- no password in the migration: the owner sets it at provisioning
  select rolpassword into v_pw from pg_authid where rolname = 'qatra_server';
  if v_pw is not null then
    raise exception 'qatra_server has a password set by the migration';
  end if;

  -- not a member of any other role
  if exists (select 1 from pg_auth_members m join pg_roles u on u.oid = m.member where u.rolname = 'qatra_server') then
    raise exception 'qatra_server is a member of another role';
  end if;

  -- no privilege on any table, view or sequence of public and private, and no schema
  -- privilege on private (USAGE on public arrives with 0005)
  for r in
    select c.oid::regclass::text as rel, p
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
    where n.nspname in ('public', 'private') and c.relkind in ('r', 'v', 'm', 'p')
  loop
    if has_table_privilege('qatra_server', r.rel, r.p) then
      raise exception 'qatra_server holds % on %', r.p, r.rel;
    end if;
  end loop;
  if has_schema_privilege('qatra_server', 'private', 'USAGE') or has_schema_privilege('qatra_server', 'private', 'CREATE') then
    raise exception 'qatra_server has a privilege on schema private';
  end if;
  if has_schema_privilege('qatra_server', 'public', 'CREATE') then
    raise exception 'qatra_server can create objects in public';
  end if;
  if (select count(*) from pg_roles where rolname = 'qatra_server') <> 1 then
    raise exception 'role qatra_server is not unique';
  end if;
end;
$$;

-- CHECK: 05 columns of the six tables match §6.2 (type, nullability, default, order)
do $$
begin
  perform qa.assert_columns('private.account_handles'::regclass, array[
    'user_id|uuid|NOT NULL|',
    'username_display|text|NOT NULL|',
    'username_normalized|text|NOT NULL|',
    'internal_auth_alias|text|NOT NULL|',
    'auth_epoch|integer|NOT NULL|0',
    'is_demo|boolean|NOT NULL|false',
    'created_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('private.password_reset_grants'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'grant_hash|bytea|NOT NULL|',
    'expires_at|timestamp with time zone|NOT NULL|',
    'status|text|NOT NULL|''active''::text',
    'created_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('private.recovery_codes'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'code_hash|bytea|NOT NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()',
    'reserved_grant_id|uuid|NULL|',
    'reserved_until|timestamp with time zone|NULL|',
    'consumed_at|timestamp with time zone|NULL|']);
  perform qa.assert_columns('private.app_sessions'::regclass, array[
    'id|uuid|NOT NULL|gen_random_uuid()',
    'user_id|uuid|NOT NULL|',
    'session_hash|bytea|NOT NULL|',
    'auth_epoch|integer|NOT NULL|',
    'encrypted_auth_tokens|bytea|NOT NULL|',
    'expires_at|timestamp with time zone|NOT NULL|',
    'revoked_at|timestamp with time zone|NULL|',
    'created_at|timestamp with time zone|NOT NULL|now()']);
  perform qa.assert_columns('private.auth_throttle'::regclass, array[
    'key_hash|bytea|NOT NULL|',
    'window_start|timestamp with time zone|NOT NULL|',
    'attempts|integer|NOT NULL|0']);
  perform qa.assert_columns('public.profiles'::regclass, array[
    'user_id|uuid|NOT NULL|',
    'language|text|NOT NULL|''ar''::text',
    'time_zone|text|NOT NULL|',
    'session_minutes|smallint|NOT NULL|10',
    'reminder_settings|jsonb|NOT NULL|''{}''::jsonb',
    'pending_settings|jsonb|NULL|',
    'terms_version|text|NOT NULL|',
    'terms_accepted_at|timestamp with time zone|NOT NULL|',
    'is_demo|boolean|NOT NULL|false',
    'created_at|timestamp with time zone|NOT NULL|now()',
    'updated_at|timestamp with time zone|NOT NULL|now()']);
end;
$$;

-- CHECK: 06 keys, foreign keys with their delete actions, and indexes match §6.2 (class A cascades; class F SET NULL on the link column only)
do $$
begin
  perform qa.assert_same_set('account_handles keys', qa.key_defs('private.account_handles'::regclass), array[
    'PRIMARY KEY (user_id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'UNIQUE (username_normalized)',
    'UNIQUE (internal_auth_alias)']);
  perform qa.assert_same_set('account_handles indexes', qa.index_defs('private.account_handles'::regclass), '{}');

  perform qa.assert_same_set('password_reset_grants keys', qa.key_defs('private.password_reset_grants'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'UNIQUE (grant_hash)']);
  perform qa.assert_same_set('password_reset_grants indexes', qa.index_defs('private.password_reset_grants'::regclass), array[
    'CREATE UNIQUE INDEX ON private.password_reset_grants USING btree (user_id) WHERE (status = ANY (ARRAY[''active''::text, ''executing''::text]))']);

  perform qa.assert_same_set('recovery_codes keys', qa.key_defs('private.recovery_codes'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'FOREIGN KEY (reserved_grant_id) REFERENCES private.password_reset_grants(id) ON DELETE SET NULL (reserved_grant_id)']);
  perform qa.assert_same_set('recovery_codes indexes', qa.index_defs('private.recovery_codes'::regclass), array[
    'CREATE UNIQUE INDEX ON private.recovery_codes USING btree (user_id) WHERE (consumed_at IS NULL)',
    'CREATE INDEX ON private.recovery_codes USING btree (reserved_grant_id) WHERE (reserved_grant_id IS NOT NULL)']);

  perform qa.assert_same_set('app_sessions keys', qa.key_defs('private.app_sessions'::regclass), array[
    'PRIMARY KEY (id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    'UNIQUE (session_hash)']);
  perform qa.assert_same_set('app_sessions indexes', qa.index_defs('private.app_sessions'::regclass), array[
    'CREATE INDEX ON private.app_sessions USING btree (user_id)']);

  perform qa.assert_same_set('auth_throttle keys', qa.key_defs('private.auth_throttle'::regclass), array[
    'PRIMARY KEY (key_hash, window_start)']);
  perform qa.assert_same_set('auth_throttle indexes', qa.index_defs('private.auth_throttle'::regclass), array[
    'CREATE INDEX ON private.auth_throttle USING btree (window_start)']);

  perform qa.assert_same_set('profiles keys', qa.key_defs('public.profiles'::regclass), array[
    'PRIMARY KEY (user_id)',
    'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE']);
  perform qa.assert_same_set('profiles indexes', qa.index_defs('public.profiles'::regclass), '{}');
end;
$$;

-- CHECK: 07 account_handles rules: unique username and alias, 3-24 characters, NFKC, lower-case, no whitespace, alias format, epoch
begin;
select qa.make_users();
insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
values (qa.id(901), 'Alice', 'alice', 'u.11111111-1111-4111-8111-111111111111@qatra.invalid');
do $$
declare
  v_alias constant text := 'u.22222222-2222-4222-8222-222222222222@qatra.invalid';
begin
  -- defaults
  if (select auth_epoch from private.account_handles where user_id = qa.id(901)) <> 0
     or (select is_demo from private.account_handles where user_id = qa.id(901)) then
    raise exception 'defaults auth_epoch 0 / is_demo false are not applied';
  end if;

  -- uniqueness
  perform qa.expect_unique(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'Alice2', 'alice', %L)$q$, v_alias), 'account_handles_username_normalized_key');
  perform qa.expect_unique($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'Bob', 'bob', 'u.11111111-1111-4111-8111-111111111111@qatra.invalid')$q$, 'account_handles_internal_auth_alias_key');

  -- lengths 3-24 (display and normalized)
  perform qa.expect_check(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'ab', 'abc', %L)$q$, v_alias), 'account_handles_username_display_length_check');
  perform qa.expect_check(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'abc', 'ab', %L)$q$, v_alias), 'account_handles_username_normalized_length_check');
  perform qa.expect_check(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), %L, 'abc', %L)$q$, repeat('a', 25), v_alias), 'account_handles_username_display_length_check');
  perform qa.expect_check(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'abc', %L, %L)$q$, repeat('a', 25), v_alias), 'account_handles_username_normalized_length_check');
  perform qa.expect_ok(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), %L, %L, %L)$q$, repeat('a', 24), repeat('a', 24), v_alias), '24 characters are accepted');
  delete from private.account_handles where user_id = qa.id(902);

  -- normalized: equal to its own lower(), NFKC, no whitespace
  perform qa.expect_check(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'Bob', 'Bob', %L)$q$, v_alias), 'account_handles_username_normalized_lower_check');
  perform qa.expect_check(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'bob', 'bo b', %L)$q$, v_alias), 'account_handles_username_normalized_space_check');
  -- U+FB01 (a ligature) is not NFKC-normalized (its NFKC form is two letters)
  perform qa.expect_check(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'bob', %L, %L)$q$, 'bo' || chr(64257), v_alias), 'account_handles_username_normalized_nfkc_check');

  -- alias: u.<uuid4>@qatra.invalid only
  perform qa.expect_check($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'bob', 'bob', 'bob@example.com')$q$, 'account_handles_internal_auth_alias_format_check');
  perform qa.expect_check($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'bob', 'bob', 'u.22222222-2222-1222-8222-222222222222@qatra.invalid')$q$, 'account_handles_internal_auth_alias_format_check');
  perform qa.expect_check($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(902), 'bob', 'bob', 'u.22222222-2222-4222-8222-222222222222@example.com')$q$, 'account_handles_internal_auth_alias_format_check');

  -- epoch >= 0
  perform qa.expect_check(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias, auth_epoch)
    values (qa.id(902), 'bob', 'bob', %L, -1)$q$, v_alias), 'account_handles_auth_epoch_check');

  -- a handle needs its Auth user (class A foreign key)
  perform qa.expect_fk(format($q$insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias)
    values (qa.id(950), 'bob', 'bob', %L)$q$, v_alias), 'account_handles_user_id_fkey');
end;
$$;
rollback;

-- CHECK: 08 password_reset_grants: status set, 32-byte hash, expiry after creation, one live grant per account
begin;
select qa.make_users();
do $$
declare
  v_status text;
  v_hash   bytea := decode(repeat('ab', 32), 'hex');
begin
  -- the four statuses are accepted, anything else is not (A-05)
  foreach v_status in array array['active', 'executing', 'consumed', 'cancelled'] loop
    perform qa.expect_ok(format($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
      values (qa.id(902), decode(repeat('f0', 32), 'hex'), now() + interval '10 minutes', %L)$q$, v_status), 'status ' || v_status);
    delete from private.password_reset_grants where user_id = qa.id(902);
  end loop;
  perform qa.expect_check($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(902), decode(repeat('01', 32), 'hex'), now() + interval '10 minutes', 'bogus')$q$, 'password_reset_grants_status_check');
  perform qa.expect_check($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(902), decode(repeat('01', 32), 'hex'), now() + interval '10 minutes', 'Active')$q$, 'password_reset_grants_status_check');

  -- default status
  insert into private.password_reset_grants (user_id, grant_hash, expires_at)
  values (qa.id(901), v_hash, now() + interval '10 minutes');
  if (select status from private.password_reset_grants where user_id = qa.id(901)) <> 'active' then
    raise exception 'default status is not active';
  end if;

  -- grant_hash: unique and exactly 32 bytes
  perform qa.expect_unique($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(902), decode(repeat('ab', 32), 'hex'), now() + interval '10 minutes', 'cancelled')$q$, 'password_reset_grants_grant_hash_key');
  perform qa.expect_check($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at)
    values (qa.id(902), decode(repeat('ab', 31), 'hex'), now() + interval '10 minutes')$q$, 'password_reset_grants_grant_hash_length_check');
  perform qa.expect_check($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at)
    values (qa.id(902), decode(repeat('ab', 33), 'hex'), now() + interval '10 minutes')$q$, 'password_reset_grants_grant_hash_length_check');

  -- expires_at > created_at
  perform qa.expect_check($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at)
    values (qa.id(902), decode(repeat('02', 32), 'hex'), now())$q$, 'password_reset_grants_expires_at_check');
  perform qa.expect_check($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at)
    values (qa.id(902), decode(repeat('02', 32), 'hex'), now() - interval '1 minute')$q$, 'password_reset_grants_expires_at_check');

  -- at most one live (active or executing) grant per account
  perform qa.expect_unique($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(901), decode(repeat('03', 32), 'hex'), now() + interval '10 minutes', 'active')$q$, 'password_reset_grants_user_id_live_key');
  perform qa.expect_unique($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(901), decode(repeat('04', 32), 'hex'), now() + interval '10 minutes', 'executing')$q$, 'password_reset_grants_user_id_live_key');
  -- terminal grants do not count, and another account is independent
  perform qa.expect_ok($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(901), decode(repeat('05', 32), 'hex'), now() + interval '10 minutes', 'consumed')$q$, 'a consumed grant beside a live one');
  perform qa.expect_ok($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(901), decode(repeat('06', 32), 'hex'), now() + interval '10 minutes', 'cancelled')$q$, 'a cancelled grant beside a live one');
  perform qa.expect_ok($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(902), decode(repeat('07', 32), 'hex'), now() + interval '10 minutes', 'active')$q$, 'a live grant of another account');
  -- cancelling the live grant frees the slot
  update private.password_reset_grants set status = 'cancelled' where user_id = qa.id(901) and status = 'active';
  perform qa.expect_ok($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(901), decode(repeat('08', 32), 'hex'), now() + interval '10 minutes', 'active')$q$, 'a new live grant after cancelling');
  -- an executing grant also blocks a second one
  update private.password_reset_grants set status = 'executing' where user_id = qa.id(901) and status = 'active';
  perform qa.expect_unique($q$insert into private.password_reset_grants (user_id, grant_hash, expires_at, status)
    values (qa.id(901), decode(repeat('09', 32), 'hex'), now() + interval '10 minutes', 'active')$q$, 'password_reset_grants_user_id_live_key');
end;
$$;
rollback;

-- CHECK: 09 recovery_codes: one active code per account, 32-byte hash, reservation end time, SET NULL on the reserved grant only
begin;
select qa.make_users();
do $$
declare
  v_grant uuid;
begin
  insert into private.recovery_codes (user_id, code_hash) values (qa.id(901), decode(repeat('a1', 32), 'hex'));

  -- exactly one active (not consumed) code per account
  perform qa.expect_unique($q$insert into private.recovery_codes (user_id, code_hash)
    values (qa.id(901), decode(repeat('a2', 32), 'hex'))$q$, 'recovery_codes_user_id_active_key');
  perform qa.expect_ok($q$insert into private.recovery_codes (user_id, code_hash)
    values (qa.id(902), decode(repeat('a3', 32), 'hex'))$q$, 'an active code of another account');
  -- consuming (or rotating) the code frees the slot; consumed codes may accumulate
  update private.recovery_codes set consumed_at = now() where user_id = qa.id(901);
  perform qa.expect_ok($q$insert into private.recovery_codes (user_id, code_hash)
    values (qa.id(901), decode(repeat('a4', 32), 'hex'))$q$, 'a new active code after consuming');
  update private.recovery_codes set consumed_at = now() where user_id = qa.id(901);
  perform qa.expect_ok($q$insert into private.recovery_codes (user_id, code_hash)
    values (qa.id(901), decode(repeat('a5', 32), 'hex'))$q$, 'a second new active code after consuming');

  -- the hash is exactly 32 bytes
  perform qa.expect_check($q$insert into private.recovery_codes (user_id, code_hash, consumed_at)
    values (qa.id(901), decode(repeat('a6', 16), 'hex'), now())$q$, 'recovery_codes_code_hash_length_check');

  -- a reservation always carries its end time
  insert into private.password_reset_grants (user_id, grant_hash, expires_at)
  values (qa.id(902), decode(repeat('b1', 32), 'hex'), now() + interval '10 minutes')
  returning id into v_grant;
  perform qa.expect_check(format($q$update private.recovery_codes set reserved_grant_id = %L where user_id = qa.id(902)$q$, v_grant),
    'recovery_codes_reserved_until_check');
  perform qa.expect_ok(format($q$update private.recovery_codes set reserved_grant_id = %L, reserved_until = now() + interval '10 minutes' where user_id = qa.id(902)$q$, v_grant),
    'a reservation with its end time');

  -- class F: deleting the grant clears the link column only; the code row stays
  delete from private.password_reset_grants where id = v_grant;
  if (select reserved_grant_id from private.recovery_codes where user_id = qa.id(902)) is not null then
    raise exception 'reserved_grant_id was not set to NULL';
  end if;
  if (select user_id from private.recovery_codes where code_hash = decode(repeat('a3', 32), 'hex')) is distinct from qa.id(902) then
    raise exception 'the recovery code row or its user_id changed when the grant was deleted';
  end if;

  -- the reserved grant must exist
  perform qa.expect_fk($q$update private.recovery_codes set reserved_grant_id = gen_random_uuid(), reserved_until = now() where user_id = qa.id(902)$q$,
    'recovery_codes_reserved_grant_id_fkey');
end;
$$;
rollback;

-- CHECK: 10 app_sessions and auth_throttle rules: unique fingerprint, 32-byte hashes, epoch, expiry, bucket key, attempts
begin;
select qa.make_users();
do $$
begin
  insert into private.app_sessions (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at)
  values (qa.id(901), decode(repeat('c1', 32), 'hex'), 0, '\x01', now() + interval '30 days');

  perform qa.expect_unique($q$insert into private.app_sessions (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at)
    values (qa.id(902), decode(repeat('c1', 32), 'hex'), 0, '\x01', now() + interval '30 days')$q$, 'app_sessions_session_hash_key');
  perform qa.expect_check($q$insert into private.app_sessions (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at)
    values (qa.id(902), decode(repeat('c2', 31), 'hex'), 0, '\x01', now() + interval '30 days')$q$, 'app_sessions_session_hash_length_check');
  perform qa.expect_check($q$insert into private.app_sessions (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at)
    values (qa.id(902), decode(repeat('c3', 32), 'hex'), -1, '\x01', now() + interval '30 days')$q$, 'app_sessions_auth_epoch_check');
  perform qa.expect_check($q$insert into private.app_sessions (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at)
    values (qa.id(902), decode(repeat('c4', 32), 'hex'), 0, '\x01', now())$q$, 'app_sessions_expires_at_check');
  -- revoked_at is nullable and defaults to null; several sessions per account are allowed
  if (select revoked_at from private.app_sessions where user_id = qa.id(901)) is not null then
    raise exception 'revoked_at is not null by default';
  end if;
  perform qa.expect_ok($q$insert into private.app_sessions (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at)
    values (qa.id(901), decode(repeat('c5', 32), 'hex'), 0, '\x01', now() + interval '30 days')$q$, 'a second session of one account');

  -- auth_throttle: no user link, key (key_hash, window_start)
  insert into private.auth_throttle (key_hash, window_start) values (decode(repeat('d1', 32), 'hex'), date_trunc('minute', now()));
  if (select attempts from private.auth_throttle) <> 0 then
    raise exception 'attempts does not default to 0';
  end if;
  perform qa.expect_error($q$insert into private.auth_throttle (key_hash, window_start, attempts)
    values (decode(repeat('d1', 32), 'hex'), date_trunc('minute', now()), 1)$q$, '23505', 'duplicate bucket', 'auth_throttle_pkey');
  perform qa.expect_ok($q$insert into private.auth_throttle (key_hash, window_start, attempts)
    values (decode(repeat('d1', 32), 'hex'), date_trunc('minute', now()) - interval '1 minute', 1)$q$, 'a second bucket of the key');
  perform qa.expect_check($q$insert into private.auth_throttle (key_hash, window_start, attempts)
    values (decode(repeat('d2', 31), 'hex'), now(), 1)$q$, 'auth_throttle_key_hash_length_check');
  perform qa.expect_check($q$insert into private.auth_throttle (key_hash, window_start, attempts)
    values (decode(repeat('d3', 32), 'hex'), now(), -1)$q$, 'auth_throttle_attempts_check');
  if exists (select 1 from information_schema.columns
             where table_schema = 'private' and table_name = 'auth_throttle' and column_name like '%user%') then
    raise exception 'auth_throttle has a user column';
  end if;
end;
$$;
rollback;

-- CHECK: 11 validate_profile and the profile rules: time zones, minutes 5/10/15, languages, terms fields, jsonb containers
begin;
select qa.make_users();
do $$
declare
  v text;
  n integer;
begin
  -- a valid profile; defaults of §6.2
  insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
  values (qa.id(901), 'Asia/Dubai', '2026-10-04', now());
  if (select (language, session_minutes, reminder_settings::text, is_demo, pending_settings is null)::text
      from public.profiles where user_id = qa.id(901)) <> '(ar,10,{},f,t)' then
    raise exception 'profile defaults differ from §6.2';
  end if;

  -- time_zone: a known IANA zone only (trigger validate_profile, D57)
  perform qa.expect_check($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
    values (qa.id(902), 'Mars/Olympus', '2026-10-04', now())$q$, 'profiles_time_zone_known_check');
  perform qa.expect_check($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
    values (qa.id(902), 'dubai', '2026-10-04', now())$q$, 'profiles_time_zone_known_check');
  perform qa.expect_check($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
    values (qa.id(902), '+04:00', '2026-10-04', now())$q$, 'profiles_time_zone_known_check');
  perform qa.expect_check($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
    values (qa.id(902), ' ', '2026-10-04', now())$q$, 'profiles_time_zone_known_check');
  foreach v in array array['UTC', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'Asia/Kolkata'] loop
    perform qa.expect_ok(format($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
      values (qa.id(902), %L, '2026-10-04', now())$q$, v), 'zone ' || v);
    delete from public.profiles where user_id = qa.id(902);
  end loop;
  -- on update: a changed zone is validated, an unchanged one is not re-validated
  perform qa.expect_check($q$update public.profiles set time_zone = 'Mars/Olympus' where user_id = qa.id(901)$q$, 'profiles_time_zone_known_check');
  perform qa.expect_ok($q$update public.profiles set time_zone = 'Europe/London' where user_id = qa.id(901)$q$, 'valid zone change');
  perform qa.expect_ok($q$update public.profiles set language = 'en' where user_id = qa.id(901)$q$, 'unrelated update');

  -- pending_settings: null, or an object with effectiveDate; its timeZone, when present, must be known
  perform qa.expect_ok($q$update public.profiles set pending_settings = '{"effectiveDate": "2026-10-06"}' where user_id = qa.id(901)$q$, 'pending without timeZone');
  perform qa.expect_ok($q$update public.profiles set pending_settings = '{"effectiveDate": "2026-10-06", "timeZone": "Asia/Dubai", "sessionMinutes": 15}' where user_id = qa.id(901)$q$, 'pending with a known timeZone');
  perform qa.expect_ok($q$update public.profiles set pending_settings = null where user_id = qa.id(901)$q$, 'pending null');
  perform qa.expect_check($q$update public.profiles set pending_settings = '{"effectiveDate": "2026-10-06", "timeZone": "Mars/Olympus"}' where user_id = qa.id(901)$q$, 'profiles_pending_time_zone_known_check');
  perform qa.expect_check($q$update public.profiles set pending_settings = '{"effectiveDate": "2026-10-06", "timeZone": 4}' where user_id = qa.id(901)$q$, 'profiles_pending_time_zone_known_check');
  perform qa.expect_check($q$update public.profiles set pending_settings = '{"timeZone": "Asia/Dubai"}' where user_id = qa.id(901)$q$, 'profiles_pending_settings_check');
  perform qa.expect_check($q$update public.profiles set pending_settings = '[]' where user_id = qa.id(901)$q$, 'profiles_pending_settings_check');
  perform qa.expect_check($q$update public.profiles set pending_settings = '"effectiveDate"' where user_id = qa.id(901)$q$, 'profiles_pending_settings_check');
  perform qa.expect_check($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at, pending_settings)
    values (qa.id(902), 'UTC', '2026-10-04', now(), '{"effectiveDate": "2026-10-06", "timeZone": "Mars/Olympus"}')$q$, 'profiles_pending_time_zone_known_check');

  -- session_minutes: 5, 10 or 15 (R01, D34)
  foreach n in array array[5, 10, 15] loop
    perform qa.expect_ok(format($q$update public.profiles set session_minutes = %s where user_id = qa.id(901)$q$, n), 'minutes ' || n);
  end loop;
  foreach n in array array[0, 1, 7, 20, -5] loop
    perform qa.expect_check(format($q$update public.profiles set session_minutes = %s where user_id = qa.id(901)$q$, n), 'profiles_session_minutes_check');
  end loop;

  -- language: ar or en (PRD R11)
  perform qa.expect_ok($q$update public.profiles set language = 'ar' where user_id = qa.id(901)$q$, 'language ar');
  perform qa.expect_ok($q$update public.profiles set language = 'en' where user_id = qa.id(901)$q$, 'language en');
  foreach v in array array['fr', 'AR', '', 'ar-AE'] loop
    perform qa.expect_check(format($q$update public.profiles set language = %L where user_id = qa.id(901)$q$, v), 'profiles_language_check');
  end loop;

  -- terms fields: both mandatory, the version non-empty
  perform qa.expect_check($q$update public.profiles set terms_version = '' where user_id = qa.id(901)$q$, 'profiles_terms_version_check');
  perform qa.expect_check($q$update public.profiles set terms_version = '  ' where user_id = qa.id(901)$q$, 'profiles_terms_version_check');
  perform qa.expect_error($q$update public.profiles set terms_version = null where user_id = qa.id(901)$q$, '23502', 'terms_version null');
  perform qa.expect_error($q$update public.profiles set terms_accepted_at = null where user_id = qa.id(901)$q$, '23502', 'terms_accepted_at null');
  perform qa.expect_error($q$insert into public.profiles (user_id, time_zone, terms_version) values (qa.id(902), 'UTC', '2026-10-04')$q$, '23502', 'terms_accepted_at has no default');
  perform qa.expect_error($q$insert into public.profiles (user_id, time_zone, terms_accepted_at) values (qa.id(902), 'UTC', now())$q$, '23502', 'terms_version has no default');
  perform qa.expect_error($q$insert into public.profiles (user_id, terms_version, terms_accepted_at) values (qa.id(902), '2026-10-04', now())$q$, '23502', 'time_zone has no default');

  -- reminder_settings: an object
  perform qa.expect_ok($q$update public.profiles set reminder_settings = '{"enabled": true}' where user_id = qa.id(901)$q$, 'reminder object');
  perform qa.expect_check($q$update public.profiles set reminder_settings = '[]' where user_id = qa.id(901)$q$, 'profiles_reminder_settings_check');
  perform qa.expect_check($q$update public.profiles set reminder_settings = 'true' where user_id = qa.id(901)$q$, 'profiles_reminder_settings_check');

  -- a profile needs its Auth user and is unique per user
  perform qa.expect_fk($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
    values (qa.id(950), 'UTC', '2026-10-04', now())$q$, 'profiles_user_id_fkey');
  perform qa.expect_error($q$insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at)
    values (qa.id(901), 'UTC', '2026-10-04', now())$q$, '23505', 'one profile per user', 'profiles_pkey');
end;
$$;
rollback;

-- CHECK: 12 triggers: set_updated_at and validate_profile on profiles only; validate_profile is security definer with an empty search path and closed to the API roles
do $$
declare
  v_missing text[];
  v_extra   text[];
begin
  with expected(tbl, trg, fn, timing_events) as (
    values ('profiles', 'profiles_set_updated_at',  'set_updated_at',   'BEFORE UPDATE'),
           ('profiles', 'profiles_validate_profile', 'validate_profile', 'BEFORE INSERT OR UPDATE')
  ), actual as (
    select c.relname::text as tbl, t.tgname::text as trg, p.proname::text as fn,
           case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end
           || ' ' || concat_ws(' OR ',
                case when (t.tgtype & 4) <> 0 then 'INSERT' end,
                case when (t.tgtype & 16) <> 0 then 'UPDATE' end,
                case when (t.tgtype & 8) <> 0 then 'DELETE' end) as timing_events
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal
      and (n.nspname = 'private' or c.relname = 'profiles')
  )
  select
    (select array_agg(e.trg) from expected e where not exists (select 1 from actual a where a.trg = e.trg and a.tbl = e.tbl and a.fn = e.fn and a.timing_events = e.timing_events)),
    (select array_agg(a.trg) from actual a where not exists (select 1 from expected e where a.trg = e.trg and a.tbl = e.tbl and a.fn = e.fn and a.timing_events = e.timing_events))
  into v_missing, v_extra;
  if v_missing is not null or v_extra is not null then
    raise exception 'trigger mismatch: missing %, unexpected %', v_missing, v_extra;
  end if;

  -- validate_profile: security definer, search_path = '', private schema, closed to the API roles
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'validate_profile' and p.prosecdef
      and p.proconfig @> array['search_path=""']) then
    raise exception 'private.validate_profile is not security definer with an empty search_path';
  end if;
  if has_function_privilege('anon', 'private.validate_profile()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.validate_profile()', 'EXECUTE')
     or has_function_privilege('service_role', 'private.validate_profile()', 'EXECUTE') then
    raise exception 'an API role can execute private.validate_profile';
  end if;
end;
$$;

-- CHECK: 13 set_updated_at refreshes profiles.updated_at; the trigger fires although the API roles cannot execute the function
begin;
select qa.make_users();
insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at, updated_at)
values (qa.id(901), 'UTC', '2026-10-04', now(), timestamptz '2000-01-01 00:00:00+00');
update public.profiles set language = 'en' where user_id = qa.id(901);
do $$
begin
  if (select updated_at from public.profiles where user_id = qa.id(901)) < now() - interval '1 minute' then
    raise exception 'updated_at was not refreshed by the trigger';
  end if;
end;
$$;
rollback;

-- CHECK: 14 class A: deleting the Auth user removes its profile, handle, recovery codes, grants and sessions (and only its own)
begin;
select qa.make_users();
do $$
declare
  v_grant uuid;
begin
  insert into private.account_handles (user_id, username_display, username_normalized, internal_auth_alias) values
    (qa.id(901), 'alice', 'alice', 'u.11111111-1111-4111-8111-111111111111@qatra.invalid'),
    (qa.id(902), 'bob',   'bob',   'u.22222222-2222-4222-8222-222222222222@qatra.invalid');
  insert into public.profiles (user_id, time_zone, terms_version, terms_accepted_at) values
    (qa.id(901), 'UTC', '2026-10-04', now()), (qa.id(902), 'UTC', '2026-10-04', now());
  insert into private.recovery_codes (user_id, code_hash) values
    (qa.id(901), decode(repeat('a1', 32), 'hex')), (qa.id(902), decode(repeat('a2', 32), 'hex'));
  insert into private.password_reset_grants (user_id, grant_hash, expires_at) values
    (qa.id(901), decode(repeat('b1', 32), 'hex'), now() + interval '10 minutes'),
    (qa.id(902), decode(repeat('b2', 32), 'hex'), now() + interval '10 minutes');
  insert into private.app_sessions (user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at) values
    (qa.id(901), decode(repeat('c1', 32), 'hex'), 0, '\x01', now() + interval '30 days'),
    (qa.id(902), decode(repeat('c2', 32), 'hex'), 0, '\x01', now() + interval '30 days');

  delete from auth.users where id = qa.id(901);

  if exists (select 1 from private.account_handles where user_id = qa.id(901))
     or exists (select 1 from public.profiles where user_id = qa.id(901))
     or exists (select 1 from private.recovery_codes where user_id = qa.id(901))
     or exists (select 1 from private.password_reset_grants where user_id = qa.id(901))
     or exists (select 1 from private.app_sessions where user_id = qa.id(901)) then
    raise exception 'rows of the deleted Auth user remain';
  end if;
  if (select count(*) from private.account_handles) <> 1
     or (select count(*) from public.profiles) <> 1
     or (select count(*) from private.recovery_codes) <> 1
     or (select count(*) from private.password_reset_grants) <> 1
     or (select count(*) from private.app_sessions) <> 1 then
    raise exception 'rows of another account were removed';
  end if;
end;
$$;
rollback;

-- CHECK: 15 no seed rows: the six tables are empty
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array['private.account_handles', 'private.password_reset_grants',
                           'private.recovery_codes', 'private.app_sessions',
                           'private.auth_throttle', 'public.profiles'] loop
    execute format('select count(*) from %s', t) into n;
    if n <> 0 then
      raise exception '% holds % rows after the migration', t, n;
    end if;
  end loop;
end;
$$;
