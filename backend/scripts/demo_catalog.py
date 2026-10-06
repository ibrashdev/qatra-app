"""Synthetic edition-size profiles shared by the demo tooling (WP-B).

The published sample is tiny (one 15-word surah and one hadith), so the precomputed simulations
(``make_demo_simulations``) and the Q6 comparison harness (``ai_comparison``) work on SYNTHETIC
editions: the sizes of ``model_probe.make_juz_amma`` and ``make_nawawi40`` (their word counts are
formulas, not the real ones), relabelled the way the real catalog labels sections (a Quran section
reference is the surah number, a hadith reference is ``nawawi40:<n>``; titles are the numeric
labels). Nothing here is sacred text and nothing is read from a database or the network.

Passages are cut by a fixed rule so the same input always gives the same ids:

- ``quran`` path: ``QURAN_PASSAGE_WORDS`` (12) words per passage;
- ``matn`` path: ``HADITH_PASSAGE_WORDS`` (25) words per passage;
- every other path (``sanad``, ``grade``): the section's words as one passage.

A passage of ``w`` words has ``ceil(w / PART_MAX)`` near-equal parts (``PART_MAX`` is the real
part size ceiling of ``app.workflow.passages``). Ids are ``uuid5`` of the edition key, section
ordinal, path and position, so they are stable across runs and machines.

The two editions carry keys that START WITH the keys of the real editions
(``quran-hafs-quranenc``, ``nawawi40-hadeethenc``), so a scenario fixture that selects an edition
by prefix resolves against them exactly as it would against the live catalog.
"""

from __future__ import annotations

import dataclasses
import math
import sys
import uuid
from collections.abc import Sequence
from pathlib import Path

if __package__ in (None, ""):  # started as ``python scripts/demo_catalog.py``
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.domain.plan_policy import (  # noqa: E402
    EditionData,
    PassageRow,
    canonical_paths,
)
from app.domain.session_policy import (  # noqa: E402
    REVIEW_QUESTION_CAP,
    PartInfo,
    PassageInfo,
    review_round_size,
)
from app.workflow.passages import PART_MAX  # noqa: E402
from scripts.model_probe import make_juz_amma, make_nawawi40  # noqa: E402

JUZ_AMMA = "juz_amma"
NAWAWI40 = "nawawi40"
JUZ_AMMA_KEY = "quran-hafs-quranenc-synthetic"
NAWAWI40_KEY = "nawawi40-hadeethenc-synthetic"

QURAN_PASSAGE_WORDS = 12
HADITH_PASSAGE_WORDS = 25
_NAMESPACE = uuid.UUID("5a0c6a46-0f3b-4f55-9f39-0d1d2c2b7e01")
_TARGET_WORDS = {"quran": QURAN_PASSAGE_WORDS, "matn": HADITH_PASSAGE_WORDS}


def _relabel(edition: EditionData, key: str, reference) -> EditionData:
    sections = tuple(
        dataclasses.replace(
            section,
            reference=reference(section),
            title_ar=reference(section),
            title_en=reference(section),
        )
        for section in edition.sections
    )
    return dataclasses.replace(edition, edition_key=key, sections=sections)


def harness_editions() -> dict[str, EditionData]:
    """The two synthetic editions, keyed ``juz_amma`` and ``nawawi40``."""
    juz = _relabel(make_juz_amma(), JUZ_AMMA_KEY, lambda s: str(s.ordinal))
    nawawi = _relabel(make_nawawi40(), NAWAWI40_KEY, lambda s: f"nawawi40:{s.ordinal}")
    return {JUZ_AMMA: juz, NAWAWI40: nawawi}


def edition_list() -> list[EditionData]:
    return list(harness_editions().values())


def _split(words: int, count: int) -> list[int]:
    base, extra = divmod(words, count)
    return [base + (1 if index < extra else 0) for index in range(count)]


def passage_reference(section_reference: str, position: int) -> str:
    """The synthetic reference of the ``position``-th (1-based) passage of a section."""
    return f"{section_reference}#{position}"


