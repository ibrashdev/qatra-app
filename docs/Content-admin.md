# Qatra: content manager web admin (D91)

Version 1.1 · 2026-10-05 · Version 1.1 is an implementation record, no new owner approval: it records the coordinator's review decisions after the build (`GET /access` answers a boolean, a section's English title stays required, the withdraw retry, the counts' bank version and the 503 for a refused service key). Status: **Approved direction (owner, D91, 5 October 2026)**. The screens are built directly in code without a separate design file, on the owner's instruction. The detailed rules below are the coordinator's specification under D91 (Needs Review by the owner after the build). Implementation and verification status lives in [Readiness.tracker.md](Readiness.tracker.md), not here.

Owner's words (5 October 2026, Claude Code session), verbatim: «لا تستخدم figma قم ببناء الواجهات بشكل مباشر اعتمد خطة لبناء الواجهات والخدمة frontend & backend & DB & AI لا يوجد تعديل على قاعدة البيانات وانما واجهة CRUD للتحكم بمحتوياتها (ادارة فقط المحتوى لمدير المحتوى وليس ادارة الحسابات) قم ببناء واجهات التحكم دون عملية الاضافة كونها معقدة مبدأيا اشرح بشكل مبسط ثم باشر العمل عليها use subagents»

D91 amends, for this web admin only: D43 and D70 (the manager UI is no longer conditional on the day-one gate), API-spec §0 and §5 ("no HTTP content-management endpoint"), and the PRD roles matrix (the content manager signs in with an ordinary Qatra account that is named in a server setting). Everything else in D44, D69 and D25 still holds.

## 1. Scope

**In scope**

- Read every content table that matters to the manager: categories, books, sources, editions, sections, units (read only), counts of passages, lessons and questions, and the workflow job history.
- Update display metadata only (section 3).
- Remove content in the D44 way: physical delete only for things nothing uses; a published edition is withdrawn (irreversible) or hidden from the catalog (reversible).
- A read-only AI status card.

**Out of scope (not built, not allowed through this admin)**

- Create or add of any entity (the owner deferred it: «دون عملية الاضافة»). Adding content stays the CLI workflow.
- Account management of any kind; reading learner data, plans, sessions, attempts, progress or feedback.
- Editing verbatim source text, tokens, hashes, references, units, passages, lessons or question items. A correction is a new edition through the CLI workflow (D44, API-spec §5).
- `approve` and `publish`: they stay owner-typed CLI steps (API-spec §5.2, D71, D83).
- Any database migration, new role, grant, view or function.
- Any model call. The web admin never asks a model to write or edit content (D20, D22, D43); the AI question proposals of D92 belong to the CLI workflow, where they are checked and reviewed before the bank is built, and are not part of this admin.

## 2. Access and security

- **Who:** the server setting `QATRA_CONTENT_MANAGER_USERNAMES` (comma separated). Each entry is normalized with `normalize_username` and compared with the signed-in account's username. Empty or unset means nobody (fail closed). A demo session is never a manager. Trade-off accepted for the MVP: if the owner deletes their account, someone could later register the same username; the owner removes the name from the setting before deleting an account.
- **Guards, in this order:** `require_valid_origin` (every POST/PATCH), the session (`require_session_details`), `require_content_manager`, then the admin rate limiter `QATRA_RATE_ADMIN_PER_MIN` (default 60 per minute per IP).
- **Answers:** no session gives 401 `unauthenticated`; a signed-in non-manager gives 403 `forbidden`; a missing service gives 503 `unavailable`. The one exception is `GET /access`, which answers 200 with `contentManager: false` to a signed-in non-manager (and to a demo session), so the settings screen can ask without producing an error for every learner. A service key that the database refuses answers 503, never 401, so a deployment fault does not sign the manager out.
- **Database access:** server side only, through PostgREST with `SUPABASE_SERVICE_ROLE_KEY`, which Render already holds for the Auth Admin API. The browser never receives a key. Reads use the base content tables (the catalog views are not granted to `service_role`). The admin never queries a learner table; a learner reference is detected only by the database refusing a delete (foreign key `23503`).
- **No schema change:** `service_role` already has SELECT, INSERT, UPDATE and DELETE on the content tables (migration 0005) and EXECUTE on `srv_redact_revoked_content`.
- **Logs:** one event `content_admin_action` with `action`, `entity` and `outcome` only. No ids, usernames, text or bodies (API-spec §1.12).

