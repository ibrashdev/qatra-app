"""``approve``: the owner's approval, recorded only from explicit inputs (API-spec §5.3).

In this project the owner types the approval in the Claude Code chat. Those typed words, recorded
verbatim with their source and time, are the interactive confirmation the specification asks for
(coordinator decision, D83 session). So ``approve`` needs six inputs and refuses when any is
missing or empty: the owner's words, the source (a session URL), the time (ISO 8601 with a time
zone), the reviewer identity, the scope of the review actually performed and a note. There is no
default for any of them, nothing is read from the environment or a terminal, and silence, a
timeout or a missing value is never an approval.

The entry written to ``book_editions.review_record`` is ``{who, at, note, scope, words, source}``.
The job summary also binds it to the exact validated bundle (``bundleSha256``, ``contentHash``).
The owner's words are not source text; they are never printed by the CLI.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Final
from urllib.parse import urlsplit

from app.workflow.bundle import bundle_sha256, loads_bundle
from app.workflow.errors import InputError, PreconditionError
from app.workflow.jobs import JobRepository
from app.workflow.models import ContentJob, canonical_json, sha256_hex
from app.workflow.paths import BuildPaths
from app.workflow.runner import StepHandler, StepOutcome

APPROVAL_KEYS: Final = ("who", "at", "note", "scope", "words", "source")
# operational limits (not policy values): they only stop a pasted file or a stray value
MAX_LENGTH: Final = {
    "words": 5000,
    "note": 2000,
    "scope": 2000,
    "who": 200,
    "source": 500,
    "at": 100,
}
FUTURE_TOLERANCE: Final = timedelta(minutes=5)  # clock skew between the chat and this machine


@dataclass(frozen=True, slots=True)
class ApprovalInput:
    """The six explicit inputs of ``approve``, already checked."""

    reviewer: str
    review_scope: str
    note: str
    owner_words: str
    source: str
    at: datetime


def _required(label: str, value: str | None, key: str) -> str:
    if value is None or not value.strip():
        raise InputError(f"approve needs {label}: it is missing or empty")
    if "\x00" in value:
        raise InputError(f"{label} contains a NUL character")
    if len(value) > MAX_LENGTH[key]:
        raise InputError(f"{label} is longer than {MAX_LENGTH[key]} characters")
    return value


def _parse_source(value: str) -> str:
    text = _required("--source (a session URL)", value, "source").strip()
    parts = urlsplit(text)
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or any(ch.isspace() for ch in text)
    ):
        raise InputError("--source must be an https URL of the session, without credentials")
    return text


def _parse_at(value: str, now: datetime) -> datetime:
    text = _required("--at (the time of the owner's words)", value, "at").strip()
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise InputError("--at is not an ISO 8601 date-time") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise InputError("--at needs a time zone, for example 2026-10-05T07:30:00+04:00")
    if parsed > now + FUTURE_TOLERANCE:
        raise InputError("--at is in the future: an approval cannot precede its own words")
    return parsed


def read_owner_words_file(path: Path) -> str:
    """The words typed by the owner, read from a UTF-8 file (avoids shell quoting): the text as
    written, without the final line break."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        raise InputError("the owner words file cannot be read as UTF-8") from None
    return text.rstrip("\r\n")


def parse_approval_input(
    *,
    reviewer: str | None,
    review_scope: str | None,
    note: str | None,
    owner_words: str | None,
    source: str | None,
    at: str | None,
    now: datetime,
) -> ApprovalInput:
    """Check the six inputs; ``InputError`` names the input, never its value."""
    return ApprovalInput(
        reviewer=_required("--reviewer", reviewer, "who").strip(),
        review_scope=_required("--review-scope", review_scope, "scope").strip(),
        note=_required("--note", note, "note").strip(),
        owner_words=_required("the owner's words (--owner-words)", owner_words, "words"),
        source=_parse_source(source or ""),
        at=_parse_at(at or "", now),
    )


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def approval_entry(approval: ApprovalInput) -> dict[str, str]:
    """The approval entry of ``review_record``: who, when, note, scope, words, source."""
    return {
        "who": approval.reviewer,
        "at": _iso(approval.at),
        "note": approval.note,
        "scope": approval.review_scope,
        "words": approval.owner_words,
        "source": approval.source,
    }


def is_complete_approval(entry: Mapping[str, Any] | None) -> bool:
    """True when every one of the six keys is a non-empty string (publish checks this too)."""
    if not entry:
        return False
    return all(isinstance(entry.get(key), str) and entry[key].strip() for key in APPROVAL_KEYS)


def make_approve_handler(
    *,
    edition_key: str,
    bank_version: int,
    jobs: JobRepository,
    paths: BuildPaths,
    approval: ApprovalInput,
) -> StepHandler:
    """Runner handler of the ``approved`` step.

    The approval must follow the validation it covers and refers to exactly the bundle that
    ``validate`` accepted: a changed bundle needs a new approval (the runner also resets an
    approval whenever an earlier step changes).
    """

    def handler(job: ContentJob) -> StepOutcome:
        validated = jobs.get_job(edition_key, bank_version, "validated")
        if validated is None or validated.status != "succeeded" or not validated.cursor:
            raise PreconditionError("the 'validated' step has no recorded result")
        recorded = validated.cursor["bundleSha256"]
        if approval.at < validated.updated_at:
            raise PreconditionError(
                "the approval time is earlier than the validation it would cover; "
                "an approval must follow the results it accepts"
            )
        path = paths.bundle_json(edition_key)
        try:
            bundle = loads_bundle(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            raise PreconditionError("bundle.json cannot be read; run the earlier steps") from None
        if bundle_sha256(bundle) != recorded:
            raise PreconditionError(
                "bundle.json no longer is the bundle that validate accepted; run validate again"
            )
        verified = jobs.get_job(edition_key, bank_version, "verified")
        verification = ((verified.validation_summary or {}) if verified else {}).get(
            "verification", {}
        )
        entry = approval_entry(approval)
        content_hash = bundle["edition"]["contentHash"]
        counts = {
            "approvals": 1,
            "units": len(bundle["units"]),
            "passages": len(bundle["passages"]),
            "questions": len(bundle["questions"]),
        }
        summary: dict[str, Any] = {
            "approval": entry,
            "bundleSha256": recorded,
            "contentHash": content_hash,
            "verification": {
                "method": verification.get("method"),
                "result": verification.get("result"),
            },
            "counts": counts,
            "reviewRecordEntry": {"approval": entry},
        }
        digest = sha256_hex(
            canonical_json(
                {"approval": entry, "bundleSha256": recorded, "contentHash": content_hash}
            )
        )
        return StepOutcome(
            "succeeded",
            cursor={"bundleSha256": recorded, "contentHash": content_hash},
            summary=summary,
            digest=digest,
            counts=counts,
        )

    return handler
