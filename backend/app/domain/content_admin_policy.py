"""Content manager web admin policy (D91, docs/Content-admin.md): pure rules, standard library only.

It decides who may use the admin, which text is acceptable, which actions an edition offers and
what the edition's ``review_record`` looks like after a withdrawal or a change of catalog
visibility. It never talks to a database: ``app/services/content_admin.py`` executes.

Sources: Content-admin.md sections 2, 3 and 5; API-spec section 5 (D44: a published edition is
withdrawn or hidden, never deleted); migration 0001 (``book_editions_status_approval_check`` keeps
``review_record.approval`` on every non-draft edition, so a withdrawal never removes it).
"""

from __future__ import annotations

import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Literal

from app.domain.auth_policy import normalize_username
from app.domain.content_policy import (
    ContentPolicyError,
    assert_delete_unused_draft_allowed,
)

# --- limits and vocabularies (Content-admin.md section 3) ---------------------------------------

TITLE_MAX_LENGTH: Final = 120  # titles, labels, author, provider, edition label
SOURCE_TITLE_MAX_LENGTH: Final = 200
WITHDRAWAL_NOTE_MAX_LENGTH: Final = 500
LICENSE_URL_MAX_LENGTH: Final = 500
DISPLAY_ORDER_MIN: Final = 0
DISPLAY_ORDER_MAX: Final = 9999

WITHDRAW_REASONS: Final[tuple[str, ...]] = ("transmission", "rights", "accreditation")

# Used when the edition has no ``published`` job to copy the pipeline version from.
ADMIN_PIPELINE_VERSION: Final = "admin-web"
WITHDRAWAL_VIA: Final = "admin_web"

# Characters refused inside a text: control characters, lone surrogates (they cannot be stored) and
# the line and paragraph separators.
_REFUSED_CATEGORIES: Final = frozenset({"Cc", "Cs", "Zl", "Zp"})

VisibilityAction = Literal["hidden", "shown"]
WithdrawalMode = Literal["fresh", "retry"]


class AdminStateError(ContentPolicyError):
    """The edition's current status does not allow the action (answered ``409`` reason
    ``state``). ``code`` is a stable machine-readable reason; the message holds no content."""


# --- who may use the admin (section 2) ----------------------------------------------------------


def configured_manager_names(raw: str | None) -> frozenset[str]:
    """The normalized names of ``QATRA_CONTENT_MANAGER_USERNAMES`` (comma separated; blank
    entries are ignored). Unset or empty gives an empty set, which means nobody (fail closed)."""
    if not raw:
        return frozenset()
    names = (normalize_username(part.strip()) for part in raw.split(","))
    return frozenset(name for name in names if name)


def is_content_manager(raw_setting: str | None, username: str, *, is_demo: bool) -> bool:
    """A demo session is never a manager; otherwise the signed-in username, normalized like a
    lookup key, must be one of the configured names."""
    if is_demo:
        return False
    normalized = normalize_username(username.strip())
    return bool(normalized) and normalized in configured_manager_names(raw_setting)


# --- text rules (section 3) ---------------------------------------------------------------------


def text_violation(value: str, *, max_length: int) -> str | None:
    """The rule name a TRIMMED text breaks, or ``None``: ``text_length`` (empty or longer than
    ``max_length`` characters) or ``text_control_chars``."""
    if not 1 <= len(value) <= max_length:
        return "text_length"
    if any(unicodedata.category(char) in _REFUSED_CATEGORIES for char in value):
        return "text_control_chars"
    return None


def url_violation(value: str) -> str | None:
    """The rule name a license link breaks, or ``None``: ``url_length`` (longer than 500),
    ``url_https`` (does not start with ``https://`` or has nothing after it) or ``url_chars``
    (whitespace or a control character inside)."""
    if len(value) > LICENSE_URL_MAX_LENGTH:
        return "url_length"
    if not value.startswith("https://") or len(value) == len("https://"):
        return "url_https"
    if any(char.isspace() or unicodedata.category(char) in _REFUSED_CATEGORIES for char in value):
        return "url_chars"
    return None


# --- edition actions (section 5) ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EditionActions:
    """What the manager may do with one edition now (the ``actions`` object of EditionDetail)."""

    edit_label: bool
    archive: bool
    unarchive: bool
    withdraw: bool
    delete: bool


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def has_withdrawal_entry(review_record: Mapping[str, Any] | None) -> bool:
    """True when ``review_record.withdrawal`` is an object: the status write of a withdrawal
    happened (a retry may still have to redact snapshots and record the job)."""
    return isinstance(_mapping(review_record).get("withdrawal"), Mapping)


def has_published_job(jobs: Iterable[Mapping[str, Any]]) -> bool:
    """True when a job of step ``published`` was ever recorded (the edition is never deleted)."""
    return any(job.get("step") == "published" for job in jobs)


def _withdrawal_pending(
    status: str, review_record: Mapping[str, Any] | None, jobs: Iterable[Mapping[str, Any]]
) -> bool:
    """A revoked edition with a withdrawal entry whose ``withdrawn`` job did not succeed: the
    request can be repeated to finish redaction and the job record."""
    if status != "revoked" or not has_withdrawal_entry(review_record):
        return False
    return not any(
        job.get("step") == "withdrawn" and job.get("status") == "succeeded" for job in jobs
    )


