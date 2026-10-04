# Operator CLI: `content_tools` (content workflow, B7)

The content manager and the reviewer (the owner, D70/D71) run the content workflow from a
developer machine; no HTTP endpoint exposes it (API-spec §5, D48). B7 delivers the workflow core
and two implemented steps, `acquire` and `verify`; the other commands are registered and refuse
with exit code 6 until B8/C6.

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

Ten commands are registered (nine write a `content_jobs` step; `delete-unused-draft` writes
none, API-spec §5.2).

| Command | Step written | B7 |
|---|---|---|
| `acquire` | `acquired` | implemented |
| `verify` | `verified` | implemented |
| `segment` | `segmented` | registered, exit 6 (B8) |
| `build-bank` | `bank_built` | registered, exit 6 (B8) |
| `validate` | `validated` | registered, exit 6 (B8) |
| `approve` | `approved` | registered; refuses every non-interactive run; exit 6 (C6) |
| `publish` | `published` | registered; exit 3 (`license_missing`, fail closed) until a license record can be recorded; exit 6 otherwise (C6) |
| `withdraw` | `withdrawn` | registered, exit 6 (C6) |
| `archive` | `archived` | registered, exit 6 (C6) |
| `delete-unused-draft` | none | registered, exit 6 (C6) |

A registered command first checks its preconditions through `app/domain/content_policy.py`
(step order, approvable, publishable, removable); a violated precondition is exit 3. `page_mapped`
and `embedded` are recorded as `skipped` rows (web edition, D68; embeddings postponed, D69).
A published version is immutable: every earlier step then refuses to run again.

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
# Over MCP JSON-RPC when the host is reachable (never live-tested; see below)
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
```

- **Quran**: NFC text equals the NFC oracle text for every ayah of the scope. The oracle file is
  UTF-8, one ayah per line as `surah|ayah|text` (blank lines and `#` comments ignored); a trailing
  ayah number (digits, optionally with U+06DD or ornate brackets) is stripped before comparing.
  The oracle is a verification tool only, never committed, never a content source.
- **Hadith**: pass 1 equals pass 2 after NFC for the narration, the takhrij (Narrator) and the
  grade, and both passes agree on id and URL. `--skeleton` (`fortyNumber|text` per line) compares
  letter skeletons and only **flags** omissions or additions for review (never blocks). A hadith
  absent from one or both passes is a documented gap (`gap_report.md`), not a failure.
- `--http-recheck`: re-fetch over HTTP and compare byte for byte; an unreachable host is exit 7
  and no verification is recorded.
- Any mismatch blocks the affected unit (exit 4, the step is recorded `failed` with its cursor
  and the edition stays draft). Writes `verification.json`, `verification_report.md` and, for
  hadith, `gap_report.md` under `<build>/<editionKey>/` (counts and unit refs only).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success (including `acquire` stored and still waiting for more input) |
| 1 | unexpected internal error (only the exception type is printed) |
| 2 | usage error or an invalid input file (nothing was stored) |
| 3 | precondition, step order or refused overwrite (policy refusal, hash conflict, scope, independence) |
| 4 | verification failed (units blocked) or a stored object fails its integrity check |
| 5 | not configured: Supabase variables missing, or a Supabase repository that B7 does not have |
| 6 | not implemented in B7 (B8/C6) |
| 7 | source host unreachable, or an MCP protocol or response-layout error |

## Safety rules

- Counts and ids only are printed or written to reports; source text and secrets never are.
- Raw objects and reports are written only below the build directory (`.content-build/` is
  gitignored). Never commit them.
- The CLI reads only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `QATRA_DATA_BACKEND`; it
  never reads learner tables or `QATRA_SERVER_DB`.
- The MCP client accepts only `https://mcp.islamiccontent.org/...` and never follows redirects.
  It has been tested against `httpx.MockTransport` only: the live host is not reachable from the
  build container.
