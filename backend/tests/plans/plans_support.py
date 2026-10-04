"""Fixtures for the B4 tests (catalog and plans). Synthetic data only: no religious text.

The Quran fixture edition reproduces the numbers of the API-spec E15 example: sections 1 and 2
hold four passages and 180 words (100 + 80), and one passage of 20 words in section 1 is the
placement-known one. ``login_as`` overrides ``require_session`` with a fake context: this is a
TEST-ONLY shortcut (never a cookie); production code never does it.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.dependencies import SessionContext, require_session
from app.main import create_app
from app.services.plans import PlanningServices, build_planning_services
from app.workflow.bundle import TOP_LEVEL_KEYS, dumps_bundle
from tests.support import FRONTEND_ORIGIN, make_settings

TODAY = date(2026, 10, 4)
NOW = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)  # 13:00 on 2026-10-04 in Asia/Dubai
USER_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")
OTHER_USER_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000002")
QURAN_ID = UUID("11111111-1111-4111-8111-0000000000e1")
HADITH_ID = UUID("11111111-1111-4111-8111-0000000000e2")
PLACEMENT_ID = UUID("33333333-3333-4333-8333-000000000001")
UNKNOWN_ID = UUID("99999999-9999-4999-8999-999999999999")
TOKEN = "learner-token-for-tests"


class Clock:
    """A settable clock: tests move it to cross a day boundary."""

    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def pid(number: int) -> UUID:
    """A fixed synthetic passage id."""
    return UUID(f"55555555-5555-4555-8555-{number:012d}")


def sid(number: int) -> str:
    return f"22222222-2222-4222-8222-{number:012d}"


# (passage number, section ordinal, path, ordinal inside the path, words)
QURAN_PASSAGES = [
    (1, 1, "quran", 1, 20),  # the placement-known passage of the example
    (2, 1, "quran", 2, 80),
    (3, 2, "quran", 3, 40),
    (4, 2, "quran", 4, 40),
    (5, 3, "quran", 5, 30),
    (6, 4, "quran", 6, 30),
]
HADITH_PASSAGES = [
    (11, 1, "matn", 1, 10),
    (12, 1, "sanad", 1, 6),
    (13, 1, "grade", 1, 1),
    (14, 2, "matn", 2, 30),
    (15, 2, "sanad", 2, 8),  # hadith 2 has no grade passage
    (16, 3, "matn", 3, 20),
    (17, 3, "sanad", 3, 5),
    (18, 3, "grade", 3, 1),
]

EXAMPLE_ESTIMATE: dict[str, Any] = {
    "days": 16,
    "endDate": "2026-10-20",
    "newWordsPerDay": 12,
    "totalWords": 180,
    "knownWords": 20,
    "passageCount": 4,
    "sessionMinutes": 5,
    "scope": {"sectionOrdinals": [1, 2]},
    "paths": ["quran"],
}
EXAMPLE_ALTERNATIVES: list[dict[str, Any]] = [
    {
        "days": 8,
        "endDate": "2026-10-12",
        "newWordsPerDay": 25,
        "totalWords": 180,
        "knownWords": 20,
        "passageCount": 4,
        "sessionMinutes": 10,
        "scope": {"sectionOrdinals": [1, 2]},
        "paths": ["quran"],
    },
    {
        "days": 8,
        "endDate": "2026-10-12",
        "newWordsPerDay": 12,
        "totalWords": 100,
        "knownWords": 20,
        "passageCount": 2,
        "sessionMinutes": 5,
        "scope": {"sectionOrdinals": [1]},
        "paths": ["quran"],
    },
]


def make_bundle(
    *,
    edition_id: UUID,
    key: str,
    content_format: str,
    sections: list[tuple[int, str, str, str]],
    passages: list[tuple[int, int, str, int, int]],
    title_en: str | None = "Book title placeholder",
    category_label_en: str | None = "Category placeholder",
) -> dict[str, Any]:
    """A content bundle (format v1) with only what the catalog needs; the keys follow the order
    ``loads_bundle`` requires. Section tuple: (ordinal, kind, reference, English title)."""
    values: dict[str, Any] = {
        "bundleVersion": 1,
        "editionKey": key,
        "bankVersion": 1,
        "category": {
            "slug": "quran" if content_format == "quran" else "hadith",
            "labelAr": "«اسم الباب»",
            "labelEn": category_label_en,
        },
        "book": {
            "id": str(uuid.uuid5(uuid.NAMESPACE_DNS, key)),
            "titleAr": "«عنوان الكتاب»",
            "titleEn": title_en,
            "author": "«اسم المؤلف»",
            "contentFormat": content_format,
        },
        "source": {},
        "edition": {"id": str(edition_id), "editionLabel": "«تسمية الطبعة»"},
        "pages": [],
        "sections": [
            {
                "id": sid(ordinal),
                "ordinal": ordinal,
                "kind": kind,
                "reference": reference,
                "titleAr": "«اسم القسم»",
                "titleEn": title,
                "sourceUrl": "https://example.invalid/source-url-must-not-leak",
            }
            for ordinal, kind, reference, title in sections
        ],
        "units": [],
        "passages": [
            {
                "id": str(pid(number)),
                "ordinal": ordinal,
                "sectionOrdinal": section,
                "path": path,
                "startRef": "1:0",
                "endRef": "1:1",
                "wordCount": words,
                "reference": "ref",
                "parts": [],
            }
            for number, section, path, ordinal, words in passages
        ],
        "lessons": [],
        "questions": [],
    }
    assert tuple(values) == TOP_LEVEL_KEYS
    return values


def quran_bundle(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "edition_id": QURAN_ID,
        "key": "quran-test",
        "content_format": "quran",
        "sections": [
            (1, "surah", "78", "Surah 78"),
            (2, "surah", "79", "Surah 79"),
            (3, "surah", "80", "Surah 80"),
            (4, "surah", "81", "Surah 81"),
        ],
        "passages": QURAN_PASSAGES,
    }
    values.update(overrides)
    return make_bundle(**values)


def hadith_bundle(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "edition_id": HADITH_ID,
        "key": "hadith-test",
        "content_format": "hadith_collection",
        "sections": [
            (1, "hadith", "nawawi40:1", "Hadith 1"),
            (2, "hadith", "nawawi40:2", "Hadith 2"),
            (3, "hadith", "nawawi40:3", "Hadith 3"),
        ],
        "passages": HADITH_PASSAGES,
    }
    values.update(overrides)
    return make_bundle(**values)


def write_bundles(directory: Path, *bundles: dict[str, Any]) -> str:
    """Write the bundles to files and return the ``QATRA_CONTENT_BUNDLES`` value."""
    paths = []
    for index, bundle in enumerate(bundles or (quran_bundle(), hadith_bundle())):
        path = directory / f"bundle{index}.json"
        path.write_text(dumps_bundle(bundle), encoding="utf-8")
        paths.append(str(path))
    return ",".join(paths)


@dataclass
class Env:
    """An app in memory mode with a fixed clock and the seedable parts of the services."""

    app: FastAPI
    settings: Settings
    services: PlanningServices
    clock: Clock

    @property
    def repository(self):
        assert self.services.repository is not None
        return self.services.repository

    def seed_placement(
        self,
        user_id: UUID = USER_ID,
        *,
        known: tuple[UUID, ...] = (pid(1),),
        placement_id: UUID = PLACEMENT_ID,
        edition_id: UUID = QURAN_ID,
    ) -> None:
        assert self.services.placements is not None
        self.services.placements.add_session(user_id, placement_id, edition_id, set(known))


def make_env(directory: Path, *bundles: dict[str, Any], **settings: Any) -> Env:
    values = make_settings(QATRA_CONTENT_BUNDLES=write_bundles(directory, *bundles), **settings)
    app = create_app(values)
    moving = Clock()
    services = build_planning_services(values, clock=moving)  # a settable clock for the tests
    app.state.catalog_service = services.catalog
    app.state.plan_service = services.plans
    return Env(app, values, services, moving)


def session_context(
    user_id: UUID = USER_ID, *, demo: bool = False, token: str | None = None
) -> SessionContext:
    return SessionContext(
        user_id=user_id,
        is_demo=demo,
        auth_epoch=1,
        access_token=SecretStr(token) if token else None,
    )


def login_as(
    app: FastAPI, user_id: UUID = USER_ID, *, demo: bool = False, token: str | None = None
) -> None:
    """TEST ONLY: replace ``require_session`` with a fake context (never a real cookie). The
    learner access token is only needed by the supabase-mode tests."""
    context = session_context(user_id, demo=demo, token=token)
    app.dependency_overrides[require_session] = lambda: context


def browser(app: FastAPI) -> TestClient:
    """A client that sends the frontend ``Origin`` on every request, as a browser does."""
    return TestClient(app, headers={"Origin": FRONTEND_ORIGIN})


def estimate_body(**overrides: Any) -> dict[str, Any]:
    """The E15 example request of API-spec §4.5 (with its placement session)."""
    body: dict[str, Any] = {
        "editionId": str(QURAN_ID),
        "targetScope": {"sectionOrdinals": [1, 2]},
        "paths": ["quran"],
        "sessionMinutes": 5,
        "preferredDate": "2026-10-20",
        "placementSessionId": str(PLACEMENT_ID),
    }
    body.update(overrides)
    return {key: value for key, value in body.items() if value is not None}


def create_body(**overrides: Any) -> dict[str, Any]:
    """The E16 example request: the E15 body plus ``order`` and the confirmed estimate."""
    body = estimate_body()
    body["order"] = "book"
    body["confirmedEstimate"] = dict(EXAMPLE_ESTIMATE)
    body.update(overrides)
    return {key: value for key, value in body.items() if value is not None}


def code(response: Any) -> str:
    return response.json()["error"]["code"]


def details(response: Any) -> dict[str, Any]:
    return response.json()["error"]["details"]


def fields(response: Any) -> list[tuple[str, str]]:
    return [(item["field"], item["rule"]) for item in details(response)["fields"]]


Factory = Callable[..., Env]
