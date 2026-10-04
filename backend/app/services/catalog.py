"""The public catalog (E14): published editions as metadata only (API-spec §4.4, D71).

The repository returns per-path counts; ``edition_dto`` (pure) derives ``defaultPaths``,
``totalWords`` and the section counts from them and keeps text, lessons, questions and canonical
URLs out. Visitors, learners and demo accounts get the same payload.
"""

from __future__ import annotations

from uuid import UUID

from app.contracts_plan_chat import CatalogEdition
from app.domain.plan_policy import EditionData, edition_dto
from app.repositories.catalog import CatalogRepository


class CatalogService:
    def __init__(self, repository: CatalogRepository) -> None:
        self._repository = repository

    def list_editions(self) -> list[CatalogEdition]:
        return [edition_dto(edition) for edition in self._repository.list_editions()]

    def get_edition(self, edition_id: UUID) -> EditionData | None:
        """A published, non-revoked, non-hidden edition for planning, or ``None``."""
        return self._repository.get_edition(edition_id)
