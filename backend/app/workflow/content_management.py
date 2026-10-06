"""Acquisition and verbatim verification (contract §2.7, API-spec §5.3, B7).

``acquire_source`` stores raw publisher records UNMODIFIED, one object per surah (Quran) or per
hadith and pass (hadith), with tool name, arguments, retrieval time, canonical URL and
``rawSha256``. ``verify_verbatim`` runs the checks of contract §2.7. Both write counts and ids
only to their reports and job summaries: never source text.

**Records file** (``acquire --records PATH``, format version 1): the records returned by the
Islamic Content MCP connector and transcribed by the assistant, as JSON::

    {"formatVersion": 1, "tool": "get_quran_verses" | "get_hadith",
     "retrievedAt": "<ISO 8601 with time zone>", "acquisition": "mcp_tool",
     "records": [ <contract §2.7 record>, ... ]}

Quran records are ``{surah, ayah, text, url}`` and must cover whole surahs; hadith records are
``{hadeethencId, fortyNumber, title, narration, narrator, grade, url, languages}``. Unknown
fields are refused (a tafsir, translation or commentary can never reach storage).

**Storage names** (open item OPEN-17): ``bank<N>-surah-NNN.json`` and
``bank<N>-pass<P>-forty-NN.json``: the bank version is part of the name, so a correction (a new
bank version) never collides with the refused overwrite of an existing object.

**Completeness**: a Quran acquisition is complete when every surah of the scope is stored
(otherwise the step stays ``running`` with its cursor). A hadith acquisition is complete when
both independent passes are stored: which hadiths legitimately have no record is decided at
``verify`` (the gap report), not by acquisition.

**Oracle file** (``verify --oracle PATH``, Quran): UTF-8 text, one ayah per line as
``surah|ayah|text``; blank lines and lines starting with ``#`` are ignored; a trailing ayah
number (digits, optionally with U+06DD or ornate brackets) is stripped before comparing.
**Skeleton file** (``verify --skeleton PATH``, hadith, optional): ``fortyNumber|text`` lines.

**Source-only mode** (``verify --source-only-decision D83|D95``): for exactly the scope of the
selected decision (see ``source_only``) independent HTTP acquisitions from the service replace
the oracle and the skeleton. Without the option nothing changes: a missing oracle still fails
closed.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from app.domain.normalization import letter_skeleton
from app.workflow import source_only
from app.workflow.editions import (
    MCP_SOURCE_URL,
    QURAN_AYAH_COUNTS,
    EditionScope,
    EditionSpec,
    default_scope,
    edition_spec,
)
from app.workflow.errors import (
    AcquisitionInterruptedError,
    InputError,
    McpParseError,
    ObjectConflictError,
    ObjectNotFoundError,
    PreconditionError,
    SourceUnreachableError,
    VerificationFailedError,
)
from app.workflow.jobs import JobRepository
from app.workflow.mcp_client import (
    McpJsonRpcClient,
    hadith_arguments,
    quran_arguments,
)
from app.workflow.models import (
    Acquisition,
    ContentJob,
    HadithRecord,
    QuranRecord,
    RawObject,
    VerificationRecord,
    canonical_json,
    parse_json_object,
    safe_validation_summary,
    sha256_hex,
)
from app.workflow.paths import BuildPaths
from app.workflow.reports import write_acquisition_report, write_verification_files
from app.workflow.results import AcquisitionSnapshot, Gap, ObjectInfo, VerificationOutcome
from app.workflow.runner import StepHandler, StepOutcome
from app.workflow.storage import RawStorage
from app.workflow.validation import (
    hadith_gaps,
    missing_surahs,
    validate_hadith_records,
    validate_quran_records,
)

Clock = Callable[[], datetime]
RECORDS_FILE_FORMAT_VERSION = 1
_HADITH_NAME_RE = re.compile(r"^bank(\d+)-pass([12])-forty-(\d{2})\.json$")
_TRAILING_AYAH_NUMBER = re.compile(r"[\s۝﴾﴿(\[]*[0-9٠-٩۰-۹]+[\s﴾﴿)\]]*$")
_ACQUIRE_WHO = "content_tools acquire (automated; not a human review)"
_VERIFY_WHO = "content_tools verify (automated; not a human review)"


def quran_object_name(bank_version: int, surah: int) -> str:
    return f"bank{bank_version}-surah-{surah:03d}.json"


def hadith_object_name(bank_version: int, pass_number: int, forty_number: int) -> str:
    return f"bank{bank_version}-pass{pass_number}-forty-{forty_number:02d}.json"


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


# --- input files ---------------------------------------------------------------------------


class _RecordsFileModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    format_version: Literal[1] = Field(alias="formatVersion")
    tool: str
    retrieved_at: AwareDatetime = Field(alias="retrievedAt")
    acquisition: Acquisition = "mcp_tool"
    records: list[dict[str, Any]]


@dataclass(frozen=True, slots=True)
class RecordsFile:
    """A parsed records file; ``source_sha256`` fingerprints the file (independence guard)."""

    tool_name: str
    acquisition: Acquisition
    retrieved_at: datetime
    quran: tuple[QuranRecord, ...]
    hadith: tuple[HadithRecord, ...]
    source_sha256: str


@dataclass(frozen=True, slots=True)
class FileSource:
    records: RecordsFile


@dataclass(frozen=True, slots=True)
class HttpSource:
    """Acquire over MCP JSON-RPC. ``id_map`` maps Forty numbers to HadeethEnc ids (hadith)."""

    client: McpJsonRpcClient
    id_map: Mapping[int, int]


def load_records_file(path: Path, edition_key: str) -> RecordsFile:
    spec = edition_spec(edition_key)
    try:
        data = Path(path).read_bytes()
    except OSError:
        raise InputError("the records file cannot be read") from None
    try:
        model = _RecordsFileModel.model_validate(parse_json_object(data, what="the records file"))
    except ValidationError as exc:
        raise InputError(
            f"the records file header is invalid: {safe_validation_summary(exc)}"
        ) from None
    if model.tool != spec.tool_name:
        raise InputError(f"the records file tool must be {spec.tool_name!r} for this edition")
    if not model.records:
        raise InputError("the records file has no records")
    quran: list[QuranRecord] = []
    hadith: list[HadithRecord] = []
    for index, item in enumerate(model.records):
        try:
            if spec.kind == "quran":
                quran.append(QuranRecord.model_validate(item))
            else:
                hadith.append(HadithRecord.model_validate(item))
        except ValidationError as exc:
            raise InputError(
                f"records[{index}] is invalid: {safe_validation_summary(exc)}"
            ) from None
    return RecordsFile(
        tool_name=model.tool,
        acquisition=model.acquisition,
        retrieved_at=model.retrieved_at,
        quran=tuple(quran),
        hadith=tuple(hadith),
        source_sha256=sha256_hex(data),
    )


def load_id_map(path: Path) -> dict[int, int]:
    """``{"<fortyNumber>": <hadeethencId>}``: which HadeethEnc record carries the Forty's own
    wording of each hadith. A number without an id is a gap; ids are never guessed."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        raise InputError("the id map file cannot be read") from None
    result: dict[int, int] = {}
    for key, value in parse_json_object(data, what="the id map").items():
        if not (
            key.isdigit() and isinstance(value, int) and not isinstance(value, bool) and value > 0
        ):
            raise InputError("the id map must map Forty numbers to positive HadeethEnc ids")
        result[int(key)] = value
    return result


