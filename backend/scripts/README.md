# Operator CLI: `content_tools` (content workflow, B7)

The content manager and the reviewer (the owner, D70/D71) run the content workflow from a
developer machine; no HTTP endpoint exposes it (API-spec §5, D48). Eight commands are
implemented: `acquire`, `verify`, `segment`, `propose-questions`, `build-bank`, `validate`, `approve`
and `publish`.
`withdraw`, `archive` and `delete-unused-draft` are registered: they check their preconditions
and then refuse with exit code 6 until C6.

```bash
cd backend
uv run python -m scripts.content_tools <command> --edition <key> --bank-version <N> [options]
uv run python scripts/content_tools.py <command> ...        # equivalent
```

Common options: `--edition {quran-hafs-quranenc,nawawi40-hadeethenc}` and `--bank-version N`
(both required), `--build-dir DIR` (default `backend/.content-build`, gitignored),
`--data-backend {memory,supabase}` (default: `QATRA_DATA_BACKEND` if set, else `memory`).
`memory` keeps jobs and raw objects in the local build area. `supabase` needs `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` (from the process environment or the gitignored `backend/.env`) and
is **not available in B7**: the `content_jobs` repository lands after B1 is accepted and G5.

## Commands and the step each one writes

Eleven commands are registered. Six implemented commands write their `content_jobs` step to the
local job rows. `publish` writes no local row (the `published` row is in its SQL file, see
`publish`), and `propose-questions` and `delete-unused-draft` write none (API-spec §5.2).

| Command | Step written | Status |
|---|---|---|
| `acquire` | `acquired` | implemented |
| `verify` | `verified` | implemented, with the source-only mode `--source-only-decision D83` |
| `segment` | `segmented` | implemented (B8) |
| `propose-questions` | none (optional, between `segment` and `build-bank`) | implemented (D90) |
| `build-bank` | `bank_built` | implemented (B8) |
| `validate` | `validated` | implemented (B8) |
| `approve` | `approved` | implemented: records the owner's approval from explicit inputs |
| `publish` | none locally (the SQL file holds the job rows and the `published` row) | implemented: writes ONE SQL file and applies nothing |
| `withdraw` | `withdrawn` | registered, exit 6 (C6) |
| `archive` | `archived` | registered, exit 6 (C6) |
| `delete-unused-draft` | none | registered, exit 6 (C6) |

Every command first checks its preconditions through `app/domain/content_policy.py` (step order,
approvable, publishable, removable); a violated precondition is exit 3. `page_mapped` and
`embedded` are recorded as `skipped` rows (web edition, D68; embeddings postponed, D69). A version
with a recorded `published` row is immutable: every earlier step then refuses to run again.
`publish` does not record that row locally, so a local build stays re-runnable; in the database
the row exists once the SQL file is applied, and the file's own guard refuses a second
application.

## `acquire`

```bash
# Quran, records captured through the MCP connector (scope defaults to surahs 78-114)
uv run python -m scripts.content_tools acquire --edition quran-hafs-quranenc --bank-version 1 \
    --records path/to/quran_records.json [--surahs 112]
# Hadith: two independent passes are required
uv run python -m scripts.content_tools acquire --edition nawawi40-hadeethenc --bank-version 1 \
    --pass 1 --records path/to/pass1.json [--forty 1-42]
uv run python -m scripts.content_tools acquire --edition nawawi40-hadeethenc --bank-version 1 \
    --pass 2 --records path/to/pass2.json
# Over MCP JSON-RPC (host must be reachable; see "The MCP client in live use")
uv run python -m scripts.content_tools acquire --edition quran-hafs-quranenc --bank-version 1 --http
uv run python -m scripts.content_tools acquire --edition nawawi40-hadeethenc --bank-version 1 \
    --pass 1 --http --id-map path/to/ids.json
```

- **Records file** (format version 1, JSON): `{"formatVersion": 1, "tool": "get_quran_verses" |
  "get_hadith", "retrievedAt": "<ISO 8601 with time zone>", "acquisition": "mcp_tool",
  "records": [...]}`. Quran records `{surah, ayah, text, url}` must cover whole surahs; hadith
  records `{hadeethencId, fortyNumber, title, narration, narrator, grade, url, languages}`.
  Unknown fields are refused, so a tafsir, translation or commentary cannot reach storage.
