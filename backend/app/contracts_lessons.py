"""DTOs of the lessons reader: ``GET /api/lessons`` and ``GET /api/lessons/{sectionId}`` (D92, owner
approval of 5 Oct 2026: a session without games that only shows the verses or hadiths of the
learner's own plan, read only).

Pure pydantic, like ``contracts_sessions``, whose ``PassageView`` the detail reuses so that the
reader shows exactly the text a learn step shows. JSON names are camelCase. The reader never
returns a question, an answer key or a game: it is text and its source only.

``sectionId`` is the ordinal of the section in the plan's edition (the number the plan's scope
lists as ``targetScope.sectionOrdinals``); there is no other section identifier in the bank. It is
meaningful only together with the learner's active plan, which decides the edition.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from app.contracts_plan_chat import CamelModel
from app.contracts_sessions import PassageView

LessonKind = Literal["surah", "hadith"]


class LessonSection(CamelModel):
    """One card of the list: a surah or a hadith of the plan's scope."""

    section_id: int
    kind: LessonKind
    reference_ar: str
    passage_count: int  # the passages of this section on the plan's selected paths


class LessonsResponse(CamelModel):
    """The sections of the active plan's scope in the plan's order (``book`` or ``reverse``).

    ``planId`` and ``planVersion`` are the active plan's, so a client that credits reading time
    can open today's daily session (E20) without a second read.
    """

    plan_id: UUID
    plan_version: int
    sections: list[LessonSection]


class LessonSectionDetail(CamelModel):
    """The text of one section: its in-scope passages in book order, verbatim."""

    section_id: int
    kind: LessonKind
    reference_ar: str
    book_title_ar: str
    source_url: str
    passages: list[PassageView]
