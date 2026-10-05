# Qatra: Implementation Contract v1.11

Version 1.11 · 2026-10-05 · Asia/Dubai · Status: **Approved: D74, 4 October 2026 (owner: «approve best practice», «q7 approved») for v1.4, including the nine v1.4 amendments of §13; Approved: D75, A1 (owner, 4 October 2026: «A1 approved , best practice») for the v1.5 amendments of §14 (the plan conversation); Approved: D76 (owner delegation «use best practice for all», 4 October 2026) for the v1.6 change of §11 only (the English-label open item is resolved for this build: numeric section labels until Jamhara terms are supplied; no interface, DTO or configuration change); implementation beyond the approved gates is not authorized.** Version 1.11 records D92 (Approved: owner, 5 October 2026): §2.4 (whole-passage question context, source line after the answer), §5 (new-material-first session order and whole-unit daily pace) and the question-payload notes; the code is implemented locally on branch `question-bank-fixes`, local tests only, not deployed, and nothing here is Implemented-and-Verified or live. D60, D64, D66 and D55 are unchanged and C5/Q8 stay open. Version 1.10 is an implementation record, no new owner approval: §18 records the S-03 and S-04 screens, the F0 follow-up, the C6 subset of the content pipeline for D83, the hosting facts that the coordinator reported and the terms-version defect found on the production page, and the references to API-spec.md name its current version (v1.5); it adds no DTO and no endpoint and changes no rule (local tests only; no user-tested production flow is recorded here). Version 1.9 is an implementation record, no new owner approval: §17 records B6 checkpoint 2 (merge d145f0c), the W-INT wiring (merge ce86d04), the W-OPS2 access-log measures (merge 76a25bd), the coordinator decisions applied and a pointer to D83, and the references to Database-schema.md and API-spec.md name their current versions (v1.4); it adds no DTO and no endpoint and changes no rule (local tests only; no deployment of this code is recorded here). Version 1.8 is an implementation record, no new owner approval: §1 records the `lucide-react` dependency (D81, Q6), §8 records that the code default of `QATRA_CHAT_MODEL_FOR_LEARNERS` is `false` since the B13 wiring step (D76, Q2), and §16 lists the B13 facts, the B6 implementation decisions and the S-01 dependency; it adds no DTO and no endpoint (local tests only, nothing deployed). Version 1.7 is an implementation record and needs no new approval: §1 and §8 record the dependencies and configuration names that now exist in `backend/`, and §15 lists the change; it alters no interface, DTO or rule, and the defaults it names are configuration defaults, not approved numbers (local tests only, nothing deployed). Owner: root coordinator.

This file is the single source of truth for **cross-package interfaces**: content bundle, database tables, API DTOs, mastery/session/planning rules, auth flow and configuration. It fills the remaining Needs Review/Needs Input details of the approved package (D01–D74) with concrete, implementable choices. Where it is silent, follow [Architecture-and-data.md](Architecture-and-data.md), [Programming-guide.md](Programming-guide.md) and the owning policy document. The physical database schema (ERD, tables, keys, roles, grants, migration order) is specified in [Database-schema.md](Database-schema.md) (v1.4) and the full REST API (per-endpoint authentication, authorization, schemas, limits, errors) in [API-spec.md](API-spec.md) (v1.5); their v1.1 content is approved by D74 and their D75 additions by D75 (A1), and their later additions (Database-schema 1.3 and 1.4, API-spec 1.3, 1.4 and 1.5) are implementation records without new owner approval. They refine the interfaces fixed here, and a contradiction between them and this file is returned to the coordinator. A worker that finds a contradiction or gap returns it to the coordinator instead of inventing a rule. Changes to this file are made by the coordinator only.

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
  supabase/migrations/ 0001_content.sql … 0005_rls_functions.sql, 0006_plan_chats.sql (D75), 0007_feedback.sql (conditional, D45; renumbered from 0006)
  fixtures/            synthetic demo scenarios/simulations only (demo_scenarios.json, demo_simulations.json)
