"""Edition labels: category, book, edition and section titles (UI labels, never unit text).

Section titles are labels, not source text (contract §2.2). They come from a data file so that
a synthetic build uses placeholder titles through the same pipeline. The packaged
``data/edition_labels.json`` is **Needs Review** by the owner: the Arabic surah names, the
Arabic ordinal hadith titles and the book/edition labels are workflow data, not part of the
verified publisher records, and the English labels follow D28 (numeric until sourced).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.workflow.errors import InputError
from app.workflow.models import safe_validation_summary

DEFAULT_LABELS_PATH: Final = Path(__file__).resolve().parent / "data" / "edition_labels.json"


class CategoryLabels(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    slug: str = Field(pattern=r"^[a-z][a-z0-9_-]*$")
    label_ar: str = Field(alias="labelAr", min_length=1)
    label_en: str | None = Field(default=None, alias="labelEn")


class BookLabels(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    title_ar: str = Field(alias="titleAr", min_length=1)
    title_en: str | None = Field(default=None, alias="titleEn")
    author: str = Field(min_length=1)


class EditionLabels(BaseModel):
    """Labels of one edition. ``section_titles_ar`` is keyed by the surah number (Quran) or
    the Forty number (hadith) as a decimal string."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    category: CategoryLabels
    book: BookLabels
    edition_label: str = Field(alias="editionLabel", min_length=1)
    section_titles_ar: dict[str, str] = Field(alias="sectionTitlesAr")
    section_title_en_template: str = Field(alias="sectionTitleEnTemplate")

    def title_ar(self, number: int) -> str:
        try:
            return self.section_titles_ar[str(number)]
        except KeyError:
            raise InputError(f"the labels file has no Arabic title for section {number}") from None

    def title_en(self, number: int) -> str:
        return self.section_title_en_template.format(n=number)


class _LabelsFile(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    format_version: int = Field(alias="formatVersion")
    editions: dict[str, EditionLabels]


def load_labels(edition_key: str, path: Path | None = None) -> EditionLabels:
    """Labels of ``edition_key`` from ``path`` (default: the packaged data file)."""
    source = Path(path) if path is not None else DEFAULT_LABELS_PATH
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise InputError("the labels file cannot be read as JSON") from None
    try:
        parsed = _LabelsFile.model_validate(data)
    except ValidationError as exc:
        raise InputError(f"the labels file is invalid: {safe_validation_summary(exc)}") from None
    if parsed.format_version != 1:
        raise InputError("the labels file must have formatVersion 1")
    try:
        return parsed.editions[edition_key]
    except KeyError:
        raise InputError("the labels file has no entry for this edition") from None
