"""The publisher's terms as recorded in ``sources.license_record`` (D68, A-12, decision on [O-27]).

Recording the terms is a precondition of ``publish``. Everything in the record comes from the
terms page of the Islamic Content MCP service (the access channel for both editions) as read on
5 October 2026, from the build notes and from the recorded approval:

- the terms URL, the page's own "last updated" line, the retrieval date and two verbatim
  sentences of the page;
- a note that the publishers' own pages could not be reached from the build environment;
- the register that lists every source and what is known about its terms (a draft that the owner
  has not yet accepted);
- ``owner_acceptance``, filled only from the recorded approval of the edition (the owner's words
  also cover accepting the recorded terms). Without an approval there is no record and
  ``publish`` refuses.

The record states what was published and read. It does not claim that any right to reuse the
content was granted; the terms say nothing on reuse.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from app.domain.content_policy import PublishRefusedError
from app.workflow.approval import is_complete_approval

TERMS_TITLE: Final = "Islamic Content MCP Server Terms of Use"
TERMS_URL: Final = "https://mcp.islamiccontent.org/terms.html"
TERMS_LAST_UPDATED_TEXT: Final = "Last updated 14 September 2026"
TERMS_LAST_UPDATED: Final = "2026-09-14"
TERMS_RETRIEVED: Final = "2026-10-05"
TERMS_QUOTES: Final = (
    "This server provides read-only programmatic access to published Islamic texts: the Holy "
    "Qur’an with translations, the Prophetic Hadith collection, and the IslamHouse "
    "library, for use by AI assistants via the Model Context Protocol. It is provided free of "
    "charge.",
    "Translations and authenticity gradings are the work of the publishing institutions.",
)
PUBLISHER_PAGES_NOTE: Final = (
    "The publishers' own pages (quranenc.com, hadeethenc.com, islamenc.com, islamiccontent.sa) "
    "were not reachable from the build environment on 5 October 2026, so their own terms were "
    "not read."
)
REGISTER: Final = {
    "path": "references/source-acquisition/publisher-terms-register.md",
    "version": "v0.1 Draft",
}
ACCEPTANCE_BASIS: Final = (
    "taken from the approval recorded for this edition; the owner's words also cover accepting "
    "the recorded terms"
)


def build_license_record(approval: Mapping[str, Any] | None) -> dict[str, Any]:
    """The ``license_record`` of the source, with ``owner_acceptance`` copied from ``approval``.

    Raises ``PublishRefusedError`` when the approval does not exist or lacks one of the six keys
    written by ``approve``: nothing is filled in by default.
    """
    if not approval:
        raise PublishRefusedError(
            "approval_missing", "the owner's approval must be recorded before the terms are"
        )
    if not is_complete_approval(approval):
        raise PublishRefusedError(
            "approval_incomplete",
            "the recorded approval must hold who, at, note, scope, words and source",
        )
    return {
        "terms_title": TERMS_TITLE,
        "terms_url": TERMS_URL,
        "terms_last_updated_text": TERMS_LAST_UPDATED_TEXT,
        "terms_last_updated": TERMS_LAST_UPDATED,
        "terms_retrieved": TERMS_RETRIEVED,
        "terms_quotes": list(TERMS_QUOTES),
        "publisher_pages_note": PUBLISHER_PAGES_NOTE,
        "register": dict(REGISTER),
        "owner_acceptance": {
            "who": approval["who"],
            "at": approval["at"],
            "source": approval["source"],
            "words": approval["words"],
            "basis": ACCEPTANCE_BASIS,
        },
    }