- **`--id-map`** (hadith over `--http`): JSON `{"<fortyNumber>": <hadeethencId>}`. A number with
  no id is never fetched or guessed; it becomes a gap at `verify`.
- **Raw objects** are stored unmodified with tool name, arguments, retrieval time, canonical URL
  and `rawSha256` (SHA-256 of the canonical JSON of the records) as
  `<build>/raw/<editionKey>/bank<N>-surah-NNN.json` and
  `bank<N>-pass<P>-forty-NN.json`. The same input writes nothing new; an existing object whose
  record hash differs is refused (exit 3): a correction needs a new `--bank-version`.
- **Scope** (`--surahs`, `--forty`) is fixed by the first `acquire` of a build (a narrower scope
  makes a sample build); a later conflicting value is refused. A Quran acquisition is complete
  when every surah of the scope is stored (otherwise the step stays `running` with its cursor).
  A hadith acquisition is complete when both passes are stored; which hadiths have no record is
  decided by `verify` (the gap report).
- The same records file cannot serve both hadith passes (independence guard).
- Over `--http`, a network failure keeps what was stored and the cursor (exit 7); run the same
  command again to resume without re-fetching stored objects.
- Writes `<build>/<editionKey>/acquisition_report.md` and the aggregate
  `<build>/acquisition_report.md` (counts and ids only).

## `verify`

```bash
uv run python -m scripts.content_tools verify --edition quran-hafs-quranenc --bank-version 1 \
    --oracle path/to/oracle.txt [--http-recheck]
uv run python -m scripts.content_tools verify --edition nawawi40-hadeethenc --bank-version 1 \
    [--skeleton path/to/reference.txt] [--http-recheck]
# D83: two HTTP acquisitions from the service replace the oracle and the skeleton
uv run python -m scripts.content_tools verify --edition quran-hafs-quranenc --bank-version 1 \
    --source-only-decision D83 --http-recheck
uv run python -m scripts.content_tools verify --edition nawawi40-hadeethenc --bank-version 1 \
    --source-only-decision D83
```

- **Quran** (with `--oracle`): NFC text equals the NFC oracle text for every ayah of the scope.
  The oracle file is UTF-8, one ayah per line as `surah|ayah|text` (blank lines and `#` comments
  ignored); a trailing ayah number (digits, optionally with U+06DD or ornate brackets) is
  stripped before comparing. The oracle is a verification tool only, never committed, never a
  content source.
- **Hadith**: pass 1 equals pass 2 after NFC for the narration, the takhrij (Narrator) and the
  grade, and both passes agree on id and URL. `--skeleton` (`fortyNumber|text` per line) compares
  letter skeletons and only **flags** omissions or additions for review (never blocks). A hadith
  absent from one or both passes is a documented gap (`gap_report.md`), not a failure.
- `--http-recheck`: re-fetch over HTTP and compare byte for byte; an unreachable host is exit 7
  and no verification is recorded.
- **`--source-only-decision D83`** (owner decision of 5 October 2026) accepts two independent
  acquisitions from the Islamic Content service in place of the oracle and the skeleton, for
  exactly surah 112 of `quran-hafs-quranenc` and Forty hadith 1 (HadeethEnc record 66511) of
  `nawawi40-hadeethenc`, both at bank version 1. No other source is fetched, not even as a check.
  - Quran: both acquisitions must be HTTP; a unit passes when the stored one and the
    re-acquisition made by `verify` are byte-identical (and equal after NFC), so `--http-recheck`
    is required.
  - Hadith: both passes must be HTTP acquisitions; a unit passes when pass 1 and pass 2 are
    identical after NFC. Whether they are also byte-identical is recorded as information.
    `--http-recheck` is optional and adds a third acquisition.
  - Refused: any other scope or bank version, a stored object that came from a records file and a
    hadith record other than 66511 (exit 3, before any request); `--oracle` or `--skeleton`
    together with the option, and any decision other than `D83` (exit 2).
  - Recorded (counts, ids and hashes only): the method `source_only(D83):...`, the decision id,
    the objects with their `rawSha256` and times, in `verification.json`,
    `verification_report.md`, the job summary (`sourceOnly`) and the `verification` entry of the
    review record. For the Quran the summary also cites the sample check recorded in D68 as
    prior evidence (not re-fetched).
  - Without the option nothing changes: a missing oracle still fails closed.