```

- Frontend talks only to same-origin `/api/*`; Next.js `rewrites()` forward to `BACKEND_ORIGIN` (Render). No Next route handlers/Server Actions implementing business logic.
- Backend layering: router/DTO → service → domain policy (pure, no FastAPI/DB imports) + repository/provider.
- Fonts: no build-time network fonts. Self-host SIL OFL fonts from npm `@fontsource/*` packages (D69). UI font per [Design-system.md](Design-system.md): a clear Cairo-style Arabic sans (`Cairo`) for the Arabic RTL UI and `Inter` (or a similar sans) for the English LTR UI. Quran text `Amiri Quran` and hadith text `Amiri` (both SIL OFL); the original-text font follows the source requirements and never alters its letters. Verify Uthmani marks (U+06E1, U+06E5, U+06E6, U+06E2, U+06ED, U+06DF) render in the Playwright screenshots.
- Backend dependencies added at implementation (`backend/pyproject.toml`; recorded in [Delivery-and-baseline.md](Delivery-and-baseline.md)): `cryptography` (pyca; AES-256-GCM encryption of the stored Supabase tokens, §6; added by B3; owner decision D76, Q1; installed 50.0.2, licence Apache-2.0 OR BSD-3-Clause) and `tzdata` (IANA time-zone data for the standard-library `zoneinfo`, which the code uses for learning dates and time-zone validation; added in S1-5b; the owner's words: «apprvoed if it fits the project»; installed 2026.5, licence Apache-2.0). Both are covered by the local tests only; nothing is deployed.
- Frontend dependency added at implementation (`frontend/package.json`; recorded in [Delivery-and-baseline.md](Delivery-and-baseline.md)): `lucide-react` (the Lucide icon set; owner decision D81, Q6; exact pin 1.52.0; licence ISC, with an MIT notice for glyphs derived from Feather), imported only by the seam component `frontend/src/components/ui/Icon.tsx`; `frontend/THIRD_PARTY_NOTICES.md` arrives with the S-02 step.

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
- Plan order is the plan's `order` (D72): `'book'` (the default for every edition) or `'reverse'` ("from An-Nas backwards", available for the Juz' Amma (Quran) edition only), chosen at plan creation; a change is a plan revision effective the next learning day (§5, §7). Book order: Juz' Amma surah 78 → 114 (ascending section ordinal) with passages inside a surah in mushaf order; Forty hadith 1 → 42. Reverse order: surah 114 → 78 (descending section ordinal); passages inside a surah stay in mushaf order (a design reading of D72, to be confirmed by the owner at architecture approval). Within the chosen order no unit of the scope is dropped, and the Teaching Agent never reorders new material (AI-agent.md: proposal validation checks the plan's chosen order and that no unit is dropped).

### 2.4 Question bank (four templates, deterministic, D20/D31/D64)

All question text is assembled from token refs of the same edition; nothing is generated. Each question stores `covered_part_ids` (the part(s) whose tokens it tests) and `context_refs` (stored for compatibility; since D92 they are no longer used for display). **Question context (D92, replaces "context ±6 words").** `QuestionContext = {before: Token[], after: Token[], ayahEnds: AyahEnd[]}`: `before` and `after` are all tokens of the question's passage outside the target span (`start_ref` to `end_ref`, across units), with unaltered text, so the learner reads the whole passage (all ayat or the whole hadith passage) with the blank in place; `AyahEnd = {afterRef, number}` marks the last token of each ayah unit except the passage's last ayah and never falls inside the blank. `word_order` also carries the whole passage as context (its part is the gap). The fields are additive with defaults (`ayahEnds = []`). Context is orientation only: showing it is not coverage (D64, D66 unchanged). The source line (`SourceRef`, with the human reference `referenceAr`: a hadith section title, or «سورة X، الآية n» / «…، الآيات a–b» in Arabic-Indic digits for the Quran) is shown only after the question is answered; `publisher`, `editionLabel` and `reference` stay in the contract for compatibility but are never rendered to learners (D92).

| type (`game_kind`) | Built per part | Answer | Covers |
|---|---|---|---|
| `word_order` | Parts with 3–8 words; two adjacent parts < 4 words each may be merged | Original token order | All tested parts |
| `word_choice` | (a) blank = continuation word (first word of a non-first part) or a keyword; 4 options = correct + 3 distractor words from the same section (different normalized form, length ±2 letters; fallback same edition). (b) segment variant: "choose what comes next" with 3 options of 2–4 contiguous words: the correct next segment + 2 other same-length segments from the same section | Option id | The part containing the blank/segment |
| `word_recall` | Blank = keyword (longest normalized word in the part outside a small stoplist) or continuation word; context = the whole passage (D92). Quran recall targets exclude words whose Uthmani spelling diverges from common spelling (containing U+0670, U+06E5, U+06E6, U+0653 or U+06DF) — those positions use `word_choice` instead | Typed single word, graded by `arabic-norm-v1` against `n` or `a` | The part containing the blank |
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

- Acquisition runs through the Islamic Content MCP tools. Each raw record is saved unmodified by the CLI in the private Supabase Storage bucket `sources`, under `sources/<editionKey>/raw/` (`service_role`, content-publishing scope only; architecture directive 5) and never in git, with the tool name, arguments, retrieval time and canonical URL: Quran `{surah, ayah, text, url}`; hadith `{hadeethencId, fortyNumber, title, narration, narrator, grade, url, languages}`.
- Because records pass through an assistant transcription step, every text is verified programmatically before it is published: (1) Quran: NFC-normalized text must equal NFC of the independent KFGQPC Hafs v18 oracle with its trailing ayah number removed, for all 564 ayat (a verification oracle only, never a content source); (2) hadith: two independent acquisitions must be identical after NFC, and the letter skeleton is compared with the OpenITI Shamela text of the Forty only to flag omissions/additions for review; (3) when `mcp.islamiccontent.org` becomes reachable from the build environment, the workflow re-acquires over HTTP (MCP JSON-RPC) and diffs byte-for-byte. Any mismatch blocks the affected unit until resolved.
- Text is stored NFC-normalized (canonically equivalent to the publisher's text). Zero-width characters present in the publisher text (e.g. U+200C) are preserved in `canonical_text` and removed only in normalized forms.

## 3. Database (Supabase Postgres)

Migrations live in `supabase/migrations/` and are applied in order. Every table enables RLS in the migration that creates it. Personal rows cascade on account deletion; published content is never deleted because a learner was deleted. The complete physical schema (ERD, columns, keys, roles, grants, migration order) is specified in [Database-schema.md](Database-schema.md) (v1.1, approved by D74); this section lists the interface-level facts.

### 3.1 `0001_content.sql` (content worker)

Tables per Architecture "المخطط المنطقي: المحتوى المشترك" with these concrete additions: `book_editions.edition_key text unique`, `book_editions.bank_version int`; `book_sections.kind text`, `title_ar`, `title_en`, `source_url`; `units.kind`, `units.source_url`, `units.token_spans jsonb` (the token array), `units.hadith_meta jsonb`; `edition_pages`/`unit_page_spans` exist but stay empty for web editions; new `passages(id, edition_id, bank_version, ordinal, section_id, path, start_ref, end_ref, word_count, reference, unique(edition_id,bank_version,path,ordinal))`; new `passage_parts(id, passage_id, edition_id, ordinal, start_ref, end_ref, word_count, unique(passage_id,ordinal))`; `lessons.passage_id`; `question_items(… type, variant, passage_id, covered_part_ids uuid[], token_refs jsonb, option_refs jsonb, correct_ref jsonb, context_refs jsonb …)`; `unit_embeddings(embedding vector(384))` created but not populated (D69: embeddings are postponed for the MVP, amending D37/D65 for the MVP only; the workflow's `embedded` step is skipped and D31 candidates come from normalized text matching inside one edition, §2.4); `content_jobs` as documented. RLS: `authenticated` may `select` content rows whose edition is `published` and not revoked; writes only via `service_role`. Anonymous read access is limited to published catalog metadata (books, edition metadata, sections) through a `public.catalog_*` view or column-level grants for the `anon` role only, never units, passages, parts, lessons or questions (D71); the exact grants are specified in [Database-schema.md](Database-schema.md). `create extension if not exists vector`.

### 3.2 `0002_identity.sql` … `0005_rls_functions.sql` (backend worker)

- `private` schema (not exposed through the Data API): `account_handles`, `recovery_codes`, `password_reset_grants`, `app_sessions`, `auth_throttle` exactly as Architecture §"الحساب والتقدم الخاص".
- `public.profiles` with `terms_version`, `terms_accepted_at`, `language`, `time_zone`, `session_minutes (5|10|15)`, `reminder_settings jsonb`, `pending_settings jsonb` (next-learning-day changes, D57), `is_demo` mirror (read-only to the user).
- `master_plans` (+ `paths text[]`, `plan_order text` constrained to `book`/`reverse`, with `reverse` only for the Quran edition, D72), `plan_versions`, `plan_phases`, `learning_sessions` (+ `steps jsonb` immutable snapshot, `status prepared|open|completed`), `attempts` (+ `assisted bool`, `review_round_id uuid null`), no `reviews` table (dropped from the physical schema by architecture directive 3: the review ladder lives in `target_mastery` and due reviews are derived from `next_review_due`; see [Database-schema.md](Database-schema.md)), `session_activity_intervals`, `daily_progress`, `daily_completions`, `target_mastery` (see §4), `target_part_evidence(user_id, plan_id, passage_id, part_id, attempt_id, learning_date, unique(user_id,plan_id,part_id))`, `offline_snapshots` (+ `payload jsonb`), `ai_usage(provider, model, prompt_version, input_tokens, output_tokens, cost_usd numeric null, status, created_at)` with no learner text.
- One active plan per account: partial unique index on `master_plans(user_id) where status='active'`.
- Private access functions live in `public` as `srv_*` `SECURITY DEFINER` functions with `set search_path = ''`; `revoke execute … from public, anon, authenticated, service_role; grant execute …` only to the separate limited database role whose credential is the `QATRA_SERVER_DB` secret on Render (D34, D69; the functions' uses are listed in Architecture-and-data.md, «RLS والحدود»). One exception (v1.4, A-04): `srv_redact_revoked_content` (Database-schema §8.2 item 19) is executable by `service_role` only (the CLI's publishing role, used by `withdraw`), not by `qatra_server`. `srv_throttle_record(p_key_hashes bytea[], p_outcome text)` takes `p_outcome` (`failure` or `success`, A-03). Apart from that function, `service_role` never runs these functions and is not used for learner requests: it is limited to the Supabase Auth Admin API (create user at registration, reset password by recovery, delete account) and content publishing, including content-workflow writes (D34, D37).
- Learner tables: RLS `user_id = (select auth.uid())` with parent-ownership checks via composite foreign keys `(id, user_id)`.

### 3.3 `0006_plan_chats.sql` (backend worker; D75, Approved — D75, A1 (owner, 4 October 2026))

Two personal tables for the plan conversation, specified in [Database-schema.md](Database-schema.md) §6.3: `plan_chats(id, user_id, plan_id null, status open|confirmed|abandoned, language ar|en, proposal jsonb null, proposal_version, model_turns, created_at, updated_at, closed_at null)` with a partial unique index so an account has at most one `open` conversation, and `plan_chat_messages(id, chat_id, user_id, ordinal, role learner|assistant, kind text|proposal|refusal|redirect|fallback|quick_reply, text ≤ 2 000 characters, source learner|rules|model|fixed, payload jsonb null, created_at)`. RLS `user_id = (select auth.uid())`, privileges revoked from `anon` and `service_role`, composite parent keys `(id, user_id)` and `(plan_id, user_id)`. `ai_usage` (0004) is reused unchanged (`prompt_version` `plan-chat-v1`; no learner text, no account id). No `srv_*` function is needed. The conditional feedback migration is renumbered `0007_feedback.sql`.

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
- **Order** (D72): plan order is the plan's `order` (§2.3). `'book'` (default) = sections by ascending ordinal and passages in book order inside a section; `'reverse'` (Juz' Amma only) = sections by descending ordinal with passages in mushaf order inside a surah. New passages are introduced in the chosen order and no passage of the scope is dropped. Any Teaching Agent proposal is also validated for the chosen order and for dropping no passage of the scope (AI-agent.md). Changing `order` is a plan revision effective the next learning day; recorded mastery state and history are kept as for any revision (D57, D66).
- **Placement** (optional, `kind=placement`): up to 8 passages sampled evenly across the scope, one `word_choice` (continuation) or `word_recall` question each, plus optional self-rating `none|some|most`. Placement time never counts toward daily progress. A correctly answered placement passage is marked `known` for the estimate and is scheduled as an early quick review instead of new learning (no mastery credit).
- **Capacity** (new words per learning day): 5 min → 12, 10 min → 25, 15 min → 40. A passage larger than capacity is introduced over consecutive days (one passage at a time). Internal word pacing stays (D66); since D92 the plan displays the pace in whole units (see Estimate below).
- **Daily goal (A-07, v1.4)**: `dailyGoalMs` = `Plan.sessionMinutes` of the plan version in force × 60 000. `Profile.sessionMinutes` is only the default pre-filled for a new plan (initial value 10). A plan-level change takes effect from the next learning day (D57) and the pending value is exposed as the optional `Plan.pendingSessionMinutes` (absent or `null` when none); the day boundary is the account time zone at the time of the request.
- **Plan lifecycle (A-08, v1.4)**: one active plan per account. `POST /plans` (and `POST /demo/plans`) pause the previous active plan; `POST /plans/:id/resume` sets a paused plan active and pauses the current one (progress kept; `currentVersion` unchanged; an already active plan is returned unchanged). A plan becomes `completed` automatically when every passage in its version scope is `confirmed`; maintenance reviews (§4) stay available from a completed plan through the daily session (reviews only, no new passages). A paused plan can be revised and stays paused; a completed plan can be neither revised nor resumed (`409 version_conflict`, `details.reason = "plan_not_active"`). Resume is for learner accounts only; demo accounts get `403 forbidden` and manage plans through `POST /demo/plans`.
- **Estimate**: `days = ceil((totalWords − knownWords) / capacity × 1.15)` (15% review buffer); `endDate = today + days`. Alternatives: (a) next larger minutes option, (b) scope halved (first half in plan order). `reasonCode`: `fits_preferred_date | exceeds_preferred_date | no_preferred_date`. **Daily pace in whole units (D92)**: `Estimate.dailyNew = {unit: 'ayah' | 'hadith', perDay: int ≥ 1 | null, everyDays: int ≥ 1 | null}` with exactly one of `perDay` and `everyDays` set (the whole object is `null` for plans stored before D92 or without unit counts; the UI then shows the earlier words text). `remaining = max(1, round_half_up(units × (total_words − known_words) / total_words))`; if `remaining ≥ days` then `perDay = max(1, round_half_up(remaining / days))`, otherwise `everyDays = max(1, round_half_up(days / remaining))` (for example a new hadith every two days). `units` = ayat (Quran, never half an ayah) or sections that have a passage on a selected path (hadith), taken from `SectionData.unit_count` (memory bundle: ayat; Supabase mode: `QURAN_AYAH_COUNTS`). `new_words_per_day` and the capacity above are unchanged internally. `EstimateInput` accepts an optional `dailyNew`; `estimates_equal` ignores it. For a long hadith the days are spread over consecutive days at the D66 passage boundaries (coordinator decision recorded in D92, not owner wording).
- **Daily session** (`kind=daily`), in order (D92: new material first; replaces "due review rounds first"): (1) continue the current `learning` passage or introduce the next passage(s) in plan order up to capacity: per new passage a `learn` step showing the full passage with reference, edition, page(s), takhrij and D50 notice, then training batches; `TRAINING_BATCHES = {5: 2, 10: 2, 15: 3}` for 5/10/15 min, batch type progression `word_choice` → `word_order` → `word_recall` → `similar_distinction`, each batch being one question of that single type per ranked part (a multi-part question serves its parts; parts lacking that type are skipped; an empty batch does not count); if fewer than `STREAK_TARGET` (3) training questions result, further batches wrap over the unused types; (2) due review rounds (same selection and caps, 6/10/14 questions for 5/10/15 min), each round's questions preferring the day's review type `review_game_type(seed) = rotation[stable_hash(seed, "review-type") % 4]` unless the part's last attempt used that type (§4.3: the next review changes the template); the review block is grouped by type, and round evaluation is by round id, independent of order; (3) quick drills grouped the same way; (4) end-of-session test of 3/5/7 questions mixing today's passage parts, error parts and uncovered parts, grouped by type. Light-review and maintenance days are reviews only, unchanged. The learner may continue with more practice; nothing force-closes the session. Implemented locally on branch `question-bank-fixes` (local tests only, not deployed).
- **Lessons tab (D92)**: the owner approved a read-only «الدروس» tab within the plan's scope (reading ayat or hadith, no games) whose reading time counts toward the daily goal (D40); its endpoints are documented in a later pass.
- **Absence (PRD R07)**: after 3 or more days of absence the session starts with a light review (the due reviews of step 1) and introduces no new material by default; missed days are not stacked, and due reviews that do not fit the session stay due for the following days (AI-agent.md, QA-and-evaluation.md).
- **Game session** (`kind=game`): up to 10 questions of an optional `gameType` over optional `passageIds` inside the active plan scope (future-day passages allowed).
- **Teaching Agent** (`services/planner.py`): for `is_demo` accounts with a fixture scenario only. Input = scenario id, passage ids/word counts, placement correct/incorrect counts (no account id or free text). Output JSON `{newWordsPerDay, reviewOffsetsDays, priorityReviewPassageIds}` validated against allowed ids and bounds; new material always follows the plan's chosen order (`'book'` or `'reverse'`, D72) with no unit dropped (AI-agent.md), so the agent sets pace and review timing/priority only, never the order of new passages; any failure, timeout (8 s) or ineligible model → rules engine. Every call records `ai_usage`. From D75 the plan assistant for **all** learners is the plan conversation below; this bullet still describes `services/planner.py` and E28.

- **Plan conversation (D75, Approved — D75, A1 (owner, 4 October 2026); [Plan-conversation.md](Plan-conversation.md) §2.4; endpoints E31–E34).** Every account builds and revises its plan in a conversation limited to plan logistics; the plan is saved only when the learner confirms the current proposal (E34 with `proposalVersion`; `409 version_conflict` reason `proposal_stale` otherwise). The rules engine computes every number; the model only interprets free text and phrases conversational text, and its output never supplies a number of the plan.
  - **Rules first, model second.** Pipeline order per learner turn: (1) guard, (2) quick reply, (3) free text through the model, (4) rules fallback, (5) record. No model call when: the first turn's `goalText` equals the composed sentence and asks nothing; a quick reply is used; the guard matches; the daily or per-conversation model cap is reached.
  - **Guard** (`domain/plan_chat_policy.py`, `classify_request`): reviewed Arabic and English keyword and pattern list (version `QATRA_CHAT_GUARD_VERSION`, default `guard-v1`) returning `religious | out_of_scope | logistics`. `religious` → the fixed D26 message verbatim; `out_of_scope` → the fixed redirect line. Applied on the input before any model call and again on the model's reply (≤ 600 characters; numbers replaced by the server's values or the templated reply used). The model has no tools and no data beyond its payload.
  - **Quick replies** (`QuickReplyCode`) change parameters by rules only: minutes to the next option of 5, 10, 15; smaller scope = first half in plan order; later date = +25 % days; order `book` / `reverse` (Quran only); paths sets (hadith: `matn`, `sanad`, `grade`; takhrij is never a path); `confirm` is the client calling E34. The rules engine (the E15 function) recomputes the estimate each time.
  - **Caps (configuration, not approved numbers; A4: «use best practice as mentioned in open router»):** the whole deployment 50 model requests per day and 20 per minute (OpenRouter's published limits for free models without purchased credits, to be verified at provisioning; shared with the demo planner), 10 model calls per account per day, 6 model turns per conversation; model timeout 8 s; at most 400 output tokens. Over any cap, or on a time-out, provider error, invalid JSON, ineligible model (D60 live-pricing check) or exhausted free quota: a templated rules reply with quick replies (`kind = 'fallback'`), shown as a calm notice once per conversation, never an HTTP error; the journey always completes without the model (NFR-16). Every model call writes one `ai_usage` row (`prompt_version = plan-chat-v1`).
  - **Privacy of the payload (R27, NFR-17):** under a temporary conversation id (random, not derived from the account, unrelated to `chatId`, never reused) the model receives only the instructions, the edition's catalog metadata, the current parameters and estimate, the placement summary `{knownWords, passageCount}`, the last ten messages and the interface language; for a revision also the anonymized learning record (per-passage mastery states with review outcomes and dates, error-prone parts, the daily-time history of the last 30 learning days and the last 50 attempts, source-text references only). Never a user id, username, IP, device, registration date or session data. Message text, goal text and model output are never logged.
  - **One open conversation per account;** a new E31 abandons the previous one. A completed plan cannot be revised in a conversation (`409 version_conflict`, `details.reason = "plan_not_active"`, A-08). A revision takes effect from the next learning day (D57). Demo accounts use the same operations in `synthetic_demo` mode (D71).

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

The complete per-endpoint specification (authentication, authorization, request/response schemas, validation, status codes, errors, limits, examples) is [API-spec.md](API-spec.md) (v1.5; v1.1 approved by D74, the D75 additions approved by D75 with A1; v1.3, v1.4 and v1.5 are implementation records); this section fixes the shared DTOs and the endpoint list it must honor.

Errors: HTTP status + `{"error": {"code": "snake_case", "message": "safe text", "details": {}}}`. Codes: `validation_error` 422, `invalid_credentials` 401, `unauthenticated` 401, `forbidden_origin` 403, `forbidden` 403 (role-based denial, e.g. a demo account on a learner-only operation), `not_found` 404, `username_taken` 409, `version_conflict` 409 (also for a stale plan version on an offline snapshot; from v1.5 also for a stale conversation proposal, `details.reason = "proposal_stale"`, and a closed conversation, `"chat_closed"`), `payload_too_large` 413 (body above the 64 KiB cap), `terms_required` 400, `throttled` 429, `unavailable` 503, `internal` 500. `details` is an object whose keys are documented per endpoint and per code in [API-spec.md](API-spec.md) §1.5 (`{}` when none); values are never echoed. `Idempotency-Key` (UUID, optional) is accepted on `POST /sessions/:id/complete` only; no other mutation uses or requires it in v1.

```ts
type ISODate = string;        // YYYY-MM-DD (learning date in the account time zone)
type ISODateTime = string;    // RFC 3339 UTC
type TokenRef = string;       // "<unitOrdinal>:<tokenIndex>"
type Path = 'quran' | 'matn' | 'sanad' | 'grade';
type GameKind = 'word_order' | 'word_choice' | 'word_recall' | 'similar_distinction';
type PlanOrder = 'book' | 'reverse'; // 'book' is the default for every edition; 'reverse' is valid for the Juz' Amma (Quran) edition only (D72)

interface Profile { username: string; language: 'ar' | 'en'; timeZone: string; sessionMinutes: 5 | 10 | 15;
  reminderSettings: { inApp: boolean }; isDemo: boolean; termsVersion: string; termsAcceptedAt: ISODateTime;
  createdAt: ISODateTime; pendingSettings: { sessionMinutes?: 5 | 10 | 15; timeZone?: string; effectiveDate: ISODate } | null; }

interface CatalogSection { sectionId: string; ordinal: number; kind: 'surah' | 'hadith'; reference: string;
  titleAr: string; titleEn: string; wordCount: number; passageCount: number; paths: Path[]; }
interface CatalogEdition { editionId: string; editionKey: string; titleAr: string; titleEn: string; author: string;
  editionLabel: string; category: { slug: string; labelAr: string; labelEn: string }; catalogVersion: number;
  contentFormat: 'quran' | 'hadith_collection'; availablePaths: Path[]; defaultPaths: Path[];
  defaultOrder: PlanOrder;                 // always 'book'; 'reverse' is offered only when contentFormat is 'quran' (D72)
  totalWords: number; sections: CatalogSection[]; }

interface TargetScope { sectionOrdinals: number[]; }
interface Estimate { days: number; endDate: ISODate; newWordsPerDay: number; totalWords: number; knownWords: number;
  passageCount: number; sessionMinutes: 5 | 10 | 15; scope: TargetScope; paths: Path[];
  dailyNew?: { unit: 'ayah' | 'hadith'; perDay: number | null; everyDays: number | null } | null; }   // D92, exactly one of perDay/everyDays set
interface Plan { planId: string; editionId: string; titleAr: string; titleEn: string; targetScope: TargetScope;
  paths: Path[]; order: PlanOrder; sessionMinutes: 5 | 10 | 15; preferredDate: ISODate | null;
  agreedEstimate: Estimate; currentVersion: number; status: 'active' | 'paused' | 'completed'; createdAt: ISODateTime;
  pendingSessionMinutes?: 5 | 10 | 15 | null; // optional (A-07): plan-level change effective the next learning day (D57)
  planner: { source: 'rules' | 'teaching_agent'; model?: string }; }

interface DailyProgress { learningDate: ISODate; dailyActiveMs: number; dailyGoalMs: number; dailyPercent: number;
  dailyCompleted: boolean; extraActiveMs: number; }
interface Today extends DailyProgress { plan: Plan | null; dueReviews: number; nextNewPassage: { reference: string;
  sectionTitleAr: string } | null; openSessionId: string | null; streakDays: number;
  openPlanChatId?: string | null; }   // v1.5 (D75): optional, the open plan conversation, lets S-08/S-11 resume it
interface PlanProgress { planId: string; titleAr: string; titleEn: string; status: Plan['status']; currentVersion: number; // v1.5 (O-32, D75, UG-04): lets a completed plan open an E20 daily session
  overallPercent: number;
  confirmedWords: number; totalWords: number; confirmedSections: number; totalSections: number;
  counts: { new: number; learning: number; reviewing: number; confirmed: number; needsRefresh: number };
  nextReviewDate: ISODate | null;
  sections: { ordinal: number; reference: string; titleAr: string; titleEn: string; percent: number;
    status: 'new' | 'learning' | 'reviewing' | 'confirmed' | 'needs_refresh' }[]; }
interface ProgressResponse { daily: DailyProgress; history: { date: ISODate; activeMs: number; goalMs: number;
  completed: boolean }[]; plans: PlanProgress[]; }

interface TokenView { ref: TokenRef; text: string; }
interface SourceRef { publisher: string; editionLabel: string; bookTitleAr: string; reference: string; referenceAr: string;
  url: string; pages: string[]; }                                        // pages empty for web editions; url shown with the source line after answering (D92); publisher/editionLabel/reference never rendered
interface PassageView { passageId: string; path: Path; reference: string; referenceAr: string; sectionTitleAr: string;
  units: { unitRef: number; kind: 'ayah' | 'hadith_narration'; reference: string; text: string }[]; // verbatim
  highlight: { startRef: TokenRef; endRef: TokenRef };                    // the passage range inside the units
  takhrij: string | null; grade: string | null; showD50Notice: boolean; source: SourceRef; }
interface QuestionBase { questionId: string; type: GameKind; passageId: string; role: 'training' | 'review' | 'test' |
  'placement' | 'game'; reviewRoundId: string | null; context: { before: TokenView[]; after: TokenView[]; ayahEnds: { afterRef: TokenRef; number: number }[] }; // whole passage (D92)
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
// Replay envelope of an event recorded offline (PWA-design.md §5). `SessionEvent` and `EventsResponse` are the only names (C-05/C-06,
// D74); PWA-design's earlier "OfflineEvent" wording is superseded. NR below = shapes PWA-design.md still leaves open. All fields or none; online events omit it. localSequence is ordering input, never a trusted clock.
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
// O-21 enumerations (API-spec §8.2, A-12, approved D74):
//   rejected[].code: 'question_not_in_session' | 'out_of_scope' | 'edition_mismatch' | 'bank_version_mismatch' | 'invalid_answer_shape'
//     | 'activity_out_of_bounds' | 'plan_not_active' | 'session_closed' | 'envelope_mismatch'
//   pending[].reasonCode: 'plan_changed_unverifiable' | 'content_unverifiable' | 'policy_unsupported' | 'clock_unverifiable'
//   RevalidationResult.reasonCode: 'current' | 'plan_version_changed' | 'bank_version_changed' | 'content_revoked' | 'validity_ended'
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

Plan conversation DTOs (v1.5, D75; Approved — D75, A1 (owner, 4 October 2026); copied from [Plan-conversation.md](Plan-conversation.md) §2.2). The `Path` line repeats the unchanged type for reference (the owner declined takhrij as a path; "§0" there means Plan-conversation §0), and the `Today` line is the declaration-merging form of the optional field already shown on `Today` above. `PlanSections` text is assembled by the server from templates and the rules engine's numbers; when a model turn succeeded, the model's phrasing may appear only in the *goal* and *nextStep* lines, after the output guard, and the numbers never come from the model.

```ts
type Path = 'quran' | 'matn' | 'sanad' | 'grade';               // unchanged: the owner declined takhrij as a path (§0)
type QuickReplyCode = 'fewer_minutes' | 'more_minutes' | 'smaller_scope' | 'later_date' | 'no_date'
                    | 'order_book' | 'order_reverse' | 'paths_matn_only' | 'paths_all' | 'confirm';
interface QuickReply { code: QuickReplyCode; labelAr: string; labelEn: string; }
interface PlanSections { goal: string; totalTime: string; dailyTime: string; stages: string;
  reviews: string; nextStep: string; }                           // plain text, interface language, server-built
interface PlanProposal { proposalVersion: number; editionId: string; targetScope: TargetScope; paths: Path[];
  order: PlanOrder; sessionMinutes: 5 | 10 | 15; preferredDate: ISODate | null; estimate: Estimate;
  sections: PlanSections; }
interface ChatMessage { messageId: string; ordinal: number; role: 'learner' | 'assistant';
  kind: 'text' | 'proposal' | 'refusal' | 'redirect' | 'fallback' | 'quick_reply'; text: string;
  source: 'learner' | 'rules' | 'model' | 'fixed'; createdAt: ISODateTime; }
interface PlanChat { chatId: string; status: 'open' | 'confirmed' | 'abandoned'; planId: string | null;
  language: 'ar' | 'en'; messages: ChatMessage[]; proposal: PlanProposal | null; quickReplies: QuickReply[];
  modelTurnsLeft: number; assistant: { source: 'rules' | 'model'; model?: string }; }
interface Today { /* unchanged fields */ openPlanChatId?: string | null; }   // optional addition, lets S-11/S-08 resume
```

| Method/path | Request | Response |
|---|---|---|
| GET `/health` | — | `{status:'ok', version, time}` (liveness: no database access, no auth, no secrets) |
| GET `/health/ready` | — | `{status:'ok'}`, or the `unavailable` error (503) when the trivial database query fails (readiness; no auth; minimal body; rate-limited; D72); exact body and limits in [API-spec.md](API-spec.md) |
| POST `/auth/register` | `{username, password, timeZone, language, termsAccepted:true, termsVersion}` | 201 `{profile: Profile, recoveryCode}` + cookie |
| POST `/auth/login` | `{username, password}` | `{profile, reconsentRequired}` + cookie |
| POST `/auth/consent` | `{termsVersion}` (session) | `{profile}` |
| POST `/auth/recovery/verify` | `{username, recoveryCode}` | `{resetGrant, expiresInSec}` |
| POST `/auth/recovery/reset` | `{resetGrant, newPassword}` | `{recoveryCode}` (then login) |
| POST `/auth/recovery/rotate` | `{password}` (session) | `{recoveryCode}` |
| POST `/auth/password` | `{currentPassword, newPassword}` (session) | `{profile}` + new cookie (all other sessions revoked) |
| POST `/auth/logout` | — | 204, cookie cleared |
| GET/PATCH `/me` | PATCH `{language?, timeZone?, sessionMinutes?, reminderSettings?}` | `Profile` (minutes/zone become `pendingSettings` for the next learning day) |
| POST `/account/delete` | `{password, confirm:'DELETE'}` (session; replaces `DELETE /account`, A-10) | 204, cookie cleared |
| GET `/catalog` | — | `{editions: CatalogEdition[]}` — public, no session; metadata only (D71) |
| POST `/plans/estimate` | `{editionId, targetScope, paths, sessionMinutes, preferredDate?, placementSessionId?, order?}` | `{estimate, alternatives: Estimate[], reasonCode}` (no writes) |
| POST `/plans` | `{editionId, targetScope, paths, order, sessionMinutes, preferredDate?, placementSessionId?, confirmedEstimate}` | 201 `Plan` (previous active plan → paused) |
| POST `/plans/:id/revise` | `{expectedVersion, sessionMinutes?, preferredDate?, paths?, order?, confirmedEstimate?}` | `Plan` or 409 (`order` is validated as in `POST /plans` and takes effect the next learning day, D72; `confirmedEstimate` is sent when the change alters the estimate and replaces `agreedEstimate`; a mismatch is 409 `version_conflict`) |
| POST `/plans/:id/resume` | — (session, learner accounts) | 200 `Plan`: a paused plan becomes active and the current active plan is paused; 409 `version_conflict` (`details.reason = "plan_not_active"`) for a completed plan; 403 `forbidden` for a demo account (A-08) |
| GET `/today` | — | `Today` |
| GET `/progress` | — | `ProgressResponse` |
| POST `/sessions` | `{kind:'daily', planId, expectedPlanVersion}` · `{kind:'game', planId, expectedPlanVersion, gameType?, passageIds?}` · `{kind:'placement', editionId, targetScope, selfRating?}` | 201 `SessionSnapshot` (daily returns the open session for today if one exists) |
| POST `/sessions/:id/events` | `{events: SessionEvent[]}` (≤ 100) | `EventsResponse` (idempotent per clientEventId) |
| POST `/sessions/:id/complete` | — (optional `Idempotency-Key` header, UUID) | `CompleteResponse` |
| POST `/plans/:id/offline-snapshots` | `{clientOperationId, expectedPlanVersion, downloadTargetRefs}` (`downloadTargetRefs: string[]`; proposed in PWA-design §5, NR) | 201 `PlanSnapshot`; the same input again → 200 with the same snapshot; changed input → 409; invalid reference, version or scope → 422 |
| GET `/offline-snapshots/:id` | — | 200 `PlanSnapshot`, or a chunked download manifest with positions and hashes (shape NR); `Cache-Control: no-store`; read-only, creates no session |
| POST `/offline/revalidate` | `{snapshotId, expectedPlanVersion, editionId, bankVersion}` | `RevalidationResult` (`status` is an `OfflineStatus`: available, stale, revoked or expired) |
| POST `/demo/accounts` | same body as register | 201 `{profile, recoveryCode}` + cookie, `isDemo:true` |
| GET `/demo/scenarios` | — | `{scenarios: {scenarioId, titleAr, titleEn, editionKey, targetScope}[]}` |
| POST `/demo/plans` | `{scenarioId, placementSessionId?}` (demo session only) | 201 `Plan` with `planner` |
| GET `/demo/simulations` | — | `{simulations: …}` from `fixtures/demo_simulations.json`, labeled synthetic |
| POST `/plan-chats` | `{editionId, targetScope, paths, sessionMinutes, preferredDate?, placementSessionId?, goalText, language, planId?}` (session; D75) | 201 `PlanChat` whose first assistant message is a rules-built `proposal`; `goalText` ≤ 500 characters; `planId` present = revision conversation; an existing `open` conversation is abandoned and replaced; 409 `version_conflict` (`plan_not_active`) for a completed plan |
| POST `/plan-chats/:id/messages` | `{text?, quickReply?}`: exactly one (session; D75) | 200 `PlanChat` with the learner message and the assistant reply appended; `text` ≤ 500 characters; 409 `version_conflict` (`chat_closed`); model caps are never an error |
| GET `/plan-chats/:id` | — (session; D75) | 200 `PlanChat` (own conversations only) |
| POST `/plan-chats/:id/confirm` | `{proposalVersion}` (session; D75) | 201 `Plan` (creation, E16 semantics) or 200 `Plan` (revision, E17 semantics); 409 `version_conflict` (`proposal_stale` with `details.proposal`, `plan_version`, `active_plan_conflict`) |

Server-side rules: never accept `userId`, `correct`, mastery, daily totals or demo/mode flags from the client; validate every question/passage against the session's edition, bank version and plan scope; reject events for sessions owned by another account (404); reject `order: 'reverse'` with `validation_error` unless the plan's edition has `contentFormat = 'quran'` (D72). The conversation operations (D75) are resolved inside the caller's own rows: an unknown id and another account's conversation are both `404`; the model, the guard and the caps are server-side only, and no endpoint accepts a model name, a `userId` or a mode from the client.

**Activity events**: `endedAt ≤ serverNow + 60 s`; `startedAt ≥ session.createdAt − 60 s`; `activeMs ≤ endedAt − startedAt + 1000`; ≤ 30 min per event; placement sessions excluded; learning date from `startedAt` in the account time zone effective that day; overlapping intervals of the same account and date are merged (union) before totals; `daily_completions` written once when `activeMs ≥ goalMs`.

**Offline (D46/D58/D59)**: names follow PWA-design.md §4–§6, where the offline contract is proposed and Needs Review (NR). The snapshot is created online from `downloadTargetRefs` (refs of memorization targets, i.e. passages, D66, inside the plan's edition and scope; the numeric size and partitioning of a download are NR and none is set here) and holds the server-prepared sessions for those targets (`preparedSessions`: `status prepared`, `offline_snapshot_id` set) plus the `lessons`, `games` and `references` they use; GET never creates a session. Events recorded offline are replayed later to `/sessions/:id/events` with their original ids and the offline envelope; only a server acknowledgment removes an event from the local outbox; old events are validated in their original plan/version even if the plan changed (D59); disputed or unverifiable events stay pending without credit, and the device clock is not proof. `/offline/revalidate` statuses: `available` permits new runs (replaying an old event still needs a per-event eligibility decision, D59); `stale` stops display and new runs of the affected material until it is revalidated; `revoked` and `expired` block display of the blocked text and clear its material locally; `expired` means validity actually ended per source/session data (no TTL is invented). A 401 stops replay and asks for an online login; a free-server wake-up timeout or 5xx (D48) is a connectivity state, never `stale`, `revoked` or `expired`. No lease, lock or expiry is added (D58).

## 8. Configuration

Backend (Render environment only; local `.env` gitignored): `APP_ENV` (`production|development|test`), `FRONTEND_ORIGIN`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable), `SUPABASE_SERVICE_ROLE_KEY` (secret; Auth Admin API and content publishing only, never the `srv_*` functions or learner requests), `QATRA_SERVER_DB` (secret; credential of the separate limited database role that runs the private `SECURITY DEFINER` functions, D34/D69; never `service_role`), `QATRA_SESSION_KEY` (AES-256-GCM token encryption), `QATRA_SESSION_HMAC_KEY`, `QATRA_RECOVERY_HMAC_KEY` and `QATRA_THROTTLE_HMAC_KEY` (each 32 independent random bytes, base64; one key per purpose), `TERMS_VERSION`, `OPENROUTER_API_KEY` (optional for the demo planner; **required in production for the plan conversation**, D75: without it every conversation turn is a rules turn and the journey still completes), `OPENROUTER_MODELS` (comma-separated candidates; only models whose live pricing is zero are used), `QATRA_DATA_BACKEND` (`supabase|memory`; `memory` is refused when `APP_ENV=production`), `QATRA_CONTENT_BUNDLES` (memory mode: comma-separated bundle paths). `backend/.env.example` lists names only.

Plan conversation configuration (D75, Approved — D75, A1 (owner, 4 October 2026); defaults are configuration, not approved numbers; A4): `QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY` (default 50, OpenRouter's published daily limit for free models without purchased credits; shared by the plan conversation and the demo planner), `QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE` (default 20), `QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY` (default 10), `QATRA_CHAT_MODEL_TURNS_PER_CHAT` (default 6), `QATRA_CHAT_MODEL_TIMEOUT_SEC` (default 8), `QATRA_CHAT_MAX_TOKENS` (default 400), `QATRA_CHAT_GUARD_VERSION` (default `guard-v1`). The OpenRouter figures are the coordinator's reading of the published limits and are verified at provisioning (API-spec O-31). The chat write rate class (20 per client IP per minute) and the other conversation limits are in API-spec §1.7 and §1.8.

Implementation settings (v1.7; defaults are configuration defaults, A-12, not approved numbers; local tests only): `QATRA_TRUSTED_XFF_DEPTH` (default 0, which uses the peer address as the client address; N of 1 or more uses the N-th entry from the right of `X-Forwarded-For`; a depth larger than the real proxy chain lets a client choose its own address, so the production value is set and confirmed on the deployed stack, expected 2; the measurement of 5 October 2026 recommends 4, see §18); the per-client-IP limits per minute `QATRA_RATE_PUBLIC_READ_PER_MIN` (60), `QATRA_RATE_ANONYMOUS_ENTRY_PER_MIN` (10), `QATRA_RATE_SESSION_READ_PER_MIN` (120), `QATRA_RATE_SESSION_WRITE_PER_MIN` (60) and `QATRA_RATE_CHAT_WRITE_PER_MIN` (20), which implement the classes of API-spec §1.8; and `QATRA_CHAT_MODEL_FOR_LEARNERS` (boolean; when false, every conversation of a non-demo account is rules-only and no provider call is made). Under D76 (Q2) the judging deployment runs with `QATRA_CHAT_MODEL_FOR_LEARNERS=false`, and the value changes to `true` only after written confirmation from the organizers. The code default is `false` since the B13 wiring step (D76, Q2).

Frontend (Vercel): `BACKEND_ORIGIN` (Render URL, used by rewrites; not secret).

## 9. Verification baseline and device support (D67)

Supported target (basic version): phones 360–430 px wide in portrait first, tablets 768–1024 px, desktop ≥ 1280 px; usable down to 320 px without horizontal scrolling. Browsers: iOS/iPadOS 17+ Safari (install via Share → Add to Home Screen), Android 10+ Chrome current and previous major version, Samsung Internet current, desktop Chrome/Edge/Firefox current and previous major version, Safari 17+ on macOS. Installable PWA with offline reopen: Android Chrome/Samsung Internet, desktop Chrome/Edge, iOS Safari 17+ (manual add). Not supported: Internet Explorer, legacy Edge, iOS < 17, Android < 10; in-app browsers work online only and show an «افتح في المتصفح» hint for install/offline. Accessibility: WCAG 2.2 AA (contrast, visible focus, 44×44 px touch targets, reduced motion, screen-reader labels in Arabic and English).

- Backend: `uv run ruff check`, `uv run pytest` (domain policies, services with in-memory repositories, API tests with httpx/TestClient).
- Frontend: `pnpm lint`, `pnpm typecheck`, `pnpm build`, unit tests for game evaluation/normalization, Playwright e2e on Chromium at 360×780, 390×844 and 1280×800 against backend memory mode.
- Real-device checks on the D67 support matrix are manual and labeled as such; only the actually tested matrix is reported as verified.

## 10. Package ownership (exclusive)

| Package | Owns |
|---|---|
| Acquisition | `sources/<editionKey>/raw/**` in the private Storage bucket (raw publisher records only, written by the CLI `acquire` step), `backend/.content-build/acquisition_report.md` (gitignored) |
| Content | `supabase/migrations/0001_content.sql`, `backend/app/workflow/**`, `backend/app/domain/content_policy.py`, `backend/app/domain/normalization.py`, `backend/scripts/content_tools.py`, `backend/tests/workflow/**`, `backend/tests/data/**` (committed synthetic bundle), `backend/.content-build/<editionKey>/**` |
| Backend | `backend/` except the content-owned paths, `supabase/migrations/0002…0005`, `fixtures/demo_*.json` |
| Plan conversation (B2b, B13; D75, Approved — D75, A1 (owner, 4 October 2026)) | `supabase/migrations/0006_plan_chats.sql` (B2b); `backend/app/routers/plan_chats.py`, `backend/app/services/plan_chat.py`, `backend/app/domain/plan_chat_policy.py`, `backend/app/providers/openrouter.py` (shared with the demo planner; B13 adds the structured-reply call only) and their tests (B13); `backend/app/workflow/**` is unchanged. The conditional feedback migration is renumbered `supabase/migrations/0007_feedback.sql` and is not created unless D45 is activated |
| Frontend | `frontend/**` |
| Coordinator | `docs/**`, root files, deployment, integration fixes |

Shared file `backend/app/domain/normalization.py` (`arabic-norm-v1`) is owned by the content package; the backend imports it. The committed synthetic bundle `backend/tests/data/synthetic_bundle.json` (§2.6) is also owned by the content package; backend tests, memory mode (`QATRA_CONTENT_BUNDLES`) and the Playwright e2e only read it.

## 11. Open risks and open questions

Items marked ACCEPTED or RESOLVED record owner decisions of 2026-10-04 (D72, D76); the English labels outside the numeric section labels remain listed gaps and must not be filled by assumption.

- **ACCEPTED for the MVP (D72, owner answer "Accept for MVP"): client-held answer keys and client-reported hint use.** Session snapshots (including offline snapshots) carry each question's `answerKey` to the client (needed for the approved offline feedback), and `hintUsed` is reported by the client, so a modified client can inflate its own progress. The accepted controls are the ones in §7: the server grades every submitted answer, validates events, and never accepts `correct`, mastery or daily totals from the client. This remains a self-study app without certificates; no further mitigation is decided, and any later hardening is a new owner decision.
- **RESOLVED (D72, owner answer "Offer both, book order default"): reverse Juz' Amma order (surah 114 → 78).** `PlanOrder = 'book' | 'reverse'` (§7): book order is the default for every edition; `'reverse'` ("from An-Nas backwards") is available for the Juz' Amma (Quran) edition only, chosen at plan creation, and a change is a plan revision effective the next learning day (§2.3, §5). Within the chosen order no unit is dropped and the Teaching Agent never reorders new material. Confirmed by the owner (Q4, D74): passages inside a surah keep mushaf order under `'reverse'`.
- **RESOLVED for this build (D76, 4 October 2026, owner delegation «use best practice for all»; UQ-03 of UI-design.md §9.3): English religious labels (D28).** The English UI shows numeric section labels (`Surah 78` … `Surah 114`, `Hadith 1` … `Hadith 42`, §2.2) for the build and for judging until Jamhara dictionary terms are supplied; no machine translation is used and D28 is unchanged. Category, book, edition and demo-scenario English labels (e.g. `labelEn`, `titleEn`) must still come from the Jamhara dictionary until sourced and are listed as gaps (Database-schema OPEN-10).

## 13. v1.4 amendments (applied; approved by D74, 4 October 2026)

Dated 4 October 2026. The owner approved the architecture package including these nine amendments (D74: «approve best practice», «q7 approved»); they are applied in the sections above and this list is the change log from v1.3.

1. `POST /api/plans/{id}/resume` (A-08).
2. `POST /api/account/delete` replaces `DELETE /api/account` (A-10).
3. `Plan.pendingSessionMinutes` optional (A-07).
4. Optional `order` in E15 and optional `confirmedEstimate` in E17.
5. Error codes `forbidden` 403 and `payload_too_large` 413; `details` shape; 409 for stale offline-snapshot plan version (C-11).
6. `Idempotency-Key` optional on E22 only.
7. Enumerations of O-21.
8. `SessionEvent` and `EventsResponse` confirmed as the only names (C-05/C-06).
9. §3.2 grant rule: one exception — `srv_redact_revoked_content` (Database-schema §8.2 item 19, A-04) is executable by `service_role` only (the CLI's publishing role), not by `qatra_server`; and `srv_throttle_record` takes a `p_outcome` argument (`failure` or `success`, A-03).

## 14. v1.5 amendments (D75; Approved — D75, A1 (owner, 4 October 2026))

Dated 4 October 2026. The owner approved the plan-conversation package with «A1 approved , best practice» (D75; [Plan-conversation.md](Plan-conversation.md) v1.1); the v1.4 content above keeps its Approved — D74 status. These items are applied in the sections above and this list is the change log from v1.4. Owner decision A2 stays declined: `Path` keeps its four values (`'quran' | 'matn' | 'sanad' | 'grade'`) and takhrij is displayed, never tested.

1. **DTOs and operations (§7):** `QuickReplyCode`, `QuickReply`, `PlanSections`, `PlanProposal`, `ChatMessage` and `PlanChat`, and the endpoint rows E31–E34 (`POST /plan-chats`, `POST /plan-chats/:id/messages`, `GET /plan-chats/:id`, `POST /plan-chats/:id/confirm`).
2. **`PlanProgress.currentVersion: number`** (API-spec O-32, UG-04), so a completed plan can open an E20 `daily` session with the right `expectedPlanVersion`.
3. **`Today.openPlanChatId?: string | null`**, optional, so S-08 and S-11 can resume an open conversation.
4. **Conversation rules (§5):** rules-first pipeline, guard, quick replies, caps, time-out, fallback, payload privacy.
5. **Configuration (§8):** `QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY`, `QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE`, `QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY`, `QATRA_CHAT_MODEL_TURNS_PER_CHAT`, `QATRA_CHAT_MODEL_TIMEOUT_SEC`, `QATRA_CHAT_MAX_TOKENS`, `QATRA_CHAT_GUARD_VERSION`; `OPENROUTER_API_KEY` is required in production for this feature.
6. **Ownership and migrations (§1, §3.3, §10):** the B13 files (`backend/app/routers/plan_chats.py`, `services/plan_chat.py`, `domain/plan_chat_policy.py`, `providers/openrouter.py`; `backend/app/workflow` unchanged), `supabase/migrations/0006_plan_chats.sql`, and the conditional feedback migration renumbered `0007_feedback.sql`.
7. **Error details (§7):** `version_conflict` reasons `proposal_stale` and `chat_closed`.

## 15. v1.7 implementation record (4 October 2026; no new approval)

Dated 4 October 2026. This list is the change log from v1.6. It records implementation facts and an owner dependency approval; it changes no interface, DTO or rule.

1. **Toolchain (§1):** the backend dependencies `cryptography` (D76, Q1) and `tzdata` (owner approval «apprvoed if it fits the project»).
2. **Configuration (§8):** `QATRA_TRUSTED_XFF_DEPTH`, the five `QATRA_RATE_*_PER_MIN` settings and `QATRA_CHAT_MODEL_FOR_LEARNERS`, with the scheduled default change of D76 (Q2) still pending B13.
3. **Evidence and limits:** backend tests 2756 passed with ruff clean; the Supabase mode is tested against fakes only and no live-project test has run.

## 16. v1.8 implementation record (4 October 2026; no new approval)

Dated 4 October 2026. This list is the change log from v1.7. It records implementation facts, coordinator implementation decisions within D66 and §4, and one owner dependency decision (D81, Q6); it adds no DTO and no endpoint, and it is an implementation record with no new owner approval. Everything below was tested locally only, and nothing is deployed from this branch.

1. **Toolchain (§1):** the frontend dependency `lucide-react` 1.52.0 (exact pin; owner decision D81, Q6; licence ISC, with an MIT notice for glyphs derived from Feather) is used only through the seam component `frontend/src/components/ui/Icon.tsx`. `frontend/THIRD_PARTY_NOTICES.md` arrives with the S-02 step.
2. **Configuration (§8):** the code default of `QATRA_CHAT_MODEL_FOR_LEARNERS` is `false` since the B13 wiring step (D76, Q2; merge db6baaa); it was `true` until then.
3. **B13 wiring (E31 to E34; 115 tests):** a per-request `PlanChatGateway` binds B4's `PlanService.ports_for` and the learner's token, and `wiring.install_plan_chat` installs it. The new file is `backend/app/services/plan_chat_learning.py`.
4. **B13 persistence:** the Supabase mode uses a PostgREST conversation repository (`app_plan_chat_open`, `app_plan_chat_append`, `app_plan_chat_confirm`) and an atomic confirmer that writes the plan and closes the conversation in one transaction. The usage ledger writes through `srv_record_ai_usage` using `QATRA_SERVER_DB`.
5. **B13 behaviour:** E33 is in the Session read class; E34 answers 422 `validation_error` when a proposal rule no longer holds and 404 when a placement session vanished; E32 and E34 answer 409 `version_conflict` with `details.reason` `chat_closed` for a closed conversation. A cross-process race on the open-conversation index answers 503, and `modelTurnsLeft` is 0 for demo accounts, for a switched-off model and for a reached cap (the F14 signal for "model switched off" is an open point for Sprint 3).
6. **B13 known limitation:** the cap counters live in process memory because `qatra_server` has no read function for `ai_usage`. This is accepted for this build, a restart resets them, and the judging deployment makes no model call.
7. **B6 rules (checkpoint 1, merge 3655064, 784 tests):** the pure mastery and time rules are in `backend/app/domain/mastery_policy.py` and `time_policy.py`; checkpoint 2 with E18, E19, E21 and E22 is in progress (update in v1.9: it is merged, see §17). The B6 decisions below were taken by the coordinator within D66 and §4, not by the owner.
8. **B6 attempts:** assisted attempts change no streak, give no evidence and add no error parts outside review rounds, and a hint fails a review round. A new passage becomes `learning` at its first graded attempt.
9. **B6 rounds:** stage 3 passed while a part is still uncovered keeps stage 3, with no lapse, and the next round is on the next learning day. A failed maintenance round adds a lapse and the failing parts and resets the maintenance stage.
10. **B6 ordering:** at most one stage per learning date, and a round older than `last_review_date` has no effect. A part leaves `error_part_ids` when it later gets a correct unassisted answer.
11. **B6 time and status:** credited time is `[startedAt, startedAt + min(activeMs, span)]` merged by union, and placement activity is validated then ignored. The section status rollup is confirmed, needs_refresh, reviewing, learning, new, in that order.
12. **B6 plan state in E21:** E21 accepts events for sessions of active and completed plans and rejects paused plans with `plan_not_active`; this resolves the difference between API-spec S-4 and A-08/O-32 (API-spec C-17), where the later D75 rule lets completed plans open maintenance sessions. The pending reason codes are `policy_unsupported`, `plan_changed_unverifiable` and `content_unverifiable`.
13. **B6 known limitation:** mastery rows are written without a row lock, so two parallel batches on one passage can lose an update. This is accepted for at most 10 users.
14. **S-01 and the frontend:** the S-01 Login screen (merge 3212e4a) uses the `Icon` seam over `lucide-react` and aligns the `PassageView` unit kinds of the frontend types; the screen decisions are recorded in [UI-screens.md](UI-screens.md) (O-07 resolved, Batch 1 implementation notes).
15. **Evidence and limits:** backend 3657 tests passed with ruff clean; the database harness 122 passed, 0 failed; frontend lint, typecheck, 365 unit tests, build and 150 browser tests passed. The owner has not reviewed Batch 1 (G2 pending).

## 17. v1.9 implementation record (5 October 2026; no new approval)

Dated 5 October 2026. This list is the change log from v1.8. It records implementation facts (each item is Implemented locally, local tests only) and the coordinator's decisions on the open questions of the B6 checkpoint 2 worker, taken within the approved text (D66, §7, API-spec E21, E22 and O-24) and not by the owner; it adds no DTO and no endpoint and changes no rule, and it is an implementation record with no new owner approval. No deployment of this code is recorded here.

1. **B6 checkpoint 2 (merge d145f0c; 768 new tests; backend 4425 passed after the merge):** E21 (`POST /api/sessions/:id/events`) grades and records answer and activity events in array order, with one outcome each (`acknowledged`, `duplicate`, `pending`, `rejected`), and persists a request through `app_apply_events`; E22 (`POST /api/sessions/:id/complete`) closes a session idempotently and returns its summary; E18 (`GET /api/today`) and E19 (`GET /api/progress`) read the day, the streak, the 30-day history and the overall progress per plan (D40, D57, D66). The files are `backend/app/routers/sessions.py` and `services/sessions.py` (E21, E22), `routers/progress.py` and `services/progress.py` (E18, E19) and the B6 methods of `repositories/learning.py`; package B4 gains the additive `list_plans`. Item 7 of §16 said that checkpoint 2 was in progress; it is merged.
2. **W-INT (merge ce86d04; backend 4454 passed):** wires the seams that checkpoint 2 left open. E21 dates an activity event by its `startedAt` in the account time zone in force that day (§7, activity events; D57) through `PlanService.learning_zone` and `PlanServiceCalendar.learning_zone`; `Today.openPlanChatId` of E18 names the caller's open plan conversation through a lookup that `wiring.py` binds to the plan-conversation service; and an integration test shows that the B13 revision conversation receives the days E21 recorded.
3. **Coordinator decisions on the checkpoint 2 worker's open questions (all applied):** (a) activity dating follows §7: the learning date of an interval is the date of `startedAt` in the account zone effective that day, wired by W-INT; (b) an online (un-enveloped) event for a `prepared` session is `rejected` with `envelope_mismatch` (API-spec E21 step 4: online events need an open session, and a prepared session opens on its first accepted replayed event), not `session_closed`, which is for `completed` sessions; (c) E22 `newPassages` keeps the literal rule of API-spec O-24 (passages first attempted in the session), with the account's earliest attempt by (`occurredAt`, `clientEventId`), attempts of placement sessions included, so a passage that the placement test asked about is not new in the first daily session; (d) additive edits to the B5 test helpers `ss_postgrest.py` and `ss_support.py` are accepted; (e) a passage that the placement test marked as known and that is practised on day one gains mastery credit from those daily answers (D66; API-spec E15: known passages are scheduled as an early quick review, with no mastery credit from the placement itself), and neither rule changes; (f) the flaky B0 test `test_access_log_records_the_error_code` now asserts that the raw path (`/42`, `does-not-exist`) never reaches the log, instead of a bare `42` that `latency_ms` can contain (fixed by W-INT).
4. **Known limits of checkpoint 2:** they are listed in [Readiness.tracker.md](Readiness.tracker.md) (backend row); the lost-update limit of item 13 of §16 is one of them.
5. **API-spec clarifications:** the processing, reason-code and counting details that checkpoint 2 settled are recorded in API-spec v1.4 (E18, E19, E21, E22); they add no behaviour.
6. **Evidence and limits:** backend 4454 tests passed after W-INT; frontend lint, typecheck, 608 unit tests, build and 228 browser tests passed after the S-02 merge (32d1809). The owner has not reviewed Batch 1 (G2 pending).
7. **W-OPS2 (merge 76a25bd; commit 66f9743; backend 4444 passed when verified):** the access log carries two proxy-chain measures, `xff_entries` (the number of non-empty `X-Forwarded-For` entries that arrived) and `via_vercel` (whether an `x-vercel-id` header was present), a count and a flag only, to choose `QATRA_TRUSTED_XFF_DEPTH` (§8) from production logs; no header value, address or hash is logged, and no configuration, DTO or endpoint changes (API-spec §1.12).
8. **D83 (owner, 5 October 2026):** G4 and G6 are granted for the scopes stated in D83: the core-journey screens connected to the real server, and surah 112 and hadith 1 from the Islamic Content service only (bank version 1). The coordinator's application for that scope verifies by two independent acquisitions compared byte for byte, without the KFGQPC oracle and the OpenITI skeleton for now, so the verification steps of §2.7 are narrowed for this scope until a later decision; the text of §2.7 is not changed. The content work is in progress and nothing is published.

## 18. v1.10 implementation record (5 October 2026; no new approval)

Dated 5 October 2026. This list is the change log from v1.9. It records implementation facts (each item about code is Implemented locally, local tests only, and on main where it says so) and coordinator decisions taken where the specification was silent, within the approved text and not by the owner; it adds no DTO and no endpoint and changes no rule, and it needs no new owner approval. The hosting items (5 and 6) are coordinator reports of 5 October 2026: no user-tested production flow is recorded here. Merged to main: PR #13 (merge fb43b15, docs pass 4, which carried v1.9), PR #14 (merge 0b4a568: S-03, S-04 and the content pipeline) and PR #15 (merge 821bedf: the F0 follow-up). PR #12 (merge 86156db: the Quran audio list for Juz' Amma, metadata references only) was merged by another session and is in the branch.

1. **S-03 Terms and privacy (commit d1ec509, merge 73894f6):** the page text is taken from Authentication-and-privacy.md, section «شروط الاستخدام وبيان الخصوصية», plus the rows of «البيانات المسموحة ومكانها» that it points to (`frontend/src/i18n/terms-text.ts`); owner copy fix 1 is applied (the D75 transparency line and paragraph; the D53 notice verbatim). Left out until their features exist: the offline paragraph and the downloaded-plan row (F13), the lesson-feedback row (D45) and the embedding sentences (D69). Not copied: the configurable 7-day cleanup line and the outdated review days 1/3/7 (D66 uses 1/2/4). The P-02 check glyph on the selected language segment is implemented. Coordinator decisions: the `reading` column stays an opt-in of the public shell, and the anchor offset of S-26 is decided when S-26 is built. Note for the owner, raised at G2 (no decision recorded): the D75 privacy paragraph describes sending the text of the plan conversation to an external model, while the learner default `QATRA_CHAT_MODEL_FOR_LEARNERS` is `false` (D76, §8). The screen calls no API.
2. **S-04 Recovery-code save (commit ed26653, merge 225fc32):** coordinator decisions where the specification was silent: guard 9 sends a visitor to `/login` with the recovery wording and a signed-in learner to the home destination with the default wording; a failed session probe counts as a visitor; the join dash between the two code lines is kept in the text but not shown; the download file has no byte order mark and no trailing newline; leaving from the recovery host shows only the guard-9 banner (one arrival banner, P-09); the toast has no control and does not pause on hover; S-11 and S-22 must mount `RecoveryCodeUnavailableBanner` when they are built; `LoginForm` gained the `code_unavailable` arrival; the browser-test ports are configurable through `E2E_APP_PORT` and `E2E_BACKEND_PORT`. Owner copy fix 2 is applied. The screen calls no API (the code arrives with the response of E03, E07 or E08).
3. **F0 follow-up (commit c306c0b, merge 9d8b53f):** a top bar that wraps beyond one row plus half a rem becomes static (not sticky); `FocusShell` follows the same rule; the scroll padding follows the bar state; the root `error.tsx` uses Next 16's `retry`. Rule for future screens: a sticky element under the bar (S-34's Slot T, and any later screen with a sticky element under the bar) must follow `data-wrapped` on the header. Open, not done: from 1024 px the public and focus shells keep a sticky bar while the document scroll padding is 8 px, so a focused control can land under the bar (S-03 works around it with `rail:scroll-mt-appbar`); a fix was started and stopped unfinished and is to be redone.
4. **Content pipeline, C6 subset for D83 (commit bde8bd1, merge 3d40a3e):** `verify --source-only-decision D83`, scoped validation, `approve` from the owner's recorded chat words, and `publish --sql-out` (one transactional SQL file that the owner applies; the bucket upload is deferred). The interface is recorded in API-spec v1.5 §5.5; the verification narrowing of item 8 of §17 is the one implemented here, and the text of §2.7 is not changed. Operator run of 5 October 2026 (bank version 1, memory mode; the gitignored build directory was in the content worker's container and was not persisted; counts and ids only): `quran-hafs-quranenc` surah 112: 1 section, 4 units, 15 words, 1 passage, 4 parts, 1 lesson, 16 questions, `validate` 0 issues, verification `source_only(D83)` by HTTP re-acquisition with byte equality; `nawawi40-hadeethenc` hadith 1 (HadeethEnc record 66511): 1 section, 3 units, 99 words, 2 passages (matn and sanad), 11 parts, 2 lessons, 47 questions, `validate` 0 issues, verification by two-pass NFC equality; the grade passage is omitted because one hadith has one grade phrase (no invented option). Publication waits for the owner's final approval words and accepts the C5 register position (no publisher states a reuse permission); nothing is published.
5. **Hosting (coordinator report, 5 October 2026):** Vercel production deploys `main` automatically. Render did not auto-deploy the commits of `main`; the coordinator triggered the deploy of f177a46 (live 02:48 UTC), and the later `main` commits changed no runtime backend code. The access-log measures of item 7 of §17 show `xff_entries` of 4 with `via_vercel` true for requests through Vercel, and `xff_entries` of 0 with `via_vercel` false for Render's health checks; Vercel documents that it overwrites `X-Forwarded-For`; the recommended `QATRA_TRUSTED_XFF_DEPTH` is 4, which supersedes the expected 2 of §8. Setting it was blocked by the coordinator's permission rules, so it is an owner action, pending. Residual risk: a direct request to the onrender.com address can forge entries; the per-username login throttle still applies.
6. **Defect found, terms version:** the production page shows the terms version «2026-10-04.» with a trailing full stop, although the template of the screen adds none. The Vercel value of `NEXT_PUBLIC_TERMS_VERSION` therefore likely differs from the backend `TERMS_VERSION` («2026-10-04», §6), and the two must be equal (UA-16 of UI-design.md, which expects the check when the environments are provisioned). Registration on production would then be refused with `terms_required`. Not yet verified. Owner action pending: set the Vercel value to `2026-10-04`, redeploy, and check the `TERMS_VERSION` of Render.
7. **Evidence and limits:** each commit was verified by the coordinator when it was made: S-03 lint, typecheck, 677 unit tests, build and 307 browser tests; S-04 806 unit tests and 337 browser tests; the F0 follow-up 897 unit tests and 462 browser tests; the content pipeline pytest 4585 passed with ruff check and format clean. Baseline after the F0 follow-up merge (9d8b53f; the coordinator's baseline logs, not committed): backend 4585 passed with ruff clean; database harness 122 passed, 0 failed; frontend lint, typecheck, 897 unit tests, build and 462 browser tests passed. These are local tests only. The hosting statements of items 5 and 6 are coordinator reports, no user-tested production flow is recorded, and the owner has not yet answered the G2 summary of Batch 1 (the owner's «تابع» is pending).
