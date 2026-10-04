# Local migration validation (scratch PostgreSQL only)

This folder holds a **local validation harness** for `supabase/migrations/*.sql`. It applies the
migrations to a throwaway PostgreSQL 16 database and runs assertions against the result.

- It is **not** a deployment tool and **never** touches a Supabase project, Render, Vercel or any
  cloud service. Do not point it at production or at any shared database.
- It is **not** the security review that `Database-schema.md` §11 item 7 requires before production
  use. It checks that the migration builds what the approved schema (`docs/Database-schema.md`
  v1.1, approved by D74) describes, on a stand-in for a Supabase project.
- It uses synthetic placeholder rows only (for example the word `test`). No source text, secret or
  personal data belongs here.

## Files

| File | Purpose |
|---|---|
| `00_supabase_shim.sql` | Stand-ins for what a Supabase project already provides: roles `anon`, `authenticated`, `service_role`; schemas `auth` (users, `auth.uid()`), `storage` (buckets, objects with RLS and no policy) and `extensions`; and the platform default privileges on new `public` objects that the migrations must revoke. |
| `01_check_helpers.sql` | Helper functions in a scratch schema `qa` (expected-error assertions, a synthetic row graph `qa.make_fixture()`). |
| `run_local.sh` | The runner. |
| `checks_NNNN.sql` | Assertions for migration `NNNN_*.sql`; run right after that migration is applied. `checks_0001.sql` covers `0001_content`. |

## Run

Requirements: PostgreSQL 16 (15 or later is required by the schema), the `pgvector` package
(`apt-get install -y postgresql-16-pgvector`), and either root (the script uses
`runuser -u postgres`) or `PG*` variables that reach a superuser.

```bash
cd qatra-app
bash supabase/tests/local/run_local.sh
```

What the script does:

1. Starts cluster `16/main` if it is down (`pg_ctlcluster`, root only) and waits for it.
2. Creates a fresh database `qatra_local_<pid>` (UTF8).
3. Applies the shim and the helpers, then every `supabase/migrations/NNNN_*.sql` in sorted order with
   `psql -v ON_ERROR_STOP=1 --single-transaction`. After each migration it runs the checks file with
   the same prefix, if one exists (`checks_0001.sql` after `0001_*.sql`), so each check sees the
   database exactly as that migration left it (later migrations add policies and grants that would
   change what a `0001` check may assert).
4. Prints `PASS` or `FAIL` for each check (each `-- CHECK:` block of a checks file is one
   independent check) and a summary; the exit code is non-zero if anything failed.
5. Drops the scratch database, unless `KEEP_DB=1`.

Options (environment variables):

| Variable | Effect |
|---|---|
| `KEEP_DB=1` | Keep the scratch database and print its name, for example to run `\d+ public.units`. |
| `UPTO=0001` | Stop after the migration with this prefix and its checks. |
| `PGVER`, `PGCLUSTER` | Cluster started when it is down (default `16` / `main`). |

The roles `anon`, `authenticated` and `service_role` are cluster-wide and stay after the scratch
database is dropped (the shim creates them only if absent). Drop them by hand if the cluster should
be left as it was.

## What `checks_0001.sql` covers

Tables (17) and RLS; no privilege for `anon` and `authenticated` (with a control that proves the
shim's default privileges are active, so the check is not vacuous); `service_role` keeps
select/insert/update/delete; schema `private` locked; the three trigger helpers and where the
triggers are attached; the private bucket `sources` with no `storage.objects` policy;
`unit_embeddings.embedding` as `vector(384)` with a cosine HNSW index; every column (type,
nullability, default), primary and unique key, foreign key with its delete action, and secondary
index compared with `Database-schema.md` §6.1; the value sets of §4.4 and the other `CHECK` rules
(formats, bounds, containers, couplings), each rejecting a bad value on exactly the intended
constraint; composite keys that keep children inside one edition and bank version; `RESTRICT` on
catalog parents; `guard_edition_delete` and `guard_unit_text` behaviour for every edition status;
`updated_at` maintenance; runtime behaviour of the three API roles; and no seed rows.

## Known limits

- Locally the migrations run as the cluster superuser. A hosted project's `postgres` role is not a
  superuser, so permission problems of that kind would not show here.
- The default privileges of the shim are an assumption about the Supabase platform
  (`Database-schema.md` OPEN-15 asks to confirm them on the real project). The `service_role` check
  relies on them.
- No Data API (PostgREST), Auth or Storage service runs: roles are tested with `SET ROLE`.
- Row level security policies, grants for `authenticated`, the `catalog_*` views and the `srv_*` and
  `app_*` functions belong to `0005_rls_functions` and are not covered by `checks_0001.sql`.