## 3. What may change, per entity

| Entity (table) | Editable fields | Remove | Never changed here |
|---|---|---|---|
| Category (`categories`) | `label_ar`, `label_en` (nullable), `display_order` (0 to 9999) | Delete when no book uses it | `slug` |
| Book (`books`) | `title_ar`, `title_en` (nullable), `author`, `category_id` | Delete when no edition uses it | `content_format` |
| Source (`sources`) | `title`, `provider`, `license_url` (https, nullable), `rights_status` | Delete when no edition uses it | `source_url`, `eligibility_record`, `license_record`, `approved_rule_id` |
| Edition (`book_editions`) | `edition_label` (not when `revoked`) | See section 5 | `edition_key`, `book_id`, `source_id`, `version`, `bank_version`, `content_hash`, `status` directly, `review_record.approval` |
| Section (`book_sections`) | `title_ar`, `title_en` (not when the edition is `revoked`) | None | `ordinal`, `kind`, `reference`, `source_url` |
| Units, passages, lessons, questions, jobs | None (read only) | None | Everything |

Text limits after trimming: titles, labels, author and provider 1 to 120 characters; source title 1 to 200; withdrawal note 1 to 500; `license_url` up to 500 and must start with `https://`. Control characters are refused.

**Concurrency:** every editable row except sections carries `updated_at`. A write sends `expectedUpdatedAt` (the value it read). The server writes with the filter `updated_at=eq.<value>`; no row matched means 409 `version_conflict` with `details.reason = "stale"`. Sections have no `updated_at`; the last write wins (one manager).

## 4. HTTP API (prefix `/api/admin`)

JSON in camelCase, `Cache-Control: no-store`, error envelope and codes of API-spec §1. Every body model forbids unknown fields.

| Method and path | Body | Answer |
|---|---|---|
| `GET /access` | none | `{ "contentManager": boolean }` (session only, no manager check) |
| `GET /overview` | none | `Overview` |
| `GET /editions/{id}` | none | `EditionDetail` |
| `PATCH /editions/{id}` | `{ expectedUpdatedAt, editionLabel }` | `EditionDetail` |
| `POST /editions/{id}/withdraw` | `{ expectedUpdatedAt, reason, note }` | `EditionDetail` |
| `POST /editions/{id}/archive` | `{ expectedUpdatedAt }` | `EditionDetail` |
| `POST /editions/{id}/unarchive` | `{ expectedUpdatedAt }` | `EditionDetail` |
| `POST /editions/{id}/delete` | `{ expectedUpdatedAt }` | 204 |
| `GET /sections/{id}` | none | `SectionDetail` |
| `PATCH /sections/{id}` | `{ titleAr?, titleEn? }` (at least one) | `SectionDetail` |
| `GET /books` | none | `{ books: Book[], categories: CategoryOption[] }` |
| `PATCH /books/{id}` | `{ expectedUpdatedAt, titleAr?, titleEn?, author?, categoryId? }` | `Book` |
| `POST /books/{id}/delete` | `{ expectedUpdatedAt }` | 204 |
| `GET /categories` | none | `{ categories: Category[] }` |
| `PATCH /categories/{id}` | `{ expectedUpdatedAt, labelAr?, labelEn?, displayOrder? }` | `Category` |
| `POST /categories/{id}/delete` | `{ expectedUpdatedAt }` | 204 |
| `GET /sources` | none | `{ sources: Source[] }` |
| `PATCH /sources/{id}` | `{ expectedUpdatedAt, title?, provider?, licenseUrl?, rightsStatus? }` | `Source` |
| `POST /sources/{id}/delete` | `{ expectedUpdatedAt }` | 204 |