- Any mismatch blocks the affected unit (exit 4, the step is recorded `failed` with its cursor
  and the edition stays draft). Writes `verification.json`, `verification_report.md` and, for
  hadith, `gap_report.md` under `<build>/<editionKey>/` (counts and unit refs only).

## `segment`, `build-bank` and `validate`

```bash
uv run python -m scripts.content_tools segment --edition <key> --bank-version 1 \
    [--labels path/to/labels.json] [--boundaries path/to/boundaries.json]
uv run python -m scripts.content_tools build-bank --edition <key> --bank-version 1
uv run python -m scripts.content_tools validate --edition <key> --bank-version 1
```

- `segment` (needs `verified`): sections, units, passages and parts of the verified units only (a
  documented gap is left out). `--labels` defaults to the packaged
  `app/workflow/data/edition_labels.json`; `--boundaries` (hadith only) defaults to the packaged
  `nawawi40_boundaries.json`. Writes `bundle.json`, the draft `publish.sql` and `report.md` under
  `<build>/<editionKey>/`. Prints `sections`, `units`, `words`, `passages`, `parts`, and
  `boundary_doubts=[...]` where the quote marks around the Prophet's words are absent or
  ambiguous.
- `build-bank` (needs `segmented`): lessons and the four question templates, deterministic.
  Prints `lessons`, `questions`, `skipped`. It refuses a `bundle.json` that no longer has the
  structure `segment` recorded.
- `validate` (needs `bank_built`): fail-closed edition and bank validation. Any issue is exit 4
  (the step is recorded `failed`, the edition stays draft; issue codes and ids are in
  `report.md`). Prints `issues`, `questions`, `parts`, `parts_covered`.
- **Scope**: the three steps follow the scope recorded by the first `acquire` and never expect all
  of Juz' Amma or all 42 hadiths from a sample build; a full-scope build is checked exactly as
  before. The grade question is a choice among the distinct grade phrases of the edition, so a
  sample build with fewer than two of them (for example one hadith) makes no grade passage: the
  grade unit is kept, `segment` prints `grade_passages_omitted=[...]` and the review record lists
  a `grade_path_unavailable` flag. A full build still makes every grade passage, so a grade that
  cannot be tested stays a `validate` failure (`part_uncovered`). No other validation rule changed.

## `propose-questions` (optional, D90)

```bash
uv run python -m scripts.content_tools propose-questions --edition <key> --bank-version 1 \
    [--max-requests 30] [--timeout 90] [--pause 3.5] [--refresh] [--dry-run]
```

The owner approved (D90) that a free AI model proposes the question words, the program checks the
answers and the owner reviews them before publishing. The model never changes the religious text
and never invents information: it answers with **references** to words of the source (never a new
word), and every pick is checked by the program.

- **Where it sits**: after `segment` (needs the `segmented` step), before `build-bank`. It writes
  no job row. Without it, `build-bank` is exactly the rules engine; the rules engine is also the
  permanent fallback for every part the model did not or could not pick.
- **What is sent**: one request per non-grade passage (grade passages have no recall or word
  question): its parts with word references and the distinct Arabic words of its section (the
  distractor pool, at most 200). Published source text only; the workflow holds no learner data.
- **Free models only (D60)**: the request goes through `OpenRouterProvider`, which calls a model
  only when its live OpenRouter price is zero. Set `OPENROUTER_API_KEY` and `OPENROUTER_MODELS`
  (free model ids, best first) in the environment or the gitignored `backend/.env`. With no key or
  no candidate the command prints `rules fallback: no free model configured`, exits 0 and writes
  nothing. If no listed model is free it stops with `stopped=ineligible` (nothing was sent).
- **Quota**: the free allowance is per OpenRouter account and shared with the live app (50 a day by
  default). `--max-requests` (default 30) is also capped by
  `QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY`; `--pause` spaces requests for the per-minute limit. The
  run is **resumable**: the store is saved after every passage and a passage whose proposal is
  current is not asked again, so run it again the next day for the passages still `deferred`.
  `--refresh` asks again for every passage; `--dry-run` prints the plan (`planned=N`) and sends
  nothing (no key needed). A failed, timed-out or malformed answer leaves that passage to the rules
  (counted in `failed`, the reason codes printed as `failures=`); three failures in a row stop the
  run (`stopped=provider_failing`).
