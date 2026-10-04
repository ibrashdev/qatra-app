# Qatra Supabase migration verification and remediation plan

Version 1.0 · 4 October 2026 · Asia/Dubai.

Status: **Verified for the explicitly listed metadata checks; raw function text has two line-ending differences. Full reference test/fingerprint rerun Blocked. Remediation plan Needs Review; no remediation implemented.**

## 1. Scope, authority and evidence

The owner requested a read-only comparison of Supabase project `qatra`, ref `ikxcubnbhiolqfqdfzxs`, against `ibrashdev/qatra-app`, branch `claude/sleepy-thompson-jkbssq`, migrations 0001–0006. The owner then requested a written findings report, a fixing plan, GitHub synchronization and merge on 4 October 2026. This authorizes publishing this documentation; it does not approve the proposed database changes.

- Audited source commit: [`85cbdb77bb9a6598cbe25295c268b157d6809f1d`](https://github.com/ibrashdev/qatra-app/tree/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations).
- Region: `eu-central-1`, as supplied by the owner; project region was not independently queried in this audit.
- Live server: PostgreSQL **17.11**; installed pgvector **0.8.2**. `dblink` was not listed among installed live extensions; local availability was not verified.
- Final privilege query timestamp: **4 October 2026, 21:13:10 Asia/Dubai** (17:13:10 UTC). Advisor observations were timestamped 21:03:01–21:03:02 Asia/Dubai.
- Methods: GitHub read tools; Supabase `execute_sql` with SELECT only, `list_tables`, `list_migrations`, and `get_advisors`. No application function was invoked. No hosted DDL or INSERT/UPDATE/DELETE was executed.
- Password contents, password hashes, API keys and application records were not retrieved. The role password check returned only the boolean `password_set = false`; storage reads were bucket metadata.
- Coordinator compared live catalogs with all six pinned source files. A GPT-6 Luna worker independently extracted source identities, object names, security declarations, grants and the final deletion body; it did not independently query the live database.
- Source authority: [Database-schema.md](Database-schema.md), [Readiness.tracker.md](Readiness.tracker.md), and the actual migration files. This is a bounded migration-conformity review, not a full security audit, application integration test or production-readiness approval.

The existing readiness tracker separately attributes a local 122-check run and a 15/20 category fingerprint comparison to earlier work. That record is preserved as earlier reported evidence. It was **not rerun or independently reproduced in this verification**, whose local shell was unavailable.

## 2. Results by requested check

| # | Check | Result and evidence |
|---|---|---|
| 1 | Tables and RLS | **PASS:** 37 public/private tables; all 37 have RLS enabled; exact table-name set matches. No issues found. |
| 2 | Function identities | **PASS:** 29 public + 7 private = 36. All named identity arguments match `pg_get_function_identity_arguments`. Missing: none. Extra: none. There are 37 CREATE definitions because 0006 replaces `srv_delete_personal_rows`. No issues found. |
| 3 | Function security | **PASS:** PUBLIC and anon have no EXECUTE. Excluding owner rights, 18 server functions have only qatra_server EXECUTE; the redactor only service_role; 10 app functions only authenticated; seven private helpers have no non-owner EXECUTE grant. All srv functions are SECURITY DEFINER, all app functions SECURITY INVOKER, and all 36 set an empty search_path. Effective privileges for anon/authenticated/qatra_server/service_role and explicit non-owner ACLs showed no violations. No issues found. |
| 4 | Policies | **PASS:** 47 total across public/private/storage: public 47, private 0, storage 0. Names match exactly. No issues found. |
| 5 | Views and anonymous access | **PASS:** exactly public.catalog_editions and public.catalog_sections. anon has SELECT on both and no other table/column/sequence privileges in public/private. No issues found. |
| 6 | Triggers | **PASS:** exactly 16 non-internal triggers; names match and all are enabled. No issues found. |
| 7 | qatra_server | **PASS:** exists and LOGIN true; SUPERUSER, CREATEDB, CREATEROLE, REPLICATION and BYPASSRLS all false. password_set = false, the expected state. No issues found. |
| 8 | Storage | **PASS:** sources bucket exists with public = false. No issues found. |
| 9 | 0006 deletion tail | **PASS for statements/content; FAIL for raw text:** both chat deletes are present and the full body matches section 7 after CRLF-to-LF normalization. See DBV-001. |
| 10 | Local reference and catalog fingerprint | **BLOCKED:** local process initialization was unavailable. The 122 checks and full category fingerprint were not run here. No fresh pass claim is made. See DBV-002. |
| 11 | Advisors | **PASS for retrieval:** both scans completed; 11 security and 75 performance findings are recorded individually in section 6. This does not mean the database is free of security/performance issues. |

Columns, constraints, index definitions, policy expressions, full table/column/default ACLs and view/trigger definitions were **not compared exhaustively to a freshly built reference**. Their complete fingerprint remains outside verified coverage. Catalog definitions for views, triggers and policies were inspected, but that inspection is not claimed as a full reference equivalence test.

## 3. Confirmed differences and verification gap

### DBV-001 — Two raw function bodies use CRLF instead of LF

Classification: **Low, textual variance**. Status: **Open; no code-content difference after normalization**.

| Function | Source | Repository body MD5 | Live body MD5 | Live MD5 after CRLF→LF |
|---|---|---|---|---|
| public.srv_throttle_record | [0005:1025](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1025) | 3016ddf0e84c6433517c410de806cf3e | 0f466919f1c2079b361e6947d252dd01 | 3016ddf0e84c6433517c410de806cf3e |
| public.srv_delete_personal_rows | [0006:515](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0006_plan_chats.sql#L515) | f4ab26aaeb1eb68c083fe1b2084ad60c | 8b5ca1a3df8df13df9fdde5022777771 | f4ab26aaeb1eb68c083fe1b2084ad60c |

Comparison of every final `prosrc` value found **34 byte-identical bodies** and the two exceptions above. Exact equality and normalized equality were checked directly; SELECT-computed MD5 values above confirm the two exceptions. The live throttle body contains 28 CRLF sequences and the deletion body 30; the corresponding repository bodies contain none.

Consequence: a fingerprint including raw `md5(prosrc)` differs. No changed SQL statement was found after normalization; this does not substitute for runtime tests. The user's expressly allowed platform differences did not include line endings, so this report retains the raw mismatch.

The final [0006 section 7](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0006_plan_chats.sql#L515) contains the two chat-table deletes before the remaining account rows:

```sql
delete from public.plan_chat_messages where user_id = p_user_id;
delete from public.plan_chats         where user_id = p_user_id;
```

It then removes target_part_evidence, target_mastery, daily_completions, daily_progress, session_activity_intervals, attempts, learning_sessions, offline_snapshots, plan_phases, plan_versions, master_plans, profiles, and private app_sessions/password_reset_grants/recovery_codes/account_handles for the user. It conditionally deletes private.auth_throttle rows matching the supplied username-throttle hash. The entire body, including the comments and conditional cleanup, matches after newline normalization. This proves the tail is present by source inspection; no deletion was executed.

### DBV-002 — Fresh full-reference verification unavailable

Classification: **Verification gap, not a demonstrated schema defect**. Status: **Blocked**.

The requested local `KEEP_DB=1 bash supabase/tests/local/run_local.sh` run could not start because the local shell process was unavailable. No new result of “checks passed: 122, failed: 0” was observed, and no fresh full catalog fingerprint was computed on both sides.

Allowed platform differences for the later comparison remain limited to the owner's stated exceptions: PostgreSQL 17 service_role MAINTAIN, additional postgres default-ACL entries, and postgres ADMIN on qatra_server. The last membership was observed live as ADMIN true with INHERIT and SET false. The other two exceptions were not independently verified by a complete comparison in this audit.

## 4. Migration history

The expected **nine rows** were returned. The schema was judged independently of history: owner-run SQL editor pieces need not appear as separate migration rows. No history rewrite or reapplication is proposed merely to change this count.

| Version | Name |
|---|---|
| 20261004153322 | `0001_content` |
| 20261004153423 | `0002_identity` |
| 20261004153520 | `0003_plans_sessions` |
| 20261004153555 | `0004_progress` |
| 20261004162121 | `0005_rls_functions_part1_of_3` |
| 20261004162840 | `0005_rls_functions_part2a_of_3` |
| 20261004165339 | `0005_rls_functions_part2d_of_3` |
| 20261004165439 | `0005_rls_functions_part3_of_3` |
| 20261004165535 | `0006_plan_chats_part1_of_2` |

## 5. Proposed fixing and verification plan

The following plan is **Needs Review**. Publication/merge records the plan; it does not mark fixes approved, applied, or verified. Actual hosted database changes require separate owner authorization and the existing analysis/architecture gates.

| Priority / record | Action and owner | Approval boundary | Verification and stop rule |
|---|---|---|---|
| **P0 / DBV-002** | Database engineer builds a local PostgreSQL 16 reference with pgvector and dblink. Run `KEEP_DB=1 bash supabase/tests/local/run_local.sh` in an isolated scratch environment. Coordinator reviews evidence. | Local scratch verification only; never run the harness against the hosted/shared project. | Capture actual output, require 122 passed / 0 failed for these six migrations, then compute the same catalog fingerprint over functions including md5(prosrc), columns, constraints, indexes, policies, grants, views and triggers, with search_path = pg_catalog and COLLATE "C" ordering. Record exact category definitions and both digests. Allow only the stated platform exceptions; retain CRLF variance explicitly unless separately normalized. Stop/mark Blocked if execution or dependencies remain unavailable. Preserve earlier tracker evidence as attributed history. |
| **P1 / ADV-SEC-001** | Database/security reviewer examines both definer views' columns, filters, owner and grants; designs synthetic exposure/denial tests. | Preserve approved metadata views; no blanket switch to security_invoker. A behavior/grant change requires evidence and owner approval. | Verify that anonymous access exposes only the approved metadata. Execute behavior tests in a scratch/test environment first. Stop before production use or changes without the appropriate approval; report any confirmed leak separately. |
| **P1 / ADV-SEC-002** | Database/security reviewer confirms default denial on all nine no-policy tables and the approved privileged access paths, including function-only identity access. | Do not add blanket policies or expand access merely to silence INFO notices. | Document role-specific denied direct access and permitted paths using synthetic tests in a scratch environment. Close as reviewed only with evidence; stop before altering policy/function boundaries without approval. |
| **P2 / DBV-001** | Database engineer proposes optional LF normalization of the two bodies if exact raw equality is required. | Obtain separate hosted DB-change authorization. Use a reviewed forward-only migration, not a history rewrite or blanket replay of 0001–0006. | Preserve identity arguments, body content, owner, security mode, empty search_path and grants. Run reference/regression checks before application; after an approved application compare exact prosrc hashes and effective privileges. No such migration is created or applied by this task. |
| **P2 / ADV-PERF-001** | Database engineer assesses the 34 unindexed foreign keys using representative query, write and deletion workloads. | Propose additional indexes only where measurements support the benefit; schema changes need separate approval. | Record plans, redundant-prefix checks and write/delete costs per candidate. Stop where representative workload evidence is unavailable. |
| **P3 / ADV-PERF-002** | Database engineer reviews the 41 unused indexes after representative traffic. | Do not remove indexes solely because a new/empty database reports zero usage. | Record usage and write-cost evidence. Retain indexes needed by uniqueness, constraints or demonstrated queries. Any removal requires a reviewed proposal and separate approval. |
| **Operational follow-up** | Deployment owner configures qatra_server authentication through the existing deployment process. | Out-of-band secret configuration only, outside this task. Never include passwords or connection credentials in this report, source control, prompts or logs. | The unset-password boolean is expected migration state. Verify operational login later through the approved secret-management process without returning secret material; this is not a schema-mismatch fix. |

Closeout: **Fixed/Closed** only after the specific review/fix and its evidence; **Open** for unresolved variance/advisor review; **Blocked** for the fresh local reference; **Not in scope** for application fixes, live DDL/data changes, deployment and secret configuration. The checked structural/signature/security items are Verified within section 2's limits.

## 6. All advisor observations

These are all **86 findings**, not merely the four grouped lint types. Advisor severity is preserved. Notices alone do not establish a vulnerability or authorize schema changes.

The two definer metadata views are deliberate in [Database-schema §7](Database-schema.md#7-catalog-views-the-only-anonymous-surface). The private no-policy posture is deliberate in §6.2; the remaining no-policy objects have restricted approved paths. Those explanations require review evidence for closure, not silent dismissal of the notices.

### RLS Enabled No Policy: INFO, 9 findings

Detects cases where row level security (RLS) has been enabled on a table but no RLS policies have been created.

| # | Observed finding | Remediation |
|---|---|---|
| 1 | Table private.account_handles has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| 2 | Table private.app_sessions has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| 3 | Table private.auth_throttle has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| 4 | Table private.password_reset_grants has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| 5 | Table private.recovery_codes has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| 6 | Table public.ai_usage has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| 7 | Table public.approved_source_rules has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| 8 | Table public.content_jobs has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |
| 9 | Table public.unit_embeddings has RLS enabled, but no policies exist | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) |

### Security Definer View: ERROR, 2 findings

Detects views defined with the SECURITY DEFINER property. These views enforce Postgres permissions and row level security policies (RLS) of the view creator, rather than that of the querying user

| # | Observed finding | Remediation |
|---|---|---|
| 1 | View public.catalog_editions is defined with the SECURITY DEFINER property | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view) |
| 2 | View public.catalog_sections is defined with the SECURITY DEFINER property | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view) |

### Unindexed foreign keys: INFO, 34 findings

Identifies foreign key constraints without a covering index, which can impact database performance.

| # | Observed finding | Remediation |
|---|---|---|
| 1 | Table public.attempts has a foreign key attempts_question_id_edition_id_passage_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 2 | Table public.attempts has a foreign key attempts_session_id_user_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 3 | Table public.book_sections has a foreign key book_sections_parent_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 4 | Table public.daily_completions has a foreign key daily_completions_reached_in_plan_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 5 | Table public.learning_sessions has a foreign key learning_sessions_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 6 | Table public.learning_sessions has a foreign key learning_sessions_offline_snapshot_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 7 | Table public.learning_sessions has a foreign key learning_sessions_phase_id_plan_version_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 8 | Table public.learning_sessions has a foreign key learning_sessions_plan_id_user_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 9 | Table public.learning_sessions has a foreign key learning_sessions_plan_version_id_plan_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 10 | Table public.lesson_units has a foreign key lesson_units_lesson_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 11 | Table public.lesson_units has a foreign key lesson_units_unit_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 12 | Table public.lessons has a foreign key lessons_passage_id_edition_id_bank_version_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 13 | Table public.master_plans has a foreign key master_plans_id_current_version_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 14 | Table public.offline_snapshots has a foreign key offline_snapshots_plan_id_plan_version_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 15 | Table public.offline_snapshots has a foreign key offline_snapshots_plan_id_user_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 16 | Table public.passage_parts has a foreign key passage_parts_passage_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 17 | Table public.passages has a foreign key passages_section_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 18 | Table public.plan_chat_messages has a foreign key plan_chat_messages_chat_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 19 | Table public.plan_chat_messages has a foreign key plan_chat_messages_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 20 | Table public.plan_chats has a foreign key plan_chats_plan_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 21 | Table public.plan_phases has a foreign key plan_phases_plan_version_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 22 | Table public.plan_versions has a foreign key plan_versions_plan_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 23 | Table public.question_items has a foreign key question_items_lesson_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 24 | Table public.question_items has a foreign key question_items_passage_id_edition_id_bank_version_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 25 | Table public.question_items has a foreign key question_items_unit_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 26 | Table public.session_activity_intervals has a foreign key session_activity_intervals_session_id_user_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 27 | Table public.target_mastery has a foreign key target_mastery_passage_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 28 | Table public.target_mastery has a foreign key target_mastery_plan_id_user_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 29 | Table public.target_part_evidence has a foreign key target_part_evidence_attempt_id_user_id_passage_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 30 | Table public.target_part_evidence has a foreign key target_part_evidence_part_id_passage_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 31 | Table public.unit_embeddings has a foreign key unit_embeddings_unit_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 32 | Table public.unit_page_spans has a foreign key unit_page_spans_page_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 33 | Table public.unit_page_spans has a foreign key unit_page_spans_unit_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |
| 34 | Table public.units has a foreign key units_section_id_edition_id_fkey without a covering index. This can lead to suboptimal query performance. | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys) |

