# DBV-002 local reference run

Date: 2026-10-05 (Asia/Dubai). Repository HEAD at run time: `175b057e992e877c3593485a23cee149c8efe73a` (worktree had no tracked edits by this task).

## Status

**Local reference: Passed** (122 passed, 0 failed; fingerprint computed and reproducible on the local side). Hosted-side comparison: **not run** (outside this task).

## Environment

- PostgreSQL 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1), local cluster 16/main, scratch database `qatra_local_1087`, UTF8. Container-only; no hosted project, MCP, Supabase, Render or Vercel connection used.
- pgvector 0.6.0, installed in this container with `apt-get install -y postgresql-16-pgvector` (it was missing). The `vector` extension is installed in the scratch database (`plpgsql 1.0`, `vector 0.6.0`). `dblink` and `pgcrypto` are available from the postgresql-16 package; dblink is used only inside the concurrency checks.

## Commands

```
apt-get install -y postgresql-16-pgvector
KEEP_DB=1 bash supabase/tests/local/run_local.sh      # exit code 0
runuser -u postgres -- psql -X -At -F' | ' -d qatra_local_1087 -f references/verification/dbv-002-fingerprint.sql
```

The fingerprint was run twice with identical output.

## Migrations applied (harness order) with hashes

Shim files `00_supabase_shim.sql` and `01_check_helpers.sql` were applied first. Git blob SHA-1 / SHA-256 of each file:

| File | git blob | sha256 |
|---|---|---|
| 0001_content.sql | 23e44fa0e9c2f268a4cc2f678ec32a229be69785 | cef256fd45596f6a7efffe368bfe2d244b820e939cf652afcc9e17a8da287796 |
| 0002_identity.sql | ae41042fa6e3fc35646be87f7bf222c7a59400a3 | 4823297c5d89b5628b9a5cc7c5505fe222442556059f7542fe8621ac1f5db4e7 |
| 0003_plans_sessions.sql | 1564a089f4d9be5fe8f163ea3289ff34c460e761 | ba912aefa5239fca4da02e927551d374d7ac9f0828b47ebb06feae775b7e3517 |
| 0004_progress.sql | 75187bbe61a49df404d5fc5128440fee33462471 | 74563f322ed80aeb55bcded752fc33c2c9eba503fe381a39ede92a02bb8a979b |
| 0005_rls_functions.sql | 4abd62e68f7e9675d213b137a9086a67f1828cc3 | 70ebf8870c664cd8fba0fe713e818f3349e19c904e6b43e2bd428da653431ab4 |
| 0006_plan_chats.sql | 82fd287d0184ae05479c1ec71e0f24031df2227c | 1859ee526eb03c9b093e9c1f72c6fb4b2998d18f7ed4e2d66b2920681cb085bf |

## Harness result (verbatim summary)

```
PostgreSQL 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1) (scratch database qatra_local_1087)
APPLIED  00_supabase_shim.sql
APPLIED  01_check_helpers.sql
APPLIED  0001_content.sql
APPLIED  0002_identity.sql
APPLIED  0003_plans_sessions.sql
APPLIED  0004_progress.sql
APPLIED  0005_rls_functions.sql
APPLIED  0006_plan_chats.sql
----
checks passed: 122, failed: 0
KEEP_DB=1: scratch database kept: qatra_local_1087
```

122 `PASS` lines, no `FAIL` lines (individual PASS lines omitted here).

## Catalog fingerprint (LOCAL side)

SQL: `references/verification/dbv-002-fingerprint.sql` (read-only, `set search_path = pg_catalog`, every aggregate ordered `COLLATE "C"`). Scope: schemas `public` and `private`; extension-owned functions excluded; the harness `qa` schema and the shim `auth`/`storage` schemas are out of scope. Each category line is `md5(string_agg(line, E'\n' ORDER BY line COLLATE "C"))`; `ALL` hashes `category|line` over every category.

- functions: identity arguments, result, kind, security definer, volatility, leakproof, proconfig, owner, proacl, md5(prosrc)
- columns: type, not null, default, identity, generated, position
- constraints: `pg_get_constraintdef`
- indexes: `pg_indexes.indexdef`
- policies: `pg_policies` columns plus RLS enabled/forced per table
- grants: relation, column, function and schema ACLs via `aclexplode`, plus `pg_default_acl` entries
- views: `pg_get_viewdef` and reloptions (materialized views included, none present)
- triggers: `pg_get_triggerdef` (non-internal)

