"""The content manager admin over HTTP (docs/Content-admin.md sections 2 and 4): guards and their
order, who may enter, the answers of every route, the error envelope, the one log event.

Sessions are real: accounts are registered through the authentication routes of the harness and the
session cookie travels in the client, so ``require_session_details`` resolves the username."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import create_app
from app.repositories.content_admin import (
    MemoryContentAdminRepository,
    PostgrestContentAdminRepository,
)
from app.services.content_admin import ContentAdminService
from tests.auth.auth_support import PASSWORD, TERMS, Harness, build_harness, register
from tests.content_admin.support import (
    ANON_KEY,
    IDS,
    SERVICE_KEY,
    SUPABASE_URL,
    FakePostgrest,
    seed_catalog,
    uid,
)
from tests.support import FRONTEND_ORIGIN, make_settings

STAMP = "2026-10-05T09:00:00Z"
FAKE_KEY = "sk-or-synthetic-test-key-123"
MANAGER_SETTING = " Sample_User_01 , other_name "


def repo_of(app: FastAPI) -> MemoryContentAdminRepository:
    service: ContentAdminService = app.state.content_admin_service
    repo = service._repo
    assert isinstance(repo, MemoryContentAdminRepository)
    return repo


def build(**settings: Any) -> Harness:
    settings.setdefault("QATRA_CONTENT_MANAGER_USERNAMES", MANAGER_SETTING)
    harness = build_harness(**settings)
    seed_catalog(repo_of(harness.app))
    return harness


@pytest.fixture
def harness() -> Iterator[Harness]:
    """A memory-mode app with the admin installed and the manager (``sample_user_01``) signed in
    on ``harness.client``."""
    built = build()
    with built.client:
        assert register(built.client).status_code == 201
        yield built


@pytest.fixture
def client(harness: Harness) -> TestClient:
    return harness.client


def code_of(response: httpx.Response) -> str:
    return str(response.json()["error"]["code"])


def reason_of(response: httpx.Response) -> str:
    return str(response.json()["error"]["details"]["reason"])


def stamp_of(client: TestClient, path: str, *keys: str) -> str:
    """``updatedAt`` of the object at ``path`` (``keys`` walk into the body first)."""
    body = client.get(path).json()
    for key in keys:
        body = body[int(key)] if isinstance(body, list) else body[key]
    return str(body["updatedAt"])


def second_learner(harness: Harness) -> TestClient:
    other = harness.new_client("203.0.113.10")
    assert register(other, username="second_user").status_code == 201
    return other


# every route of spec section 4, with a body that is valid for it
ROUTES: list[tuple[str, str, dict[str, Any] | None]] = [
    ("GET", "/api/admin/access", None),
    ("GET", "/api/admin/overview", None),
    ("GET", f"/api/admin/editions/{IDS.published}", None),
    (
        "PATCH",
        f"/api/admin/editions/{IDS.published}",
        {"expectedUpdatedAt": STAMP, "editionLabel": "x"},
    ),
    (
        "POST",
        f"/api/admin/editions/{IDS.published}/withdraw",
        {"expectedUpdatedAt": STAMP, "reason": "rights", "note": "n"},
    ),
    ("POST", f"/api/admin/editions/{IDS.published}/archive", {"expectedUpdatedAt": STAMP}),
    ("POST", f"/api/admin/editions/{IDS.published}/unarchive", {"expectedUpdatedAt": STAMP}),
    ("POST", f"/api/admin/editions/{IDS.draft}/delete", {"expectedUpdatedAt": STAMP}),
    ("GET", f"/api/admin/sections/{IDS.section}", None),
    ("PATCH", f"/api/admin/sections/{IDS.section}", {"titleAr": "x"}),
    ("GET", "/api/admin/books", None),
    ("PATCH", f"/api/admin/books/{IDS.book}", {"expectedUpdatedAt": STAMP, "author": "x"}),
    ("POST", f"/api/admin/books/{IDS.empty_book}/delete", {"expectedUpdatedAt": STAMP}),
    ("GET", "/api/admin/categories", None),
    (
        "PATCH",
        f"/api/admin/categories/{IDS.category}",
        {"expectedUpdatedAt": STAMP, "displayOrder": 1},
    ),
    ("POST", f"/api/admin/categories/{IDS.empty_category}/delete", {"expectedUpdatedAt": STAMP}),
    ("GET", "/api/admin/sources", None),
    ("PATCH", f"/api/admin/sources/{IDS.source}", {"expectedUpdatedAt": STAMP, "title": "x"}),
    ("POST", f"/api/admin/sources/{IDS.empty_source}/delete", {"expectedUpdatedAt": STAMP}),
]
ROUTE_IDS = [f"{method} {path.removeprefix('/api/admin')}" for method, path, _ in ROUTES]
# every route but the access probe: a non-manager gets 403 there (the probe answers 200 false)
GUARDED = [route for route in ROUTES if route[1] != "/api/admin/access"]
GUARDED_IDS = [f"{method} {path.removeprefix('/api/admin')}" for method, path, _ in GUARDED]


def call(client: TestClient, route: tuple[str, str, dict[str, Any] | None]) -> httpx.Response:
    method, path, body = route
    return client.request(method, path, json=body)


def test_the_routes_are_exactly_the_ones_of_the_spec(harness: Harness) -> None:
    paths = harness.app.openapi()["paths"]
    found = {
        (method.upper(), path)
        for path, operations in paths.items()
        if path.startswith("/api/admin")
        for method in operations
    }
    expected = {
        ("GET", "/api/admin/access"),
        ("GET", "/api/admin/overview"),
        ("GET", "/api/admin/editions/{edition_id}"),
        ("PATCH", "/api/admin/editions/{edition_id}"),
        ("POST", "/api/admin/editions/{edition_id}/withdraw"),
        ("POST", "/api/admin/editions/{edition_id}/archive"),
        ("POST", "/api/admin/editions/{edition_id}/unarchive"),
        ("POST", "/api/admin/editions/{edition_id}/delete"),
        ("GET", "/api/admin/sections/{section_id}"),
        ("PATCH", "/api/admin/sections/{section_id}"),
        ("GET", "/api/admin/books"),
        ("PATCH", "/api/admin/books/{book_id}"),
        ("POST", "/api/admin/books/{book_id}/delete"),
        ("GET", "/api/admin/categories"),
        ("PATCH", "/api/admin/categories/{category_id}"),
        ("POST", "/api/admin/categories/{category_id}/delete"),
        ("GET", "/api/admin/sources"),
        ("PATCH", "/api/admin/sources/{source_id}"),
        ("POST", "/api/admin/sources/{source_id}/delete"),
    }
    assert found == expected  # no create, no account, no approve or publish route


# --- who may enter --------------------------------------------------------------------------------


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_a_visitor_is_unauthenticated(harness: Harness, route) -> None:
    visitor = harness.new_client("203.0.113.20")
    response = call(visitor, route)
    assert (response.status_code, code_of(response)) == (401, "unauthenticated")


@pytest.mark.parametrize("route", GUARDED, ids=GUARDED_IDS)
def test_a_signed_in_account_that_is_not_listed_is_forbidden(harness: Harness, route) -> None:
    other = second_learner(harness)
    response = call(other, route)
    assert (response.status_code, code_of(response)) == (403, "forbidden")


def demo_client(harness: Harness) -> TestClient:
    """A client with a live demo session (``demo_learner``, ``is_demo``)."""
    demo = harness.auth.register_account(
        username="demo_learner",
        password=PASSWORD,
        time_zone="Asia/Dubai",
        language="en",
        terms_accepted=True,
        terms_version=TERMS,
        is_demo=True,
    )
    client = harness.new_client()
    client.cookies.set("qatra_session", demo.cookie_value)
    return client


@pytest.mark.parametrize("route", GUARDED, ids=GUARDED_IDS)
def test_a_demo_session_is_never_a_manager(route) -> None:
    harness = build(QATRA_CONTENT_MANAGER_USERNAMES="demo_learner")
    with demo_client(harness) as client:
        response = call(client, route)
        assert (response.status_code, code_of(response)) == (403, "forbidden")


@pytest.mark.parametrize("setting", [None, "", "   ", " , "])
def test_an_empty_or_missing_list_means_nobody(setting: str | None) -> None:
    overrides: dict[str, Any] = (
        {} if setting is None else {"QATRA_CONTENT_MANAGER_USERNAMES": setting}
    )
    harness = build_harness(**overrides)
    seed_catalog(repo_of(harness.app))
    with harness.client:
        register(harness.client)
        for route in GUARDED[:3]:
            response = call(harness.client, route)
            assert (response.status_code, code_of(response)) == (403, "forbidden")


@pytest.mark.parametrize("name", ["Sample_User_01", "SAMPLE_USER_01", " sample_user_01 "])
def test_the_list_is_compared_with_the_normalized_username(name: str) -> None:
    harness = build(QATRA_CONTENT_MANAGER_USERNAMES=f"nobody_here,{name}")
    with harness.client:
        register(harness.client)
        response = harness.client.get("/api/admin/access")
        assert (response.status_code, response.json()) == (200, {"contentManager": True})


# --- the access probe: 200 for every signed-in account -------------------------------------------


def test_access_answers_true_for_a_manager(client: TestClient) -> None:
    response = client.get("/api/admin/access")
    assert (response.status_code, response.json()) == (200, {"contentManager": True})
    assert response.headers["cache-control"] == "no-store"


def test_access_answers_false_not_403_for_a_signed_in_non_manager(harness: Harness) -> None:
    other = second_learner(harness)
    response = other.get("/api/admin/access")
    assert (response.status_code, response.json()) == (200, {"contentManager": False})
    assert response.headers["cache-control"] == "no-store"
    # another name in the list does not let a different account into the other routes
    assert other.get("/api/admin/overview").status_code == 403


def test_access_answers_false_for_a_demo_session_even_when_its_name_is_listed() -> None:
    harness = build(QATRA_CONTENT_MANAGER_USERNAMES="demo_learner")
    with demo_client(harness) as client:
        response = client.get("/api/admin/access")
        assert (response.status_code, response.json()) == (200, {"contentManager": False})


@pytest.mark.parametrize("setting", [None, "", "   ", " , "])
def test_access_answers_false_for_everybody_when_the_list_is_empty(setting: str | None) -> None:
    overrides: dict[str, Any] = (
        {} if setting is None else {"QATRA_CONTENT_MANAGER_USERNAMES": setting}
    )
    harness = build_harness(**overrides)
    with harness.client:
        register(harness.client)
        response = harness.client.get("/api/admin/access")
        assert (response.status_code, response.json()) == (200, {"contentManager": False})


def test_access_for_a_signed_out_visitor_is_unauthenticated(harness: Harness) -> None:
    visitor = harness.new_client("203.0.113.23")
    response = visitor.get("/api/admin/access")
    assert (response.status_code, code_of(response)) == (401, "unauthenticated")
    assert response.headers["cache-control"] == "no-store"


def test_access_does_not_need_the_content_service(harness: Harness) -> None:
    harness.app.state.content_admin_service = None
    assert harness.client.get("/api/admin/access").json() == {"contentManager": True}
    other = second_learner(harness)
    assert other.get("/api/admin/access").json() == {"contentManager": False}


def test_access_uses_the_admin_limit_for_every_signed_in_account() -> None:
    harness = build(QATRA_RATE_ADMIN_PER_MIN=2)
    with harness.client:
        register(harness.client)
        other = second_learner(harness)
        assert [other.get("/api/admin/access").status_code for _ in range(3)] == [200, 200, 429]
        throttled = other.get("/api/admin/access")
        assert (throttled.status_code, code_of(throttled)) == (429, "throttled")
        assert int(throttled.headers["retry-after"]) >= 1


# --- guard order ----------------------------------------------------------------------------------

MUTATIONS = [route for route in ROUTES if route[0] != "GET"]
MUTATION_IDS = [f"{m} {p.removeprefix('/api/admin')}" for m, p, _ in MUTATIONS]


@pytest.mark.parametrize("route", MUTATIONS, ids=MUTATION_IDS)
def test_origin_is_checked_before_the_session_and_the_manager(harness: Harness, route) -> None:
    method, path, body = route
    for cookies in (False, True):  # a visitor, and the signed-in manager
        plain = TestClient(harness.app)  # no default Origin header
        if cookies:
            plain.cookies.update(harness.client.cookies)
        missing = plain.request(method, path, json=body)
        assert (missing.status_code, code_of(missing)) == (403, "forbidden_origin")
        wrong = plain.request(method, path, json=body, headers={"Origin": "http://evil.example"})
        assert (wrong.status_code, code_of(wrong)) == (403, "forbidden_origin")


@pytest.mark.parametrize("route", MUTATIONS, ids=MUTATION_IDS)
def test_the_session_and_the_manager_check_come_before_the_body(harness: Harness, route) -> None:
    method, path, _ = route
    other = second_learner(harness)
    invalid = other.request(method, path, json={"unknownField": 1})
    assert (invalid.status_code, code_of(invalid)) == (403, "forbidden")
    visitor = harness.new_client("203.0.113.21")
    invalid = visitor.request(method, path, json={"unknownField": 1})
    assert (invalid.status_code, code_of(invalid)) == (401, "unauthenticated")


def test_the_admin_limit_counts_a_manager_per_client_address() -> None:
    harness = build(QATRA_RATE_ADMIN_PER_MIN=3)
    with harness.client:
        register(harness.client)
        statuses = [harness.client.get("/api/admin/access").status_code for _ in range(4)]
        assert statuses == [200, 200, 200, 429]
        throttled = harness.client.get("/api/admin/overview")
        assert (throttled.status_code, code_of(throttled)) == (429, "throttled")
        assert int(throttled.headers["retry-after"]) >= 1
        assert throttled.json()["error"]["details"]["retryAfterSec"] >= 1


def test_requests_the_manager_check_refuses_do_not_use_up_the_admin_limit() -> None:
    harness = build(QATRA_RATE_ADMIN_PER_MIN=2)
    with harness.client:
        register(harness.client)
        other = second_learner(harness)
        assert [other.get("/api/admin/overview").status_code for _ in range(5)] == [403] * 5
        assert harness.client.get("/api/admin/overview").status_code == 200


def test_a_missing_service_answers_unavailable_after_the_guards(harness: Harness) -> None:
    harness.app.state.content_admin_service = None
    unavailable = harness.client.get("/api/admin/overview")
    assert (unavailable.status_code, code_of(unavailable)) == (503, "unavailable")
    for route in MUTATIONS:
        response = call(harness.client, route)
        assert (response.status_code, code_of(response)) == (503, "unavailable")
    assert harness.client.get("/api/admin/access").status_code == 200  # a pure access check
    visitor = harness.new_client("203.0.113.22")
    assert visitor.get("/api/admin/overview").status_code == 401  # guards still come first
    other = second_learner(harness)
    assert other.get("/api/admin/overview").status_code == 403


# --- wiring ---------------------------------------------------------------------------------------


def test_supabase_mode_without_url_or_service_key_has_no_service() -> None:
    for values in (
        {},
        {"SUPABASE_URL": SUPABASE_URL},
        {"SUPABASE_SERVICE_ROLE_KEY": SERVICE_KEY, "SUPABASE_ANON_KEY": ANON_KEY},
    ):
        app = create_app(make_settings(QATRA_DATA_BACKEND="supabase", **values))
        assert app.state.content_admin_service is None
        with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as client:
            assert client.get("/api/admin/access").status_code == 401  # routes exist


def test_supabase_mode_with_url_and_service_key_uses_postgrest() -> None:
    fake = FakePostgrest({})
    app = create_app(
        make_settings(
            QATRA_DATA_BACKEND="supabase",
            SUPABASE_URL=SUPABASE_URL,
            SUPABASE_ANON_KEY=ANON_KEY,
            SUPABASE_SERVICE_ROLE_KEY=SERVICE_KEY,
        ),
        transport=fake.transport(),
    )
    service: ContentAdminService = app.state.content_admin_service
    assert isinstance(service._repo, PostgrestContentAdminRepository)
    assert SERVICE_KEY not in repr(service) + repr(service._repo)


def test_the_memory_service_starts_empty() -> None:
    app = create_app(make_settings())
    repo = repo_of(app)
    assert repo.counts() == {"categories": 0, "books": 0, "sources": 0}


# --- reads ----------------------------------------------------------------------------------------


def test_overview(client: TestClient) -> None:
    body = client.get("/api/admin/overview").json()
    assert set(body) == {"counts", "editions", "ai"}
    assert body["counts"] == {
        "categories": 2,
        "books": 2,
        "sources": 2,
        "editions": {"draft": 1, "validated": 0, "published": 1, "superseded": 0, "revoked": 0},
    }
    assert [e["version"] for e in body["editions"]] == [2, 1]
    assert set(body["editions"][0]) == {
        "id",
        "editionKey",
        "editionLabel",
        "language",
        "version",
        "bankVersion",
        "status",
        "catalogHidden",
        "archivedAt",
        "updatedAt",
        "book",
    }
    assert set(body["editions"][0]["book"]) == {"id", "titleAr", "titleEn"}


def test_the_ai_card_is_configuration_and_counters_never_the_key() -> None:
    harness = build(
        OPENROUTER_API_KEY=FAKE_KEY,
        OPENROUTER_MODELS="model-a:free,model-b:free",
        QATRA_CHAT_MODEL_FOR_LEARNERS=True,
        QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY=9,
    )
    with harness.client:
        register(harness.client)
        response = harness.client.get("/api/admin/overview")
        assert FAKE_KEY not in response.text
        ai = response.json()["ai"]
        assert set(ai) == {
            "chatModelForLearners",
            "providerConfigured",
            "models",
            "dailyCap",
            "usedToday",
            "usedLastMinute",
        }
        assert (ai["chatModelForLearners"], ai["providerConfigured"]) == (True, True)
        assert (ai["models"], ai["dailyCap"]) == (["model-a:free", "model-b:free"], 9)
        # the plan conversation's in-process ledger is reachable in memory mode and still empty
        assert (ai["usedToday"], ai["usedLastMinute"]) == (0, 0)


def test_the_ai_card_without_a_provider(client: TestClient) -> None:
    ai = client.get("/api/admin/overview").json()["ai"]
    assert (ai["providerConfigured"], ai["models"], ai["chatModelForLearners"]) == (
        False,
        [],
        False,
    )


def test_edition_detail(client: TestClient) -> None:
    response = client.get(f"/api/admin/editions/{IDS.published}")
    body = response.json()
    assert response.status_code == 200
    assert {
        "source",
        "contentHash",
        "approval",
        "withdrawal",
        "counts",
        "sections",
        "jobs",
        "actions",
    } <= set(body)
    assert body["approval"]["who"] == "Synthetic Owner" and "note" not in body["approval"]
    assert body["actions"] == {
        "editLabel": True,
        "archive": True,
        "unarchive": False,
        "withdraw": True,
        "delete": False,
    }


def test_section_books_categories_and_sources_reads(client: TestClient) -> None:
    section = client.get(f"/api/admin/sections/{IDS.section}").json()
    assert section["questionCounts"] == {
        "wordOrder": 1,
        "wordChoice": 2,
        "wordRecall": 0,
        "similarDistinction": 1,
    }
    assert [u["ordinal"] for u in section["units"]] == [1, 2]
    books = client.get("/api/admin/books").json()
    assert set(books) == {"books", "categories"} and books["books"][0]["editionCount"] == 2
    assert client.get("/api/admin/categories").json()["categories"][0]["bookCount"] == 2
    assert client.get("/api/admin/sources").json()["sources"][0]["editionCount"] == 2


@pytest.mark.parametrize(
    "path",
    [
        f"/api/admin/editions/{uid(999)}",
        f"/api/admin/sections/{uid(999)}",
    ],
)
def test_an_unknown_id_is_not_found(client: TestClient, path: str) -> None:
    response = client.get(path)
    assert (response.status_code, code_of(response)) == (404, "not_found")


@pytest.mark.parametrize("path", ["/api/admin/editions/not-a-uuid", "/api/admin/sections/12"])
def test_a_path_id_must_be_a_uuid(client: TestClient, path: str) -> None:
    response = client.get(path)
    assert (response.status_code, code_of(response)) == (422, "validation_error")
    assert response.json()["error"]["details"]["fields"][0]["field"].startswith("path.")


# --- edits and removals ---------------------------------------------------------------------------


def test_rename_an_edition_and_the_token_moves_on(client: TestClient) -> None:
    path = f"/api/admin/editions/{IDS.published}"
    before = stamp_of(client, path)
    response = client.patch(path, json={"expectedUpdatedAt": before, "editionLabel": " New label "})
    assert response.status_code == 200
    body = response.json()
    assert body["editionLabel"] == "New label" and body["updatedAt"] != before
    again = client.patch(path, json={"expectedUpdatedAt": before, "editionLabel": "Other"})
    assert (again.status_code, code_of(again), reason_of(again)) == (
        409,
        "version_conflict",
        "stale",
    )
    assert (
        client.patch(
            path, json={"expectedUpdatedAt": body["updatedAt"], "editionLabel": "Other"}
        ).status_code
        == 200
    )


def test_hide_show_and_withdraw_an_edition(harness: Harness, client: TestClient) -> None:
    path = f"/api/admin/editions/{IDS.published}"
    hidden = client.post(
        f"{path}/archive", json={"expectedUpdatedAt": stamp_of(client, path)}
    ).json()
    assert hidden["catalogHidden"] is True and hidden["archivedAt"] is not None
    assert (hidden["actions"]["archive"], hidden["actions"]["unarchive"]) == (False, True)
    shown = client.post(f"{path}/unarchive", json={"expectedUpdatedAt": hidden["updatedAt"]}).json()
    assert shown["catalogHidden"] is False and shown["archivedAt"] is None
    withdrawn = client.post(
        f"{path}/withdraw",
        json={
            "expectedUpdatedAt": shown["updatedAt"],
            "reason": "accreditation",
            "note": "synthetic",
        },
    )
    assert withdrawn.status_code == 200
    body = withdrawn.json()
    assert body["status"] == "revoked"
    assert (
        body["withdrawal"]["reason"] == "accreditation"
        and body["withdrawal"]["note"] == "synthetic"
    )
    assert body["approval"]["who"] == "Synthetic Owner"  # kept
    assert set(body["actions"].values()) == {False}
    assert repo_of(harness.app).redacted == [str(IDS.published)]
    assert [j["step"] for j in body["jobs"]][-2:] == ["archived", "withdrawn"]


def test_withdraw_is_a_state_conflict_for_a_draft(client: TestClient) -> None:
    path = f"/api/admin/editions/{IDS.draft}"
    response = client.post(
        f"{path}/withdraw",
        json={"expectedUpdatedAt": stamp_of(client, path), "reason": "rights", "note": "n"},
    )
    assert (response.status_code, code_of(response), reason_of(response)) == (
        409,
        "version_conflict",
        "state",
    )


def test_a_failed_withdraw_step_is_unavailable_over_http(
    harness: Harness, client: TestClient
) -> None:
    path = f"/api/admin/editions/{IDS.published}"
    body = {"expectedUpdatedAt": stamp_of(client, path), "reason": "rights", "note": "n"}
    repo_of(harness.app).fail_on = {"redact"}
    failed = client.post(f"{path}/withdraw", json=body)
    assert (failed.status_code, code_of(failed)) == (503, "unavailable")
    assert client.get(path).json()["status"] == "revoked"
    repo_of(harness.app).fail_on = set()
    assert client.post(f"{path}/withdraw", json=body).status_code == 200


def test_delete_a_draft_edition_answers_no_content(client: TestClient) -> None:
    path = f"/api/admin/editions/{IDS.draft}"
    response = client.post(f"{path}/delete", json={"expectedUpdatedAt": stamp_of(client, path)})
    assert (response.status_code, response.content) == (204, b"")
    assert response.headers["cache-control"] == "no-store"
    assert client.get(path).status_code == 404


def test_a_published_edition_cannot_be_deleted(client: TestClient) -> None:
    path = f"/api/admin/editions/{IDS.published}"
    response = client.post(f"{path}/delete", json={"expectedUpdatedAt": stamp_of(client, path)})
    assert (response.status_code, reason_of(response)) == (409, "state")


def test_a_draft_a_learner_uses_is_in_use(harness: Harness, client: TestClient) -> None:
    repo_of(harness.app).learner_edition_ids.add(str(IDS.draft))
    path = f"/api/admin/editions/{IDS.draft}"
    response = client.post(f"{path}/delete", json={"expectedUpdatedAt": stamp_of(client, path)})
    assert (response.status_code, reason_of(response)) == (409, "in_use")


def test_rename_a_section(client: TestClient) -> None:
    path = f"/api/admin/sections/{IDS.section}"
    response = client.patch(path, json={"titleAr": "عنوان جديد", "titleEn": "New title"})
    assert response.status_code == 200
    body = response.json()
    assert (body["titleAr"], body["titleEn"]) == ("عنوان جديد", "New title")
    assert [u["ordinal"] for u in body["units"]] == [1, 2]  # the original text stays read only


def test_books_edit_and_delete(client: TestClient) -> None:
    path = f"/api/admin/books/{IDS.book}"
    stamp = stamp_of(client, "/api/admin/books", "books", "0")
    response = client.patch(
        path,
        json={
            "expectedUpdatedAt": stamp,
            "titleEn": None,
            "author": "مؤلف آخر",
            "categoryId": str(IDS.empty_category),
        },
    )
    assert response.status_code == 200
    book = response.json()
    assert book["titleEn"] is None and book["author"] == "مؤلف آخر"
    assert book["category"]["id"] == str(IDS.empty_category)
    used = client.post(f"{path}/delete", json={"expectedUpdatedAt": book["updatedAt"]})
    assert (used.status_code, reason_of(used)) == (409, "in_use")
    unused = f"/api/admin/books/{IDS.empty_book}"
    stamp = stamp_of(client, "/api/admin/books", "books", "1")
    assert client.post(f"{unused}/delete", json={"expectedUpdatedAt": stamp}).status_code == 204


def test_an_unknown_book_category_is_a_validation_error(client: TestClient) -> None:
    stamp = stamp_of(client, "/api/admin/books", "books", "0")
    response = client.patch(
        f"/api/admin/books/{IDS.book}",
        json={"expectedUpdatedAt": stamp, "categoryId": str(uid(999))},
    )
    assert (response.status_code, code_of(response)) == (422, "validation_error")
    assert response.json()["error"]["details"]["fields"] == [
        {"field": "categoryId", "rule": "category_not_found"}
    ]


def test_categories_edit_and_delete(client: TestClient) -> None:
    stamp = stamp_of(client, "/api/admin/categories", "categories", "0")
    response = client.patch(
        f"/api/admin/categories/{IDS.category}",
        json={"expectedUpdatedAt": stamp, "labelEn": None, "displayOrder": 7},
    )
    assert response.status_code == 200
    category = response.json()
    assert (category["labelEn"], category["displayOrder"], category["slug"]) == (
        None,
        7,
        "demo-category",
    )
    used = client.post(
        f"/api/admin/categories/{IDS.category}/delete",
        json={"expectedUpdatedAt": category["updatedAt"]},
    )
    assert (used.status_code, reason_of(used)) == (409, "in_use")
    stamp = stamp_of(client, "/api/admin/categories", "categories", "0")  # sorted: 7 comes last
    empty = client.get("/api/admin/categories").json()["categories"][0]
    assert empty["id"] == str(IDS.empty_category)
    deleted = client.post(
        f"/api/admin/categories/{empty['id']}/delete",
        json={"expectedUpdatedAt": empty["updatedAt"]},
    )
    assert deleted.status_code == 204 and stamp


def test_sources_edit_and_delete(client: TestClient) -> None:
    stamp = stamp_of(client, "/api/admin/sources", "sources", "0")
    response = client.patch(
        f"/api/admin/sources/{IDS.source}",
        json={
            "expectedUpdatedAt": stamp,
            "title": "Renamed",
            "licenseUrl": None,
            "rightsStatus": "verified",
        },
    )
    assert response.status_code == 200
    source = response.json()
    assert (source["title"], source["licenseUrl"], source["rightsStatus"]) == (
        "Renamed",
        None,
        "verified",
    )
    assert source["sourceUrl"] == "https://example.invalid/source"
    used = client.post(
        f"/api/admin/sources/{IDS.source}/delete", json={"expectedUpdatedAt": source["updatedAt"]}
    )
    assert (used.status_code, reason_of(used)) == (409, "in_use")
    unused = client.get("/api/admin/sources").json()["sources"][1]
    assert unused["id"] == str(IDS.empty_source)
    assert (
        client.post(
            f"/api/admin/sources/{unused['id']}/delete",
            json={"expectedUpdatedAt": unused["updatedAt"]},
        ).status_code
        == 204
    )


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("PATCH", f"/api/admin/editions/{uid(999)}"),
        ("POST", f"/api/admin/editions/{uid(999)}/archive"),
        ("POST", f"/api/admin/editions/{uid(999)}/unarchive"),
        ("POST", f"/api/admin/editions/{uid(999)}/withdraw"),
        ("POST", f"/api/admin/editions/{uid(999)}/delete"),
        ("PATCH", f"/api/admin/sections/{uid(999)}"),
        ("PATCH", f"/api/admin/books/{uid(999)}"),
        ("POST", f"/api/admin/books/{uid(999)}/delete"),
        ("PATCH", f"/api/admin/categories/{uid(999)}"),
        ("POST", f"/api/admin/categories/{uid(999)}/delete"),
        ("PATCH", f"/api/admin/sources/{uid(999)}"),
        ("POST", f"/api/admin/sources/{uid(999)}/delete"),
    ],
)
def test_a_write_to_an_unknown_id_is_not_found(client: TestClient, method: str, path: str) -> None:
    body: dict[str, Any] = {"expectedUpdatedAt": STAMP}
    if "editions" in path and method == "PATCH":
        body["editionLabel"] = "x"
    elif path.endswith("/withdraw"):
        body.update(reason="rights", note="n")
    elif method == "PATCH":
        body = {"titleAr": "x"} if "sections" in path else {**body, _FIELD[path.split("/")[3]]: "x"}
    response = client.request(method, path, json=body)
    assert (response.status_code, code_of(response)) == (404, "not_found")


_FIELD = {"books": "author", "categories": "labelAr", "sources": "title"}


# --- validation over HTTP -------------------------------------------------------------------------

BAD_BODIES: list[tuple[str, str, dict[str, Any], str, str]] = [
    # (method, path template, body, field, rule)
    ("PATCH", "editions/{e}", {"editionLabel": "x"}, "expectedUpdatedAt", "required"),
    (
        "PATCH",
        "editions/{e}",
        {"expectedUpdatedAt": "yesterday", "editionLabel": "x"},
        "expectedUpdatedAt",
        "timestamp_invalid",
    ),
    (
        "PATCH",
        "editions/{e}",
        {"expectedUpdatedAt": "2026-10-05T09:00:00", "editionLabel": "x"},
        "expectedUpdatedAt",
        "timestamp_invalid",
    ),
    (
        "PATCH",
        "editions/{e}",
        {"expectedUpdatedAt": STAMP, "editionLabel": ""},
        "editionLabel",
        "text_length",
    ),
    (
        "PATCH",
        "editions/{e}",
        {"expectedUpdatedAt": STAMP, "editionLabel": "x" * 121},
        "editionLabel",
        "text_length",
    ),
    (
        "PATCH",
        "editions/{e}",
        {"expectedUpdatedAt": STAMP, "editionLabel": "a\u0000b"},
        "editionLabel",
        "text_control_chars",
    ),
    (
        "PATCH",
        "editions/{e}",
        {"expectedUpdatedAt": STAMP, "editionLabel": 5},
        "editionLabel",
        "string_type",
    ),
    (
        "PATCH",
        "editions/{e}",
        {"expectedUpdatedAt": STAMP, "editionLabel": "x", "status": "draft"},
        "status",
        "forbidden_field",
    ),
    (
        "POST",
        "editions/{e}/withdraw",
        {"expectedUpdatedAt": STAMP, "reason": "other", "note": "n"},
        "reason",
        "literal_error",
    ),
    (
        "POST",
        "editions/{e}/withdraw",
        {"expectedUpdatedAt": STAMP, "reason": "rights", "note": "x" * 501},
        "note",
        "text_length",
    ),
    (
        "POST",
        "editions/{e}/withdraw",
        {"expectedUpdatedAt": STAMP, "reason": "rights"},
        "note",
        "required",
    ),
    (
        "POST",
        "editions/{e}/archive",
        {"expectedUpdatedAt": STAMP, "extra": 1},
        "extra",
        "forbidden_field",
    ),
    ("POST", "editions/{e}/delete", {}, "expectedUpdatedAt", "required"),
    ("PATCH", "sections/{s}", {}, "body", "no_fields"),
    ("PATCH", "sections/{s}", {"titleEn": None}, "body", "null_not_allowed"),
    ("PATCH", "sections/{s}", {"titleAr": "x", "ordinal": 3}, "ordinal", "forbidden_field"),
    ("PATCH", "sections/{s}", {"titleAr": "x" * 121}, "titleAr", "text_length"),
    ("PATCH", "books/{b}", {"expectedUpdatedAt": STAMP}, "body", "no_fields"),
    (
        "PATCH",
        "books/{b}",
        {"expectedUpdatedAt": STAMP, "author": None},
        "body",
        "null_not_allowed",
    ),
    (
        "PATCH",
        "books/{b}",
        {"expectedUpdatedAt": STAMP, "categoryId": "nope"},
        "categoryId",
        "uuid_parsing",
    ),
    (
        "PATCH",
        "books/{b}",
        {"expectedUpdatedAt": STAMP, "contentFormat": "quran"},
        "contentFormat",
        "forbidden_field",
    ),
    (
        "PATCH",
        "categories/{c}",
        {"expectedUpdatedAt": STAMP, "displayOrder": 10000},
        "displayOrder",
        "less_than_equal",
    ),
    (
        "PATCH",
        "categories/{c}",
        {"expectedUpdatedAt": STAMP, "displayOrder": -1},
        "displayOrder",
        "greater_than_equal",
    ),
    (
        "PATCH",
        "categories/{c}",
        {"expectedUpdatedAt": STAMP, "displayOrder": True},
        "displayOrder",
        "int_type",
    ),
    (
        "PATCH",
        "categories/{c}",
        {"expectedUpdatedAt": STAMP, "slug": "x"},
        "slug",
        "forbidden_field",
    ),
    (
        "PATCH",
        "sources/{o}",
        {"expectedUpdatedAt": STAMP, "licenseUrl": "http://x.invalid"},
        "licenseUrl",
        "url_https",
    ),
    (
        "PATCH",
        "sources/{o}",
        {"expectedUpdatedAt": STAMP, "licenseUrl": "https://x.invalid/" + "a" * 500},
        "licenseUrl",
        "url_length",
    ),
    (
        "PATCH",
        "sources/{o}",
        {"expectedUpdatedAt": STAMP, "rightsStatus": "fine"},
        "rightsStatus",
        "literal_error",
    ),
    (
        "PATCH",
        "sources/{o}",
        {"expectedUpdatedAt": STAMP, "title": "x" * 201},
        "title",
        "text_length",
    ),
    (
        "PATCH",
        "sources/{o}",
        {"expectedUpdatedAt": STAMP, "sourceUrl": "https://x.invalid"},
        "sourceUrl",
        "forbidden_field",
    ),
]


@pytest.mark.parametrize(
    ("method", "template", "body", "field", "rule"),
    BAD_BODIES,
    ids=[f"{t[0]} {t[1]} {t[3]} {t[4]}" for t in BAD_BODIES],
)
def test_invalid_bodies_are_validation_errors(
    client: TestClient, method: str, template: str, body: dict, field: str, rule: str
) -> None:
    path = "/api/admin/" + template.format(
        e=IDS.published, s=IDS.section, b=IDS.book, c=IDS.category, o=IDS.source
    )
    response = client.request(method, path, json=body)
    assert (response.status_code, code_of(response)) == (422, "validation_error")
    assert {"field": field, "rule": rule} in response.json()["error"]["details"]["fields"]


def test_a_body_that_is_not_json_is_a_validation_error(client: TestClient) -> None:
    response = client.patch(
        f"/api/admin/editions/{IDS.published}",
        content=b'{"expectedUpdatedAt": ',
        headers={"Content-Type": "application/json"},
    )
    assert (response.status_code, code_of(response)) == (422, "validation_error")


def test_a_validation_error_changes_nothing(harness: Harness, client: TestClient) -> None:
    before = repo_of(harness.app).get("book_editions", IDS.published)
    client.patch(
        f"/api/admin/editions/{IDS.published}",
        json={"expectedUpdatedAt": STAMP, "editionLabel": "x" * 500},
    )
    assert repo_of(harness.app).get("book_editions", IDS.published) == before


def test_an_oversized_body_is_refused_by_the_body_limit(client: TestClient) -> None:
    response = client.patch(
        f"/api/admin/sections/{IDS.section}",
        content=b'{"titleAr": "' + b"x" * 70000 + b'"}',
        headers={"Content-Type": "application/json"},
    )
    assert (response.status_code, code_of(response)) == (413, "payload_too_large")


# --- headers and logs -----------------------------------------------------------------------------


@pytest.mark.parametrize("route", ROUTES, ids=ROUTE_IDS)
def test_every_answer_is_no_store(client: TestClient, route) -> None:
    response = call(client, route)  # a manager: 200, 204, 409 or 422 depending on the route
    assert response.headers["cache-control"] == "no-store"


def test_error_answers_are_no_store_too(harness: Harness) -> None:
    visitor = harness.new_client("203.0.113.30")
    other = second_learner(harness)
    for response in (
        visitor.get("/api/admin/access"),
        other.get("/api/admin/overview"),
        harness.client.get(f"/api/admin/editions/{uid(999)}"),
        TestClient(harness.app).post(f"/api/admin/editions/{IDS.draft}/delete", json={}),
    ):
        assert response.status_code in {401, 403, 404}
        assert response.headers["cache-control"] == "no-store"


def test_a_change_logs_one_admin_event_and_nothing_personal(
    harness: Harness, client: TestClient, log_lines: list[str]
) -> None:
    path = f"/api/admin/editions/{IDS.published}"
    client.patch(
        path, json={"expectedUpdatedAt": stamp_of(client, path), "editionLabel": "Secret label"}
    )
    events = [json.loads(line) for line in log_lines if '"event":"content_admin_action"' in line]
    assert events == [
        {"event": "content_admin_action", "action": "update", "entity": "edition", "outcome": "ok"}
    ]
    joined = "\n".join(log_lines)
    for leaked in (
        "Secret label",
        str(IDS.published),
        "sample_user_01",
        "Sample_User_01",
        PASSWORD,
    ):
        assert leaked not in joined
    access = [json.loads(line) for line in log_lines if '"event":"request"' in line]
    assert any(e["route"] == "/api/admin/editions/{edition_id}" for e in access)


def test_a_refused_change_is_logged_by_reason(client: TestClient, log_lines: list[str]) -> None:
    path = f"/api/admin/editions/{IDS.published}"
    client.post(f"{path}/delete", json={"expectedUpdatedAt": stamp_of(client, path)})
    (event,) = [json.loads(line) for line in log_lines if '"event":"content_admin_action"' in line]
    assert (event["action"], event["entity"], event["outcome"]) == ("delete", "edition", "state")


def test_the_session_ids_never_reach_the_service(harness: Harness) -> None:
    """The admin takes no account identifier: a body that names one is an unknown property."""
    response = harness.client.patch(
        f"/api/admin/books/{IDS.book}",
        json={"expectedUpdatedAt": STAMP, "author": "x", "userId": str(UUID(int=1))},
    )
    assert response.status_code == 422
