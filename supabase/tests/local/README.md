# Local migration validation (scratch PostgreSQL only)

This folder holds a **local validation harness** for `supabase/migrations/*.sql`. It applies the
migrations to a throwaway PostgreSQL 16 database and runs assertions against the result.

- It is **not** a deployment tool and **never** touches a Supabase project, Render, Vercel or any
  cloud service. Do not point it at production or at any shared database.
- It is **not** the security review that `Database-schema.md` §11 item 7 requires before production
  use. It checks that the migration builds what the approved schema (`docs/Database-schema.md`
  v1.1, approved by D74; v1.2, D75, for `0006_plan_chats`) describes, on a stand-in for a Supabase
  project.
- It uses synthetic placeholder rows only (for example the word `test`). No source text, secret or
  personal data belongs here.

## Files

| File | Purpose |
|---|---|
| `00_supabase_shim.sql` | Stand-ins for what a Supabase project already provides: roles `anon`, `authenticated`, `service_role`; schemas `auth` (users, `auth.uid()`), `storage` (buckets, objects with RLS and no policy) and `extensions`; and the platform default privileges on new `public` objects that the migrations must revoke. |
| `01_check_helpers.sql` | Helper functions in a scratch schema `qa`: expected-error assertions, a synthetic content row graph `qa.make_fixture()` (plus `make_passage2`, `make_hadith_edition`, `publish_fixture`), synthetic accounts and plans (`make_users`, `make_plan`, `make_session`, `populate_user`), role switches for the API roles (`as_user`, `as_none`, `as_anon`, `as_service`, `as_server`, `as_owner`) and catalog comparison helpers (`columns_of`, `key_defs`, `index_defs`, `assert_columns`, `assert_same_set`). |
| `run_local.sh` | The runner. |
| `checks_NNNN.sql` | Assertions for migration `NNNN_*.sql`; run right after that migration is applied. `checks_0001.sql` covers `0001_content`, `checks_0002.sql` `0002_identity`, `checks_0003.sql` `0003_plans_sessions`, `checks_0004.sql` `0004_progress`, `checks_0005.sql` `0005_rls_functions`, `checks_0006.sql` `0006_plan_chats`. |

## Run