Deletes use POST, following the `POST /api/account/delete` convention (A-10). A PATCH must change at least one field (422 otherwise). A book's `titleEn`, a category's `labelEn` and a source's `licenseUrl` accept `null` to clear; a section's `titleEn` is NOT NULL in the database, so `null` there answers 422. A book `categoryId` that does not exist answers 422 (rule `category_not_found`). Passage, lesson and question counts are those of the edition's current `bank_version`.

**Shapes**

```text
EditionStatus  = "draft" | "validated" | "published" | "superseded" | "revoked"
EditionSummary = { id, editionKey, editionLabel, language, version, bankVersion, status,
                   catalogHidden, archivedAt|null, updatedAt, book: { id, titleAr, titleEn|null } }
Overview       = { counts: { categories, books, sources, editions: { <EditionStatus>: n } },
                   editions: EditionSummary[],            // by book titleAr, then version desc
                   ai: AiStatus }
AiStatus       = { chatModelForLearners, providerConfigured, models: string[], dailyCap,
                   usedToday|null, usedLastMinute|null }   // counters are in process memory
EditionDetail  = EditionSummary + { source: { id, title, provider, rightsStatus }, contentHash|null,
                   approval: { who, at, scope, words, source }|null,     // review_record.approval; each field text|null
                   withdrawal: { reason, note, at }|null,                // review_record.withdrawal; each field text|null
                   counts: { sections, units, passages, lessons, questions },
                   sections: { id, ordinal, kind, reference, titleAr, titleEn }[],   // by ordinal
                   jobs: { step, status, updatedAt, publishedAt|null }[],            // by created_at
                   actions: { editLabel, archive, unarchive, withdraw, delete } }    // booleans
SectionDetail  = { id, edition: { id, editionLabel, status }, ordinal, kind, reference, titleAr, titleEn,
                   units: { id, ordinal, kind, reference, text }[],                  // by ordinal
                   questionCounts: { wordOrder, wordChoice, wordRecall, similarDistinction } }
Book           = { id, titleAr, titleEn|null, author, contentFormat, category: { id, labelAr },
                   editionCount, updatedAt }
CategoryOption = { id, labelAr }
Category       = { id, slug, labelAr, labelEn|null, displayOrder, bookCount, updatedAt }
Source         = { id, title, provider, sourceUrl, licenseUrl|null, rightsStatus, checkedAt|null,
                   editionCount, updatedAt }
```

