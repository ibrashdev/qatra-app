# Operator CLI: `content_tools` (content workflow, B7)

The content manager and the reviewer (the owner, D70/D71) run the content workflow from a
developer machine; no HTTP endpoint exposes it (API-spec §5, D48). Seven commands are
implemented: `acquire`, `verify`, `segment`, `build-bank`, `validate`, `approve` and `publish`.
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

Ten commands are registered. Six implemented commands write their `content_jobs` step to the
local job rows. `publish` writes no local row (the `published` row is in its SQL file, see
`publish`) and `delete-unused-draft` writes none (API-spec §5.2).

| Command | Step written | Status |
|---|---|---|
| `acquire` | `acquired` | implemented |
| `verify` | `verified` | implemented, with the source-only mode `--source-only-decision D83` |
| `segment` | `segmented` | implemented (B8) |
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
