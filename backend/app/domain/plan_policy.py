"""Pure planning rules of package B4 (Implementation-contract §5, API-spec §4.4-§4.5).

No framework, database or HTTP imports: the rules work on plain data that the repositories hand
over (``EditionData``, ``PassageRow``) and return the shared DTOs of ``contracts_plan_chat``.

What lives here
- the catalog view of an edition (default paths, section and edition counts; A-12 decision on
  [O-15]: counts sum the edition's ``defaultPaths``) and the shared input rules of E15-E17
  (``validate_plan_input`` reuses ``plan_chat_policy.validate_parameters``, so the plan
  conversation and the REST endpoints answer with the same rule names);
- the estimate: capacity 5 -> 12, 10 -> 25, 15 -> 40 new words per learning day,
  ``days = ceil((totalWords - knownWords) / capacity * 1.15)`` computed with exact integer
  arithmetic (1.15 = 23/20), ``endDate = today + days``, the two alternatives (the next larger
  minutes option and the scope halved with ``plan_chat_policy.halve_scope``) and the reason code;
- the plan commit: ``plan_phases`` rows, ``plan_versions.policy_json`` and the effective date.

Design decisions for shapes the approved schema leaves open (Database-schema OPEN-04, API-spec
[O-17]); they are documented here because the database stores them as ``jsonb``:

``plan_phases`` (one phase per section of the scope that has passages for the selected paths, in
plan order: ``book`` = ascending section ordinal, ``reverse`` = descending, Quran edition only;
passages inside a section keep book order, paths in the order quran, matn, sanad, grade)
    ``section_refs``      ``[{"sectionId": "<uuid>", "ordinal": <int>}]``
    ``unit_range``        ``{"passages": [{"id": "<uuid>", "path": "<path>", "ordinal": <int>}]}``
                          the ordered memorization targets of the phase (passages, D66); every
                          passage of the scope for the selected paths appears in exactly one phase,
                          so no unit is dropped
    ``goal_size``         words of those passages (the D66 weight; known passages included)
    ``estimated_window``  ``[start,end)`` daterange, an approximate window and not a promise (R02):
                          the phases share ``today .. today + days`` in proportion to their words
                          that are not known yet

``plan_versions.policy_json`` (the snapshot that applies from ``effective_learning_date``)
    ``{"policyVersion": 1, "scope": {"sectionOrdinals": [...]}, "paths": [...], "order": "...",
    "sessionMinutes": n, "preferredDate": "YYYY-MM-DD" | null, "agreedEstimate": {...},
    "knownPassages": {"placementSessionId": "<uuid>" | null, "passageIds": ["<uuid>", ...]},
    "planner": {"source": "rules" | "teaching_agent", "model": "<id>" (only with a model)}}``
    ``knownPassages`` is the answer to [O-17] "where placement-known passages are stored with the
    plan": inside the version's ``policy_json`` (the schema names it there), as the placement
    session id plus the ids of the passages answered correctly and unassisted in it.

Other choices where the sources are silent (reported to the coordinator, none is an approved
number): a scope that has no passage for the selected paths is ``scope_invalid`` (an empty plan
would have no phase to record); a revision takes effect on the next learning day (D57) while a
new plan starts today; a missing English label falls back to the Arabic one (D28: never a
machine translation).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from app.contracts_plan_chat import (
    PATH_ORDER,
    SESSION_MINUTES_OPTIONS,
    CatalogCategory,
    CatalogEdition,
    CatalogSection,
    Estimate,
    EstimateResult,
    PlanParameters,
    TargetScope,
)
from app.domain.plan_chat_policy import (
    FieldError,
    derive_reason_code,
    halve_scope,
    in_plan_order,
    validate_parameters,
)

# --- constants (Implementation-contract §5) ------------------------------------------------------

CAPACITY_BY_MINUTES: Mapping[int, int] = {5: 12, 10: 25, 15: 40}
# 15 % review buffer = 23 / 20, kept as integers so that the ceiling is exact.
_BUFFER_NUMERATOR = 23
_BUFFER_DENOMINATOR = 20

POLICY_VERSION = 1
REASON_CREATED = "plan_created"
REASON_REVISED = "plan_revised"
PLANNER_RULES = "rules"


class PlanInputError(Exception):
    """One or more shared input rules failed (API-spec §4.5): ``errors`` lists every field."""

    def __init__(self, errors: Iterable[FieldError]) -> None:
        self.errors: tuple[FieldError, ...] = tuple(errors)
        super().__init__(self.errors[0].rule if self.errors else "invalid")


class EstimateMismatch(Exception):
    """The recomputed estimate differs from ``confirmedEstimate``; ``fresh`` is the new one."""

    def __init__(self, fresh: Estimate) -> None:
        self.fresh = fresh
        super().__init__("estimate_changed")


# --- catalog data (what the repositories read) ---------------------------------------------------


@dataclass(frozen=True, slots=True)
class SectionData:
    """A section and its per-path word and passage counts for the current bank version."""

    section_id: str
    ordinal: int
    kind: str  # surah | hadith
    reference: str
    title_ar: str
    title_en: str
    path_words: Mapping[str, int]
    path_passages: Mapping[str, int]


@dataclass(frozen=True, slots=True)
class EditionData:
    """A published, visible edition as the public catalog views describe it (metadata only)."""

    edition_id: UUID
    edition_key: str
    edition_label: str
    title_ar: str
    title_en: str | None
    author: str
    category_slug: str
    category_label_ar: str
    category_label_en: str | None
    catalog_version: int
    content_format: str  # quran | hadith_collection
    available_paths: tuple[str, ...]
    path_words: Mapping[str, int]
    path_passages: Mapping[str, int]
    sections: tuple[SectionData, ...]

    def section(self, ordinal: int) -> SectionData | None:
        return next((s for s in self.sections if s.ordinal == ordinal), None)


@dataclass(frozen=True, slots=True)
class PassageRow:
    """A memorization target (passage) of an edition: only what planning needs."""

    passage_id: UUID
    section_ordinal: int
    path: str
    ordinal: int  # book order of the passages of one path inside the edition
    words: int


def canonical_paths(values: Iterable[str]) -> tuple[str, ...]:
    """Unique paths in the fixed order quran, matn, sanad, grade (unknown names last)."""
    unique = set(values)
    return tuple(
        sorted(unique, key=lambda name: PATH_ORDER.index(name) if name in PATH_ORDER else 99)
    )


def default_paths(content_format: str, available: Sequence[str]) -> tuple[str, ...]:
    """Contract §5: the Quran edition defaults to ``quran``, the Forty to ``matn``."""
    wanted = "quran" if content_format == "quran" else "matn"
    if wanted in available:
        return (wanted,)
    return tuple(available[:1])


def edition_dto(data: EditionData) -> CatalogEdition:
    """The public ``CatalogEdition``: metadata only, counts summed over the default paths.

    A missing English label (D28: not yet sourced) falls back to the Arabic label, never to a
    machine translation; the section titles are the numeric labels stored in the catalog.
    """
    defaults = default_paths(data.content_format, data.available_paths)
    sections = [
        CatalogSection(
            section_id=section.section_id,
            ordinal=section.ordinal,
            kind=section.kind,  # type: ignore[arg-type]
            reference=section.reference,
            title_ar=section.title_ar,
            title_en=section.title_en,
            word_count=sum(section.path_words.get(p, 0) for p in defaults),
            passage_count=sum(section.path_passages.get(p, 0) for p in defaults),
            paths=list(canonical_paths(set(section.path_words) | set(section.path_passages))),  # type: ignore[arg-type]
        )
        for section in sorted(data.sections, key=lambda s: s.ordinal)
    ]
    return CatalogEdition(
        edition_id=str(data.edition_id),
        edition_key=data.edition_key,
        title_ar=data.title_ar,
        title_en=data.title_en or data.title_ar,
        author=data.author,
        edition_label=data.edition_label,
        category=CatalogCategory(
            slug=data.category_slug,
            label_ar=data.category_label_ar,
            label_en=data.category_label_en or data.category_label_ar,
        ),
        catalog_version=data.catalog_version,
        content_format=data.content_format,  # type: ignore[arg-type]
        available_paths=list(canonical_paths(data.available_paths)),  # type: ignore[arg-type]
        default_paths=list(defaults),  # type: ignore[arg-type]
        default_order="book",
        total_words=sum(data.path_words.get(p, 0) for p in defaults),
        sections=sections,
    )


# --- shared input rules (API-spec §4.5) ----------------------------------------------------------


def scope_totals(
    edition: EditionData, ordinals: Iterable[int], paths: Sequence[str]
) -> tuple[int, int]:
    """``(words, passages)`` of the sections in scope for the selected paths."""
    words = passages = 0
    for ordinal in set(ordinals):
        section = edition.section(ordinal)
        if section is None:
            continue
        words += sum(section.path_words.get(p, 0) for p in paths)
        passages += sum(section.path_passages.get(p, 0) for p in paths)
    return words, passages


def validate_plan_input(
    edition: EditionData,
    *,
    ordinals: Sequence[int],
    paths: Sequence[str],
    session_minutes: int,
    preferred_date: date | None,
    order: str,
    today: date,
) -> list[FieldError]:
    """The shared rules of E15, E16 and E17, with the rule names of API-spec §4.5.

    Reuses ``plan_chat_policy.validate_parameters`` (scope, paths, order, minutes, past date) and
    adds one rule: a scope without any passage for the selected paths cannot be planned
    (``scope_invalid``; a design choice, see the module note).
    """
    params = PlanParameters(
        edition_id=edition.edition_id,
        target_scope=TargetScope(section_ordinals=list(ordinals)),
        paths=list(paths),
        order=order,
        session_minutes=session_minutes,
        preferred_date=preferred_date,
    )
    errors = validate_parameters(params, edition_dto(edition), today)
    if not any(error.field in {"targetScope", "paths"} for error in errors):
        _, passages = scope_totals(edition, ordinals, canonical_paths(paths))
        if passages == 0:
            errors.append(FieldError("targetScope", "scope_invalid"))
    return errors


# --- the estimate (contract §5) ------------------------------------------------------------------


def review_buffered_days(remaining_words: int, capacity: int) -> int:
    """``ceil(remaining / capacity * 1.15)`` in exact integer arithmetic."""
    numerator = max(remaining_words, 0) * _BUFFER_NUMERATOR
    denominator = capacity * _BUFFER_DENOMINATOR
    return -(-numerator // denominator)


def known_words_in_scope(
    known: Iterable[PassageRow], ordinals: Iterable[int], paths: Sequence[str]
) -> int:
    scope = set(ordinals)
    return sum(row.words for row in known if row.section_ordinal in scope and row.path in paths)


def compute_estimate(
    edition: EditionData,
    *,
    ordinals: Sequence[int],
    paths: Sequence[str],
    session_minutes: int,
    today: date,
    known: Sequence[PassageRow] = (),
) -> Estimate:
    """One ``Estimate``. ``known`` are the passages answered correctly in the placement session;
    only those inside the scope and the selected paths count."""
    selected = canonical_paths(paths)
    total, passages = scope_totals(edition, ordinals, selected)
    known_words = min(known_words_in_scope(known, ordinals, selected), total)
    capacity = CAPACITY_BY_MINUTES[session_minutes]
    days = review_buffered_days(total - known_words, capacity)
    return Estimate(
        days=days,
        end_date=today + timedelta(days=days),
        new_words_per_day=capacity,
        total_words=total,
        known_words=known_words,
        passage_count=passages,
        session_minutes=session_minutes,  # type: ignore[arg-type]
        scope=TargetScope(section_ordinals=sorted(set(ordinals))),
        paths=list(selected),  # type: ignore[arg-type]
    )


def estimate_with_alternatives(
    edition: EditionData,
    *,
    ordinals: Sequence[int],
    paths: Sequence[str],
    session_minutes: int,
    order: str,
    preferred_date: date | None,
    today: date,
    known: Sequence[PassageRow] = (),
) -> EstimateResult:
    """E15: the estimate, at most two alternatives and the reason code.

    (a) the next larger minutes option (omitted at 15 minutes); (b) the scope halved with
    ``halve_scope`` (the first half in plan order, so ``reverse`` halves from the end; omitted
    when the scope is a single section). An alternative that does not apply is left out.
    """
    main = compute_estimate(
        edition,
        ordinals=ordinals,
        paths=paths,
        session_minutes=session_minutes,
        today=today,
        known=known,
    )
    alternatives: list[Estimate] = []
    larger = [m for m in SESSION_MINUTES_OPTIONS if m > session_minutes]
    if larger:
        alternatives.append(
            compute_estimate(
                edition,
                ordinals=ordinals,
                paths=paths,
                session_minutes=larger[0],
                today=today,
                known=known,
            )
        )
    half = halve_scope(ordinals, order)
    if len(half) < len(set(ordinals)):
        alternatives.append(
            compute_estimate(
                edition,
                ordinals=half,
                paths=paths,
                session_minutes=session_minutes,
                today=today,
                known=known,
            )
        )
    return EstimateResult(
        estimate=main,
        alternatives=alternatives,
        reason_code=derive_reason_code(main.end_date, preferred_date),
    )


def estimates_equal(left: Estimate, right: Estimate) -> bool:
    """Every field equal (API-spec E16); the order of ``scope`` and ``paths`` does not matter."""
    return (
        left.days == right.days
        and left.end_date == right.end_date
        and left.new_words_per_day == right.new_words_per_day
        and left.total_words == right.total_words
        and left.known_words == right.known_words
        and left.passage_count == right.passage_count
        and left.session_minutes == right.session_minutes
        and sorted(left.scope.section_ordinals) == sorted(right.scope.section_ordinals)
        and list(canonical_paths(left.paths)) == list(canonical_paths(right.paths))
    )


# --- learning date (API-spec §1.10, D57) ---------------------------------------------------------


def learning_date(
    now: datetime,
    time_zone: str,
    pending_time_zone: str | None = None,
    pending_effective: date | None = None,
) -> date:
    """Today's learning date in the account time zone; local midnight starts a new day.

    A time-zone change takes effect from its ``effectiveDate`` (the next learning day, D57): until
    then the current zone stays in force. Raises ``ValueError`` for an unknown zone name.
    """
    try:
        zone = ZoneInfo(time_zone)
        today = now.astimezone(zone).date()
        if pending_time_zone and pending_effective is not None and today >= pending_effective:
            zone = ZoneInfo(pending_time_zone)
            today = now.astimezone(zone).date()
    except (KeyError, OSError) as exc:  # ZoneInfoNotFoundError is a KeyError
        raise ValueError("unknown time zone") from exc
    return today


# --- known passages and the stored plan state ----------------------------------------------------


@dataclass(frozen=True, slots=True)
class KnownPassages:
    """The placement-known set recorded with a plan version ([O-17]; see the module note)."""

    placement_session_id: UUID | None = None
    passage_ids: tuple[UUID, ...] = ()

    def as_json(self) -> dict[str, Any]:
        return {
            "placementSessionId": str(self.placement_session_id)
            if self.placement_session_id
            else None,
            "passageIds": [str(item) for item in self.passage_ids],
        }


def known_from_policy(policy: Mapping[str, Any]) -> KnownPassages:
    """Read ``knownPassages`` from a stored ``policy_json`` (tolerant: anything odd means none)."""
    raw = policy.get("knownPassages") if isinstance(policy, Mapping) else None
    if not isinstance(raw, Mapping):
        return KnownPassages()
    placement: UUID | None = None
    try:
        if raw.get("placementSessionId"):
            placement = UUID(str(raw["placementSessionId"]))
    except ValueError:
        placement = None
    ids: list[UUID] = []
    for item in raw.get("passageIds") or []:
        try:
            ids.append(UUID(str(item)))
        except ValueError:
            continue
    return KnownPassages(placement, tuple(ids))


def planner_from_policy(policy: Mapping[str, Any]) -> tuple[str, str | None]:
    """``(source, model)`` of a stored version; plans without a record count as ``rules``."""
    raw = policy.get("planner") if isinstance(policy, Mapping) else None
    if isinstance(raw, Mapping) and raw.get("source") in {"rules", "teaching_agent"}:
        model = raw.get("model")
        return str(raw["source"]), model if isinstance(model, str) and model else None
    return PLANNER_RULES, None


# --- phases (plan_phases) ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PlanPhase:
    ordinal: int
    section_refs: tuple[dict[str, Any], ...]
    unit_range: dict[str, Any]
    goal_size: int
    window_start: date
    window_end: date  # exclusive, like the daterange it is stored in

    def row(self) -> dict[str, Any]:
        """The element of ``p_phases`` of ``app_create_plan`` / ``app_revise_plan``."""
        return {
            "ordinal": self.ordinal,
            "section_refs": [dict(ref) for ref in self.section_refs],
            "unit_range": self.unit_range,
            "goal_size": self.goal_size,
            "estimated_window": f"[{self.window_start.isoformat()},{self.window_end.isoformat()})",
        }


def _windows(new_words: Sequence[int], days: int, today: date) -> list[tuple[date, date]]:
    """Spread ``today .. today + days`` over the phases in proportion to their unknown words."""
    span = max(days, 1)
    total = sum(new_words)
    done = 0
    windows: list[tuple[date, date]] = []
    for words in new_words:
        if total > 0 and days > 0:
            start = (days * done) // total
            done += words
            end = max(start + 1, -(-(days * done) // total))
        else:
            start, end = 0, 1
        start = min(start, span - 1)
        end = min(max(end, start + 1), span)
        windows.append((today + timedelta(days=start), today + timedelta(days=end)))
    return windows


def build_phases(
    edition: EditionData,
    passages: Sequence[PassageRow],
    *,
    ordinals: Sequence[int],
    paths: Sequence[str],
    order: str,
    known_ids: Iterable[UUID],
    today: date,
    days: int,
) -> list[PlanPhase]:
    """One phase per section of the scope that has passages for the selected paths, in plan order.

    Inside a section the passages keep book order, grouped by path in the fixed path order; under
    ``reverse`` only the sections run backwards (D72, confirmed by D74 Q4). No passage of the scope
    is dropped and none appears twice.
    """
    selected = canonical_paths(paths)
    known = set(known_ids)
    groups: list[tuple[SectionData, list[PassageRow]]] = []
    for ordinal in in_plan_order(ordinals, order):
        section = edition.section(ordinal)
        if section is None:
            continue
        rows = sorted(
            (row for row in passages if row.section_ordinal == ordinal and row.path in selected),
            key=lambda row: (PATH_ORDER.index(row.path), row.ordinal),
        )
        if rows:
            groups.append((section, rows))
    unknown_words = [sum(r.words for r in rows if r.passage_id not in known) for _, rows in groups]
    windows = _windows(unknown_words, days, today)
    phases: list[PlanPhase] = []
    for index, ((section, rows), (start, end)) in enumerate(zip(groups, windows, strict=True), 1):
        phases.append(
            PlanPhase(
                ordinal=index,
                section_refs=({"sectionId": section.section_id, "ordinal": section.ordinal},),
                unit_range={
                    "passages": [
                        {"id": str(row.passage_id), "path": row.path, "ordinal": row.ordinal}
                        for row in rows
                    ]
                },
                goal_size=sum(row.words for row in rows),
                window_start=start,
                window_end=end,
            )
        )
    return phases


# --- the commit ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PlanValues:
    """The values the ``master_plans`` row mirrors (the latest version)."""

    edition_id: UUID
    scope: tuple[int, ...]  # ascending
    paths: tuple[str, ...]  # canonical order
    order: str
    session_minutes: int
    preferred_date: date | None
    agreed_estimate: Estimate


@dataclass(frozen=True, slots=True)
class PlanCommit:
    """Everything one create or revise call persists (``app_create_plan`` / ``app_revise_plan``)."""

    values: PlanValues
    reason_code: str
    policy_json: dict[str, Any]
    effective_learning_date: date
    phases: tuple[PlanPhase, ...]

    def phase_rows(self) -> list[dict[str, Any]]:
        return [phase.row() for phase in self.phases]

    def plan_args(self) -> dict[str, Any]:
        """``p_plan_args`` of ``app_plan_chat_confirm`` (the plan values come from the stored
        proposal there); the plan conversation (B13) can reuse the same commit in the database."""
        return {
            "reason_code": self.reason_code,
            "policy_json": self.policy_json,
            "effective_learning_date": self.effective_learning_date.isoformat(),
            "phases": self.phase_rows(),
        }


def build_plan_commit(
    values: PlanValues,
    *,
    reason_code: str,
    edition: EditionData,
    passages: Sequence[PassageRow],
    known: KnownPassages,
    planner_source: str,
    planner_model: str | None,
    today: date,
    days: int,
    effective_date: date,
) -> PlanCommit:
    """Assemble the phases and the ``policy_json`` snapshot of one plan version.

    ``days`` is the span the phase windows share, starting ``today`` (the freshly computed
    estimate, which can differ from ``values.agreed_estimate`` on a revision without a
    ``confirmedEstimate``).
    """
    phases = build_phases(
        edition,
        passages,
        ordinals=values.scope,
        paths=values.paths,
        order=values.order,
        known_ids=known.passage_ids,
        today=today,
        days=days,
    )
    planner: dict[str, Any] = {"source": planner_source}
    if planner_model:
        planner["model"] = planner_model
    policy: dict[str, Any] = {
        "policyVersion": POLICY_VERSION,
        "scope": {"sectionOrdinals": list(values.scope)},
        "paths": list(values.paths),
        "order": values.order,
        "sessionMinutes": values.session_minutes,
        "preferredDate": values.preferred_date.isoformat() if values.preferred_date else None,
        "agreedEstimate": values.agreed_estimate.model_dump(by_alias=True, mode="json"),
        "knownPassages": known.as_json(),
        "planner": planner,
    }
    return PlanCommit(
        values=values,
        reason_code=reason_code,
        policy_json=policy,
        effective_learning_date=effective_date,
        phases=tuple(phases),
    )