`reason` is one of `transmission`, `rights`, `accreditation` (the CLI's `--reason` values). `rightsStatus` is one of `owner_accepted_pending_verification`, `verified`, `rejected`.

**Errors:** 401 `unauthenticated`; 403 `forbidden` or `forbidden_origin`; 404 `not_found`; 409 `version_conflict` with `details.reason` one of `stale` (changed since read), `in_use` (something still uses it), `state` (not allowed in the current status); 422 `validation_error` with `details.fields`; 429 `throttled`; 503 `unavailable`. No new error code is added.

## 5. Edition actions

`actions` in `EditionDetail` is computed by the same rules the server enforces:

| Action | Allowed when | Effect |
|---|---|---|
| `editLabel` | status is not `revoked` | updates `edition_label` |
| `archive` (hide) | status `published` and `catalog_hidden` is false | `catalog_hidden = true`, `archived_at = now()`; appends `{action: "hidden", at}` to `review_record.catalogVisibility`; upserts the `content_jobs` row of step `archived` (status `succeeded`) |
| `unarchive` (show again) | status `published` and `catalog_hidden` is true | `catalog_hidden = false`, `archived_at = null`; appends `{action: "shown", at}` to `review_record.catalogVisibility`. Resolves O-26 for the web admin (coordinator design under D91, Needs Review) |
| `withdraw` | status `published` (never `superseded`) | see below; irreversible |
| `delete` | status `draft` and no job of step `published` was ever recorded | deletes the edition row; its sections, units, passages, lessons, questions, pages and jobs go with it (ON DELETE CASCADE). A learner reference makes the database refuse (`23503`), and the guard trigger refuses a non-draft (`23001`); both answer 409 |

**Withdraw sequence** (PostgREST has no multi-statement transaction, so each step is safe to repeat):

1. Read the edition. Status must be `published`; if it is already `revoked` with a `withdrawal` entry, skip to step 3 (a retry after a failed step 3 or 4).
2. PATCH `status = 'revoked'` and `review_record` = the read record plus `withdrawal: {reason, note, at, via: "admin_web"}` (the `approval` key is kept, CHECK `book_editions_status_approval_check`), filtered by `id`, `status=eq.published` and `updated_at`.
3. Call `srv_redact_revoked_content(p_edition_id)` (redacts offline snapshots and prepared sessions; idempotent).
4. Upsert the `content_jobs` row (`edition_id`, `bank_version`, step `withdrawn`, status `succeeded`); `pipeline_version` is copied from the edition's `published` job, or `admin-web` when none exists.

If step 3 or 4 fails, the answer is 503 `unavailable`; the status is already `revoked`, so learners no longer receive the edition, and repeating the request completes the remaining steps. For that reason `actions.withdraw` is also true for a revoked edition that has a `withdrawal` entry but no succeeded `withdrawn` job; the retry ignores the token, reason and note it receives and keeps the recorded ones. Lessons and question items keep their own status; row-level security already hides them through the edition status. If the `archived` job upsert fails after an edition was hidden, the answer is 503 and the edition stays hidden.

## 6. Screens

All screens are inside the signed-in app shell (`/admin` routes), Arabic first, RTL, WCAG 2.2 AA, with the existing kit, tokens and loading, waking, offline and throttle states. Test and mock data are synthetic; no Quran or hadith text is invented.

| Id | Route | Content |
|---|---|---|
| AD-00 | `/settings` (one row) | Link «إدارة المحتوى» shown only when `GET /api/admin/access` answers `contentManager: true`; any other answer shows nothing |
| AD-01 | `/admin` | Note that only display data is edited here; counts; links to books, categories and sources; AI status card; editions list (book, label, status, hidden mark, version) linking to AD-02 |
| AD-02 | `/admin/editions/[id]` | Details, approval and withdrawal records, counts, actions (rename, hide or show, withdraw with reason and note, delete draft), sections with rename and a link to AD-03, job history |
| AD-03 | `/admin/sections/[id]` | Titles with rename, question counts by game type, the units' original text read only (Quran text in the Quran face) |
| AD-04 | `/admin/books` | Books with edit (titles, author, category) and delete when no edition uses it |
| AD-05 | `/admin/categories` | Categories with edit (labels, order) and delete when empty |
| AD-06 | `/admin/sources` | Sources with edit (title, provider, license link, rights status) and delete when unused |

Every destructive confirmation is an alert dialog whose safe choice (Cancel) takes focus. The withdraw dialog states that withdrawal cannot be undone. A 403 shows «هذه الصفحة لمدير المحتوى فقط.»; a 401 returns to sign-in with the page as `next`.

## 7. AI

The web admin makes no model call and AI takes no part in its actions. The card on AD-01 only reports configuration and counters: whether the plan-conversation model is on for learners (`QATRA_CHAT_MODEL_FOR_LEARNERS`), whether a provider key is configured (yes or no, never the key), the configured free model ids (`OPENROUTER_MODELS`), the daily cap (`QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY`) and the counted requests today and in the last minute from the in-process ledger (reset when the server restarts). The rules engine stays the permanent fallback (D60). No `ai_usage` read is added (that would need a grant).

## 8. Known limits

- No create. Adding a book, edition or source stays the CLI workflow.
- Deleting a draft does not remove raw objects from the private `sources` bucket; the raw upload is deferred, so none exist today.
- The CLI's `withdraw`, `archive` and `delete-unused-draft` remain stubs; the web admin is the working path for these actions.
- Section titles have no concurrency token.
- In memory mode (local development and tests) the admin store starts empty; real data appears only with the Supabase backend.
- To become a manager, the owner adds their username to `QATRA_CONTENT_MANAGER_USERNAMES` on Render and redeploys.
