"""Offline snapshot policy (pure): which passages a download holds, which sessions are prepared,
when an edition may be downloaded and what the status of a held snapshot is (API-spec E23 to E25,
A-04, A-12; offline-decisions G-01, G-02, G-05, G-12).

**Targets** (``select_download_targets``, G-01). When the client leaves the choice to the server,
up to ``MAX_TARGET_REFS`` passages of the plan's scope are taken in four classes, each in plan
order: passages with a review due today, passages still being learned, new passages (the learner's
next new passage first), then every other passage (reviewing or confirmed and not due), so that a
download is never emptier than the scope allows. The result is returned in plan order.

**Sessions** (``prepared_session_kinds``, G-02): one ``daily`` session of the learning date at
download plus one ``game`` session per game type, five in all; the cap is
``MAX_PREPARED_SESSIONS``.

**Downloadable** (``edition_downloadable``, G-12): a *new* download (E23) needs a selectable
edition (published and not hidden) whose source rights were not rejected. Hiding stops new
selection only (D44), so reading a stored snapshot (E24) and revalidating it (E25) ask only that
the edition is not revoked or withdrawn: ``edition_readable`` is false for a revoked or unknown
edition and ``rights_withdrawn`` is true when the source rights were rejected. The rights flag is
a column the learner role cannot read, so a deployment that knows it passes it in; without it only
the status decides.

**Status** (``derive_status``, A-04, A-12, G-05): ``revoked`` when the edition is revoked or
withdrawn or cannot be read (``content_revoked``); ``expired`` only when validity really ended
(``validity_ended``; no source or session data says so today, so the service never sets it);
``stale`` when the plan is not active or its version moved on (``plan_version_changed``), or the
edition was superseded or its bank version moved on (``bank_version_changed``); otherwise
``available`` (``current``). Hiding an edition alone changes nothing.

Pure module: standard library, ``app.domain.answer_policy``, ``app.domain.learning_state`` and
``app.domain.session_policy`` only.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Final, Literal
from uuid import UUID

from app.domain.answer_policy import GAME_TYPES
from app.domain.learning_state import PassageMastery
from app.domain.session_policy import PassageInfo, plan_order

MAX_TARGET_REFS: Final = 60
MAX_PREPARED_SESSIONS: Final = 7
SCHEMA_VERSION: Final = 1
PROTOCOL_VERSION: Final = 1

OfflineStatus = Literal["available", "stale", "revoked", "expired"]
ReasonCode = Literal[
    "current", "plan_version_changed", "bank_version_changed", "content_revoked", "validity_ended"
]

DAILY: Final = "daily"
GAME: Final = "game"


def prepared_session_kinds() -> tuple[tuple[str, str | None], ...]:
    """The sessions of a snapshot as ``(kind, game type)``: the daily session, then one game per
    game type (G-02). At most ``MAX_PREPARED_SESSIONS``."""
    plan = ((DAILY, None), *((GAME, game_type) for game_type in GAME_TYPES))
    return plan[:MAX_PREPARED_SESSIONS]


# --- targets -------------------------------------------------------------------------------------


def select_download_targets(
    passages: Iterable[PassageInfo],
    order: str,
    mastery: Mapping[UUID, PassageMastery],
    today: date,
    *,
    limit: int = MAX_TARGET_REFS,
) -> list[UUID]:
    """The passage ids a download holds when the server chooses (see the module docstring).

    ``order`` is the plan's order (``book`` or ``reverse``). The same learner state and date give
    the same list."""
    ordered = plan_order(passages, order)
    due: list[UUID] = []
    learning: list[UUID] = []
    new: list[UUID] = []
    rest: list[UUID] = []
    for passage in ordered:
        row = mastery.get(passage.id)
        status = "new" if row is None else row.status
        if row is not None and row.is_due(today):
            due.append(passage.id)
        elif status == "learning":
            learning.append(passage.id)
        elif status == "new":
            new.append(passage.id)
        else:
            rest.append(passage.id)
    chosen: list[UUID] = []
    for group in (due, learning, new, rest):
        room = limit - len(chosen)
        if room <= 0:
            break
        chosen.extend(group[:room])
    taken = set(chosen)
    return [passage.id for passage in ordered if passage.id in taken]


# --- edition -------------------------------------------------------------------------------------


def edition_downloadable(*, selectable: bool, rights_rejected: bool = False) -> bool:
    """G-12, for a new download: the edition is selectable (published, not hidden, not revoked)
    and the rights of its source are not rejected."""
    return selectable and not rights_rejected


# --- revalidation --------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Held:
    """What the device says it holds (E25 request)."""

    plan_version: int
    edition_id: UUID
    bank_version: int


def snapshot_mismatches(held: Held, recorded: Held) -> list[str]:
    """The request fields that differ from the snapshot's recorded values, by their API names."""
    found: list[str] = []
    if held.plan_version != recorded.plan_version:
        found.append("expectedPlanVersion")
    if held.edition_id != recorded.edition_id:
        found.append("editionId")
    if held.bank_version != recorded.bank_version:
        found.append("bankVersion")
    return found


@dataclass(frozen=True, slots=True)
class Current:
    """The server state a held snapshot is compared with. ``edition_readable`` is false for a
    revoked or unknown edition; ``bank_version`` is the edition's current one (``None`` when it
    cannot be read)."""

    plan_status: str
    plan_version: int
    edition_readable: bool
    bank_version: int | None
    rights_withdrawn: bool = False
    edition_superseded: bool = False
    validity_ended: bool = False


def derive_status(recorded: Held, current: Current) -> tuple[OfflineStatus, ReasonCode]:
    """The status and reason code of a snapshot recorded as ``recorded`` (see the docstring)."""
    if not current.edition_readable or current.rights_withdrawn:
        return "revoked", "content_revoked"
    if current.validity_ended:
        return "expired", "validity_ended"
    if current.plan_status != "active" or current.plan_version != recorded.plan_version:
        return "stale", "plan_version_changed"
    if current.edition_superseded or current.bank_version != recorded.bank_version:
        return "stale", "bank_version_changed"
    return "available", "current"


def runnable_session_ids(states: Sequence[tuple[UUID, str]]) -> list[UUID]:
    """The prepared sessions that may still be run: every one that is not completed (a completed
    session rejects events, ``session_closed``)."""
    return [session_id for session_id, status in states if status != "completed"]