def _parse_numbered_lines(path: Path, *, what: str, with_surah: bool) -> dict[Any, str]:
    try:
        text = Path(path).read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        raise InputError(f"the {what} file cannot be read as UTF-8") from None
    entries: dict[Any, str] = {}
    for number, raw in enumerate(text.split("\n"), start=1):
        line = raw.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("|", 2 if with_surah else 1)
        head = [p.strip() for p in parts[:-1]]
        if len(parts) != (3 if with_surah else 2) or not all(h.isdigit() for h in head):
            shape = "surah|ayah|text" if with_surah else "fortyNumber|text"
            raise InputError(f"{what} line {number} is not '{shape}'")
        key: Any = (int(head[0]), int(head[1])) if with_surah else int(head[0])
        if key in entries:
            raise InputError(f"{what} line {number} repeats an earlier entry")
        entries[key] = parts[-1]
    if not entries:
        raise InputError(f"the {what} file has no entries")
    return entries


def load_oracle(path: Path) -> dict[tuple[int, int], str]:
    """Verification oracle ``surah|ayah|text`` (a tool for checking, never a content source)."""
    return _parse_numbered_lines(path, what="oracle", with_surah=True)


def load_skeleton(path: Path) -> dict[int, str]:
    """Reference wording ``fortyNumber|text`` for the optional letter-skeleton comparison."""
    return _parse_numbered_lines(path, what="skeleton", with_surah=False)


def strip_trailing_ayah_number(text: str) -> str:
    """Remove the trailing ayah number (and its end-of-ayah mark or brackets) of an oracle line."""
    return _TRAILING_AYAH_NUMBER.sub("", text).rstrip()


# --- acquire -------------------------------------------------------------------------------


def _quran_object(
    bank_version: int,
    surah: int,
    records: Sequence[QuranRecord],
    retrieved_at: datetime,
    acquisition: Acquisition,
) -> tuple[str, RawObject]:
    ordered = sorted(records, key=lambda r: r.ayah)
    obj = RawObject.build(
        tool_name="get_quran_verses",
        arguments=quran_arguments(surah),
        retrieved_at=retrieved_at,
        canonical_url=ordered[0].url,
        payload={"records": [r.model_dump(by_alias=True) for r in ordered]},
        acquisition=acquisition,
    )
    return quran_object_name(bank_version, surah), obj


def _hadith_object(
    bank_version: int,
    record: HadithRecord,
    pass_number: int,
    retrieved_at: datetime,
    acquisition: Acquisition,
) -> tuple[str, RawObject]:
    obj = RawObject.build(
        tool_name="get_hadith",
        arguments=hadith_arguments(record.hadeethenc_id),
        retrieved_at=retrieved_at,
        canonical_url=record.url,
        payload={"records": [record.model_dump(by_alias=True)]},
        acquisition=acquisition,
        pass_number=pass_number,
    )
    return hadith_object_name(bank_version, pass_number, record.forty_number), obj


