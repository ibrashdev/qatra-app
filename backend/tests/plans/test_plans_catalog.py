"""E14 and the catalog reads: metadata only, no session, both data modes."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.domain.plan_policy import edition_dto
from app.domain.rate_limit import SlidingWindowLimiter
from app.main import create_app
from app.providers.postgrest import PostgrestClient
from app.repositories.catalog import (
    BundleLoadError,
    MemoryCatalogRepository,
    MemoryContent,
    PostgrestCatalogRepository,
    edition_from_bundle,
)
from app.routers.plans import PUBLIC_READ_RATE_PER_MIN
from app.services.catalog import CatalogService
from tests.plans.fake_postgrest import ANON_KEY, FakePostgrest
from tests.plans.plans_support import (
    HADITH_ID,
    QURAN_ID,
    UNKNOWN_ID,
    USER_ID,
    browser,
    code,
    hadith_bundle,
    login_as,
    make_env,
    quran_bundle,
)
from tests.support import make_settings

EDITION_KEYS = {
    "editionId",
    "editionKey",
    "titleAr",
    "titleEn",
    "author",
    "editionLabel",
    "category",
    "catalogVersion",
    "contentFormat",
    "availablePaths",
    "defaultPaths",
    "defaultOrder",
    "totalWords",
    "sections",
}
SECTION_KEYS = {
    "sectionId",
    "ordinal",
    "kind",
    "reference",
    "titleAr",
    "titleEn",
    "wordCount",
    "passageCount",
    "paths",
}


@pytest.fixture
def env(tmp_path: Path):
    return make_env(tmp_path)


def test_e14_lists_the_published_editions_as_metadata_only(env) -> None:
    with TestClient(env.app) as visitor:  # no session, no Origin: a plain public read
        response = visitor.get("/api/catalog")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"editions"}
    assert [e["editionId"] for e in body["editions"]] == [str(HADITH_ID), str(QURAN_ID)]
    for edition in body["editions"]:
        assert set(edition) == EDITION_KEYS
        assert set(edition["category"]) == {"slug", "labelAr", "labelEn"}
        for section in edition["sections"]:
            assert set(section) == SECTION_KEYS
    raw = response.text.lower()
    for forbidden in ("https://", "sourceurl", "canonicaltext", "lesson", "question", "token"):
        assert forbidden not in raw


def test_e14_follows_the_documented_example_shape(env) -> None:
    quran = next(
        e
        for e in TestClient(env.app).get("/api/catalog").json()["editions"]
        if e["contentFormat"] == "quran"
    )
    assert quran["availablePaths"] == ["quran"]
    assert quran["defaultPaths"] == ["quran"]
    assert quran["defaultOrder"] == "book"
    assert quran["catalogVersion"] == 1
    assert quran["totalWords"] == 240
    first = quran["sections"][0]
    assert (first["ordinal"], first["kind"], first["reference"]) == (1, "surah", "78")
    assert (first["wordCount"], first["passageCount"], first["paths"]) == (100, 2, ["quran"])


def test_english_section_titles_are_numeric_labels(env) -> None:
    editions = TestClient(env.app).get("/api/catalog").json()["editions"]
    titles = {e["contentFormat"]: [s["titleEn"] for s in e["sections"]] for e in editions}
    assert titles["quran"] == ["Surah 78", "Surah 79", "Surah 80", "Surah 81"]
    assert titles["hadith_collection"] == ["Hadith 1", "Hadith 2", "Hadith 3"]


def test_hadith_counts_sum_the_default_matn_path(env) -> None:
    hadith = next(
        e
        for e in TestClient(env.app).get("/api/catalog").json()["editions"]
        if e["contentFormat"] == "hadith_collection"
    )
    assert hadith["availablePaths"] == ["matn", "sanad", "grade"]
    assert hadith["defaultPaths"] == ["matn"]
    assert hadith["totalWords"] == 60
    assert [s["wordCount"] for s in hadith["sections"]] == [10, 30, 20]


def test_reverse_order_adds_no_field_and_the_default_stays_book(env) -> None:
    for edition in TestClient(env.app).get("/api/catalog").json()["editions"]:
        assert edition["defaultOrder"] == "book"
        assert "order" not in edition and "orders" not in edition


def test_editions_are_ordered_by_edition_key(tmp_path: Path) -> None:
    env = make_env(tmp_path, quran_bundle(key="zzz"), hadith_bundle(key="aaa"))
    keys = [e["editionKey"] for e in TestClient(env.app).get("/api/catalog").json()["editions"]]
    assert keys == ["aaa", "zzz"]


def test_a_session_cookie_or_header_is_ignored(env) -> None:
    plain = TestClient(env.app).get("/api/catalog")
    cookie_client = TestClient(env.app)
    cookie_client.cookies.set("__Host-qatra_session", "garbage")
    with_cookie = cookie_client.get("/api/catalog")
    with_header = TestClient(env.app).get("/api/catalog", headers={"Authorization": "Bearer x"})
    assert with_cookie.status_code == with_header.status_code == 200
    assert with_cookie.json() == with_header.json() == plain.json()


def test_visitors_learners_and_demo_accounts_get_the_same_payload(env) -> None:
    visitor = TestClient(env.app).get("/api/catalog").json()
    login_as(env.app, demo=False)
    learner = browser(env.app).get("/api/catalog").json()
    login_as(env.app, USER_ID, demo=True)
    demo = browser(env.app).get("/api/catalog").json()
    assert visitor == learner == demo


def test_e14_is_never_cached(env) -> None:
    assert TestClient(env.app).get("/api/catalog").headers["cache-control"] == "no-store"


def test_empty_catalog_when_no_bundle_is_configured() -> None:
    app = create_app(make_settings())
    assert TestClient(app).get("/api/catalog").json() == {"editions": []}


def test_a_missing_english_label_falls_back_to_the_arabic_one(tmp_path: Path) -> None:
    env = make_env(tmp_path, quran_bundle(title_en=None, category_label_en=None))
    edition = TestClient(env.app).get("/api/catalog").json()["editions"][0]
    assert edition["titleEn"] == edition["titleAr"]
    assert edition["category"]["labelEn"] == edition["category"]["labelAr"]


def test_public_read_limit_is_60_per_client_ip_per_minute(env) -> None:
    assert PUBLIC_READ_RATE_PER_MIN == 60  # API-spec §1.8 (A-12 configuration default)
    env.app.state.public_read_limiter = SlidingWindowLimiter(3)
    client = TestClient(env.app)
    assert [client.get("/api/catalog").status_code for _ in range(3)] == [200, 200, 200]
    blocked = client.get("/api/catalog")
    assert (blocked.status_code, code(blocked)) == (429, "throttled")
    assert int(blocked.headers["retry-after"]) >= 1
    assert blocked.json()["error"]["details"]["retryAfterSec"] == int(
        blocked.headers["retry-after"]
    )


def test_the_limiter_is_created_with_the_documented_limit(env) -> None:
    client = TestClient(env.app)
    assert client.get("/api/catalog").status_code == 200
    limiter = env.app.state.public_read_limiter
    assert isinstance(limiter, SlidingWindowLimiter)
    assert limiter._limit == 60


def test_the_catalog_needs_the_service_to_be_installed(env) -> None:
    env.app.state.catalog_service = None
    response = TestClient(env.app).get("/api/catalog")
    assert (response.status_code, code(response)) == (503, "unavailable")


def test_the_bundle_loader_keeps_metadata_and_counts_only() -> None:
    data, passages = edition_from_bundle(quran_bundle())
    assert data.edition_id == QURAN_ID and data.catalog_version == 1
    assert data.available_paths == ("quran",)
    assert dict(data.path_words) == {"quran": 240} and dict(data.path_passages) == {"quran": 6}
    assert [s.ordinal for s in data.sections] == [1, 2, 3, 4]
    assert len(passages) == 6
    dumped = repr(data) + repr(passages)
    assert "example.invalid" not in dumped  # a section's sourceUrl is not carried


# --- supabase mode: the two public views over PostgREST ------------------------------------------


def make_fake() -> tuple[FakePostgrest, PostgrestCatalogRepository, MemoryContent]:
    content = MemoryContent.from_bundles([quran_bundle(), hadith_bundle()])
    entries = [
        (content.edition(e.edition_id), content.passages(e.edition_id)) for e in content.editions()
    ]
    fake = FakePostgrest(entries)
    client = PostgrestClient("https://project.example", ANON_KEY, transport=fake.transport())
    return fake, PostgrestCatalogRepository(client), content


def test_the_views_are_read_with_the_anon_key_and_nothing_else() -> None:
    fake, repository, content = make_fake()
    editions = repository.list_editions()
    assert [e.edition_key for e in editions] == ["hadith-test", "quran-test"]
    assert {call.path for call in fake.calls} == {"/catalog_editions", "/catalog_sections"}
    for call in fake.calls:
        assert call.method == "GET"
        assert call.headers["apikey"] == ANON_KEY
        assert "authorization" not in call.headers  # no session, no learner token
    assert fake.calls[0].params["order"] == "edition_key.asc"


def test_the_view_rows_give_the_same_catalog_as_the_bundles() -> None:
    _, repository, content = make_fake()
    from_views = [edition_dto(e).model_dump(by_alias=True) for e in repository.list_editions()]
    from_bundles = [edition_dto(e).model_dump(by_alias=True) for e in content.editions()]
    assert from_views == from_bundles


def test_one_edition_is_read_with_a_filter_and_an_unknown_one_is_none() -> None:
    fake, repository, _ = make_fake()
    edition = repository.get_edition(QURAN_ID)
    assert edition is not None and edition.edition_key == "quran-test"
    assert all(call.params["edition_id"] == f"eq.{QURAN_ID}" for call in fake.calls)
    fake.calls.clear()
    assert repository.get_edition(UNKNOWN_ID) is None
    assert [call.path for call in fake.calls] == ["/catalog_editions"]


def test_e14_over_postgrest_returns_the_same_json_as_memory_mode(tmp_path: Path) -> None:
    env = make_env(tmp_path)
    expected = TestClient(env.app).get("/api/catalog").json()
    _, repository, _ = make_fake()
    env.app.state.catalog_service = CatalogService(repository)
    assert TestClient(env.app).get("/api/catalog").json() == expected


def test_a_database_outage_is_503_for_the_public_catalog(tmp_path: Path) -> None:
    env = make_env(tmp_path)
    fake, repository, _ = make_fake()
    fake.fail("catalog_editions", httpx.ConnectError("boom"))
    env.app.state.catalog_service = CatalogService(repository)
    response = TestClient(env.app).get("/api/catalog")
    assert (response.status_code, code(response)) == (503, "unavailable")
    assert "boom" not in response.text


def test_a_view_row_of_the_wrong_shape_is_an_internal_error(tmp_path: Path) -> None:
    env = make_env(tmp_path)
    fake, repository, _ = make_fake()
    fake.fail(
        "catalog_sections",
        httpx.Response(200, json=[{"edition_id": str(QURAN_ID), "ordinal": "x"}]),
    )
    env.app.state.catalog_service = CatalogService(repository)
    response = TestClient(env.app).get("/api/catalog")
    assert (response.status_code, code(response)) == (500, "internal")


def test_memory_repository_lists_in_key_order() -> None:
    content = MemoryContent.from_bundles([quran_bundle(key="b"), hadith_bundle(key="a")])
    assert [e.edition_key for e in MemoryCatalogRepository(content).list_editions()] == ["a", "b"]


# --- strictness of the loaders -------------------------------------------------------------------


@pytest.mark.parametrize(
    "damage",
    [
        lambda b: b["sections"][0].pop("titleEn"),
        lambda b: b["sections"][0].update(titleEn=None),
        lambda b: b["sections"][0].update(kind="chapter"),
        lambda b: b["book"].update(contentFormat="pdf"),
        lambda b: b["book"].update(author=""),
        lambda b: b["passages"][0].update(path="takhrij"),
        lambda b: b["passages"][0].update(wordCount=-1),
        lambda b: b["passages"][0].update(wordCount=True),
        lambda b: b.update(bankVersion="1"),
        lambda b: b["edition"].update(id="not-a-uuid"),
    ],
    ids=[
        "no English section title",
        "null English section title",
        "unknown section kind",
        "unknown content format",
        "empty author",
        "unknown path",
        "negative words",
        "boolean words",
        "bank version as text",
        "edition id",
    ],
)
def test_a_damaged_bundle_is_refused_not_guessed(damage) -> None:
    bundle = quran_bundle()
    damage(bundle)
    with pytest.raises(BundleLoadError):
        edition_from_bundle(bundle)


def test_a_view_row_with_a_null_required_text_is_an_internal_error(tmp_path: Path) -> None:
    env = make_env(tmp_path)
    fake, repository, _ = make_fake()
    section = {
        "edition_id": str(QURAN_ID),
        "section_id": "22222222-2222-4222-8222-000000000001",
        "ordinal": 1,
        "kind": "surah",
        "reference": "78",
        "title_ar": "x",
        "title_en": None,  # the schema makes it non-empty: a null means drift
        "path_stats": {},
    }
    fake.fail("catalog_sections", httpx.Response(200, json=[section]))
    env.app.state.catalog_service = CatalogService(repository)
    response = TestClient(env.app).get("/api/catalog")
    assert (response.status_code, code(response)) == (500, "internal")
