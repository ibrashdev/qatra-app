"""Stable identifiers (contract §2.4, §2.6): UUIDv5 over ``(editionKey, bankVersion, entity,
natural key)``, so a rebuild of the same input produces the same ids.

The namespace is fixed. Every entity (source, book, edition, section, unit, passage, part,
lesson, question) uses the same formula, exactly as the contract states; the natural keys are
documented where the entities are built.
"""

from __future__ import annotations

from typing import Final
from uuid import NAMESPACE_URL, UUID, uuid5

NAMESPACE: Final[UUID] = uuid5(NAMESPACE_URL, "https://qatra.invalid/content-ids/v1")


def stable_id(edition_key: str, bank_version: int, entity: str, key: str | int) -> str:
    """The UUIDv5 (lower-case string) of one content entity."""
    return str(uuid5(NAMESPACE, f"{edition_key}|{bank_version}|{entity}|{key}"))