def _objects_from_file(
    spec: EditionSpec,
    bank_version: int,
    scope: EditionScope,
    pass_number: int | None,
    rf: RecordsFile,
) -> list[tuple[str, RawObject]]:
    if spec.kind == "quran":
        report = validate_quran_records(rf.quran, scope.surahs)
        if not report.ok:
            raise InputError(f"the records failed validation: {report.summary()}")
        by_surah: dict[int, list[QuranRecord]] = {}
        for record in rf.quran:
            by_surah.setdefault(record.surah, []).append(record)
        return [
            _quran_object(bank_version, surah, records, rf.retrieved_at, rf.acquisition)
            for surah, records in sorted(by_surah.items())
        ]
    assert pass_number is not None
    report = validate_hadith_records(rf.hadith, scope.forty_numbers)
    if not report.ok:
        raise InputError(f"the records failed validation: {report.summary()}")
    return [
        _hadith_object(bank_version, record, pass_number, rf.retrieved_at, rf.acquisition)
        for record in sorted(rf.hadith, key=lambda r: r.forty_number)
    ]


def _same_object(existing: RawObject, new: RawObject) -> bool:
    return (
        existing.raw_sha256 == new.raw_sha256
        and existing.tool_name == new.tool_name
        and existing.arguments == new.arguments
        and existing.canonical_url == new.canonical_url
        and existing.pass_number == new.pass_number
    )


def _store_batch(
    storages: Sequence[RawStorage], edition_key: str, items: Sequence[tuple[str, RawObject]]
) -> tuple[int, int]:
    """Store objects in every storage. Returns ``(created, unchanged)`` object counts of the
    first storage.

    All conflicts are detected before the first write: an existing object whose record hash
    differs is refused (a correction needs a new ``bank_version``). An existing object with the
    same record, tool, arguments and URL is left exactly as it was (its first retrieval time
    is kept).
    """
    plan: list[tuple[int, str, RawObject, bool]] = []
    for index, storage in enumerate(storages):
        for name, obj in items:
            if storage.exists(edition_key, name):
                existing = RawObject.from_bytes(storage.read_raw(edition_key, name))
                if not _same_object(existing, obj):
                    raise ObjectConflictError(
                        "an existing raw object has a different hash; a correction needs a new "
                        "bank_version"
                    )
                plan.append((index, name, obj, False))
            else:
                plan.append((index, name, obj, True))
    for index, name, obj, is_new in plan:
        if is_new:
            storages[index].put_raw(edition_key, name, obj.to_bytes())
    created = sum(1 for index, _name, _obj, is_new in plan if index == 0 and is_new)
    unchanged = sum(1 for index, _name, _obj, is_new in plan if index == 0 and not is_new)
    return created, unchanged


def _resolve_scope(
    spec: EditionSpec, requested: EditionScope | None, stored: EditionScope | None
) -> EditionScope:
    if requested is not None and stored is not None and requested != stored:
        raise PreconditionError(
            "the requested scope differs from the scope recorded by the first acquire; "
            "use a new --bank-version for a different scope"
        )
    return requested or stored or default_scope(spec.key)


def _check_pass(spec: EditionSpec, pass_number: int | None) -> None:
    if spec.kind == "hadith" and pass_number not in (1, 2):
        raise InputError("the hadith edition needs --pass 1 or --pass 2 (two independent passes)")
    if spec.kind == "quran" and pass_number is not None:
        raise InputError("--pass applies to the hadith edition only")


def _fetch_and_store(
    *,
    spec: EditionSpec,
    bank_version: int,
    scope: EditionScope,
    pass_number: int | None,
    source: HttpSource,
    storages: Sequence[RawStorage],
    cursor: dict[str, Any],
    clock: Clock,
) -> tuple[int, int]:
    """Fetch what the cursor does not hold yet over HTTP and store each object as it arrives;
    a network failure keeps what is stored and raises ``AcquisitionInterruptedError``."""
    created = unchanged = 0
    objects: dict[str, str] = cursor["objects"]
    if spec.kind == "quran":
        targets = [s for s in scope.surahs if quran_object_name(bank_version, s) not in objects]
    else:
        assert pass_number is not None
        targets = [
            n
            for n in scope.forty_numbers
            if n in source.id_map
            and hadith_object_name(bank_version, pass_number, n) not in objects
        ]
        if not any(n in source.id_map for n in scope.forty_numbers):
            raise InputError("the id map has no HadeethEnc id for any hadith in the scope")
    for target in targets:
        try:
            retrieved_at = clock()
            if spec.kind == "quran":
                records = source.client.fetch_quran_surah(target)
                report = validate_quran_records(records, [target])
                if not report.ok:
                    raise McpParseError(
                        f"the answer for surah {target} failed validation: {report.summary()}"
                    )
                item = _quran_object(bank_version, target, records, retrieved_at, "http")
            else:
                assert pass_number is not None
                record = source.client.fetch_hadith(source.id_map[target], target)
                report = validate_hadith_records([record], [target])
                if not report.ok:
                    raise McpParseError(
                        f"the answer for hadith {target} failed validation: {report.summary()}"
                    )
                item = _hadith_object(bank_version, record, pass_number, retrieved_at, "http")
        except SourceUnreachableError as exc:
            raise AcquisitionInterruptedError(
                f"acquisition over HTTP stopped: {exc}",
                cursor=cursor,
                summary={"interrupted": True, "stored": len(objects)},
            ) from None
        made, same = _store_batch(storages, spec.key, [item])
        created += made
        unchanged += same
        objects[item[0]] = item[1].raw_sha256
    return created, unchanged