- **Writes** below `<build>/<editionKey>/`: `question-proposals.json` (the raw proposals: edition,
  passage key, SHA-256 of the passage text, model id and the references; no source text) and
  `question-proposals.md`, the review sheet with the part text, the model's keyword, word and
  distractors, and for each whether it was accepted or why the rules took over. The sheet holds
  source text: never commit it. **Read it before `approve`.**
- **Validation** (the same rules the rules engine uses, applied to the model's picks): each
  reference must exist; the keyword and the word to choose must belong to that part, be Arabic
  script, not be a stoplist word or a single letter, not be ambiguous (the same shown context
  elsewhere with another answer), and the keyword must not be a Quran position whose spelling
  forbids recall; the word to choose must differ from the keyword and, in a part after the first,
  from the first word (already tested as the continuation point); the 3 distractors must be exactly
  3 references from the pool, Arabic script, pairwise different after normalization (alternative
  forms included) and different from the target. The keyword and the choice are accepted or
  rejected independently; a rejected one is made by the rules for that part.
- **`build-bank`** reads `question-proposals.json` when it exists and re-validates every proposal,
  so the same store always gives the same bank (an unchanged result is `changed=no`). An entry whose
  passage text no longer matches its hash is stale and ignored. The question items, ids, natural keys
  and option order are unchanged; only which words are tested differs. The report and the job
  summary record counts only: `proposals.proposedBy` (`ai` both picked, `partial` one of the two,
  `rules`), the counts of model keywords and choices, stale passages and model ids, and the
  command prints `parts_ai`, `parts_partial` and `parts_rules`. Nothing is added to the question
  items or the database.
- **Exit codes**: 0 ok (including no free model); 2 an unreadable `question-proposals.json`; 3
  `segment` has not run or the bundle changed; 5 an unreadable configuration (names only).
  Errors print counts, ids and reason codes only; the API key is never printed.

## `approve`

```bash
uv run python -m scripts.content_tools approve --edition <key> --bank-version 1 \
    --reviewer "<who>" --review-scope "<what was actually reviewed>" --note "<note>" \
    --owner-words "<the owner's words, verbatim>" \
    --source https://claude.ai/code/session_<id> --at 2026-10-05T07:30:00+04:00
```

- **Explicit inputs only.** In this project the owner types the approval in the Claude Code chat;
  those words, recorded verbatim with their source and time, are the confirmation that API-spec
  §5.3 asks for. There is no terminal prompt and no default: `--reviewer`, `--review-scope`,
  `--note`, `--source`, `--at` and the owner's words (`--owner-words`, or `--owner-words-file`
  for a UTF-8 file, which avoids shell quoting) are all required. A missing or empty input is
  exit 2 and nothing is recorded; silence, a timeout or a default is never an approval. Words
  that start with a hyphen and hold no space must be given as `--owner-words=<words>`.
- **Checks on the inputs** (exit 2): `--at` is ISO 8601 with a time zone and not later than the
  current time plus 5 minutes; `--source` is an `https` URL without credentials; the words are at
  most 5000 characters, the note and the review scope at most 2000.
- **Preconditions** (exit 3): the step order, `content_policy.assert_approvable` (the edition is
  `validated` and every verification result passed), an approval time that is not earlier than
  the validation it covers, and a `bundle.json` that is still the one `validate` accepted.
- **Writes** the `approved` step with the approval entry `{who, at, note, scope, words, source}`
  (kept in the job summary as `approval` and `reviewRecordEntry`; `publish` copies it into
  `book_editions.review_record`) and binds it to the validated bundle (`bundleSha256`,
  `contentHash`). Prints counts only (`approvals=1`, `units`, `passages`, `questions`); the words
  are never printed. The same input again changes nothing (`changed=no`); other words replace the
  approval. An earlier step that changes its result removes the approval (every later step is
  reset); a `bundle.json` changed by hand makes `publish` refuse.

## `publish`

```bash
uv run python -m scripts.content_tools publish --edition <key> --bank-version 1 \
    --sql-out backend/.content-build/<key>/publish-final.sql
```

`publish` writes ONE transactional SQL file and applies nothing to any database (there is no
`service_role` key in the build environment). The local job rows are not changed.