### Unused Index: INFO, 41 findings

Detects if an index has never been used and may be a candidate for removal.

| # | Observed finding | Remediation |
|---|---|---|
| 1 | Index sources_approved_rule_id_idx on table public.sources has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 2 | Index books_category_id_idx on table public.books has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 3 | Index book_editions_book_id_published_idx on table public.book_editions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 4 | Index book_editions_source_id_idx on table public.book_editions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 5 | Index book_sections_parent_id_idx on table public.book_sections has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 6 | Index app_sessions_user_id_idx on table private.app_sessions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 7 | Index units_section_id_ordinal_idx on table public.units has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 8 | Index target_mastery_user_id_plan_id_next_review_due_idx on table public.target_mastery has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 9 | Index auth_throttle_window_start_idx on table private.auth_throttle has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 10 | Index target_mastery_passage_id_idx on table public.target_mastery has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 11 | Index unit_page_spans_page_id_idx on table public.unit_page_spans has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 12 | Index plan_phases_user_id_plan_version_id_idx on table public.plan_phases has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 13 | Index passages_section_id_idx on table public.passages has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 14 | Index offline_snapshots_user_id_plan_id_created_at_idx on table public.offline_snapshots has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 15 | Index lessons_passage_id_idx on table public.lessons has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 16 | Index lesson_units_unit_id_idx on table public.lesson_units has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 17 | Index question_items_passage_id_type_idx on table public.question_items has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 18 | Index question_items_covered_part_ids_idx on table public.question_items has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 19 | Index question_items_edition_id_bank_version_idx on table public.question_items has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 20 | Index unit_embeddings_embedding_hnsw_idx on table public.unit_embeddings has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 21 | Index unit_embeddings_edition_id_bank_version_idx on table public.unit_embeddings has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 22 | Index content_jobs_edition_id_status_idx on table public.content_jobs has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 23 | Index recovery_codes_reserved_grant_id_idx on table private.recovery_codes has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 24 | Index master_plans_user_id_status_idx on table public.master_plans has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 25 | Index master_plans_edition_id_idx on table public.master_plans has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 26 | Index plan_versions_user_id_plan_id_idx on table public.plan_versions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 27 | Index learning_sessions_user_id_learning_date_idx on table public.learning_sessions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 28 | Index learning_sessions_user_id_plan_id_learning_date_idx on table public.learning_sessions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 29 | Index learning_sessions_user_id_unfinished_idx on table public.learning_sessions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 30 | Index learning_sessions_offline_snapshot_id_idx on table public.learning_sessions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 31 | Index learning_sessions_plan_version_id_idx on table public.learning_sessions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 32 | Index learning_sessions_phase_id_idx on table public.learning_sessions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 33 | Index attempts_session_id_created_at_idx on table public.attempts has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 34 | Index attempts_user_id_passage_id_created_at_idx on table public.attempts has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 35 | Index session_activity_intervals_user_id_learning_date_started_at_idx on table public.session_activity_intervals has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 36 | Index session_activity_intervals_session_id_idx on table public.session_activity_intervals has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 37 | Index daily_completions_reached_in_plan_id_idx on table public.daily_completions has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 38 | Index target_part_evidence_user_id_plan_id_passage_id_idx on table public.target_part_evidence has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 39 | Index target_part_evidence_attempt_id_idx on table public.target_part_evidence has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 40 | Index ai_usage_created_at_idx on table public.ai_usage has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |
| 41 | Index plan_chats_plan_id_idx on table public.plan_chats has not been used | [Supabase guidance](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index) |