def acquire_source(
    *,
    edition_key: str,
    bank_version: int,
    requested_scope: EditionScope | None,
    pass_number: int | None,
    source: FileSource | HttpSource,
    storages: Sequence[RawStorage],
    previous_cursor: Mapping[str, Any] | None,
    clock: Clock,
) -> tuple[StepOutcome, AcquisitionSnapshot]:
    """Acquire records and store the raw objects; see the module docstring.

    Idempotent: the same input stores nothing new. Resumable: ``previous_cursor`` holds the
    objects stored by earlier runs.
    """
    spec = edition_spec(edition_key)
    if not storages:
        raise InputError("at least one raw storage is required")
    stored_scope = (
        EditionScope.from_dict(previous_cursor["scope"])
        if previous_cursor and "scope" in previous_cursor
        else None
    )
    scope = _resolve_scope(spec, requested_scope, stored_scope)
    _check_pass(spec, pass_number)
    cursor: dict[str, Any] = {
        "kind": spec.kind,
        "scope": scope.to_dict(),
        "objects": dict((previous_cursor or {}).get("objects", {})),
        "sourceFiles": {
            k: list(v) for k, v in (previous_cursor or {}).get("sourceFiles", {}).items()
        },
    }
    if isinstance(source, FileSource):
        if spec.kind == "hadith":
            assert pass_number is not None
            other = cursor["sourceFiles"].get(str(3 - pass_number), [])
            if source.records.source_sha256 in other:
                raise PreconditionError(
                    "this records file was already used for the other pass; the two hadith passes "
                    "must be independent acquisitions"
                )
        items = _objects_from_file(spec, bank_version, scope, pass_number, source.records)
        created, unchanged = _store_batch(storages, edition_key, items)
        for name, obj in items:
            cursor["objects"][name] = obj.raw_sha256
        if spec.kind == "hadith":
            assert pass_number is not None
            files = cursor["sourceFiles"].setdefault(str(pass_number), [])
            if source.records.source_sha256 not in files:
                files.append(source.records.source_sha256)
    else:
        created, unchanged = _fetch_and_store(
            spec=spec,
            bank_version=bank_version,
            scope=scope,
            pass_number=pass_number,
            source=source,
            storages=storages,
            cursor=cursor,
            clock=clock,
        )

    snapshot = _snapshot(
        spec=spec,
        bank_version=bank_version,
        scope=scope,
        storage=storages[0],
        objects=cursor["objects"],
        created=created,
        unchanged=unchanged,
        now=clock(),
    )
    records_total = sum(len(o.record_ids) for o in snapshot.objects)
    counts = {
        "objects": len(snapshot.objects),
        "records": records_total,
        "created": created,
        "unchanged": unchanged,
    }
    if spec.kind == "quran":
        counts["surahs"] = len(scope.surahs) - len(snapshot.missing_surahs)
        counts["missing_surahs"] = len(snapshot.missing_surahs)
    else:
        counts["passes"] = len(snapshot.passes_present)
    summary = {
        "scope": scope.to_dict(),
        "complete": snapshot.complete,
        "counts": counts,
        "source": {
            "rawSha256": snapshot.source_raw_sha256,
            "retrievedAt": _iso(snapshot.source_retrieved_at)
            if snapshot.source_retrieved_at
            else None,
            "acquisition": snapshot.source_acquisition,
            "toolName": snapshot.tool_name,
        },
        "reviewRecordEntry": {
            "acquisition": {
                "who": _ACQUIRE_WHO,
                "at": _iso(snapshot.generated_at) if snapshot.generated_at else None,
                "sourceUrl": MCP_SOURCE_URL,
                "recordIds": [rid for o in snapshot.objects for rid in o.record_ids],
            }
        },
    }
    digest = sha256_hex(canonical_json({"scope": scope.to_dict(), "objects": cursor["objects"]}))
    outcome = StepOutcome(
        status="succeeded" if snapshot.complete else "running",
        cursor=cursor,
        summary=summary,
        digest=digest,
        counts=counts,
    )
    return outcome, snapshot


def _snapshot(
    *,
    spec: EditionSpec,
    bank_version: int,
    scope: EditionScope,
    storage: RawStorage,
    objects: Mapping[str, str],
    created: int,
    unchanged: int,
    now: datetime,
) -> AcquisitionSnapshot:
    infos: list[ObjectInfo] = []
    present_surahs: set[int] = set()
    for name in sorted(objects):
        obj = RawObject.from_bytes(storage.read_raw(spec.key, name))
        if spec.kind == "quran":
            present_surahs.add(int(obj.arguments["surah"]))
            ids = tuple(f"{r.surah}:{r.ayah}" for r in obj.quran_records())
        else:
            ids = tuple(f"forty:{r.forty_number}#{r.hadeethenc_id}" for r in obj.hadith_records())
        infos.append(
            ObjectInfo(
                name=name,
                pass_number=obj.pass_number,
                record_ids=ids,
                raw_sha256=obj.raw_sha256,
                retrieved_at=obj.retrieved_at,
                acquisition=obj.acquisition,
                canonical_url=obj.canonical_url,
            )
        )
    lines = "".join(f"{name}\t{sha}\n" for name, sha in sorted(objects.items()))
    missing = tuple(missing_surahs(present_surahs, scope.surahs)) if spec.kind == "quran" else ()
    passes = (
        tuple(sorted({i.pass_number for i in infos if i.pass_number}))
        if spec.kind == "hadith"
        else ()
    )
    complete = not missing if spec.kind == "quran" else set(passes) == {1, 2}
    primary = next((i for i in infos if i.pass_number in (None, 1)), infos[0] if infos else None)
    return AcquisitionSnapshot(
        edition_key=spec.key,
        bank_version=bank_version,
        scope=scope,
        complete=complete,
        objects=tuple(infos),
        created=created,
        unchanged=unchanged,
        missing_surahs=missing,
        passes_present=passes,
        source_raw_sha256=sha256_hex(lines.encode("utf-8")),
        source_retrieved_at=max((i.retrieved_at for i in infos), default=None),
        source_acquisition=primary.acquisition if primary else "",
        tool_name=spec.tool_name,
        generated_at=now,
    )