- `--sql-out` is required and must name a file below the build directory (exit 2 otherwise). An
  existing file is replaced only if an earlier `publish` wrote it, so the draft `publish.sql` is
  never overwritten (exit 3).
- **Preconditions** (exit 3): the step order (`approved` complete, version not published),
  `content_policy.assert_publishable` (edition `validated`, every verification result `passed`,
  an approval with who, at and note, and the license record), an approval entry that holds all six
  inputs of `approve`, and a `bundle.json` that is still the one `validate` accepted and the
  approval covers. With no approval `publish` refuses: the license record is built only from it.
- **The file** is one transaction, guarded so that it refuses an edition that is no longer a
  draft: the draft upserts; `sources.license_record`; the review record with the acquisition,
  verification and approval entries; the publishing statements (the lessons and question items of
  the bank version become `published`, earlier published editions of the same book become
  `superseded`, the edition becomes `published`); and the `content_jobs` rows, among them
  `approved` and `published` with `published_at = now()`.
- **`license_record`**: the title, URL and "Last updated 14 September 2026" line of the Islamic
  Content MCP Server Terms of Use (`https://mcp.islamiccontent.org/terms.html`, retrieved 5
  October 2026) with two sentences of them verbatim; a note that the publishers' own pages were
  not reachable from the build environment on 5 October 2026; the register
  (`references/source-acquisition/publisher-terms-register.md`, v0.1 Draft); and
  `owner_acceptance`, copied only from the recorded approval (the owner's words also cover
  accepting the recorded terms). The terms say nothing on reuse, so `rights_status` stays
  `owner_accepted_pending_verification`.
- **Raw objects** stay in the local build area with their hashes in the summaries; the private
  bucket upload is deferred, and the `published` summary records "bucket upload deferred: no
  service_role key in the build environment".
- Prints counts, `job_rows`, `sql_bytes`, `sql_sha256` and `applied=no`. The same inputs write the
  same bytes (`changed=no`).
- The file holds source text and the owner's words: never commit it. It is meant to be applied
  once with `service_role`, by the owner; a second application raises at the guard. It has been
  checked as text only (statement structure and literals) and has not been run against a
  database.

## The MCP client in live use

`acquire --http`, `verify --http-recheck` and the D83 mode share one client
(`app/workflow/mcp_client.py`). Its first and so far only live run was the operator run of 5
October 2026 against `https://mcp.islamiccontent.org/mcp`: surah 112 of `quran-hafs-quranenc`
(acquired, then re-acquired by `verify`) and HadeethEnc record 66511 in two passes. The parsers
read the live layout without any change. That is one observation, not a guarantee for other
surahs or records: a layout that differs stops with exit 7, stores nothing from that answer and
names counts of the layout (block tags, ayah markers, `Source:` lines), never text. Requests carry
the descriptive `User-Agent` `qatra-content-workflow/0.1 (operator CLI; read-only acquisition)`.
The unit tests use `httpx.MockTransport` only and never touch the network.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success (including `acquire` stored and still waiting for more input) |
| 1 | unexpected internal error (only the exception type is printed) |
| 2 | usage error or an invalid input (a bad file, a missing or empty `approve` input, a `--sql-out` outside the build directory); nothing was stored |
| 3 | precondition, step order or refused overwrite (policy refusal, hash conflict, scope, independence, no approval, a bundle that changed after validation) |
| 4 | verification or validation failed (units blocked, issues found), or a stored object fails its integrity check |
| 5 | not configured: Supabase variables missing, or a Supabase repository that B7 does not have |
| 6 | not implemented: `withdraw`, `archive` and `delete-unused-draft` (C6), after their preconditions hold |
| 7 | source host unreachable, or an MCP protocol or response-layout error |

## Safety rules

- Counts and ids only are printed or written to reports; source text and secrets never are.
- Raw objects, `bundle.json` and the SQL files (all three hold source text) and the reports are
  written only below the build directory (`.content-build/` is gitignored). Never commit them.
- The CLI reads only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `QATRA_DATA_BACKEND`; it
  never reads learner tables or `QATRA_SERVER_DB`.
- The MCP client accepts only `https://mcp.islamiccontent.org/...` and never follows redirects
  (see "The MCP client in live use").