## 7. Object inventories

### 7.1 All 36 final function identities

Named identity arguments were compared, not just names or counts. PostgreSQL's canonical type names are shown; timestamptz is represented as timestamp with time zone. Missing and extra lists are both empty.

| Final identity arguments | Pinned definition | Live identity |
|---|---|---|
| `private.guard_edition_delete()` | [0001_content.sql:53](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0001_content.sql#L53) | PASS |
| `private.guard_plan_chat_update()` | [0006_plan_chats.sql:84](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0006_plan_chats.sql#L84) | PASS |
| `private.guard_plan_order()` | [0003_plans_sessions.sql:33](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0003_plans_sessions.sql#L33) | PASS |
| `private.guard_unit_text()` | [0001_content.sql:83](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0001_content.sql#L83) | PASS |
| `private.redact_json(p_value jsonb)` | [0005_rls_functions.sql:491](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L491) | PASS |
| `private.set_updated_at()` | [0001_content.sql:39](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0001_content.sql#L39) | PASS |
| `private.validate_profile()` | [0002_identity.sql:53](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0002_identity.sql#L53) | PASS |
| `public.app_apply_events(p_session_id uuid, p_events jsonb, p_daily jsonb, p_open_session boolean)` | [0005_rls_functions.sql:1503](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1503) | PASS |
| `public.app_complete_session(p_session_id uuid, p_elapsed_ms bigint)` | [0005_rls_functions.sql:1671](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1671) | PASS |
| `public.app_create_offline_snapshot(p_plan_id uuid, p_plan_version integer, p_bank_version integer, p_client_operation_id uuid, p_download_target_refs jsonb, p_schema_version integer, p_protocol_version integer, p_payload jsonb, p_sessions jsonb, p_snapshot_id uuid)` | [0005_rls_functions.sql:1719](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1719) | PASS |
| `public.app_create_plan(p_edition_id uuid, p_target_scope jsonb, p_paths text[], p_plan_order text, p_session_minutes smallint, p_preferred_date date, p_agreed_estimate jsonb, p_reason_code text, p_policy_json jsonb, p_effective_learning_date date, p_phases jsonb, p_sessions jsonb, p_plan_id uuid)` | [0005_rls_functions.sql:1189](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1189) | PASS |
| `public.app_open_session(p_kind text, p_plan_id uuid, p_plan_version_id uuid, p_phase_id uuid, p_edition_id uuid, p_learning_date date, p_lesson_refs uuid[], p_question_refs uuid[], p_steps jsonb, p_bank_version integer, p_self_rating text, p_session_id uuid)` | [0005_rls_functions.sql:1374](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1374) | PASS |
| `public.app_plan_chat_append(p_chat uuid, p_messages jsonb, p_proposal jsonb, p_model_turns_increment integer)` | [0006_plan_chats.sql:323](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0006_plan_chats.sql#L323) | PASS |
| `public.app_plan_chat_confirm(p_chat uuid, p_expected_proposal_version integer, p_plan_args jsonb)` | [0006_plan_chats.sql:408](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0006_plan_chats.sql#L408) | PASS |
| `public.app_plan_chat_open(p_language text, p_first_learner_text text, p_first_assistant jsonb, p_plan uuid, p_proposal jsonb)` | [0006_plan_chats.sql:237](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0006_plan_chats.sql#L237) | PASS |
| `public.app_resume_plan(p_plan uuid)` | [0006_plan_chats.sql:171](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0006_plan_chats.sql#L171) | PASS |
| `public.app_revise_plan(p_plan_id uuid, p_expected_version integer, p_target_scope jsonb, p_paths text[], p_plan_order text, p_session_minutes smallint, p_preferred_date date, p_agreed_estimate jsonb, p_reason_code text, p_policy_json jsonb, p_effective_learning_date date, p_phases jsonb)` | [0005_rls_functions.sql:1285](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1285) | PASS |
| `public.srv_accept_terms(p_user_id uuid, p_terms_version text)` | [0005_rls_functions.sql:599](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L599) | PASS |
| `public.srv_bump_auth_epoch(p_user_id uuid)` | [0005_rls_functions.sql:965](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L965) | PASS |
| `public.srv_create_app_session(p_user_id uuid, p_session_hash bytea, p_encrypted_auth_tokens bytea, p_auth_epoch integer, p_expires_at timestamp with time zone)` | [0005_rls_functions.sql:849](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L849) | PASS |
| `public.srv_delete_personal_rows(p_user_id uuid, p_username_throttle_key_hash bytea)` | [0006_plan_chats.sql:515](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0006_plan_chats.sql#L515) | PASS |
| `public.srv_find_handle(p_username_normalized text)` | [0005_rls_functions.sql:534](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L534) | PASS |
| `public.srv_read_app_session(p_session_hash bytea)` | [0005_rls_functions.sql:893](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L893) | PASS |
| `public.srv_record_ai_usage(p_provider text, p_model text, p_prompt_version text, p_input_tokens integer, p_output_tokens integer, p_cost_usd numeric, p_status text, p_quota_record jsonb)` | [0005_rls_functions.sql:1105](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1105) | PASS |
| `public.srv_recovery_active_code(p_user_id uuid)` | [0005_rls_functions.sql:627](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L627) | PASS |
| `public.srv_recovery_begin(p_grant_hash bytea)` | [0005_rls_functions.sql:718](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L718) | PASS |
| `public.srv_recovery_consume(p_grant_id uuid, p_new_code_hash bytea)` | [0005_rls_functions.sql:763](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L763) | PASS |
| `public.srv_recovery_release(p_grant_id uuid)` | [0005_rls_functions.sql:738](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L738) | PASS |
| `public.srv_recovery_reserve(p_user_id uuid, p_code_id uuid, p_grant_id uuid, p_grant_hash bytea, p_grant_expires_at timestamp with time zone)` | [0005_rls_functions.sql:647](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L647) | PASS |
| `public.srv_recovery_rotate(p_user_id uuid, p_new_code_hash bytea)` | [0005_rls_functions.sql:821](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L821) | PASS |
| `public.srv_redact_revoked_content(p_edition_id uuid)` | [0005_rls_functions.sql:1134](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1134) | PASS |
| `public.srv_register_account(p_user_id uuid, p_username_display text, p_username_normalized text, p_internal_auth_alias text, p_is_demo boolean, p_terms_version text, p_language text, p_time_zone text, p_recovery_code_hash bytea)` | [0005_rls_functions.sql:557](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L557) | PASS |
| `public.srv_revoke_app_session(p_session_hash bytea)` | [0005_rls_functions.sql:948](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L948) | PASS |
| `public.srv_throttle_check(p_key_hashes bytea[])` | [0005_rls_functions.sql:999](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L999) | PASS |
| `public.srv_throttle_record(p_key_hashes bytea[], p_outcome text)` | [0005_rls_functions.sql:1025](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L1025) | PASS |
| `public.srv_update_app_session_tokens(p_session_id uuid, p_encrypted_auth_tokens bytea)` | [0005_rls_functions.sql:925](https://github.com/ibrashdev/qatra-app/blob/85cbdb77bb9a6598cbe25295c268b157d6809f1d/supabase/migrations/0005_rls_functions.sql#L925) | PASS |

### 7.2 All 37 tables and RLS flags

| Table | RLS enabled | Name comparison |
|---|---|---|
| `public.categories` | true | PASS |
| `public.approved_source_rules` | true | PASS |
| `public.sources` | true | PASS |
| `public.books` | true | PASS |
| `public.book_editions` | true | PASS |
| `public.edition_pages` | true | PASS |
| `public.book_sections` | true | PASS |
| `public.units` | true | PASS |
| `public.unit_page_spans` | true | PASS |
| `public.passages` | true | PASS |
| `public.passage_parts` | true | PASS |
| `public.lessons` | true | PASS |
| `public.lesson_units` | true | PASS |
| `public.question_items` | true | PASS |
| `public.unit_embeddings` | true | PASS |
| `public.content_jobs` | true | PASS |
| `public.generic_plan_templates` | true | PASS |
| `private.account_handles` | true | PASS |
| `private.password_reset_grants` | true | PASS |
| `private.recovery_codes` | true | PASS |
| `private.app_sessions` | true | PASS |
| `private.auth_throttle` | true | PASS |
| `public.profiles` | true | PASS |
| `public.master_plans` | true | PASS |
| `public.plan_versions` | true | PASS |
| `public.plan_phases` | true | PASS |
| `public.offline_snapshots` | true | PASS |
| `public.learning_sessions` | true | PASS |
| `public.attempts` | true | PASS |
| `public.session_activity_intervals` | true | PASS |
| `public.daily_progress` | true | PASS |
| `public.daily_completions` | true | PASS |
| `public.target_mastery` | true | PASS |
| `public.target_part_evidence` | true | PASS |
| `public.ai_usage` | true | PASS |
| `public.plan_chats` | true | PASS |
| `public.plan_chat_messages` | true | PASS |

### 7.3 All 47 policies

All policy-name tuples match the migrations. Expression-level equivalence to a fresh local reference remains unverified.

| Table | Policy | Command | Role |
|---|---|---|---|
| `public.attempts` | `attempts__authenticated__insert` | INSERT | authenticated |
| `public.attempts` | `attempts__authenticated__select` | SELECT | authenticated |
| `public.book_editions` | `book_editions__authenticated__select` | SELECT | authenticated |
| `public.book_sections` | `book_sections__authenticated__select` | SELECT | authenticated |
| `public.books` | `books__authenticated__select` | SELECT | authenticated |
| `public.categories` | `categories__authenticated__select` | SELECT | authenticated |
| `public.daily_completions` | `daily_completions__authenticated__insert` | INSERT | authenticated |
| `public.daily_completions` | `daily_completions__authenticated__select` | SELECT | authenticated |
| `public.daily_progress` | `daily_progress__authenticated__insert` | INSERT | authenticated |
| `public.daily_progress` | `daily_progress__authenticated__select` | SELECT | authenticated |
| `public.daily_progress` | `daily_progress__authenticated__update` | UPDATE | authenticated |
| `public.edition_pages` | `edition_pages__authenticated__select` | SELECT | authenticated |
| `public.generic_plan_templates` | `generic_plan_templates__authenticated__select` | SELECT | authenticated |
| `public.learning_sessions` | `learning_sessions__authenticated__insert` | INSERT | authenticated |
| `public.learning_sessions` | `learning_sessions__authenticated__select` | SELECT | authenticated |
| `public.learning_sessions` | `learning_sessions__authenticated__update` | UPDATE | authenticated |
| `public.lesson_units` | `lesson_units__authenticated__select` | SELECT | authenticated |
| `public.lessons` | `lessons__authenticated__select` | SELECT | authenticated |
| `public.master_plans` | `master_plans__authenticated__insert` | INSERT | authenticated |
| `public.master_plans` | `master_plans__authenticated__select` | SELECT | authenticated |
| `public.master_plans` | `master_plans__authenticated__update` | UPDATE | authenticated |
| `public.offline_snapshots` | `offline_snapshots__authenticated__insert` | INSERT | authenticated |
| `public.offline_snapshots` | `offline_snapshots__authenticated__select` | SELECT | authenticated |
| `public.passage_parts` | `passage_parts__authenticated__select` | SELECT | authenticated |
| `public.passages` | `passages__authenticated__select` | SELECT | authenticated |
| `public.plan_chat_messages` | `plan_chat_messages__authenticated__insert` | INSERT | authenticated |
| `public.plan_chat_messages` | `plan_chat_messages__authenticated__select` | SELECT | authenticated |
| `public.plan_chats` | `plan_chats__authenticated__insert` | INSERT | authenticated |
| `public.plan_chats` | `plan_chats__authenticated__select` | SELECT | authenticated |
| `public.plan_chats` | `plan_chats__authenticated__update` | UPDATE | authenticated |
| `public.plan_phases` | `plan_phases__authenticated__insert` | INSERT | authenticated |
| `public.plan_phases` | `plan_phases__authenticated__select` | SELECT | authenticated |
| `public.plan_versions` | `plan_versions__authenticated__insert` | INSERT | authenticated |
| `public.plan_versions` | `plan_versions__authenticated__select` | SELECT | authenticated |
| `public.profiles` | `profiles__authenticated__select` | SELECT | authenticated |
| `public.profiles` | `profiles__authenticated__update` | UPDATE | authenticated |
| `public.question_items` | `question_items__authenticated__select` | SELECT | authenticated |
| `public.session_activity_intervals` | `session_activity_intervals__authenticated__insert` | INSERT | authenticated |
| `public.session_activity_intervals` | `session_activity_intervals__authenticated__select` | SELECT | authenticated |
| `public.sources` | `sources__authenticated__select` | SELECT | authenticated |
| `public.target_mastery` | `target_mastery__authenticated__insert` | INSERT | authenticated |
| `public.target_mastery` | `target_mastery__authenticated__select` | SELECT | authenticated |
| `public.target_mastery` | `target_mastery__authenticated__update` | UPDATE | authenticated |
| `public.target_part_evidence` | `target_part_evidence__authenticated__insert` | INSERT | authenticated |
| `public.target_part_evidence` | `target_part_evidence__authenticated__select` | SELECT | authenticated |
| `public.unit_page_spans` | `unit_page_spans__authenticated__select` | SELECT | authenticated |
| `public.units` | `units__authenticated__select` | SELECT | authenticated |

### 7.4 Catalog views

Exactly `public.catalog_editions` and `public.catalog_sections`; both have `security_barrier=true`, owner-based view access, and anon/authenticated SELECT grants. anon has no other relation or sequence privileges in public/private. Exhaustive view-definition fingerprint remains unverified.

### 7.5 All 16 non-internal triggers

| Table | Trigger | State |
|---|---|---|
| `public.book_editions` | `book_editions_guard_delete` | Enabled |
| `public.book_editions` | `book_editions_set_updated_at` | Enabled |
| `public.books` | `books_set_updated_at` | Enabled |
| `public.categories` | `categories_set_updated_at` | Enabled |
| `public.content_jobs` | `content_jobs_set_updated_at` | Enabled |
| `public.daily_progress` | `daily_progress_set_updated_at` | Enabled |
| `public.learning_sessions` | `learning_sessions_set_updated_at` | Enabled |
| `public.master_plans` | `master_plans_guard_plan_order` | Enabled |
| `public.master_plans` | `master_plans_set_updated_at` | Enabled |
| `public.plan_chats` | `plan_chats_guard_update` | Enabled |
| `public.plan_chats` | `plan_chats_set_updated_at` | Enabled |
| `public.profiles` | `profiles_set_updated_at` | Enabled |
| `public.profiles` | `profiles_validate_profile` | Enabled |
| `public.sources` | `sources_set_updated_at` | Enabled |
| `public.target_mastery` | `target_mastery_set_updated_at` | Enabled |
| `public.units` | `units_guard_text` | Enabled |

## 8. Reproduction notes and boundaries

Use only SELECT catalog queries against the hosted project. Do not invoke any app_* or srv_* function during a read-only comparison. Identity checks use pg_proc joined to pg_namespace, pg_get_function_identity_arguments, prokind='f', and schemas public/private; body comparisons use prosrc. Effective access checks use has_function_privilege, has_table_privilege, has_any_column_privilege and has_sequence_privilege, plus aclexplode of function ACLs. Table checks use relkind r/p and relrowsecurity; policy checks use pg_policies; trigger checks exclude tgisinternal.

Query expressions involving sequence privileges must guard relkind with CASE, because PostgreSQL may evaluate privilege functions before other filters. Empty result sets must not be interpreted as success when the connector returns an error.

The hosted connection's observed session search_path was not pg_catalog-only. Each verification query qualified catalog functions/relations, but the requested uniform search_path/C-ordered reference fingerprint was not run. It remains DBV-002, rather than a pass inferred from names and counts.

No test fixture, key, password material or local agent/session state is included. Evidence above is the observed metadata snapshot, not a promise that the live project will remain unchanged.

## 9. Verdict

**Differences found: CRLF instead of LF in public.srv_throttle_record and public.srv_delete_personal_rows; no other differences in the completed checks, with the full catalog fingerprint unverified.**
