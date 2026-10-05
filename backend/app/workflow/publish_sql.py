"""``publish.sql``: idempotent draft upserts of a bundle into the 0001 content tables
(contract §3.1, Database-schema §6.1, API-spec ``segment``). Generated text only: nothing here
is applied to any database in B7/B8, and the file contains source text, so it lives only under
the gitignored ``backend/.content-build/``.

Semantics (one transaction):

1. Guard: if the edition row exists and its status is not ``draft``, the script raises. A
   published or validated version is immutable (D44); a correction is a new version.
2. Upsert ``categories`` (by slug), ``sources``, ``books`` and ``book_editions`` (status
   ``draft``; ``validated``/``published`` are set by later steps), ``book_sections`` and
   ``units`` (by id), and delete sections and units that the bundle no longer has.
3. Replace the bank of this ``(edition, bank_version)``: delete its question items, lessons and
   passages (cascading parts and lesson units), then insert passages, parts, lessons, lesson
   units and question items from the bundle.
4. Upsert the ``content_jobs`` rows (by ``(edition_id, bank_version, step)``).

Running the script twice leaves the same rows. Lesson units are derived from the passage ranges
(one segment per unit overlapped, character offsets inside ``canonical_text``); a question's
``lesson_id`` is the lesson of its passage and its ``unit_id`` the unit of its first token.

``generate_final_publish_sql`` writes the publishing file of ``publish --sql-out``: the same
upserts (with the recorded license and the approval in the review record), then, in the same
transaction, the lessons and question items of the bank version become ``published`` (learners
read published items only), earlier published editions of the same book become ``superseded``,
the edition becomes ``published`` and the ``content_jobs`` rows are written, among them the
``approved`` and the ``published`` rows (``published_at = now()``). The file is text: the CLI
applies nothing.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, Final

from app.workflow.bundle import BUNDLE_VERSION
from app.workflow.bundle_index import BundleIndex, parse_ref
from app.workflow.errors import InputError
from app.workflow.jobs import PIPELINE_VERSION, job_id
from app.workflow.models import ContentJob

CHUNK: Final = 100
# first characters of the final publishing file: ``publish`` replaces only a file that has them
FINAL_MARKER: Final = "-- publish (final):"


def lit(value: str | None) -> str:
    """A SQL string literal (standard conforming strings); ``None`` is ``null``."""
    if value is None:
        return "null"
    if "\x00" in value:
        raise InputError("a value contains a NUL character and cannot be written as SQL")
    return "'" + value.replace("'", "''") + "'"


def js(value: Any) -> str:
    """A jsonb literal."""
    return (
        lit(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
        + "::jsonb"
    )


def uid(value: str) -> str:
    return lit(value) + "::uuid"


def _insert(
    table: str, columns: Sequence[str], rows: Sequence[Sequence[str]], conflict: str = ""
) -> list[str]:
    statements: list[str] = []
    for start in range(0, len(rows), CHUNK):
        chunk = rows[start : start + CHUNK]
        body = ",\n".join("  (" + ", ".join(row) + ")" for row in chunk)
        statements.append(
            f"insert into public.{table} ({', '.join(columns)}) values\n{body}{conflict};"
        )
    return statements


def _update_set(columns: Sequence[str]) -> str:
    return ", ".join(f"{c} = excluded.{c}" for c in columns)


def lesson_unit_segments(bundle: Mapping[str, Any]) -> list[tuple[str, int, int, int, int]]:
    """``(lesson id, ordinal, unit ordinal, start offset, end offset)`` for every lesson: one
    segment per unit the passage overlaps, covering its first to last token in that unit."""
    index = BundleIndex(bundle)
    lesson_of = {x["passageId"]: x["id"] for x in bundle["lessons"]}
    segments: list[tuple[str, int, int, int, int]] = []
    for passage in bundle["passages"]:
        lesson_id = lesson_of.get(passage["id"])
        if lesson_id is None:
            continue
        tokens = index.range_tokens(passage["startRef"], passage["endRef"]) or []
        by_unit: dict[int, list[Any]] = {}
        for tok in tokens:
            by_unit.setdefault(tok.ref[0], []).append(tok)
        for ordinal, (unit_ordinal, unit_tokens) in enumerate(by_unit.items(), start=1):
            unit = index.units[unit_ordinal]
            first = unit["tokens"][unit_tokens[0].ref[1]]
            last = unit["tokens"][unit_tokens[-1].ref[1]]
            segments.append((lesson_id, ordinal, unit_ordinal, first["s"], last["e"]))
    return segments


def _guard_lines(key: str) -> list[str]:
    """``begin`` and the guard: an edition that is no longer a draft is refused (D44)."""
    return [
        "begin;",
        "set local standard_conforming_strings = on;",
        "do $guard$ begin",
        "  if exists (select 1 from public.book_editions"
        f" where edition_key = {lit(key)} and status <> 'draft') then",
        "    raise exception 'edition % is not a draft: a validated or published version is"
        f" immutable', {lit(key)};",
        "  end if;",
        "end $guard$;",
    ]


def _content_lines(
    bundle: Mapping[str, Any], review: Mapping[str, Any], license_record: Mapping[str, Any]
) -> list[str]:
    """Upserts of the category, source, book, edition, sections and units, and the replacement
    of the bank (passages, parts, lessons, lesson units, question items)."""
    if bundle["bundleVersion"] != BUNDLE_VERSION:
        raise InputError("unsupported bundle version")
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    category, book = bundle["category"], bundle["book"]
    source, edition = bundle["source"], bundle["edition"]
    edition_id = edition["id"]
    unit_id = {u["ordinal"]: u["id"] for u in bundle["units"]}
    section_id = {s["ordinal"]: s["id"] for s in bundle["sections"]}
    lesson_of = {x["passageId"]: x["id"] for x in bundle["lessons"]}
    out: list[str] = []
    out += _insert(
        "categories",
        ("slug", "label_ar", "label_en"),
        [[lit(category["slug"]), lit(category["labelAr"]), lit(category["labelEn"])]],
        " on conflict (slug) do update set label_ar = excluded.label_ar,"
        " label_en = excluded.label_en",
    )
    eligibility = {
        "decision": "D68",
        "acquisition": source["acquisition"],
        "toolName": source["toolName"],
        "rawSha256": source["rawSha256"],
        "retrievedAt": source["retrievedAt"],
        "verification": source["verification"],
    }
    source_columns = (
        "id",
        "title",
        "provider",
        "source_url",
        "eligibility_record",
        "license_record",
        "rights_status",
    )
    out += _insert(
        "sources",
        source_columns,
        [
            [
                uid(source["id"]),
                lit(source["title"]),
                lit(source["provider"]),
                lit(source["sourceUrl"]),
                js(eligibility),
                js(license_record),
                lit(source["rightsStatus"]),
            ]
        ],
        f" on conflict (id) do update set {_update_set(source_columns[1:])}",
    )
    book_columns = ("id", "category_id", "title_ar", "title_en", "author", "content_format")
    out += _insert(
        "books",
        book_columns,
        [
            [
                uid(book["id"]),
                f"(select id from public.categories where slug = {lit(category['slug'])})",
                lit(book["titleAr"]),
                lit(book["titleEn"]),
                lit(book["author"]),
                lit(book["contentFormat"]),
            ]
        ],
        f" on conflict (id) do update set {_update_set(book_columns[1:])}",
    )
    edition_columns = (
        "id", "book_id", "source_id", "edition_key", "edition_label", "language", "version",
        "bank_version", "raw_storage_path", "content_hash", "pagination_record", "status",
        "review_record",
    )  # fmt: skip
    out += _insert(
        "book_editions",
        edition_columns,
        [
            [
                uid(edition_id),
                uid(book["id"]),
                uid(source["id"]),
                lit(key),
                lit(edition["editionLabel"]),
                lit(edition["language"]),
                str(int(edition["version"])),
                str(int(bank)),
                lit(f"{key}/raw/"),
                lit(edition["contentHash"]),
                js(edition["paginationRecord"]),
                "'draft'",
                js(review),
            ]
        ],
        f" on conflict (id) do update set {_update_set(edition_columns[1:])}",
    )
    # the bank of this version is replaced; stale sections and units are removed
    for table in ("question_items", "lessons", "passages"):
        out.append(
            f"delete from public.{table} where edition_id = {uid(edition_id)}"
            f" and bank_version = {bank};"
        )
    unit_ids = ", ".join(uid(u["id"]) for u in bundle["units"]) or "null::uuid"
    section_ids = ", ".join(uid(s["id"]) for s in bundle["sections"]) or "null::uuid"
    out.append(
        f"delete from public.units where edition_id = {uid(edition_id)} and id not in ({unit_ids});"
    )
    out.append(
        f"delete from public.book_sections where edition_id = {uid(edition_id)}"
        f" and id not in ({section_ids});"
    )
    section_columns = (
        "id",
        "edition_id",
        "ordinal",
        "kind",
        "reference",
        "title_ar",
        "title_en",
        "source_url",
    )
    out += _insert(
        "book_sections",
        section_columns,
        [
            [
                uid(s["id"]),
                uid(edition_id),
                str(int(s["ordinal"])),
                lit(s["kind"]),
                lit(s["reference"]),
                lit(s["titleAr"]),
                lit(s["titleEn"]),
                lit(s["sourceUrl"]),
            ]  # fmt: skip
            for s in bundle["sections"]
        ],
        f" on conflict (id) do update set {_update_set(section_columns[1:])}",
    )
    unit_columns = (
        "id", "edition_id", "section_id", "ordinal", "kind", "reference", "source_url",
        "canonical_text", "token_spans", "text_hash", "hadith_meta",
    )  # fmt: skip
    out += _insert(
        "units",
        unit_columns,
        [
            [
                uid(u["id"]),
                uid(edition_id),
                uid(section_id[u["sectionOrdinal"]]),
                str(int(u["ordinal"])),
                lit(u["kind"]),
                lit(u["reference"]),
                lit(u["sourceUrl"]),
                lit(u["canonicalText"]),
                js(u["tokens"]),
                lit(u["textHash"]),
                js(u["hadithMeta"]) if "hadithMeta" in u else "null",
            ]  # fmt: skip
            for u in bundle["units"]
        ],
        f" on conflict (id) do update set {_update_set(unit_columns[1:])}",
    )
    passage_columns = (
        "id", "edition_id", "bank_version", "section_id", "ordinal", "path", "start_ref",
        "end_ref", "word_count", "reference",
    )  # fmt: skip
    out += _insert(
        "passages",
        passage_columns,
        [
            [
                uid(p["id"]),
                uid(edition_id),
                str(int(bank)),
                uid(section_id[p["sectionOrdinal"]]),
                str(int(p["ordinal"])),
                lit(p["path"]),
                lit(p["startRef"]),
                lit(p["endRef"]),
                str(int(p["wordCount"])),
                lit(p["reference"]),
            ]  # fmt: skip
            for p in bundle["passages"]
        ],
    )
    out += _insert(
        "passage_parts",
        ("id", "passage_id", "edition_id", "ordinal", "start_ref", "end_ref", "word_count"),
        [
            [
                uid(part["id"]),
                uid(p["id"]),
                uid(edition_id),
                str(int(part["ordinal"])),
                lit(part["startRef"]),
                lit(part["endRef"]),
                str(int(part["wordCount"])),
            ]  # fmt: skip
            for p in bundle["passages"]
            for part in p["parts"]
        ],
    )
    out += _insert(
        "lessons",
        (
            "id",
            "edition_id",
            "bank_version",
            "passage_id",
            "ordinal",
            "duration_estimate_sec",
            "status",
        ),
        [
            [
                uid(x["id"]),
                uid(edition_id),
                str(int(bank)),
                uid(x["passageId"]),
                str(int(x["ordinal"])),
                str(int(x["durationEstimateSec"])),
                "'draft'",
            ]  # fmt: skip
            for x in bundle["lessons"]
        ],
    )
    out += _insert(
        "lesson_units",
        ("lesson_id", "ordinal", "edition_id", "unit_id", "start_offset", "end_offset"),
        [
            [
                uid(lesson_id),
                str(int(ordinal)),
                uid(edition_id),
                uid(unit_id[unit]),
                str(int(start)),
                str(int(end)),
            ]
            for lesson_id, ordinal, unit, start, end in lesson_unit_segments(bundle)
        ],
    )
    question_rows = []
    for q in bundle["questions"]:
        anchor = parse_ref(q["tokenRefs"][0])
        assert anchor is not None
        question_rows.append(
            [
                uid(q["id"]),
                uid(edition_id),
                str(int(bank)),
                uid(q["passageId"]),
                uid(lesson_of[q["passageId"]]) if q["passageId"] in lesson_of else "null",
                uid(unit_id[anchor[0]]),
                lit(q["type"]),
                lit(q["variant"]),
                "array[" + ", ".join(uid(p) for p in q["coveredPartIds"]) + "]::uuid[]",
                js(q["tokenRefs"]),
                js(q["optionRefs"]) if q["optionRefs"] is not None else "null",
                js(q["correctRef"]),
                js(q["contextRefs"]),
                lit(q["reference"]),
                "'draft'",
                "'{}'::jsonb",
            ]  # fmt: skip
        )
    out += _insert(
        "question_items",
        (
            "id",
            "edition_id",
            "bank_version",
            "passage_id",
            "lesson_id",
            "unit_id",
            "type",
            "variant",
            "covered_part_ids",
            "token_refs",
            "option_refs",
            "correct_ref",
            "context_refs",
            "reference",
            "status",
            "validation_record",
        ),  # fmt: skip
        question_rows,
    )
    return out


def _job_lines(
    bundle: Mapping[str, Any],
    jobs: Sequence[ContentJob],
    *,
    published_summary: Mapping[str, Any] | None = None,
) -> list[str]:
    """Upsert of the ``content_jobs`` rows. With ``published_summary`` (the final file) the
    ``published_at`` column is written too: ``now()`` for the ``published`` row, which is added
    here, and null for every other row. Without it the statement is the draft one."""
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    edition_id = bundle["edition"]["id"]
    job_columns: tuple[str, ...] = (
        "id",
        "edition_id",
        "bank_version",
        "pipeline_version",
        "step",
        "cursor",
        "status",
        "validation_summary",
    )
    rows = [
        [
            uid(str(job.id)),
            uid(edition_id),
            str(int(bank)),
            lit(job.pipeline_version),
            lit(job.step),
            js(job.cursor) if job.cursor is not None else "null",
            lit(job.status),
            js(job.validation_summary) if job.validation_summary is not None else "null",
        ]  # fmt: skip
        for job in jobs
    ]
    conflict = (
        " on conflict (edition_id, bank_version, step) do update set"
        " pipeline_version = excluded.pipeline_version, cursor = excluded.cursor,"
        " status = excluded.status, validation_summary = excluded.validation_summary"
    )
    if published_summary is not None:
        if any(job.step == "published" for job in jobs):
            raise InputError("the job rows must not hold the 'published' step; it is added here")
        job_columns = (*job_columns, "published_at")
        rows = [[*row, "null"] for row in rows]
        rows.append(
            [
                uid(str(job_id(key, bank, "published"))),
                uid(edition_id),
                str(int(bank)),
                lit(PIPELINE_VERSION),
                "'published'",
                "null",
                "'succeeded'",
                js(published_summary),
                "now()",
            ]
        )
        conflict += ", published_at = excluded.published_at"
    return _insert("content_jobs", job_columns, rows, conflict)


def _publication_lines(bundle: Mapping[str, Any]) -> list[str]:
    """The publishing statements of the final file, run after the upserts in the same
    transaction: the lessons and question items of this bank version become ``published``
    (learners read only published items), earlier published editions of the same book become
    ``superseded`` and the edition itself becomes ``published``. The edition's review record
    already holds the approval (the 0001 check needs it for a published status)."""
    bank = int(bundle["bankVersion"])
    edition_id = uid(bundle["edition"]["id"])
    book_id = uid(bundle["book"]["id"])
    return [
        "update public.lessons set status = 'published'"
        f" where edition_id = {edition_id} and bank_version = {bank};",
        "update public.question_items set status = 'published'"
        f" where edition_id = {edition_id} and bank_version = {bank};",
        # the same book: the same row, or a row of the same category, title and author
        "update public.book_editions as earlier set status = 'superseded'"
        " from public.books as earlier_book, public.books as this_book"
        f" where this_book.id = {book_id}"
        " and earlier_book.category_id = this_book.category_id"
        " and earlier_book.title_ar = this_book.title_ar"
        " and earlier_book.author = this_book.author"
        " and earlier.book_id = earlier_book.id"
        " and earlier.status = 'published'"
        f" and earlier.id <> {edition_id};",
        f"update public.book_editions set status = 'published' where id = {edition_id};",
    ]


def generate_publish_sql(
    bundle: Mapping[str, Any],
    jobs: Sequence[ContentJob],
    *,
    review_entries: Mapping[str, Any] | None = None,
) -> str:
    """The text of ``publish.sql`` for ``bundle`` and the given job rows.

    ``review_entries`` carries the ``acquisition`` / ``verification`` entries of
    ``book_editions.review_record`` taken from the job summaries (A-12).
    """
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    review = {**bundle["edition"]["reviewRecord"], **(review_entries or {})}
    out = [
        f"-- publish.sql: idempotent DRAFT upserts of edition {key}, bank version {bank}.",
        "-- Generated by the content workflow. Contains source text: never commit it.",
        "-- Safe to run twice. Refuses an edition that is no longer a draft (D44).",
        *_guard_lines(key),
        *_content_lines(bundle, review, bundle["source"]["licenseRecord"]),
        *_job_lines(bundle, jobs),
        "commit;",
    ]
    return "\n".join(out) + "\n"


def generate_final_publish_sql(
    bundle: Mapping[str, Any],
    jobs: Sequence[ContentJob],
    *,
    review_entries: Mapping[str, Any],
    license_record: Mapping[str, Any],
    published_summary: Mapping[str, Any],
) -> str:
    """ONE transaction that publishes the edition: the draft upserts (with the recorded license
    and the approval in the review record), the publishing statements and the job rows, among
    them the ``approved`` and the ``published`` rows with ``published_at``.

    The file applies nothing by itself. Applied once, it publishes; applied again it raises at
    the guard (the edition is then published and immutable, D44). ``jobs`` are the rows recorded
    locally (acquired to approved); the ``published`` row is added from ``published_summary``.
    """
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    review = {**bundle["edition"]["reviewRecord"], **review_entries}
    out = [
        f"{FINAL_MARKER} ONE transaction that publishes edition {key}, bank version {bank}.",
        "-- Generated by the content workflow; the CLI applied nothing. Contains source text:",
        "-- never commit it. Apply once with service_role. A second application raises at the",
        "-- guard because the edition is then published and immutable (D44).",
        *_guard_lines(key),
        *_content_lines(bundle, review, license_record),
        *_publication_lines(bundle),
        *_job_lines(bundle, jobs, published_summary=published_summary),
        "commit;",
    ]
    return "\n".join(out) + "\n"
