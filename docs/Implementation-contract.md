# Qatra — Implementation Contract v1.1

Version 1.1 · 2026-10-04 · Asia/Dubai · Status: **Approved decisions (D66–D69); remaining architecture deliverables are the next task; implementation not yet authorized.** Owner: root coordinator.

This file is the single source of truth for **cross-package interfaces**: content bundle, database tables, API DTOs, mastery/session/planning rules, auth flow and configuration. It fills the remaining Needs Review/Needs Input details of the approved package (D01–D69) with concrete, implementable choices. Where it is silent, follow [Architecture-and-data.md](Architecture-and-data.md), [Programming-guide.md](Programming-guide.md) and the owning policy document. A worker that finds a contradiction or gap returns it to the coordinator instead of inventing a rule. Changes to this file are made by the coordinator only.

Non-negotiables that still apply: original religious text is stored and shown verbatim and complete (D03/D20/D25); no generated religious content, explanations or LLM-written questions/answers/distractors (D20/D22/D31); free plans and free AI only, rules engine always available (D48/D54/D60); no secrets, real personal data or source texts committed to git; Arabic RTL first with English LTR UI (UX.md, Design-system.md; English religious terms per D28).

## 1. Repository layout and toolchain

```text
qatra-app/
  frontend/            Next.js 16 App Router, TypeScript strict, pnpm, Tailwind CSS
  backend/             FastAPI (Python 3.11+), uv, httpx, pydantic v2, pytest
    app/{routers,services,domain,repositories,providers,workflow}/
    scripts/content_tools.py
    tests/             incl. tests/data/synthetic_bundle.json (committed synthetic test bundle, §2.6)
    .content-build/    GITIGNORED: generated bundles/SQL containing source text
  supabase/migrations/ 0001_content.sql … 0005_rls_functions.sql
  fixtures/            synthetic demo scenarios/simulations only (demo_scenarios.json, demo_simulations.json)
```

- Frontend talks only to same-origin `/api/*`; Next.js `rewrites()` forward to `BACKEND_ORIGIN` (Render). No Next route handlers/Server Actions implementing business logic.
- Backend layering: router/DTO → service → domain policy (pure, no FastAPI/DB imports) + repository/provider.
- Fonts: no build-time network fonts. Self-host SIL OFL fonts from npm `@fontsource/*` packages (D69). UI font per [Design-system.md](Design-system.md): a clear Cairo-style Arabic sans (`Cairo`) for the Arabic RTL UI and `Inter` (or a similar sans) for the English LTR UI. Quran text `Amiri Quran` and hadith text `Amiri` (both SIL OFL); the original-text font follows the source requirements and never alters its letters. Verify Uthmani marks (U+06E1, U+06E5, U+06E6, U+06E2, U+06ED, U+06DF) render in the Playwright screenshots.

## 2. Content model

### 2.1 Editions (D68, owner decision 2026-10-04: source = Islamic Content MCP, https://mcp.islamiccontent.org/)