# Operator CLI: `model_probe` (free-model measurement, D54/D60, D89)

D54/D60 require the OpenRouter free model to be chosen after measurement, and D89's open next
action is to verify the `OPENROUTER_MODELS` value. `model_probe` measures candidate free models
on the **real plan-chat request path**: each model is called through the production
`OpenRouterProvider` (live zero-price check, the `plan-chat-v1` system prompt, the JSON schema,
`require_parameters`, temperature, `QATRA_CHAT_MAX_TOKENS`), and each reply is post-processed with
the production policy (`merge_model_parameters`, `guard_reply`). The owner runs it locally with
their own key; no HTTP endpoint exposes it.

```bash
cd backend
uv run python -m scripts.model_probe --list-free                      # live free catalog, no key
# Recommended minimal run: 3 models x 3 scenarios x 1 run = 9 requests
uv run python -m scripts.model_probe --models vendor/a:free,vendor/b:free,vendor/c:free \
    --scenarios ar_create,en_revise,ar_invalid                  # dry run: prints the plan
uv run python -m scripts.model_probe --models vendor/a:free,vendor/b:free,vendor/c:free \
    --scenarios ar_create,en_revise,ar_invalid --yes --json probe-report.json
```

- **Options**: `--models a,b,c` (default `OPENROUTER_MODELS`), `--runs N` (1-5, default 1),
  `--timeout S` (default `QATRA_CHAT_MODEL_TIMEOUT_SEC`, 8), `--lang ar|en|both` (default
  `both`), `--scenarios ids`, `--pause S` (default 3.5, for the free 20 requests a minute),
  `--json PATH`, `--include-replies` (keep the synthetic reply text in the JSON), `--show-payloads`,
  `--yes`, `--allow-large`, `--list-free`.
- **Dry run by default.** Without `--yes` nothing is sent: it prints the models, the scenarios,
  the total request count, the pacing time and the synthetic learner text (never the key), then
  exits with code 0, also when no key is set yet. Sending needs `--yes`, and then the key. A plan
  above 20 requests is refused unless `--allow-large` is given, and a plan above
  `QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY` (50) is always refused.
- **Synthetic data only.** Six hard-coded scenarios (Arabic plan creation, English plan revision,
  and a religious-ruling question and an out-of-range 45-minute request in each language) over a
  synthetic Juz' Amma and Forty Hadith catalog. Their payloads are built like the service builds
  them and each is checked against the R27 allowlist before sending; a disallowed key aborts. The
  religious-ruling scenarios are stress tests: in the app the input guard answers such a message
  before any model call, so the plan prints what the guard would do.
- **Quota.** The free limit (50 a day, 20 a minute) is per OpenRouter account and is shared with
  live learners on the deployed service. A run uses `models x scenarios x runs` requests, for
  example 3 models x 3 scenarios x 1 run = 9; both the dry run and the `--yes` run print "Uses N of
  the account's shared free daily requests". Spend little: use `--scenarios` and `--lang`, and raise
  `--runs` only when needed.
- **Report.** Per model: success rate (valid output and the scenario's expectation met), valid
  JSON rate, server validation pass rate (the invalid-value scenarios are not counted), p50/p95
  latency, calls within the timeout, guard replacements, refusals handled, and average tokens. The
  last line recommends models with 100 % valid output and p95 within the timeout as a ready
  `OPENROUTER_MODELS=a,b` value, best first (higher validation pass rate, fewer guard
  replacements, lower p95); if none qualify it says so. A model that is not free in the live
  catalog is reported as `ineligible` and nothing is sent to it. The report is a measurement of
  these synthetic scenarios, not a quality guarantee.
- **Safety.** `OPENROUTER_API_KEY` is read only from the environment or the gitignored
  `backend/.env` through `Settings`, and is never printed, logged or written (`--list-free` and a dry
  run need no key; `--yes` without a key exits 5 and sends nothing). The only file written is the optional `--json`
  report. The tool does not touch the database, `ai_usage` or the wiring.
- **Exit codes**: 0 ok (a dry run included, with or without a key); 1 unexpected error (only the exception type is
  printed); 2 usage error or unsafe input; 5 no key with `--yes`, or an unreadable configuration; 7 the
  OpenRouter catalog could not be read. The unit tests use `httpx.MockTransport` only and never
  touch the network.
