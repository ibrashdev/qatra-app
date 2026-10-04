"""Request DTOs of E15, E16 and E17 (API-spec §4.5; Implementation-contract §7).

Pure pydantic, strict like every request body (API-spec §1.2, S-1): camelCase names only, an
unknown property is ``422`` rule ``forbidden_field`` (so ``userId``, ``isDemo`` and ``mode`` can
never be smuggled in), and a wrong type is refused instead of coerced (``"10"`` or ``true`` for a
number). Fields that carry a *rule* of API-spec §4.5 are typed loosely on purpose (``paths`` is a
list of strings, ``sessionMinutes`` an integer, ``order`` a string): the planning rules answer
them with their own rule names (``paths_invalid``, ``session_minutes_invalid``,
``order_invalid`` ...) instead of a generic type error. Responses reuse the DTOs of
``contracts_plan_chat`` (``Estimate``, ``EstimateResult``, ``Plan``).

``confirmedEstimate`` is validated as one unit: an unknown property inside it is
``forbidden_field`` and any other structural problem is ``confirmed_estimate_invalid``; a
well-formed estimate that differs from the recomputed one is a ``409 estimate_changed``.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import Field, StrictInt, StrictStr, ValidationError, WrapValidator, field_validator
from pydantic_core import PydanticCustomError

from app.contracts_plan_chat import Estimate, RequestModel, TargetScope


class TargetScopeInput(RequestModel):
    section_ordinals: list[StrictInt]


class EstimateInput(RequestModel):
    """A ``confirmedEstimate`` as the client echoes it (the nine fields of ``Estimate``)."""

    days: StrictInt
    end_date: date
    new_words_per_day: StrictInt
    total_words: StrictInt
    known_words: StrictInt
    passage_count: StrictInt
    session_minutes: Literal[5, 10, 15]
    scope: TargetScopeInput
    paths: list[Literal["quran", "matn", "sanad", "grade"]]

    def to_estimate(self) -> Estimate:
        return Estimate(
            days=self.days,
            end_date=self.end_date,
            new_words_per_day=self.new_words_per_day,
            total_words=self.total_words,
            known_words=self.known_words,
            passage_count=self.passage_count,
            session_minutes=self.session_minutes,
            scope=TargetScope(section_ordinals=list(self.scope.section_ordinals)),
            paths=list(self.paths),
        )


def _confirmed_estimate(value: Any, handler: Any) -> Any:
    """Report one error for the whole object: ``forbidden_field`` when the only problem is an
    unknown property, otherwise ``confirmed_estimate_invalid`` (API-spec E16, E17)."""
    try:
        return handler(value)
    except ValidationError as exc:
        kinds = {error["type"] for error in exc.errors()}
        if kinds == {"extra_forbidden"}:
            raise PydanticCustomError("forbidden_field", "unknown property") from None
        raise PydanticCustomError(
            "confirmed_estimate_invalid", "the confirmed estimate is not valid"
        ) from None


ConfirmedEstimate = Annotated[EstimateInput, WrapValidator(_confirmed_estimate)]


class EstimateRequest(RequestModel):
    """E15 body; the E16 body adds ``confirmedEstimate``."""

    edition_id: UUID
    target_scope: TargetScopeInput
    paths: list[StrictStr]
    session_minutes: StrictInt
    preferred_date: date | None = None
    placement_session_id: UUID | None = None
    order: StrictStr = "book"


class CreatePlanRequest(EstimateRequest):
    confirmed_estimate: ConfirmedEstimate


class RevisePlanRequest(RequestModel):
    """E17 body. The edition and the scope cannot be sent (they are unknown properties).

    ``preferredDate`` may be ``null``: it clears the date. The other optional fields do not
    accept ``null``; leave them out instead.
    """

    expected_version: Annotated[StrictInt, Field(ge=1)]
    session_minutes: StrictInt | None = None
    preferred_date: date | None = None
    paths: list[StrictStr] | None = None
    order: StrictStr | None = None
    confirmed_estimate: ConfirmedEstimate | None = None

    @field_validator("session_minutes", "paths", "order", "confirmed_estimate", mode="before")
    @classmethod
    def _no_explicit_null(cls, value: Any) -> Any:
        if value is None:
            raise PydanticCustomError("null_not_allowed", "null is not allowed for this field")
        return value

    @property
    def has_changes(self) -> bool:
        """At least one optional field is present (otherwise ``422`` rule ``no_fields``)."""
        names = {"session_minutes", "preferred_date", "paths", "order", "confirmed_estimate"}
        return bool(names & self.model_fields_set)