def make_acquire_handler(
    *,
    edition_key: str,
    bank_version: int,
    requested_scope: EditionScope | None,
    pass_number: int | None,
    source: FileSource | HttpSource,
    storages: Sequence[RawStorage],
    paths: BuildPaths,
    clock: Clock,
) -> StepHandler:
    """Runner handler for the ``acquired`` step (writes the acquisition report)."""

    def handler(job: ContentJob) -> StepOutcome:
        outcome, snapshot = acquire_source(
            edition_key=edition_key,
            bank_version=bank_version,
            requested_scope=requested_scope,
            pass_number=pass_number,
            source=source,
            storages=storages,
            previous_cursor=job.cursor,
            clock=clock,
        )
        write_acquisition_report(paths, snapshot)
        return outcome

    return handler


# --- verify --------------------------------------------------------------------------------


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def _first_difference(a: str, b: str) -> int:
    for index, (x, y) in enumerate(zip(a, b, strict=False)):
        if x != y:
            return index
    return min(len(a), len(b))


def _compare_nfc(raw: str, other: str) -> tuple[bool, str]:
    a, b = _nfc(raw), _nfc(other)
    if a == b:
        return True, "equal after NFC"
    index = _first_difference(a, b)
    return False, f"differs: first difference at index {index}; lengths {len(a)} and {len(b)}"


def _compare_bytes(raw: str, other: str) -> tuple[bool, str]:
    a, b = raw.encode("utf-8"), other.encode("utf-8")
    if a == b:
        return True, "byte-for-byte equal"
    return (
        False,
        f"bytes differ: first difference at byte {_first_difference(a.hex(), b.hex()) // 2}",
    )


def _record(method: str, ref: str, outcome: tuple[bool, str]) -> VerificationRecord:
    ok, details = outcome
    return VerificationRecord(
        method=method, result="passed" if ok else "failed", details=details, unit_ref=ref
    )


def _read_object(storage: RawStorage, edition_key: str, name: str) -> RawObject:
    return RawObject.from_bytes(storage.read_raw(edition_key, name))


def _verify_quran(
    *,
    bank_version: int,
    scope: EditionScope,
    storage: RawStorage,
    oracle: Mapping[tuple[int, int], str],
    client: McpJsonRpcClient | None,
    edition_key: str,
) -> list[VerificationRecord]:
    units: list[VerificationRecord] = []
    for surah in scope.surahs:
        obj = _read_object(storage, edition_key, quran_object_name(bank_version, surah))
        by_ayah = {r.ayah: r for r in obj.quran_records()}
        fetched: dict[int, QuranRecord] = {}
        if client is not None:
            fetched = {r.ayah: r for r in client.fetch_quran_surah(surah)}
        for ayah in range(1, QURAN_AYAH_COUNTS[surah] + 1):
            ref = f"{surah}:{ayah}"
            record = by_ayah.get(ayah)
            expected = oracle.get((surah, ayah))
            if record is None:
                units.append(_record("nfc_equality_vs_oracle", ref, (False, "no raw record")))
                continue
            if expected is None:
                units.append(
                    _record("nfc_equality_vs_oracle", ref, (False, "the oracle has no entry"))
                )
            else:
                units.append(
                    _record(
                        "nfc_equality_vs_oracle",
                        ref,
                        _compare_nfc(record.text, strip_trailing_ayah_number(expected)),
                    )
                )
            if client is not None:
                other = fetched.get(ayah)
                units.append(
                    _record(
                        "http_byte_diff",
                        ref,
                        (False, "the HTTP answer has no such ayah")
                        if other is None
                        else _compare_bytes(record.text, other.text),
                    )
                )
    return units


def hadith_pass_records(
    storage: RawStorage, edition_key: str, bank_version: int, pass_number: int
) -> dict[int, HadithRecord]:
    records: dict[int, HadithRecord] = {}
    for name in storage.list_raw(edition_key):
        match = _HADITH_NAME_RE.match(name)
        if match and (int(match.group(1)), int(match.group(2))) == (bank_version, pass_number):
            for record in _read_object(storage, edition_key, name).hadith_records():
                records[record.forty_number] = record
    return records


def _skeleton_flag(number: int, record: HadithRecord, reference: str) -> dict[str, Any] | None:
    ref_skeleton, own = letter_skeleton(reference), letter_skeleton(record.narration)
    if ref_skeleton == own:
        return None
    matcher = difflib.SequenceMatcher(None, ref_skeleton, own, autojunk=False)
    omitted = added = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag in ("delete", "replace"):
            omitted += i2 - i1
        if tag in ("insert", "replace"):
            added += j2 - j1
    return {
        "unit": f"forty:{number}:narration",
        "kind": "skeleton_difference",
        "details": (
            f"{omitted} reference letters omitted, {added} letters added "
            f"(similarity {matcher.ratio():.3f}); review only, not a mismatch"
        ),
    }


