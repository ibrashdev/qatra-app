"""The lessons reader: ``GET /api/lessons`` and ``GET /api/lessons/{sectionId}`` (D90, owner
approval of 5 Oct 2026: a session without games that only shows the verses or hadiths of the
learner's own plan, read only).

Pure reads, like E18 and E19: nothing is created, recorded or graded here. The scope is the one the
learner's **active** plan has in force today (``PlanDirectory``, the port E18 and E19 use): its
sections, its selected paths and its order. A section outside that scope does not exist for the
reader (``404 not_found``), and so does everything of an account without an active plan (``409
version_conflict`` with ``details.reason = "plan_not_active"``, the answer E20 gives a plan that
cannot take a session).

The text is the one a learn step shows: ``read_passage_views`` builds every passage with the same
builder as the session's learn step, so the verses and hadiths are verbatim and the reference, the
takhrij, the grade and the source line are identical. Reading time is not credited here: the
client sends activity events (E21) to today's daily session, so the daily goal counts it like any
other verified active time (D40).
"""

from __future__ import annotations

from app.contracts_lessons import (
    LessonKind,
    LessonSection,
    LessonSectionDetail,
    LessonsResponse,
)
from app.dependencies import SessionContext
from app.domain.session_policy import plan_order
from app.errors import AppError, ErrorCode
from app.repositories.bank import BankPassage, BankRepository, EditionInfo
from app.services.progress import PlanDirectory
from app.services.sessions import PlanSnapshot, read_passage_views, section_reference_ar


def _in_order(passages: list[BankPassage], order: str) -> list[BankPassage]:
    """The passages in the plan's order (sections by ordinal, ascending or descending; inside a
    section in book order)."""
    by_id = {passage.id: passage for passage in passages}
    return [by_id[info.id] for info in plan_order((p.info() for p in passages), order)]


def _kind_of(edition: EditionInfo) -> LessonKind:
    return "surah" if edition.content_format == "quran" else "hadith"


class LessonService:
    def __init__(self, *, bank: BankRepository, plans: PlanDirectory) -> None:
        self._bank = bank
        self._plans = plans

    def list_sections(self, ctx: SessionContext) -> LessonsResponse:
        """The sections of the active plan's scope, in the plan's order, each with the number of its
        passages on the selected paths. A section without a passage on those paths is not listed
        (there would be nothing to read)."""
        plan = self._active_plan(ctx)
        edition = self._edition(ctx, plan)
        scope = self._bank.passages(
            ctx,
            edition.edition_id,
            bank_version=plan.bank_version,
            section_ordinals=plan.section_ordinals,
            paths=plan.paths,
        )
        grouped: dict[int, list[BankPassage]] = {}
        for passage in _in_order(scope, plan.order):
            grouped.setdefault(passage.section_ordinal, []).append(passage)
        titles = self._bank.sections(ctx, edition.edition_id, list(grouped))
        kind = _kind_of(edition)
        sections: list[LessonSection] = []
        for ordinal, passages in grouped.items():
            meta = titles.get(ordinal)
            reference = section_reference_ar(edition, meta) or (
                meta.reference if meta is not None else str(ordinal)
            )
            sections.append(
                LessonSection(
                    section_id=ordinal,
                    kind=kind,
                    reference_ar=reference,
                    passage_count=len(passages),
                )
            )
        return LessonsResponse(
            plan_id=plan.plan_id, plan_version=plan.current_version, sections=sections
        )

    def read_section(self, ctx: SessionContext, section_id: int) -> LessonSectionDetail:
        """The in-scope passages of one section in book order, built by the learn step's own
        builder. ``404`` for a section that is not in the active plan's scope or that has no
        passage on its selected paths."""
        plan = self._active_plan(ctx)
        if section_id not in plan.section_ordinals:
            raise AppError(ErrorCode.not_found)
        edition = self._edition(ctx, plan)
        found = self._bank.passages(
            ctx,
            edition.edition_id,
            bank_version=plan.bank_version,
            section_ordinals=(section_id,),
            paths=plan.paths,
        )
        if not found:
            raise AppError(ErrorCode.not_found)
        views, section = read_passage_views(self._bank, ctx, edition, _in_order(found, "book"))
        source_url = section.source_url if section is not None and section.source_url else None
        return LessonSectionDetail(
            section_id=section_id,
            kind=_kind_of(edition),
            reference_ar=section_reference_ar(edition, section),
            book_title_ar=edition.book_title_ar,
            source_url=source_url or edition.source_url,
            passages=views,
        )

    # -- shared ----------------------------------------------------------------------------------

    def _active_plan(self, ctx: SessionContext) -> PlanSnapshot:
        for entry in self._plans.list_plans(ctx):
            if entry.plan.status == "active":
                return entry.in_force
        raise AppError(ErrorCode.version_conflict, details={"reason": "plan_not_active"})

    def _edition(self, ctx: SessionContext, plan: PlanSnapshot) -> EditionInfo:
        """The readable edition of the plan at the plan's pinned bank version; a revoked or
        replaced one is not served (G-20)."""
        edition = self._bank.edition(ctx, plan.edition_id)
        if edition is None or edition.bank_version != plan.bank_version:
            raise AppError(ErrorCode.not_found)
        return edition
