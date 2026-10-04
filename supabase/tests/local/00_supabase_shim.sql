-- 00_supabase_shim.sql
--
-- LOCAL VALIDATION ONLY. Never run against a real Supabase project or any shared
-- database: it creates stand-ins for what a Supabase project already provides, so that
-- the migrations in supabase/migrations/ can be applied to a scratch PostgreSQL 16
-- database. Nothing here is part of the product schema.
--
-- Emulated (minimal, only what the migrations rely on):
--   * roles anon, authenticated, service_role (nologin; service_role bypasses RLS)
--   * schema auth: users table and auth.uid()
--   * schema storage: buckets and objects (RLS enabled, no policy), as in a new project
--   * schema extensions
--   * the platform default privileges on new public objects, which the migrations must
--     revoke (Database-schema.md §5.2 item 1; OPEN-15 asks to confirm the real defaults)
--
-- Not emulated: the non-superuser `postgres` owner of a hosted project (locally the
-- migrations run as the cluster superuser), the Data API, Auth, the Storage service.

-- Roles are cluster-wide and survive the scratch database; create only if absent.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

-- gen_random_uuid() is built into PostgreSQL 13 and later; fail early if it is missing.
select gen_random_uuid() is not null as gen_random_uuid_available \gset
\if :gen_random_uuid_available
\else
  \echo 'gen_random_uuid() is unavailable'
  select 1/0;
\endif

-- Schemas a Supabase project provides.
create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
grant usage on schema public, extensions to anon, authenticated, service_role;
grant usage on schema auth, storage to anon, authenticated, service_role;

-- auth: minimal users table and auth.uid().
create table auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz default now()
);
alter table auth.users enable row level security;

create function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- storage: minimal buckets and objects, RLS enabled and no policy (as in a new project).
create table storage.buckets (
  id         text primary key,
  name       text not null,
  public     boolean not null default false,
  created_at timestamptz default now()
);
alter table storage.buckets enable row level security;

create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;

grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- Platform default privileges: a hosted project grants broad privileges on new objects
-- in public to the three API roles. The migrations must revoke them where required.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