def _verify_hadith(
    *,
    bank_version: int,
    scope: EditionScope,
    storage: RawStorage,
    skeleton: Mapping[int, str] | None,
    client: McpJsonRpcClient | None,
    edition_key: str,
) -> tuple[list[VerificationRecord], list[Gap], list[dict[str, Any]]]:
    pass1 = hadith_pass_records(storage, edition_key, bank_version, 1)
    pass2 = hadith_pass_records(storage, edition_key, bank_version, 2)
    gaps = hadith_gaps(pass1, pass2, scope.forty_numbers)
    gap_numbers = {g.forty_number for g in gaps}
    units: list[VerificationRecord] = []
    suspected: list[dict[str, Any]] = []
    for number in scope.forty_numbers:
        if number in gap_numbers:
            continue
        r1, r2 = pass1[number], pass2[number]
        method = "two_pass_nfc_equality"
        same_identity = (r1.hadeethenc_id, r1.url) == (r2.hadeethenc_id, r2.url)
        units.append(
            _record(
                method,
                f"forty:{number}:identity",
                (
                    same_identity,
                    "same id and URL in both passes" if same_identity else "id or URL differs",
                ),
            )
        )
        for field_name, label in (
            ("narration", "narration"),
            ("narrator", "takhrij"),
            ("grade", "grade"),
        ):
            units.append(
                _record(
                    method,
                    f"forty:{number}:{label}",
                    _compare_nfc(getattr(r1, field_name), getattr(r2, field_name)),
                )
            )
        if skeleton is not None and number in skeleton:
            flag = _skeleton_flag(number, r1, skeleton[number])
            if flag:
                suspected.append(flag)
        if client is not None:
            other = client.fetch_hadith(r1.hadeethenc_id, number)
            for field_name, label in (
                ("narration", "narration"),
                ("narrator", "takhrij"),
                ("grade", "grade"),
            ):
                ok1, d1 = _compare_bytes(getattr(r1, field_name), getattr(other, field_name))
                ok2, d2 = _compare_bytes(getattr(r2, field_name), getattr(other, field_name))
                units.append(
                    _record(
                        "http_byte_diff",
                        f"forty:{number}:{label}",
                        (ok1 and ok2, d1 if not ok1 else d2 if not ok2 else d1),
                    )
                )
    return units, gaps, suspected


# --- source-only mode (D83 and D95) ---------------------------------------------------------


def _records_payload_sha256(records: Sequence[QuranRecord]) -> str:
    """The ``rawSha256`` that a raw object holding exactly these records would have."""
    ordered = sorted(records, key=lambda r: r.ayah)
    return sha256_hex(canonical_json({"records": [r.model_dump(by_alias=True) for r in ordered]}))


def _compare_source_only(raw: str, other: str) -> tuple[bool, str]:
    """Byte identity and NFC equality (D83); the details hold positions only, never text."""
    same_bytes, bytes_details = _compare_bytes(raw, other)
    same_nfc = _nfc(raw) == _nfc(other)
    if same_bytes and same_nfc:
        return True, "byte-for-byte equal; equal after NFC"
    state = "equal" if same_nfc else "different"
    return False, f"{bytes_details}; after NFC the texts are {state}"


def _verify_quran_source_only(
    *,
    bank_version: int,
    scope: EditionScope,
    storage: RawStorage,
    client: McpJsonRpcClient,
    edition_key: str,
    decision: str,
    clock: Clock,
) -> tuple[list[VerificationRecord], list[dict[str, Any]]]:
    """Compare each stored HTTP acquisition with a fresh HTTP re-acquisition of the same surah."""
    stored = {
        quran_object_name(bank_version, surah): _read_object(
            storage, edition_key, quran_object_name(bank_version, surah)
        )
        for surah in scope.surahs
    }
    source_only.assert_http_acquired(stored, decision=decision)  # before any request is made
    units: list[VerificationRecord] = []
    entries: list[dict[str, Any]] = []
    method = "source_only_http_reacquisition"
    for surah in scope.surahs:
        name = quran_object_name(bank_version, surah)
        obj = stored[name]
        by_ayah = {r.ayah: r for r in obj.quran_records()}
        retrieved_at = clock()
        fetched = client.fetch_quran_surah(surah)
        by_fetched = {r.ayah: r for r in fetched}
        for ayah in sorted(set(range(1, QURAN_AYAH_COUNTS[surah] + 1)) | set(by_fetched)):
            ref = f"{surah}:{ayah}"
            record, other = by_ayah.get(ayah), by_fetched.get(ayah)
            if record is None:
                outcome = (False, "no raw record")
            elif other is None:
                outcome = (False, "the HTTP answer has no such ayah")
            else:
                outcome = _compare_source_only(record.text, other.text)
            units.append(_record(method, ref, outcome))
        reacquired_sha = _records_payload_sha256(fetched)
        entries.append(source_only.acquisition_entry("stored", name, obj))
        entries.append(
            {
                "role": "reacquired",
                "object": name,
                "acquisition": "http",
                "rawSha256": reacquired_sha,
                "retrievedAt": _iso(retrieved_at),
                "equalToStored": reacquired_sha == obj.raw_sha256,
            }
        )
    return units, entries