| Key | Book | Publisher record (via the Islamic Content MCP of the Association for Multilingual Islamic Content) | Reference shown |
|---|---|---|---|
| `quran-hafs-quranenc` | القرآن الكريم — جزء عم (Juz' 30, surahs 78–114, 564 ayat) | QuranEnc Arabic verse text (Uthmani Hafs), tool `get_quran_verses`, canonical URL per surah `https://islamenc.com/ar/quran/<surah>` | `سورة <name> <surah>:<ayah>` + canonical URL |
| `nawawi40-hadeethenc` | الأربعون النووية (42 hadiths) | HadeethEnc records that reproduce the Forty's own wording (e.g. ids 66511 = hadith 1, 66512 = hadith 3, 66529 = hadith 28, 66535 = hadith 41), tool `get_hadith`, canonical URL `https://hadeethenc.com/ar/browse/hadith/<id>` | `الأربعون النووية، الحديث <n>` + takhrij + grade as recorded + canonical URL |

These are web editions: there are no printed page numbers; the canonical URL is the page-level reference (`pages` stays empty, D62 evidence = URL + retrieval record). Store and display only the `[EXACT]` text and the `[ATTRIBUTION]` values (takhrij = HadeethEnc "Narrator" field, grade = "Grade" field) exactly as returned; HadeethEnc `[COMMENTARY]` (explanations/benefits) and QuranEnc translations/tafsir are **not** stored or shown (D20/D26). Every passage view shows the canonical URL beside the text (the publisher's citation requirement). A Forty hadith with no HadeethEnc record in the Forty's wording is reported as a gap and left out — never filled from memory, another wording or another source. Rights status: `owner_accepted_pending_verification` until the publisher's terms are recorded.

### 2.2 Units, tokens and references

- **Unit** = one ayah (Quran: `canonical_text` = the QuranEnc Arabic verse text exactly, NFC; the ayah number is rendered by the UI from the reference, not stored in the text). For each Forty hadith (section = hadith number) there are up to three units in order: `hadith_narration` (the `[EXACT]` narration including the narrator chain and the Prophet's words), `hadith_takhrij` (HadeethEnc "Narrator" field, e.g. «رواه البخاري ومسلم»), `hadith_grade` (HadeethEnc "Grade" field, e.g. «صحيح»). Section titles (Arabic `الحديث الأول` … `الحديث الثاني والأربعون` and the surah names) are UI labels, not unit text. English section labels follow D28 (Jamhara dictionary, never machine translation); until those terms are sourced they are numeric labels (`Surah 78` … `Surah 114`, `Hadith 1` … `Hadith 42`) carried in `titleEn`.
- **Tokens**: split `canonical_text` on whitespace (space, NBSP). Each token `{i, s, e, k, n, a?}`: index (0-based over all tokens), char start/end in `canonical_text`, kind `word|number|mark|punct`, `n` = normalized form (policy `arabic-norm-v1`, §2.5), optional `a` = alternative normalized form for Quran words containing superscript alef (U+0670 mapped to `ا` instead of removed), e.g. ٱلۡعَٰلَمِينَ → n `العلمين`, a `العالمين`.
  - `number`: only Arabic-Indic/ASCII digits (ayah number). `mark`: no Arabic letter (e.g. ۞ ۩, standalone pause marks). `punct`: punctuation only («», ، . : ؛ etc.). Everything else `word` (surface keeps attached marks/punctuation for display).
- **Token ref** (string): `"<unitOrdinal>:<tokenIndex>"`, e.g. `"12:3"`. Unit ordinals are 1-based and unique within an edition. Only `word` tokens may be answers.
- References: web editions have no printed pages; `unit_page_spans`/`edition_pages` stay empty and each unit carries its canonical URL in `units.source_url`. Quran reference `78:1`; hadith reference `nawawi40:<n>`.

### 2.3 Memorization targets: passages and parts (D66)

- **Passage** (the memorization target): a fixed contiguous token range inside one section, one memorization **path**.
  - Quran (`path='quran'`): whole ayat of one surah. If the surah has ≤ 60 words → one passage. Else `k = max(ceil(ayat/5), ceil(words/60))` passages, split at ayah boundaries into k consecutive groups balanced by word count (deterministic greedy: cut at the boundary nearest to each multiple of words/k).
  - Hadith `path='matn'`: inside the narration unit, the text from the opening `«` to the closing `»` (the Prophet's words), whole if ≤ 60 words, else split at sentence punctuation (`. ؟ ! ؛`, then `،`) into `ceil(words/60)` balanced groups.
  - Hadith `path='sanad'`: the narration-unit tokens before the opening `«` (narrator chain as mentioned, including the reporting phrase), one passage per hadith.
  - Hadith `path='grade'`: the `hadith_grade` unit as recorded (one passage, tested by `word_choice` among the grade phrases present in the edition: «اختر العبارة التي ذكرها المصدر عن درجة هذا الحديث»). Missing grade → no grade passage and the UI shows «غير مذكور في النسخة». Takhrij is always displayed and is not a memorization path (QBR-03).
  - Narrations whose `«…»` boundaries are absent or ambiguous are listed in `backend/app/workflow/data/nawawi40_boundaries.json` (token ranges only, no text) with `reviewed_by` and the doubt; such a hadith gets a single `matn` passage over the whole narration until reviewed.
- **Part**: the coverage unit inside a passage. Quran: an ayah of ≤ 8 words is one part; a longer ayah is split into balanced chunks of 4–8 words, preferring a cut after a token carrying a pause mark. Hadith: clauses split at `، ؛ : . ؟ !`; clauses < 3 words merge with the next; clauses > 8 words split into balanced chunks ≤ 8 words.
- **Word count** = number of `word` tokens.
- Default plan order is **book order** for every edition (AI-agent.md: proposal validation checks book order and that no unit of the scope is dropped): Juz' Amma surah 78 → 114 (ascending section ordinal) with passages inside a surah in mushaf order; Forty hadith 1 → 42. Reverse Juz' Amma order (surah 114 → 78) is not part of this version: it is an open question for the next task (§11), so no second order value exists yet.

### 2.4 Question bank (four templates, deterministic, D20/D31/D64)

All question text is assembled from token refs of the same edition; nothing is generated. Each question stores `covered_part_ids` (the part(s) whose tokens it tests) and `context_refs` (tokens shown around the blank; showing context is not coverage).

| type (`game_kind`) | Built per part | Answer | Covers |
|---|---|---|---|
| `word_order` | Parts with 3–8 words; two adjacent parts < 4 words each may be merged | Original token order | All tested parts |
| `word_choice` | (a) blank = continuation word (first word of a non-first part) or a keyword; 4 options = correct + 3 distractor words from the same section (different normalized form, length ±2 letters; fallback same edition). (b) segment variant: "choose what comes next" with 3 options of 2–4 contiguous words: the correct next segment + 2 other same-length segments from the same section | Option id | The part containing the blank/segment |
| `word_recall` | Blank = keyword (longest normalized word in the part outside a small stoplist) or continuation word; context ±6 words. Quran recall targets exclude words whose Uthmani spelling diverges from common spelling (containing U+0670, U+06E5, U+06E6, U+0653 or U+06DF) — those positions use `word_choice` instead | Typed single word, graded by `arabic-norm-v1` against `n` or `a` | The part containing the blank |
| `similar_distinction` (D31) | Only where another part in the same edition shares a normalized 3-gram (or ≥ 60% token overlap) but differs at a position — candidates come from normalized text matching inside one edition, not from embeddings (D69); options = correct word + the word at the similar position (`option_refs`). At session time a variant may use the learner's own recorded wrong word (`attempts.wrong_token_ref`) if that word exists in the edition | Option id | The part containing the position |

Stable ids: UUIDv5 over `(editionKey, bankVersion, entity, ordinal/natural key)` so rebuilds are idempotent. Hints (any use → assisted): recall = first letter; choice/similar = remove one wrong option; order = place the first token.

### 2.5 Normalization policy `arabic-norm-v1`

NFC; remove zero-width characters (U+200B–U+200F, U+FEFF), tatweel U+0640, harakat/tanwin/shadda/sukun U+064B–U+065F, superscript alef U+0670, Quranic marks U+06D6–U+06ED, Arabic-Indic digits only when grading words, and punctuation/«»; map أ إ آ ٱ ٲ ٳ → ا, ى → ي, ة → ه, ؤ → و, ئ → ي; collapse whitespace; Latin lowercase. A recall answer must be exactly one word after trimming; it is correct when its normalized form equals the target token's `n` or `a`. Unsupported/missing policy version → grading unavailable (never guessed).

### 2.6 Content bundle (workflow output, format v1)

One JSON file per edition (`backend/.content-build/<editionKey>/bundle.json`, gitignored) plus `publish.sql` (idempotent upserts for tables in §3.1) and `report.md` (counts, validation, provenance, discrepancies). A synthetic bundle generated by the same pipeline from a synthetic placeholder source is committed at `backend/tests/data/synthetic_bundle.json` for tests (inside `backend/tests/`; it adds no shared root path).

```json
{
  "bundleVersion": 1,
  "editionKey": "quran-hafs-quranenc",
  "bankVersion": 1,
  "category": {"slug": "quran", "labelAr": "القرآن الكريم", "labelEn": "Quran"},
  "book": {"id": "uuid", "titleAr": "…", "titleEn": "…", "author": "…", "contentFormat": "quran|hadith_collection"},
  "source": {"id": "uuid", "title": "QuranEnc|HadeethEnc", "provider": "Association for Multilingual Islamic Content (Islamic Content MCP)", "sourceUrl": "https://mcp.islamiccontent.org/", "acquisition": "mcp_tool|http", "toolName": "get_quran_verses|get_hadith", "rawSha256": "…", "retrievedAt": "ISO", "rightsStatus": "owner_accepted_pending_verification", "licenseRecord": {}, "verification": {"method": "…", "result": "passed|failed", "details": "…"}},
  "edition": {"id": "uuid", "editionLabel": "…", "language": "ar", "version": 1, "contentHash": "sha256", "paginationRecord": {"kind": "web_edition"}, "reviewRecord": {"knownGaps": [], "suspectedErrors": []}},
  "pages": [],
  "sections": [{"id": "uuid", "ordinal": 1, "kind": "surah|hadith", "reference": "78", "titleAr": "النبإ", "titleEn": "Surah 78", "sourceUrl": "https://islamenc.com/ar/quran/78"}],
  "units": [{"id": "uuid", "ordinal": 1, "sectionOrdinal": 1, "kind": "ayah|hadith_narration|hadith_takhrij|hadith_grade", "reference": "78:1", "sourceUrl": "…", "canonicalText": "…", "textHash": "sha256", "tokens": [{"i": 0, "s": 0, "e": 3, "k": "word", "n": "عم"}], "hadithMeta": {"fortyNumber": 1, "hadeethencId": 66511, "citesSahihayn": true, "gradeRecorded": true, "showD50Notice": false}}],
  "passages": [{"id": "uuid", "ordinal": 1, "sectionOrdinal": 1, "path": "quran|matn|sanad|grade", "startRef": "1:0", "endRef": "5:4", "wordCount": 23, "reference": "78:1-5", "parts": [{"id": "uuid", "ordinal": 1, "startRef": "1:0", "endRef": "1:1", "wordCount": 2}]}],
  "lessons": [{"id": "uuid", "ordinal": 1, "passageId": "uuid", "durationEstimateSec": 240}],
  "questions": [{"id": "uuid", "type": "word_order|word_choice|word_recall|similar_distinction", "variant": "word|segment|keyword|continuation|null", "passageId": "uuid", "coveredPartIds": ["uuid"], "tokenRefs": ["1:0"], "optionRefs": [["1:0"]], "correctRef": ["1:0"], "contextRefs": ["…"], "reference": "78:1"}]
}
```

### 2.7 Acquisition and verbatim verification

- Acquisition runs through the Islamic Content MCP tools. Each raw record is saved unmodified under `backend/.content-build/raw/` (gitignored) with the tool name, arguments, retrieval time and canonical URL: Quran `{surah, ayah, text, url}`; hadith `{hadeethencId, fortyNumber, title, narration, narrator, grade, url, languages}`.
- Because records pass through an assistant transcription step, every text is verified programmatically before it is published: (1) Quran: NFC-normalized text must equal NFC of the independent KFGQPC Hafs v18 oracle with its trailing ayah number removed, for all 564 ayat (a verification oracle only, never a content source); (2) hadith: two independent acquisitions must be identical after NFC, and the letter skeleton is compared with the OpenITI Shamela text of the Forty only to flag omissions/additions for review; (3) when `mcp.islamiccontent.org` becomes reachable from the build environment, the workflow re-acquires over HTTP (MCP JSON-RPC) and diffs byte-for-byte. Any mismatch blocks the affected unit until resolved.
- Text is stored NFC-normalized (canonically equivalent to the publisher's text). Zero-width characters present in the publisher text (e.g. U+200C) are preserved in `canonical_text` and removed only in normalized forms.

## 3. Database (Supabase Postgres)

Migrations live in `supabase/migrations/` and are applied in order. Every table enables RLS in the migration that creates it. Personal rows cascade on account deletion; published content is never deleted because a learner was deleted.

### 3.1 `0001_content.sql` (content worker)

Tables per Architecture "المخطط المنطقي: المحتوى المشترك" with these concrete additions: `book_editions.edition_key text unique`, `book_editions.bank_version int`; `book_sections.kind text`, `title_ar`, `title_en`, `source_url`; `units.kind`, `units.source_url`, `units.token_spans jsonb` (the token array), `units.hadith_meta jsonb`; `edition_pages`/`unit_page_spans` exist but stay empty for web editions; new `passages(id, edition_id, bank_version, ordinal, section_id, path, start_ref, end_ref, word_count, reference, unique(edition_id,bank_version,path,ordinal))`; new `passage_parts(id, passage_id, edition_id, ordinal, start_ref, end_ref, word_count, unique(passage_id,ordinal))`; `lessons.passage_id`; `question_items(… type, variant, passage_id, covered_part_ids uuid[], token_refs jsonb, option_refs jsonb, correct_ref jsonb, context_refs jsonb …)`; `unit_embeddings(embedding vector(384))` created but not populated (D69: embeddings are postponed for the MVP, amending D37/D65 for the MVP only; the workflow's `embedded` step is skipped and D31 candidates come from normalized text matching inside one edition, §2.4); `content_jobs` as documented. RLS: `authenticated` may `select` content rows whose edition is `published` and not revoked; writes only via `service_role`. `create extension if not exists vector`.

### 3.2 `0002_identity.sql` … `0005_rls_functions.sql` (backend worker)

- `private` schema (not exposed through the Data API): `account_handles`, `recovery_codes`, `password_reset_grants`, `app_sessions`, `auth_throttle` exactly as Architecture §"الحساب والتقدم الخاص".
- `public.profiles` with `terms_version`, `terms_accepted_at`, `language`, `time_zone`, `session_minutes (5|10|15)`, `reminder_settings jsonb`, `pending_settings jsonb` (next-learning-day changes, D57), `is_demo` mirror (read-only to the user).
- `master_plans` (+ `paths text[]`, `plan_order text`), `plan_versions`, `plan_phases`, `learning_sessions` (+ `steps jsonb` immutable snapshot, `status prepared|open|completed`), `attempts` (+ `assisted bool`, `review_round_id uuid null`), `reviews` (unused rows allowed; mastery ladder lives in `target_mastery`), `session_activity_intervals`, `daily_progress`, `daily_completions`, `target_mastery` (see §4), `target_part_evidence(user_id, plan_id, passage_id, part_id, attempt_id, learning_date, unique(user_id,plan_id,part_id))`, `offline_snapshots` (+ `payload jsonb`), `ai_usage(provider, model, prompt_version, input_tokens, output_tokens, cost_usd numeric null, status, created_at)` with no learner text.
- One active plan per account: partial unique index on `master_plans(user_id) where status='active'`.
- Private access functions live in `public` as `srv_*` `SECURITY DEFINER` functions with `set search_path = ''`; `revoke execute … from public, anon, authenticated, service_role; grant execute …` only to the separate limited database role whose credential is the `QATRA_SERVER_DB` secret on Render (D34, D69; the functions' uses are listed in Architecture-and-data.md, «RLS والحدود»). `service_role` never runs these functions and is not used for learner requests: it is limited to the Supabase Auth Admin API (create user at registration, reset password by recovery, delete account) and content publishing, including content-workflow writes (D34, D37).
- Learner tables: RLS `user_id = (select auth.uid())` with parent-ownership checks via composite foreign keys `(id, user_id)`.

## 4. Mastery engine (D41/D64 as resolved by D66)

State per `(user, plan, passage)` in `target_mastery`: `status new|learning|reviewing|confirmed|needs_refresh`, `consecutive_correct`, `initial_success_at`, `initial_learning_date`, `review_stage 0..3`, `next_review_due date`, `last_review_date`, `confirmed_at` (current confirmation), `first_confirmed_at`, `maintenance_stage`, `lapse_count`, `error_part_ids uuid[]`. Coverage evidence in `target_part_evidence`.

1. **Validated attempt** (server-graded): correct and unassisted → `consecutive_correct += 1` and every covered part gains evidence (once per part). Incorrect → `consecutive_correct = 0`, covered parts added to `error_part_ids`. Assisted (hint used) → no streak change, no evidence, counts only as training time.
2. **Initial evidence**: first time `consecutive_correct ≥ 3` for the passage → `initial_success_at`, `initial_learning_date`, `status = reviewing`, `review_stage = 1`, `next_review_due = learning_date + 1`.
3. **Review ladder**: intervals 1, 2, 4 days between stages (cumulative days 1/3/7 when on time). A review round for a passage has `k` questions: 1 if the passage has ≤ 2 parts, 2 if 3–5, 3 if ≥ 6; parts chosen uncovered-first, then error parts, then least recently tested; game types rotate. **Pass** = every round question answered correctly, unassisted, at the first attempt. Pass → advance one stage (at most one stage per learning date per passage), `next_review_due = review date + next interval`. **Fail** (any error or hint in the round) → `review_stage = 1`, `next_review_due = learning_date + 1`, `lapse_count += 1`, failing parts added to `error_part_ids`; coverage and initial evidence are kept.
4. **Confirmation**: when stage 3 has passed **and** every part of the passage has evidence → `status = confirmed`, `confirmed_at` (and `first_confirmed_at` if empty), `maintenance_stage = 1`, next maintenance due at +14 days.
5. **Maintenance** after confirmation: rounds at +14, +30, then every +60 days. Pass → next interval. **Fail** → `status = needs_refresh`, `confirmed_at = null` (first_confirmed_at kept), re-enter the ladder at stage 1 due next learning day; re-confirmed after passing stages 1–3 again (coverage and initial evidence kept).
6. **Missed/overdue reviews** stay due without penalty and are prioritized; a late pass schedules the next interval from the actual review date.
7. **Overall plan progress** = `floor(100 × Σ wordCount(passages with status confirmed) / Σ wordCount(all passages in the active plan version scope for the selected paths))`. Shown separately: confirmed sections (a surah or hadith counts when all its passages for the selected paths are confirmed), in-progress (`reviewing`), needs-refresh counts, next review date. Daily progress (D40) is independent and time-based.
8. **Path changes** (hadith) are a plan revision effective the next learning day: deselected paths leave the denominator but their evidence stays in history; reselecting restores it. Understanding/application questions are not part of this build.

## 5. Planning rules v1 (rules engine; Teaching Agent only for demo accounts, D17)

- **Scope**: `targetScope = {sectionOrdinals: number[]}` within one edition (default: all sections). Paths: Quran `['quran']`; Forty default `['matn']`, optional `sanad`, `grade`.
- **Order**: plan order is book order (§2.3): sections by ascending ordinal and passages in book order inside a section; new passages are introduced in that order. Any Teaching Agent proposal is also validated for book order and for dropping no passage of the scope (AI-agent.md). Reverse Juz' Amma order is an open question (§11).
- **Placement** (optional, `kind=placement`): up to 8 passages sampled evenly across the scope, one `word_choice` (continuation) or `word_recall` question each, plus optional self-rating `none|some|most`. Placement time never counts toward daily progress. A correctly answered placement passage is marked `known` for the estimate and is scheduled as an early quick review instead of new learning (no mastery credit).
- **Capacity** (new words per learning day): 5 min → 12, 10 min → 25, 15 min → 40. A passage larger than capacity is introduced over consecutive days (one passage at a time).
- **Estimate**: `days = ceil((totalWords − knownWords) / capacity × 1.15)` (15% review buffer); `endDate = today + days`. Alternatives: (a) next larger minutes option, (b) scope halved (first half in plan order). `reasonCode`: `fits_preferred_date | exceeds_preferred_date | no_preferred_date`.
- **Daily session** (`kind=daily`), in order: (1) due review rounds (overdue first), capped at 6/10/14 questions for 5/10/15 min; (2) continue the current `learning` passage or introduce the next passage(s) in plan order up to capacity: a `learn` step showing the full passage with reference, edition, page(s), takhrij and D50 notice, then training questions (one per part, rotating templates) and extra questions until the passage reaches the ≥ 3 streak; (3) end-of-session test of 3/5/7 questions mixing today's passage parts, error parts and uncovered parts. The learner may continue with more practice; nothing force-closes the session.
- **Absence (PRD R07)**: after 3 or more days of absence the session starts with a light review (the due reviews of step 1) and introduces no new material by default; missed days are not stacked, and due reviews that do not fit the session stay due for the following days (AI-agent.md, QA-and-evaluation.md).
- **Game session** (`kind=game`): up to 10 questions of an optional `gameType` over optional `passageIds` inside the active plan scope (future-day passages allowed).
- **Teaching Agent** (`services/planner.py`): for `is_demo` accounts with a fixture scenario only. Input = scenario id, passage ids/word counts, placement correct/incorrect counts (no account id or free text). Output JSON `{newWordsPerDay, reviewOffsetsDays, priorityReviewPassageIds}` validated against allowed ids and bounds; new material always follows book order with no unit dropped (AI-agent.md), so the agent sets pace and review timing/priority only, never the order of new passages; any failure, timeout (8 s) or ineligible model → rules engine. Every call records `ai_usage`.

## 6. Authentication and sessions

- The username, password and recovery-code rules below summarize [Authentication-and-privacy.md](Authentication-and-privacy.md), the owning policy document.
- Username 3–24 characters: Arabic or English letters, digits, underscore. Uniqueness is checked on the NFKC-normalized name with English (Latin) letters lowercased; names containing invisible characters or spaces are rejected. No other folding is applied (in particular no Arabic letter folding; `arabic-norm-v1` is for grading words only). These rules do not apply to passwords.
- Password: at least 15 Unicode characters and at most 72 bytes in UTF-8 (the current Supabase Auth limit; the cap counts bytes, not Arabic letters). The server and the UI both validate before submission; an over-long password is rejected, never truncated or normalized. Arabic/English passphrases, pasting and password managers are allowed; no symbol-composition rules and no periodic rotation. Passwords are stored only by Supabase Auth (no password column in app tables).
- Supabase Auth identity: email alias `u.<uuid4>@qatra.invalid`, `email_confirm = true`, created with the Admin API (service role). Login: password grant with the alias. Learner data calls use the user's access token (RLS); the browser never receives Supabase tokens.
- App session: 32 random bytes → cookie `__Host-qatra_session` (Secure, HttpOnly, SameSite=Strict, Path=/; in local http dev `qatra_session` without the prefix and without Secure). Stored: `session_hash = HMAC-SHA256(QATRA_SESSION_HMAC_KEY, token)`, `encrypted_auth_tokens = AES-256-GCM(QATRA_SESSION_KEY, {access, refresh, exp})`, `auth_epoch`, `expires_at = now + 30 days`. Access tokens refresh server-side.
- Mutations require `Origin == FRONTEND_ORIGIN` (403 otherwise). Throttle per HMAC(`QATRA_THROTTLE_HMAC_KEY`, username) and HMAC(`QATRA_THROTTLE_HMAC_KEY`, IP /24 or /48 prefix from the trusted proxy header): after 5 failures in 15 min progressive delay; 20 → 429 for 15 min.
- Recovery code: 16 random bytes (128 bits) from a cryptographic random generator, displayed once as 32 hexadecimal characters in groups of four separated by `-` (display only). Before the HMAC check the server normalizes the input: remove the display separators, map Arabic-Indic digits ٠–٩ to 0–9, map A–F to a–f; then compares with a constant-time (secret-safe) comparison. Stored only as an HMAC-SHA-256 fingerprint under its own server-side key `QATRA_RECOVERY_HMAC_KEY` (also used to hash reset grants); the raw code is never stored, logged or sent to a model. Verify → atomic reservation → reset grant (random, 10 min, hashed) → reset → code consumed, new code issued once, `auth_epoch += 1`, all app sessions revoked.
- Terms: `TERMS_VERSION = "2026-10-04"`. Registration (normal and demo) requires `termsAccepted === true` and the current version; stores `terms_version` and server-time `terms_accepted_at` only. Login returns `reconsentRequired` when the stored version is older.
- Demo accounts: `POST /api/demo/accounts` is the demo link; the server sets `is_demo`. No client flag can set demo mode.

## 7. API contract (all paths under `/api`, JSON, camelCase)

Errors: HTTP status + `{"error": {"code": "snake_case", "message": "safe text", "details": {}}}`. Codes: `validation_error` 422, `invalid_credentials` 401, `unauthenticated` 401, `forbidden_origin` 403, `not_found` 404, `username_taken` 409, `version_conflict` 409, `terms_required` 400, `throttled` 429, `unavailable` 503, `internal` 500. Mutations accept an `Idempotency-Key` header where noted.

```ts
type ISODate = string;        // YYYY-MM-DD (learning date in the account time zone)
type ISODateTime = string;    // RFC 3339 UTC
type TokenRef = string;       // "<unitOrdinal>:<tokenIndex>"
type Path = 'quran' | 'matn' | 'sanad' | 'grade';
type GameKind = 'word_order' | 'word_choice' | 'word_recall' | 'similar_distinction';
type PlanOrder = 'book';      // book order only; reverse Juz' Amma order is an open question (§2.3, §11), so no second value yet

interface Profile { username: string; language: 'ar' | 'en'; timeZone: string; sessionMinutes: 5 | 10 | 15;
  reminderSettings: { inApp: boolean }; isDemo: boolean; termsVersion: string; termsAcceptedAt: ISODateTime;
  createdAt: ISODateTime; pendingSettings: { sessionMinutes?: 5 | 10 | 15; timeZone?: string; effectiveDate: ISODate } | null; }

interface CatalogSection { sectionId: string; ordinal: number; kind: 'surah' | 'hadith'; reference: string;
  titleAr: string; titleEn: string; wordCount: number; passageCount: number; paths: Path[]; }
interface CatalogEdition { editionId: string; editionKey: string; titleAr: string; titleEn: string; author: string;
  editionLabel: string; category: { slug: string; labelAr: string; labelEn: string }; catalogVersion: number;
  contentFormat: 'quran' | 'hadith_collection'; availablePaths: Path[]; defaultPaths: Path[];
  defaultOrder: PlanOrder; totalWords: number; sections: CatalogSection[]; }

interface TargetScope { sectionOrdinals: number[]; }
interface Estimate { days: number; endDate: ISODate; newWordsPerDay: number; totalWords: number; knownWords: number;
  passageCount: number; sessionMinutes: 5 | 10 | 15; scope: TargetScope; paths: Path[]; }
interface Plan { planId: string; editionId: string; titleAr: string; titleEn: string; targetScope: TargetScope;
  paths: Path[]; order: PlanOrder; sessionMinutes: 5 | 10 | 15; preferredDate: ISODate | null;
  agreedEstimate: Estimate; currentVersion: number; status: 'active' | 'paused' | 'completed'; createdAt: ISODateTime;
  planner: { source: 'rules' | 'teaching_agent'; model?: string }; }

interface DailyProgress { learningDate: ISODate; dailyActiveMs: number; dailyGoalMs: number; dailyPercent: number;
  dailyCompleted: boolean; extraActiveMs: number; }
interface Today extends DailyProgress { plan: Plan | null; dueReviews: number; nextNewPassage: { reference: string;
  sectionTitleAr: string } | null; openSessionId: string | null; streakDays: number; }
interface PlanProgress { planId: string; titleAr: string; titleEn: string; status: Plan['status']; overallPercent: number;
  confirmedWords: number; totalWords: number; confirmedSections: number; totalSections: number;
  counts: { new: number; learning: number; reviewing: number; confirmed: number; needsRefresh: number };
  nextReviewDate: ISODate | null;
  sections: { ordinal: number; reference: string; titleAr: string; titleEn: string; percent: number;
    status: 'new' | 'learning' | 'reviewing' | 'confirmed' | 'needs_refresh' }[]; }
interface ProgressResponse { daily: DailyProgress; history: { date: ISODate; activeMs: number; goalMs: number;
  completed: boolean }[]; plans: PlanProgress[]; }

interface TokenView { ref: TokenRef; text: string; }
interface SourceRef { publisher: string; editionLabel: string; bookTitleAr: string; reference: string; url: string;
  pages: string[]; }                                                     // pages empty for web editions; url always shown
interface PassageView { passageId: string; path: Path; reference: string; sectionTitleAr: string;
  units: { unitRef: number; kind: 'ayah' | 'hadith_narration'; reference: string; text: string }[]; // verbatim
  highlight: { startRef: TokenRef; endRef: TokenRef };                    // the passage range inside the units
  takhrij: string | null; grade: string | null; showD50Notice: boolean; source: SourceRef; }
interface QuestionBase { questionId: string; type: GameKind; passageId: string; role: 'training' | 'review' | 'test' |
  'placement' | 'game'; reviewRoundId: string | null; context: { before: TokenView[]; after: TokenView[] };
  policy: { normalizationPolicyVersion: 'arabic-norm-v1'; scoringPolicyVersion: 'v1' }; source: SourceRef; }
interface WordOrderQuestion extends QuestionBase { type: 'word_order'; tokens: TokenView[];      // shuffled
  answerKey: { order: TokenRef[] }; }
interface ChoiceOption { optionId: string; text: string; }
interface WordChoiceQuestion extends QuestionBase { type: 'word_choice'; variant: 'word' | 'segment';
  options: ChoiceOption[]; answerKey: { optionId: string }; }
interface SimilarQuestion extends QuestionBase { type: 'similar_distinction'; options: ChoiceOption[];
  answerKey: { optionId: string }; }
interface RecallQuestion extends QuestionBase { type: 'word_recall'; hintFirstLetter: string;
  answerKey: { acceptedNorms: string[] }; }
type Question = WordOrderQuestion | WordChoiceQuestion | SimilarQuestion | RecallQuestion;
type Step = { type: 'learn'; passage: PassageView } | { type: 'question'; question: Question };
interface SessionSnapshot { sessionId: string; kind: 'daily' | 'game' | 'placement'; planId: string | null;
  planVersion: number | null; editionId: string; bankVersion: number; learningDate: ISODate; status: 'prepared' | 'open' | 'completed';
  steps: Step[]; createdAt: ISODateTime; }

type AnswerPayload = { order: TokenRef[] } | { optionId: string } | { text: string };
// Replay envelope of an event recorded offline: PWA-design.md §5 "OfflineEvent" names, proposed there and Needs Review (NR below
// = Needs Review in PWA-design.md). All fields or none; online events omit it. localSequence is ordering input, never a trusted clock.
interface OfflineEnvelope { clientRunId: string; snapshotId: string; protocolVersion: 1; planVersion: number; editionId: string;
  bankVersion: number; normalizationPolicyVersion: 'arabic-norm-v1'; scoringPolicyVersion: 'v1'; localSequence: number; }
type SessionEvent = (
  | { clientEventId: string; type: 'answer'; questionId: string; answer: AnswerPayload; hintUsed: boolean;
      occurredAt: ISODateTime; durationMs: number }
  | { clientEventId: string; type: 'activity'; startedAt: ISODateTime; endedAt: ISODateTime; activeMs: number }
) & Partial<OfflineEnvelope>;
interface AnswerResult { clientEventId: string; questionId: string; correct: boolean; assisted: boolean;
  expected: { order?: TokenRef[]; optionId?: string; word?: string };
  passage: { passageId: string; status: 'new' | 'learning' | 'reviewing' | 'confirmed' | 'needs_refresh';
    coveredParts: number; totalParts: number; consecutiveCorrect: number }; }
interface EventsResponse { acknowledged: string[];
  duplicate: string[];                                        // same clientEventId already acknowledged earlier (PWA-design §5; NR)
  pending: { clientEventId: string; reasonCode: string }[];   // disputed/unverifiable: kept without credit (D59; NR)
  rejected: { clientEventId: string; code: string }[]; results: AnswerResult[]; daily: DailyProgress; }
interface CompleteResponse { summary: { answered: number; correct: number; newPassages: number; reviewsPassed: number;
  reviewsFailed: number; activeMs: number }; daily: DailyProgress; }

// Offline snapshot: field names follow PWA-design.md §4 ("PlanSnapshot" proposed there). NR marks shapes PWA-design leaves in
// Needs Review: the names are kept, do not invent a shape; return the gap to the coordinator.
interface PlanSnapshot {
  snapshotId: string; schemaVersion: 1; protocolVersion: 1;
  userId: string;                            // owner binding: non-secret ownership id; not a credential and not encryption
  planId: string; planVersion: number; editionId: string; bankVersion: number;
  targetScope: TargetScope;
  downloadedTargetRefs: string[];            // the accepted downloadTargetRefs (memorization targets = passage ids, D66)
  learningTimeZone: string; dailyGoalMs: number;
  contentHashes: Record<string, string>;     // NR: sha256 per downloaded content part (e.g. unit textHash, §2.6); keying/chunking open
  verifiedAt: ISODateTime;                   // NR: when the server last verified the snapshot
  contentValidity: Record<string, unknown>;  // NR: record of the last server validity/rights check; not a lease, not an expiry
  normalizationPolicyVersion: 'arabic-norm-v1'; scoringPolicyVersion: 'v1';
  preparedSessions: SessionSnapshot[];       // status 'prepared', kind 'daily' | 'game', each with its server-owned sessionId
  lessons: PassageView[];                    // verbatim text with edition, pages and source reference
  games: Question[];                         // NR: question descriptors (four templates, all options/distractors needed offline)
  references: SourceRef[]; }
type OfflineStatus = 'available' | 'stale' | 'revoked' | 'expired';
interface RevalidationResult { status: OfflineStatus; currentPlanVersion: number; allowedSessionRefs: string[];
  catalogVersion: number; reasonCode: string; }
```

| Method/path | Request | Response |
|---|---|---|
| GET `/health` | — | `{status:'ok', version, time}` (no auth, no secrets) |
| POST `/auth/register` | `{username, password, timeZone, language, termsAccepted:true, termsVersion}` | 201 `{profile: Profile, recoveryCode}` + cookie |
| POST `/auth/login` | `{username, password}` | `{profile, reconsentRequired}` + cookie |
| POST `/auth/consent` | `{termsVersion}` (session) | `{profile}` |
| POST `/auth/recovery/verify` | `{username, recoveryCode}` | `{resetGrant, expiresInSec}` |
| POST `/auth/recovery/reset` | `{resetGrant, newPassword}` | `{recoveryCode}` (then login) |
| POST `/auth/recovery/rotate` | `{password}` (session) | `{recoveryCode}` |
| POST `/auth/password` | `{currentPassword, newPassword}` (session) | `{profile}` + new cookie (all other sessions revoked) |
| POST `/auth/logout` | — | 204, cookie cleared |
| GET/PATCH `/me` | PATCH `{language?, timeZone?, sessionMinutes?, reminderSettings?}` | `Profile` (minutes/zone become `pendingSettings` for the next learning day) |
| DELETE `/account` | `{password, confirm:'DELETE'}` | 204 |
| GET `/catalog` | — | `{editions: CatalogEdition[]}` |
| POST `/plans/estimate` | `{editionId, targetScope, paths, sessionMinutes, preferredDate?, placementSessionId?}` | `{estimate, alternatives: Estimate[], reasonCode}` (no writes) |
| POST `/plans` | `{editionId, targetScope, paths, order, sessionMinutes, preferredDate?, placementSessionId?, confirmedEstimate}` | 201 `Plan` (previous active plan → paused) |
| POST `/plans/:id/revise` | `{expectedVersion, sessionMinutes?, preferredDate?, paths?}` | `Plan` or 409 |
| GET `/today` | — | `Today` |
| GET `/progress` | — | `ProgressResponse` |
| POST `/sessions` | `{kind:'daily', planId, expectedPlanVersion}` · `{kind:'game', planId, expectedPlanVersion, gameType?, passageIds?}` · `{kind:'placement', editionId, targetScope, selfRating?}` | 201 `SessionSnapshot` (daily returns the open session for today if one exists) |
| POST `/sessions/:id/events` | `{events: SessionEvent[]}` (≤ 100) | `EventsResponse` (idempotent per clientEventId) |
| POST `/sessions/:id/complete` | — | `CompleteResponse` |
| POST `/plans/:id/offline-snapshots` | `{clientOperationId, expectedPlanVersion, downloadTargetRefs}` (`downloadTargetRefs: string[]`; proposed in PWA-design §5, NR) | 201 `PlanSnapshot`; the same input again → 200 with the same snapshot; changed input → 409; invalid reference, version or scope → 422 |
| GET `/offline-snapshots/:id` | — | 200 `PlanSnapshot`, or a chunked download manifest with positions and hashes (shape NR); `Cache-Control: no-store`; read-only, creates no session |
| POST `/offline/revalidate` | `{snapshotId, expectedPlanVersion, editionId, bankVersion}` | `RevalidationResult` (`status` is an `OfflineStatus`: available, stale, revoked or expired) |
| POST `/demo/accounts` | same body as register | 201 `{profile, recoveryCode}` + cookie, `isDemo:true` |
| GET `/demo/scenarios` | — | `{scenarios: {scenarioId, titleAr, titleEn, editionKey, targetScope}[]}` |
| POST `/demo/plans` | `{scenarioId, placementSessionId?}` (demo session only) | 201 `Plan` with `planner` |
| GET `/demo/simulations` | — | `{simulations: …}` from `fixtures/demo_simulations.json`, labeled synthetic |

Server-side rules: never accept `userId`, `correct`, mastery, daily totals or demo/mode flags from the client; validate every question/passage against the session's edition, bank version and plan scope; reject events for sessions owned by another account (404).

**Activity events**: `endedAt ≤ serverNow + 60 s`; `startedAt ≥ session.createdAt − 60 s`; `activeMs ≤ endedAt − startedAt + 1000`; ≤ 30 min per event; placement sessions excluded; learning date from `startedAt` in the account time zone effective that day; overlapping intervals of the same account and date are merged (union) before totals; `daily_completions` written once when `activeMs ≥ goalMs`.

**Offline (D46/D58/D59)**: names follow PWA-design.md §4–§6, where the offline contract is proposed and Needs Review (NR). The snapshot is created online from `downloadTargetRefs` (refs of memorization targets, i.e. passages, D66, inside the plan's edition and scope; the numeric size and partitioning of a download are NR and none is set here) and holds the server-prepared sessions for those targets (`preparedSessions`: `status prepared`, `offline_snapshot_id` set) plus the `lessons`, `games` and `references` they use; GET never creates a session. Events recorded offline are replayed later to `/sessions/:id/events` with their original ids and the offline envelope; only a server acknowledgment removes an event from the local outbox; old events are validated in their original plan/version even if the plan changed (D59); disputed or unverifiable events stay pending without credit, and the device clock is not proof. `/offline/revalidate` statuses: `available` permits new runs (replaying an old event still needs a per-event eligibility decision, D59); `stale` stops display and new runs of the affected material until it is revalidated; `revoked` and `expired` block display of the blocked text and clear its material locally; `expired` means validity actually ended per source/session data (no TTL is invented). A 401 stops replay and asks for an online login; a free-server wake-up timeout or 5xx (D48) is a connectivity state, never `stale`, `revoked` or `expired`. No lease, lock or expiry is added (D58).

## 8. Configuration

Backend (Render environment only; local `.env` gitignored): `APP_ENV` (`production|development|test`), `FRONTEND_ORIGIN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable), `SUPABASE_SERVICE_ROLE_KEY` (secret; Auth Admin API and content publishing only, never the `srv_*` functions or learner requests), `QATRA_SERVER_DB` (secret; credential of the separate limited database role that runs the private `SECURITY DEFINER` functions, D34/D69; never `service_role`), `QATRA_SESSION_KEY` (AES-256-GCM token encryption), `QATRA_SESSION_HMAC_KEY`, `QATRA_RECOVERY_HMAC_KEY` and `QATRA_THROTTLE_HMAC_KEY` (each 32 independent random bytes, base64; one key per purpose), `TERMS_VERSION`, `OPENROUTER_API_KEY` (optional), `OPENROUTER_MODELS` (comma-separated candidates; only models whose live pricing is zero are used), `QATRA_DATA_BACKEND` (`supabase|memory`; `memory` is refused when `APP_ENV=production`), `QATRA_CONTENT_BUNDLES` (memory mode: comma-separated bundle paths). `backend/.env.example` lists names only.

Frontend (Vercel): `BACKEND_ORIGIN` (Render URL, used by rewrites; not secret).

## 9. Verification baseline and device support (D67)

Supported target (basic version): phones 360–430 px wide in portrait first, tablets 768–1024 px, desktop ≥ 1280 px; usable down to 320 px without horizontal scrolling. Browsers: iOS/iPadOS 17+ Safari (install via Share → Add to Home Screen), Android 10+ Chrome current and previous major version, Samsung Internet current, desktop Chrome/Edge/Firefox current and previous major version, Safari 17+ on macOS. Installable PWA with offline reopen: Android Chrome/Samsung Internet, desktop Chrome/Edge, iOS Safari 17+ (manual add). Not supported: Internet Explorer, legacy Edge, iOS < 17, Android < 10; in-app browsers work online only and show an «افتح في المتصفح» hint for install/offline. Accessibility: WCAG 2.2 AA (contrast, visible focus, 44×44 px touch targets, reduced motion, screen-reader labels in Arabic and English).

- Backend: `uv run ruff check`, `uv run pytest` (domain policies, services with in-memory repositories, API tests with httpx/TestClient).
- Frontend: `pnpm lint`, `pnpm typecheck`, `pnpm build`, unit tests for game evaluation/normalization, Playwright e2e on Chromium at 360×780, 390×844 and 1280×800 against backend memory mode.
- Real-device checks on the D67 support matrix are manual and labeled as such; only the actually tested matrix is reported as verified.

## 10. Package ownership (exclusive)

| Package | Owns |
|---|---|
| Acquisition | `backend/.content-build/raw/**`, `backend/.content-build/acquisition_report.md` (gitignored; raw publisher records only) |
| Content | `supabase/migrations/0001_content.sql`, `backend/app/workflow/**`, `backend/app/domain/content_policy.py`, `backend/app/domain/normalization.py`, `backend/scripts/content_tools.py`, `backend/tests/workflow/**`, `backend/tests/data/**` (committed synthetic bundle), `backend/.content-build/<editionKey>/**` |
| Backend | `backend/` except the content-owned paths, `supabase/migrations/0002…0005`, `fixtures/demo_*.json` |
| Frontend | `frontend/**` |
| Coordinator | `docs/**`, root files, deployment, integration fixes |

Shared file `backend/app/domain/normalization.py` (`arabic-norm-v1`) is owned by the content package; the backend imports it. The committed synthetic bundle `backend/tests/data/synthetic_bundle.json` (§2.6) is also owned by the content package; backend tests, memory mode (`QATRA_CONTENT_BUNDLES`) and the Playwright e2e only read it.

## 11. Open risks and open questions (next task)

Recorded here, not decided; do not resolve them by assumption.

- **Open risk: client-held answer keys and client-reported hint use.** Session snapshots (including offline snapshots) carry each question's `answerKey` to the client, and `hintUsed` is reported by the client, so a modified client can inflate its own progress. This version has only the server-side controls above (server grading of submitted answers, event validation, never accepting `correct` or mastery from the client); no further mitigation is decided (self-study app without certificates, D69).
- **Open question: reverse Juz' Amma order (surah 114 → 78).** Version 1 offered it as the default; this version uses book order (§2.3, §5). Whether a reverse-order option is offered at all, and how, is undecided.
- **Open item: English religious labels (D28).** Category, book, edition and demo-scenario English labels (e.g. `labelEn`, `titleEn`) must come from the Jamhara dictionary; until sourced, the English UI shows numeric section labels only (§2.2) and the remaining labels are listed as gaps.