| Category | Rows | md5 digest |
|---|---|---|
| columns | 370 | 59f1968360cb7a1e29a21fce32717fef |
| constraints | 328 | 2976e6784d10bc49aefcd0e094dcd18a |
| functions | 36 | 34da20195ef78173b4cf4508360569aa |
| grants | 514 | b90fbb7c21a95de960f08798ec1f8b9c |
| indexes | 125 | 8f298ab666321cf0d366d0a1cf4f4d81 |
| policies | 84 | 24e35628ab953e4f1777daa867a5f719 |
| triggers | 16 | c96e82eb4ef5970f2e91f5514e4d24af |
| views | 2 | 1a90f57a739623fd1003d3f7ee3b3c7c |
| ALL | 1475 | 0c387e7e4e50e5dd6923aa8ed3dbd252 |

The function count of 36 matches the 34 byte-identical plus 2 CRLF-variant bodies in DBV-001.

## Not done / caveats

- No hosted-side fingerprint was computed and no hosted connection was made. Digest equality with the hosted project is therefore unknown.
- Expected hosted differences (owner-stated platform exceptions): PostgreSQL 17 `service_role` MAINTAIN, extra `postgres` default-ACL entries, `postgres` ADMIN on `qatra_server`. These would change the `grants` digest (and `DEFACL` rows are shim-defined locally). Locally the shim stands in for Supabase roles/default privileges, so a `grants` mismatch must be compared row by row, not by digest only.
- DBV-001 CRLF in `srv_throttle_record` and `srv_delete_personal_rows` changes the `functions` digest unless normalized; the raw digest above uses raw `prosrc`.
- Hosted session `search_path` must be set to `pg_catalog` for the comparison; the hosted database collation or Supabase-owned objects in `public`/`private` (if any) may add rows.
- The scratch database `qatra_local_1087` was kept (`KEEP_DB=1`) and still exists; drop it with `runuser -u postgres -- psql -c 'drop database "qatra_local_1087"'`.

## Later hosted-side step (read-only, for the coordinator or owner)

Run the same file on the hosted project through an approved read-only path (for example SQL `execute_sql` with the contents of `dbv-002-fingerprint.sql`; the statement begins with `set search_path = pg_catalog;`, so run it in one session or prefix each statement). To localize a mismatch, replace the final select with `select cat, x from all_cat order by cat collate "C", x collate "C"` on both sides and diff the rows. No DDL or data change is involved.

## Coordinator addendum (2026-10-05, Asia/Dubai)

- **Independent rerun by the coordinator:** `bash supabase/tests/local/run_local.sh` on the same local PostgreSQL 16 → `checks passed: 122, failed: 0`. The fingerprint SQL rerun on `qatra_local_1087` reproduced every local digest above.
- **Hosted aggregate fingerprint (read-only, project «qatra», same SQL, 2026-10-05):**

| Category | Local rows / digest | Hosted rows / digest | Result |
|---|---|---|---|
| columns | 370 / 59f1968360cb7a1e29a21fce32717fef | 370 / 59f1968360cb7a1e29a21fce32717fef | Match |
| constraints | 328 / 2976e6784d10bc49aefcd0e094dcd18a | 328 / 2976e6784d10bc49aefcd0e094dcd18a | Match |
| indexes | 125 / 8f298ab666321cf0d366d0a1cf4f4d81 | 125 / 8f298ab666321cf0d366d0a1cf4f4d81 | Match |
| policies | 84 / 24e35628ab953e4f1777daa867a5f719 | 84 / 24e35628ab953e4f1777daa867a5f719 | Match |
| triggers | 16 / c96e82eb4ef5970f2e91f5514e4d24af | 16 / c96e82eb4ef5970f2e91f5514e4d24af | Match |
| views | 2 / 1a90f57a739623fd1003d3f7ee3b3c7c | 2 / 1a90f57a739623fd1003d3f7ee3b3c7c | Match |
| functions | 36 / 34da20195ef78173b4cf4508360569aa | 36 / 4a2d3963c446265ef8beab38cd8ea9c8 | Differs (expected cause: DBV-001 CRLF bodies; not confirmed) |
| grants | 514 / b90fbb7c21a95de960f08798ec1f8b9c | 576 / 3de9b11cf5f8ce4712be403ab079f1f0 | Differs (expected cause: stated platform exceptions; not confirmed) |
| ALL | 1475 / 0c387e7e4e50e5dd6923aa8ed3dbd252 | 1537 / 40fa0ac5faf639c0b9f21f015f23dfed | Differs |

- **Row-level diff of functions and grants: Not run.** The session's permission checker blocked it, and the owner chose to skip it (2026-10-05). The two differences therefore stay unexplained by evidence; attributing them to DBV-001 and the platform exceptions is an expectation, not a verified result.
- **DBV-002 status:** local reference Passed; hosted structure matches for six of eight categories; functions and grants remain Open pending a row-level comparison. No hosted change was made.