def passages_for(
    edition: EditionData, ordinals: Sequence[int], paths: Sequence[str]
) -> tuple[PassageInfo, ...]:
    """The passages of the sections ``ordinals`` for ``paths``, in book order."""
    selected = canonical_paths(paths)
    result: list[PassageInfo] = []
    running = dict.fromkeys(selected, 0)
    for ordinal in sorted(set(ordinals)):
        section = edition.section(ordinal)
        if section is None:
            continue
        for path in selected:
            words = section.path_words.get(path, 0)
            if words <= 0:
                continue
            target = _TARGET_WORDS.get(path, words)
            sizes = _split(words, max(1, math.ceil(words / target)))
            for position, size in enumerate(sizes, start=1):
                running[path] += 1
                base = f"{edition.edition_key}/{ordinal}/{path}/{position}"
                part_sizes = _split(size, max(1, math.ceil(size / PART_MAX)))
                parts = tuple(
                    PartInfo(
                        id=uuid.uuid5(_NAMESPACE, f"{base}/part/{number}"),
                        ordinal=number,
                        word_count=part_size,
                    )
                    for number, part_size in enumerate(part_sizes, start=1)
                )
                result.append(
                    PassageInfo(
                        id=uuid.uuid5(_NAMESPACE, base),
                        section_ordinal=ordinal,
                        path=path,
                        ordinal=running[path],
                        start=(position, 0),
                        word_count=size,
                        parts=parts,
                    )
                )
    return tuple(result)


def passage_rows(passages: Sequence[PassageInfo]) -> list[PassageRow]:
    """The ``PassageRow`` view that ``plan_policy.build_phases`` reads."""
    return [
        PassageRow(
            passage_id=p.id,
            section_ordinal=p.section_ordinal,
            path=p.path,
            ordinal=p.ordinal,
            words=p.word_count,
        )
        for p in passages
    ]


def passage_references(
    edition: EditionData, passages: Sequence[PassageInfo]
) -> dict[uuid.UUID, str]:
    """``{passage id: synthetic reference}`` (``<section reference>#<n>``, n per section)."""
    counters: dict[int, int] = {}
    references: dict[uuid.UUID, str] = {}
    for passage in passages:
        section = edition.section(passage.section_ordinal)
        if section is None:
            continue
        counters[passage.section_ordinal] = counters.get(passage.section_ordinal, 0) + 1
        references[passage.id] = passage_reference(
            section.reference, counters[passage.section_ordinal]
        )
    return references


def rounds_within_cap(order: Sequence[PassageInfo], minutes: int) -> list[PassageInfo]:
    """The passages whose review rounds fit one session, in the order given: whole rounds while
    the question total stays within ``REVIEW_QUESTION_CAP``; the first round that does not fit ends
    the step, so a later, smaller round never jumps the queue (``session_policy``)."""
    cap = REVIEW_QUESTION_CAP[minutes]
    used = 0
    chosen: list[PassageInfo] = []
    for passage in order:
        size = review_round_size(len(passage.parts))
        if used + size > cap:
            break
        used += size
        chosen.append(passage)
    return chosen


# --- the resolution rules of E27 (demo-decisions: edition and section resolution) ---------------


def resolve_edition(editions: Sequence[EditionData], prefixes: Sequence[str]) -> EditionData | None:
    """The edition whose key equals or starts with the FIRST matching prefix; among several
    matches the highest catalog version (then the latest key)."""
    for prefix in prefixes:
        matches = [
            e for e in editions if e.edition_key == prefix or e.edition_key.startswith(prefix)
        ]
        if matches:
            return max(matches, key=lambda e: (e.catalog_version, e.edition_key))
    return None


def resolve_section_ordinals(edition: EditionData, refs: Sequence[str]) -> tuple[int, ...]:
    """Ascending ordinals of the sections whose reference is in ``refs``; ``["*"]`` is all."""
    if list(refs) == ["*"]:
        return tuple(sorted(s.ordinal for s in edition.sections))
    wanted = set(refs)
    return tuple(sorted(s.ordinal for s in edition.sections if s.reference in wanted))