Requirements: PostgreSQL 16 (15 or later is required by the schema), the `pgvector` package
(`apt-get install -y postgresql-16-pgvector`), the contrib module `dblink` (part of the
`postgresql-16` package on Debian and Ubuntu; only the concurrency checks need it: chunk 27 of
`checks_0005.sql` and chunks 27 and 30 of `checks_0006.sql`), and either root (the script uses
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

The roles `anon`, `authenticated` and `service_role` (created by the shim, only if absent) and
`qatra_server` (created by `0002_identity`, only if absent, without a password) are cluster-wide and
stay after the scratch database is dropped. Drop them by hand if the cluster should be left as it
was. `0002_identity` restores the attributes of `qatra_server` if an existing role differs, and
never sets a password.

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

## What `checks_0002.sql` to `checks_0006.sql` cover

Each file compares the result with the approved text (`Database-schema.md` v1.1; v1.2 for
`checks_0006.sql`), not with the migration. Column lists, primary, unique and foreign keys (with
their delete actions, the column-list `SET NULL` and the deferred cyclic key), partial and
secondary indexes are compared as sets of catalog definitions; `CHECK` rules are tested by
behaviour (a good value is accepted, each bad value is refused by exactly the intended
constraint).

| File | Covers |
|---|---|
| `checks_0002.sql` | The five `private.*` tables and `public.profiles`; row level security on and no policy; no privilege for `anon`, `authenticated`, `service_role` (with controls that prove the check can see a grant); role `qatra_server` (attributes, no password, no membership, no privilege yet); username, alias, epoch, grant status set, one live grant and one active code per account, reservation rules; `private.validate_profile` (time zones, `pending_settings.timeZone`, minutes 5/10/15, languages, terms fields); class A cascades; `updated_at`; no seed rows. |
| `checks_0003.sql` | `master_plans`, `plan_versions`, `plan_phases`, `offline_snapshots`, `learning_sessions`, `attempts`, `session_activity_intervals`: columns, keys and composite parent-ownership keys, delete classes A, B, C, F, G; one active plan per account; the daily-session partial unique index (A-01); the deferred cyclic key, including a real `COMMIT` that refuses a plan without a version; `private.guard_plan_order`; value sets and the four memorization paths; couplings; idempotency keys; activity-interval bounds. |
| `checks_0004.sql` | `daily_progress`, `daily_completions`, `target_mastery`, `target_part_evidence`, `ai_usage`: columns, keys, the due-review index, no `reviews` table, every `target_mastery` state-consistency combination, evidence that refuses a part or attempt of another passage, no learner or text column in `ai_usage`, delete classes. |
| `checks_0005.sql` | The 42 policies by name and command and their predicates; the grant matrix of every role (`anon`, `authenticated` by table and column, `service_role`, `qatra_server`); the 19 `srv_*` and 6 `app_*` functions (owner, definer/invoker, empty `search_path`, EXECUTE per role, nothing for PUBLIC); default function privileges; the two catalog views (columns, owner, barrier, rows only for published, visible, unarchived editions, per-path counts of the current bank); anon and learner reads of published content; the two-account isolation test; every `app_*` function including atomic rollback; every `srv_*` function including recovery reservation, epoch, sessions, throttle buckets and purge, personal-row deletion, redaction; storage with no policy; `qatra_server` at run time; a concurrency check over `dblink` (parallel recovery reservations, daily get-or-create, revisions, plan creations, throttle increments); and, in chunk 28, `app_revise_plan` refusing a completed plan (QT003, message `plan_not_active`, tested before the version and before any write, nothing changed). |
| `checks_0006.sql` | `plan_chats` and `plan_chat_messages` against §6.3 of v1.2: columns, keys with delete classes A and B, indexes, the five P-OWN policies and the triggers, the grants (learner privileges at run time), value sets, the 2000-character text limit, the `closed_at` coupling, the tamper guard (also against a learner token), `updated_at`, no seed rows; the four learner functions with their refusals and atomic rollback: `app_plan_chat_open` (first conversation, replacement, revision conversations, invalid input), `app_plan_chat_append` (ordinals, proposal and counters), `app_plan_chat_confirm` (creation and revision, proposal version, closed and foreign chats, failing steps) and `app_resume_plan`, and their interplay; the execution boundary at run time (no token subject, `anon`, `service_role`, `qatra_server`); account deletion and cascades (`srv_delete_personal_rows` run as `qatra_server`); a completed plan refused with QT003 and the message `plan_not_active` by `app_plan_chat_open` and the revision path of `app_plan_chat_confirm` (`app_resume_plan` keeps `invalid_state`); and two concurrency checks over `dblink` (chunk 27: parallel opens, appends, a confirmation against a replacing open, a double confirmation; chunk 30: a completion racing a revision, a confirmation or an open, and the lock order of an open and a confirmation). |

## Known limits

- Locally the migrations run as the cluster superuser. A hosted project's `postgres` role is not a
  superuser, so permission problems of that kind would not show here.
- The default privileges of the shim are an assumption about the Supabase platform
  (`Database-schema.md` OPEN-15 asks to confirm them on the real project). The `service_role` checks
  rely on them, and on the shim's `service_role` bypassing row level security as the platform's does.
- No Data API (PostgREST), Auth or Storage service runs: roles are tested with `SET ROLE`, and the
  JWT subject is set with `request.jwt.claim.sub`.
- `ALTER DEFAULT PRIVILEGES ... IN SCHEMA public` cannot remove the built-in default `EXECUTE` for
  `PUBLIC`; every function therefore revokes it explicitly, and `checks_0005.sql` fails if a function
  of schema `public` is executable by `PUBLIC` or by a role other than the one the schema names.
- The negative branch of the storage guard inside `0005_rls_functions.sql` (a policy that names the
  bucket `sources` makes the migration fail) is not exercised; `checks_0005.sql` asserts that no
  `storage.objects` policy exists after the migration.
- The `srv_throttle_record` function returns nothing: the checks assert the per-key counts that the
  service turns into the progressive delay (1, 2, 4, 8 seconds, then 10 seconds per failure) and
  the 429 threshold; the delay itself is service logic.