def _verify_hadith_source_only(
    *,
    bank_version: int,
    scope: EditionScope,
    storage: RawStorage,
    client: McpJsonRpcClient | None,
    edition_key: str,
) -> tuple[list[VerificationRecord], list[Gap], list[dict[str, Any]], dict[str, Any]]:
    """Pass 1 against pass 2 after NFC (D83); both passes must be HTTP acquisitions of the
    record named by the decision. The byte comparison of the passes is recorded as information."""
    stored: dict[str, RawObject] = {}
    entries: list[dict[str, Any]] = []
    for pass_number in (1, 2):
        for number in scope.forty_numbers:
            name = hadith_object_name(bank_version, pass_number, number)
            if storage.exists(edition_key, name):
                stored[name] = _read_object(storage, edition_key, name)
                entries.append(
                    source_only.acquisition_entry(f"pass{pass_number}", name, stored[name])
                )
    source_only.assert_http_acquired(stored)
    pass1 = hadith_pass_records(storage, edition_key, bank_version, 1)
    pass2 = hadith_pass_records(storage, edition_key, bank_version, 2)
    source_only.assert_hadith_ids(pass1)
    source_only.assert_hadith_ids(pass2)
    units, gaps, suspected = _verify_hadith(
        bank_version=bank_version,
        scope=scope,
        storage=storage,
        skeleton=None,
        client=client,
        edition_key=edition_key,
    )
    identical: dict[str, dict[str, bool]] = {}
    for number in scope.forty_numbers:
        if number in pass1 and number in pass2:
            first, second = pass1[number], pass2[number]
            identical[f"forty:{number}"] = {
                label: getattr(first, field_name) == getattr(second, field_name)
                for field_name, label in (
                    ("narration", "narration"),
                    ("narrator", "takhrij"),
                    ("grade", "grade"),
                )
            }
    return units, gaps, suspected, {"acquisitions": entries, "passesByteIdentical": identical}


def verify_verbatim(
    *,
    edition_key: str,
    bank_version: int,
    scope: EditionScope,
    storage: RawStorage,
    oracle: Mapping[tuple[int, int], str] | None = None,
    skeleton: Mapping[int, str] | None = None,
    recheck_client: McpJsonRpcClient | None = None,
    source_only_decision: str | None = None,
    clock: Clock,
) -> VerificationOutcome:
    """Run the verbatim checks of contract §2.7 and return per-unit records (no exception for
    mismatches: the caller decides). Quran: NFC equality with the oracle for every ayah of the
    scope. Hadith: pass 1 equals pass 2 after NFC; optional letter-skeleton review flags;
    optional HTTP re-acquisition compared byte for byte.

    With ``source_only_decision`` (D83 or D95) the oracle and the skeleton are not used: for
    exactly the scope of that decision, two HTTP acquisitions from the service itself are
    compared instead
    (Quran: the stored one against a re-acquisition made here, byte for byte; hadith: pass 1
    against pass 2 after NFC). Any other scope is refused."""
    spec = edition_spec(edition_key)
    gaps: list[Gap] = []
    suspected: list[dict[str, Any]] = []
    evidence: dict[str, Any] = {}
    acquisitions = 0
    if source_only_decision is not None:
        source_only.require_decision(source_only_decision)
        if oracle is not None or skeleton is not None:
            raise InputError(
                "the source-only decision replaces the oracle and the skeleton: pass neither"
            )
        source_only.assert_scope(edition_key, bank_version, scope, decision=source_only_decision)
    if spec.kind == "quran":
        if source_only_decision is not None:
            if recheck_client is None:
                raise InputError(
                    "the source-only decision needs the HTTP re-acquisition (--http-recheck)"
                )
            units, entries = _verify_quran_source_only(
                bank_version=bank_version,
                scope=scope,
                storage=storage,
                client=recheck_client,
                edition_key=edition_key,
                decision=source_only_decision,
                clock=clock,
            )
            method = source_only.method_name(
                "http_reacquisition_byte_equality", decision=source_only_decision
            )
            evidence = {
                "acquisitions": entries,
                "priorEvidence": dict(source_only.prior_evidence(source_only_decision)),
            }
            acquisitions = 2
        else:
            if oracle is None:
                raise InputError("the Quran edition needs an oracle file (--oracle)")
            units = _verify_quran(
                bank_version=bank_version,
                scope=scope,
                storage=storage,
                oracle=oracle,
                client=recheck_client,
                edition_key=edition_key,
            )
            method = "nfc_equality_vs_oracle"
    elif source_only_decision is not None:
        units, gaps, suspected, evidence = _verify_hadith_source_only(
            bank_version=bank_version,
            scope=scope,
            storage=storage,
            client=recheck_client,
            edition_key=edition_key,
        )
        method = source_only.method_name(
            "two_pass_nfc_equality" + ("+http_byte_diff" if recheck_client is not None else ""),
            decision=source_only_decision,
        )
        acquisitions = 2 + (1 if recheck_client is not None else 0)
    else:
        units, gaps, suspected = _verify_hadith(
            bank_version=bank_version,
            scope=scope,
            storage=storage,
            skeleton=skeleton,
            client=recheck_client,
            edition_key=edition_key,
        )
        method = "two_pass_nfc_equality"
        if skeleton is not None:
            method += "+letter_skeleton_flag"
    if recheck_client is not None and source_only_decision is None:
        method += "+http_byte_diff"

    refs = {u.unit_ref for u in units}
    failed = {u.unit_ref for u in units if u.result == "failed"}
    nothing_verified = not refs
    counts = {
        "units": len(refs),
        "passed": len(refs - failed),
        "failed": len(failed),
        "gaps": len(gaps),
        "flagged": len(suspected),
    }
    if source_only_decision is not None:
        counts["acquisitions"] = acquisitions
    passed = not failed and not nothing_verified
    details = (
        f"{counts['passed']} of {counts['units']} units passed; "
        f"{counts['gaps']} documented gap(s); {counts['flagged']} unit(s) flagged for review"
    )
    if nothing_verified:
        details = "no unit could be verified (every hadith is a gap)"
    outcome = VerificationOutcome(
        edition_key=edition_key,
        bank_version=bank_version,
        scope=scope,
        source=VerificationRecord(
            method=method, result="passed" if passed else "failed", details=details
        ),
        units=units,
        gaps=gaps,
        suspected=suspected,
        counts=counts,
        generated_at=clock(),
        decision=source_only_decision,
        evidence=evidence,
    )
    digest_input: dict[str, Any] = {
        "scope": scope.to_dict(),
        "method": method,
        "units": [[u.unit_ref, u.method, u.result] for u in units],
        "gaps": [g.to_dict() for g in gaps],
        "flagged": [s["unit"] for s in suspected],
    }
    if source_only_decision is not None:
        digest_input["decision"] = source_only_decision
    outcome.digest = sha256_hex(canonical_json(digest_input))
    return outcome