def edition_actions(
    *,
    status: str,
    catalog_hidden: bool,
    review_record: Mapping[str, Any] | None,
    jobs: Iterable[Mapping[str, Any]],
) -> EditionActions:
    """The booleans of EditionDetail ``actions``, from the same rules the assertions below
    enforce. ``withdraw`` is also true for a half-finished withdrawal (revoked, withdrawal entry
    recorded, ``withdrawn`` job missing), so the manager can repeat it."""
    recorded = list(jobs)
    published = status == "published"
    return EditionActions(
        edit_label=status != "revoked",
        archive=published and not catalog_hidden,
        unarchive=published and catalog_hidden,
        withdraw=published or _withdrawal_pending(status, review_record, recorded),
        delete=status == "draft" and not has_published_job(recorded),
    )


def assert_can_edit_label(status: str) -> None:
    if status == "revoked":
        raise AdminStateError("edition_revoked", "a revoked edition cannot be changed")


def assert_can_edit_section(edition_status: str) -> None:
    if edition_status == "revoked":
        raise AdminStateError("edition_revoked", "a section of a revoked edition cannot be changed")


def assert_can_archive(status: str, catalog_hidden: bool) -> None:
    if status != "published":
        raise AdminStateError("not_published", "only a published edition can be hidden")
    if catalog_hidden:
        raise AdminStateError("already_hidden", "the edition is already hidden")


def assert_can_unarchive(status: str, catalog_hidden: bool) -> None:
    if status != "published":
        raise AdminStateError("not_published", "only a published edition can be shown again")
    if not catalog_hidden:
        raise AdminStateError("not_hidden", "the edition is not hidden")


def withdrawal_mode(status: str, review_record: Mapping[str, Any] | None) -> WithdrawalMode:
    """``fresh`` for a published edition (status write first), ``retry`` for an edition already
    revoked with a withdrawal entry (skip to redaction). Anything else, a superseded edition
    included, is refused."""
    if status == "published":
        return "fresh"
    if status == "revoked" and has_withdrawal_entry(review_record):
        return "retry"
    raise AdminStateError("not_published", "only a published edition can be withdrawn")


def assert_can_delete_edition(status: str, jobs: Iterable[Mapping[str, Any]]) -> None:
    """A draft that was never published (D44). A learner reference is refused by the database,
    not here. Reuses the workflow's rule ``assert_delete_unused_draft_allowed``."""
    steps = [str(job.get("step")) for job in jobs]
    assert_delete_unused_draft_allowed(status, False, steps)


# --- review_record helpers (section 5) ----------------------------------------------------------


def _stamp(at: datetime) -> str:
    return at.astimezone(UTC).isoformat(timespec="seconds")


def with_withdrawal(
    review_record: Mapping[str, Any] | None, *, reason: str, note: str, at: datetime
) -> dict[str, Any]:
    """The record after a withdrawal: every key kept (``approval`` above all, see the module
    note) plus ``withdrawal: {reason, note, at, via}``."""
    record = dict(_mapping(review_record))
    record["withdrawal"] = {"reason": reason, "note": note, "at": _stamp(at), "via": WITHDRAWAL_VIA}
    return record


def with_catalog_visibility(
    review_record: Mapping[str, Any] | None, *, action: VisibilityAction, at: datetime
) -> dict[str, Any]:
    """The record with ``{action, at}`` appended to ``catalogVisibility`` (a missing or malformed
    list starts a new one); every other key is kept."""
    record = dict(_mapping(review_record))
    existing = record.get("catalogVisibility")
    entries = list(existing) if isinstance(existing, list) else []
    entries.append({"action": action, "at": _stamp(at)})
    record["catalogVisibility"] = entries
    return record


def _text_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def approval_view(review_record: Mapping[str, Any] | None) -> dict[str, str | None] | None:
    """``{who, at, scope, words, source}`` of ``review_record.approval``, or ``None``."""
    approval = _mapping(review_record).get("approval")
    if not isinstance(approval, Mapping):
        return None
    return {
        key: _text_or_none(approval.get(key)) for key in ("who", "at", "scope", "words", "source")
    }


def withdrawal_view(review_record: Mapping[str, Any] | None) -> dict[str, str | None] | None:
    """``{reason, note, at}`` of ``review_record.withdrawal``, or ``None``."""
    withdrawal = _mapping(review_record).get("withdrawal")
    if not isinstance(withdrawal, Mapping):
        return None
    return {key: _text_or_none(withdrawal.get(key)) for key in ("reason", "note", "at")}


def pipeline_version_for(jobs: Iterable[Mapping[str, Any]], bank_version: int) -> str:
    """The pipeline version of the edition's ``published`` job (the one of this bank version
    first), or ``admin-web`` when there is none."""
    published = [job for job in jobs if job.get("step") == "published"]
    published.sort(key=lambda job: job.get("bank_version") != bank_version)
    for job in published:
        version = job.get("pipeline_version")
        if isinstance(version, str) and version.strip():
            return version
    return ADMIN_PIPELINE_VERSION
