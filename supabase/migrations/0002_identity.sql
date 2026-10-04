-- 0002_identity
--
-- Identity boundary of the Qatra database: the limited database role `qatra_server`,
-- five private tables (schema `private`), `public.profiles`, and the trigger helper
-- `private.validate_profile`.
--
-- Source: docs/Database-schema.md v1.1 (approved by the owner, D74, 4 October 2026):
-- §3.2 identity ERD, §4 conventions, §5.1 roles, §5.2 grant posture, §6.2 identity
-- tables, §10 trigger helpers, §11 migration plan `0002_identity`.
--
-- Scope notes
--   * The role `qatra_server` is created only if absent, WITHOUT a password: the owner
--     sets it out of band at provisioning (§5.1, directive 7, D69). It holds no
--     privilege yet; `USAGE` on `public` and `EXECUTE` on the `srv_*` functions arrive in
--     `0005_rls_functions`. No `CONNECTION LIMIT`, `statement_timeout` or role-level
--     `search_path` is set here: those values are chosen at provisioning (OPEN-15).
--   * Every table enables row level security (not forced) and revokes every privilege of
--     `anon`, `authenticated` and `service_role`. No policy exists on any private table:
--     the owner-run `srv_*` functions of 0005 are the only access (default deny).
--   * No seed rows. Nothing here is applied to any Supabase project by this file's
--     existence.

-- ---------------------------------------------------------------------------
-- 1. Role `qatra_server` (§5.1): created only if absent, no password
-- ---------------------------------------------------------------------------

do $$
declare
  v_role pg_catalog.pg_roles%rowtype;
begin
  select * into v_role from pg_catalog.pg_roles where rolname = 'qatra_server';

  if not found then
    create role qatra_server
      login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  elsif v_role.rolsuper or v_role.rolcreatedb or v_role.rolcreaterole
        or v_role.rolreplication or v_role.rolbypassrls or not v_role.rolcanlogin then
    -- A role that already exists keeps its password and settings; only the posture
    -- of §5.1 is restored, and only when it differs.
    alter role qatra_server
      login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Trigger helper (§10): schema private, search_path = '', security definer
-- ---------------------------------------------------------------------------

-- Before insert or update on profiles: `time_zone`, and `pending_settings.timeZone` when
-- present, must be a known IANA zone of the server's zone list (D57, R10). Security
-- definer as stated by §10; it reads only the system view of zone names.
create function private.validate_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- a NULL zone is left to the NOT NULL constraint
  if new.time_zone is not null
     and (tg_op = 'INSERT' or new.time_zone is distinct from old.time_zone) then
    if not exists (
      select 1 from pg_catalog.pg_timezone_names z where z.name = new.time_zone
    ) then
      raise exception 'profiles.time_zone is not a known IANA time zone'
        using errcode = 'check_violation',
              table = 'profiles',
              constraint = 'profiles_time_zone_known_check';
    end if;
  end if;

  if new.pending_settings is not null
     and new.pending_settings ? 'timeZone'
     and (tg_op = 'INSERT' or new.pending_settings is distinct from old.pending_settings) then
    if pg_catalog.jsonb_typeof(new.pending_settings -> 'timeZone') is distinct from 'string'
       or not exists (
         select 1 from pg_catalog.pg_timezone_names z
         where z.name = new.pending_settings ->> 'timeZone'
       ) then
      raise exception 'profiles.pending_settings.timeZone is not a known IANA time zone'
        using errcode = 'check_violation',
              table = 'profiles',
              constraint = 'profiles_pending_time_zone_known_check';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.validate_profile() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Tables, in dependency order (§11 item 2)
-- ---------------------------------------------------------------------------

-- 3.1 private.account_handles -----------------------------------------------

create table private.account_handles (
  user_id             uuid        not null,
  username_display    text        not null,
  username_normalized text        not null,
  internal_auth_alias text        not null,
  auth_epoch          integer     not null default 0,
  is_demo             boolean     not null default false,
  created_at          timestamptz not null default now(),
  constraint account_handles_pkey primary key (user_id),
  constraint account_handles_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint account_handles_username_normalized_key unique (username_normalized),
  constraint account_handles_internal_auth_alias_key unique (internal_auth_alias),
  constraint account_handles_username_display_length_check
    check (char_length(username_display) between 3 and 24),
  constraint account_handles_username_normalized_length_check
    check (char_length(username_normalized) between 3 and 24),
  -- NFKC-normalized, equal to its own lower(), no whitespace (contract §6)
  constraint account_handles_username_normalized_nfkc_check
    check (is_normalized(username_normalized, 'NFKC')),
  constraint account_handles_username_normalized_lower_check
    check (username_normalized = lower(username_normalized)),
  constraint account_handles_username_normalized_space_check
    check (username_normalized !~ '\s'),
  -- the technical address u.<uuid4>@qatra.invalid (never a learner email)
  constraint account_handles_internal_auth_alias_format_check
    check (internal_auth_alias ~ '^u\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@qatra\.invalid$'),
  constraint account_handles_auth_epoch_check check (auth_epoch >= 0)
);
comment on table private.account_handles is 'Username, internal Auth alias and auth epoch of an account; reachable only through the srv_* functions.';

alter table private.account_handles enable row level security;
revoke all on table private.account_handles from anon, authenticated, service_role;

-- 3.2 private.password_reset_grants -----------------------------------------