def verification_summary(outcome: VerificationOutcome) -> dict[str, Any]:
    """The first part of ``content_jobs.validation_summary`` (text-free)."""
    when = _iso(outcome.generated_at) if outcome.generated_at else None
    summary: dict[str, Any] = {
        "scope": outcome.scope.to_dict(),
        "verification": outcome.source.model_dump(mode="json", exclude={"unit_ref"}),
        "counts": outcome.counts,
        "gaps": [g.to_dict() for g in outcome.gaps],
        "suspectedErrors": outcome.suspected,
        "blockedUnits": outcome.failed_refs()[:100],
        "reviewRecordEntry": {
            "verification": {
                "who": _VERIFY_WHO,
                "at": when,
                "method": outcome.source.method,
                "result": outcome.source.result,
                "differences": outcome.failed_refs()[:100],
            }
        },
    }
    if outcome.decision is not None:
        summary["sourceOnly"] = {"decision": outcome.decision, **outcome.evidence}
        summary["reviewRecordEntry"]["verification"]["decision"] = outcome.decision
    return summary


def make_verify_handler(
    *,
    edition_key: str,
    bank_version: int,
    jobs: JobRepository,
    storage: RawStorage,
    paths: BuildPaths,
    oracle_path: Path | None,
    skeleton_path: Path | None,
    recheck_client: McpJsonRpcClient | None,
    source_only_decision: str | None = None,
    clock: Clock,
) -> StepHandler:
    """Runner handler for the ``verified`` step. Reports are written whether or not the
    verification passes; a failure blocks the affected units and raises
    ``VerificationFailedError`` (the step is recorded ``failed`` and the edition stays draft).

    With ``source_only_decision`` (D83) the oracle and skeleton files are refused and the
    verification compares two HTTP acquisitions of the service instead."""
    spec = edition_spec(edition_key)

    def handler(job: ContentJob) -> StepOutcome:
        acquired = jobs.get_job(edition_key, bank_version, "acquired")
        if acquired is None or not acquired.cursor or "scope" not in acquired.cursor:
            raise ObjectNotFoundError("the acquisition record of this build is missing")
        scope = EditionScope.from_dict(acquired.cursor["scope"])
        if source_only_decision is not None:
            if oracle_path is not None or skeleton_path is not None:
                raise InputError(
                    "the source-only decision replaces the oracle and the skeleton: pass neither"
                )
            oracle, skeleton = None, None
        elif spec.kind == "quran":
            if oracle_path is None:
                raise InputError("the Quran edition needs an oracle file (--oracle)")
            if skeleton_path is not None:
                raise InputError("--skeleton applies to the hadith edition only")
            oracle, skeleton = load_oracle(oracle_path), None
        else:
            if oracle_path is not None:
                raise InputError("--oracle applies to the Quran edition only")
            oracle = None
            skeleton = load_skeleton(skeleton_path) if skeleton_path is not None else None
        outcome = verify_verbatim(
            edition_key=edition_key,
            bank_version=bank_version,
            scope=scope,
            storage=storage,
            oracle=oracle,
            skeleton=skeleton,
            recheck_client=recheck_client,
            source_only_decision=source_only_decision,
            clock=clock,
        )
        write_verification_files(paths, outcome)
        summary = verification_summary(outcome)
        cursor = {"scope": scope.to_dict(), "unitsChecked": outcome.counts["units"]}
        if outcome.result == "failed":
            blocked = len(outcome.failed_refs())
            raise VerificationFailedError(
                f"verification failed: {blocked} unit(s) blocked "
                f"(see {paths.verification_report(edition_key).name})",
                cursor={**cursor, "blockedUnits": outcome.failed_refs()[:100]},
                summary=summary,
            )
        return StepOutcome(
            "succeeded",
            cursor=cursor,
            summary=summary,
            digest=outcome.digest,
            counts=outcome.counts,
        )

    return handler