create table private.password_reset_grants (
  id         uuid        not null default gen_random_uuid(),
  user_id    uuid        not null,
  grant_hash bytea       not null,
  expires_at timestamptz not null,
  status     text        not null default 'active',
  created_at timestamptz not null default now(),
  constraint password_reset_grants_pkey primary key (id),
  constraint password_reset_grants_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint password_reset_grants_grant_hash_key unique (grant_hash),
  constraint password_reset_grants_grant_hash_length_check check (octet_length(grant_hash) = 32),
  constraint password_reset_grants_expires_at_check check (expires_at > created_at),
  constraint password_reset_grants_status_check
    check (status in ('active', 'executing', 'consumed', 'cancelled'))
);
comment on table private.password_reset_grants is 'Short-lived permission for one password change (recovery steps 2-5); only the HMAC fingerprint is stored.';

-- at most one live grant per account: two simultaneous requests cannot hold two active grants
create unique index password_reset_grants_user_id_live_key
  on private.password_reset_grants (user_id)
  where status in ('active', 'executing');

alter table private.password_reset_grants enable row level security;
revoke all on table private.password_reset_grants from anon, authenticated, service_role;

-- 3.3 private.recovery_codes ------------------------------------------------

create table private.recovery_codes (
  id                uuid        not null default gen_random_uuid(),
  user_id           uuid        not null,
  code_hash         bytea       not null,
  created_at        timestamptz not null default now(),
  reserved_grant_id uuid,
  reserved_until    timestamptz,
  consumed_at       timestamptz,
  constraint recovery_codes_pkey primary key (id),
  constraint recovery_codes_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  -- class F: SET NULL on the link column only (column-list form, PostgreSQL 15 or later)
  constraint recovery_codes_reserved_grant_id_fkey
    foreign key (reserved_grant_id) references private.password_reset_grants (id)
    on delete set null (reserved_grant_id),
  constraint recovery_codes_code_hash_length_check check (octet_length(code_hash) = 32),
  -- a reservation always carries its end time
  constraint recovery_codes_reserved_until_check
    check (reserved_grant_id is null or reserved_until is not null)
);
comment on table private.recovery_codes is 'HMAC fingerprints of recovery codes; exactly one active (not consumed) code per account.';

-- exactly one active code per account
create unique index recovery_codes_user_id_active_key
  on private.recovery_codes (user_id)
  where consumed_at is null;
-- foreign-key support
create index recovery_codes_reserved_grant_id_idx
  on private.recovery_codes (reserved_grant_id)
  where reserved_grant_id is not null;

alter table private.recovery_codes enable row level security;
revoke all on table private.recovery_codes from anon, authenticated, service_role;

-- 3.4 private.app_sessions --------------------------------------------------

create table private.app_sessions (
  id                    uuid        not null default gen_random_uuid(),
  user_id               uuid        not null,
  session_hash          bytea       not null,
  auth_epoch            integer     not null,
  encrypted_auth_tokens bytea       not null,
  expires_at            timestamptz not null,
  revoked_at            timestamptz,
  created_at            timestamptz not null default now(),
  constraint app_sessions_pkey primary key (id),
  constraint app_sessions_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint app_sessions_session_hash_key unique (session_hash),
  constraint app_sessions_session_hash_length_check check (octet_length(session_hash) = 32),
  constraint app_sessions_auth_epoch_check check (auth_epoch >= 0),
  constraint app_sessions_expires_at_check check (expires_at > created_at)
);
comment on table private.app_sessions is 'Application sessions (cookie token fingerprint, encrypted Auth tokens); a session is live only while its epoch equals the account epoch.';

create index app_sessions_user_id_idx on private.app_sessions (user_id);

alter table private.app_sessions enable row level security;
revoke all on table private.app_sessions from anon, authenticated, service_role;

-- 3.5 private.auth_throttle -------------------------------------------------

create table private.auth_throttle (
  key_hash     bytea       not null,
  window_start timestamptz not null,
  attempts     integer     not null default 0,
  constraint auth_throttle_pkey primary key (key_hash, window_start),
  constraint auth_throttle_key_hash_length_check check (octet_length(key_hash) = 32),
  constraint auth_throttle_attempts_check check (attempts >= 0)
);
comment on table private.auth_throttle is 'One-minute attempt buckets per HMAC key; no user link by design (A-03); purged after 24 hours by srv_throttle_record.';

-- the bounded 24-hour purge inside srv_throttle_record
create index auth_throttle_window_start_idx on private.auth_throttle (window_start);

alter table private.auth_throttle enable row level security;
revoke all on table private.auth_throttle from anon, authenticated, service_role;

-- 3.6 public.profiles -------------------------------------------------------

create table public.profiles (
  user_id            uuid        not null,
  language           text        not null default 'ar',
  time_zone          text        not null,
  session_minutes    smallint    not null default 10,
  reminder_settings  jsonb       not null default '{}',
  pending_settings   jsonb,
  terms_version      text        not null,
  terms_accepted_at  timestamptz not null,
  is_demo            boolean     not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint profiles_pkey primary key (user_id),
  constraint profiles_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint profiles_language_check check (language in ('ar', 'en')),
  constraint profiles_session_minutes_check check (session_minutes in (5, 10, 15)),
  constraint profiles_reminder_settings_check check (jsonb_typeof(reminder_settings) = 'object'),
  -- NULL, or an object with an effectiveDate (D57)
  constraint profiles_pending_settings_check
    check (pending_settings is null
           or (jsonb_typeof(pending_settings) = 'object' and pending_settings ? 'effectiveDate')),
  constraint profiles_terms_version_check check (btrim(terms_version) <> '')
);
comment on table public.profiles is 'Account settings and the consent record; nothing else about the person (D15, D52).';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

create trigger profiles_validate_profile
  before insert or update on public.profiles
  for each row execute function private.validate_profile();

alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated, service_role;
