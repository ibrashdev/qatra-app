"""Startup wiring of the catalog and plan services (create_app and build_planning_services)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import StartupConfigError
from app.main import create_app
from app.services.plans import build_planning_services
from tests.plans.fake_postgrest import ANON_KEY
from tests.plans.plans_support import (
    QURAN_ID,
    browser,
    code,
    create_body,
    login_as,
    quran_bundle,
    write_bundles,
)
from tests.support import make_settings


def test_memory_mode_builds_the_catalog_from_the_configured_bundles(tmp_path: Path) -> None:
    settings = make_settings(QATRA_CONTENT_BUNDLES=write_bundles(tmp_path))
    app = create_app(settings)
    assert app.state.catalog_service is not None and app.state.plan_service is not None
    editions = TestClient(app).get("/api/catalog").json()["editions"]
    assert {e["editionKey"] for e in editions} == {"quran-test", "hadith-test"}


def test_blank_and_padded_bundle_lists_are_accepted(tmp_path: Path) -> None:
    listed = write_bundles(tmp_path, quran_bundle())
    for value in (f" {listed} ,", f",{listed}"):
        services = build_planning_services(make_settings(QATRA_CONTENT_BUNDLES=value))
        assert [e.edition_id for e in services.content.editions()] == [QURAN_ID]
    assert (
        build_planning_services(make_settings(QATRA_CONTENT_BUNDLES=" , ")).content.editions() == []
    )


def test_memory_mode_exposes_the_seedable_parts(tmp_path: Path) -> None:
    services = build_planning_services(make_settings(QATRA_CONTENT_BUNDLES=write_bundles(tmp_path)))
    assert services.placements is not None and services.profiles is not None
    assert services.repository is not None and services.content is not None


def test_an_unreadable_bundle_stops_the_start_with_the_variable_name_only(tmp_path: Path) -> None:
    secret_path = tmp_path / "secret-directory-name" / "missing.json"
    with pytest.raises(StartupConfigError) as exc:
        create_app(make_settings(QATRA_CONTENT_BUNDLES=str(secret_path)))
    assert exc.value.problems == ["invalid values for variables: QATRA_CONTENT_BUNDLES"]
    assert "secret-directory-name" not in str(exc.value)


@pytest.mark.parametrize("text", ["not json", "{}", '{"bundleVersion": 1}', "[]"])
def test_a_file_that_is_not_a_bundle_stops_the_start(tmp_path: Path, text: str) -> None:
    path = tmp_path / "bad.json"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(StartupConfigError) as exc:
        create_app(make_settings(QATRA_CONTENT_BUNDLES=str(path)))
    assert exc.value.problems == ["invalid values for variables: QATRA_CONTENT_BUNDLES"]


def test_a_bundle_with_the_wrong_shape_stops_the_start(tmp_path: Path) -> None:
    bundle = quran_bundle()
    bundle["passages"] = [{"id": "not-a-uuid"}]
    with pytest.raises(StartupConfigError):
        create_app(make_settings(QATRA_CONTENT_BUNDLES=write_bundles(tmp_path, bundle)))


def test_two_bundles_of_one_edition_are_refused(tmp_path: Path) -> None:
    with pytest.raises(StartupConfigError):
        create_app(
            make_settings(
                QATRA_CONTENT_BUNDLES=write_bundles(tmp_path, quran_bundle(), quran_bundle())
            )
        )


def test_supabase_mode_without_a_project_answers_503_instead_of_faking_data() -> None:
    settings = make_settings(QATRA_DATA_BACKEND="supabase")
    app = create_app(settings)  # development: only the origin and the terms are required
    assert app.state.catalog_service is None and app.state.plan_service is None
    assert (
        TestClient(app).get("/api/catalog").status_code,
        code(TestClient(app).get("/api/catalog")),
    ) == (
        503,
        "unavailable",
    )
    login_as(app, token="t")
    with browser(app) as client:
        response = client.post("/api/plans", json=create_body())
        assert (response.status_code, code(response)) == (503, "unavailable")


def test_supabase_mode_builds_the_services_without_touching_the_network() -> None:
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase",
        SUPABASE_URL="https://project.example",
        SUPABASE_ANON_KEY=ANON_KEY,
    )
    services = build_planning_services(settings)
    assert services.catalog is not None and services.plans is not None
    assert services.placements is None and services.repository is None  # memory-only parts


@pytest.mark.parametrize(
    "url", ["not a url", "ftp://project.example", "https://u:p@project.example"]
)
def test_an_invalid_supabase_url_stops_the_start_with_names_only(url: str) -> None:
    settings = make_settings(
        QATRA_DATA_BACKEND="supabase", SUPABASE_URL=url, SUPABASE_ANON_KEY=ANON_KEY
    )
    with pytest.raises(StartupConfigError) as exc:
        create_app(settings)
    assert exc.value.problems == ["invalid values for variables: SUPABASE_URL, SUPABASE_ANON_KEY"]
    assert ANON_KEY not in str(exc.value) and url not in str(exc.value)


def test_the_routes_are_documented_in_the_openapi_document() -> None:
    app = create_app(make_settings())
    paths = app.openapi()["paths"]
    assert set(paths["/api/catalog"]) == {"get"}
    assert set(paths["/api/plans/estimate"]) == {"post"}
    assert set(paths["/api/plans"]) == {"post"}
    assert set(paths["/api/plans/{plan_id}/revise"]) == {"post"}
    assert set(paths["/api/plans/{plan_id}/resume"]) == {"post"}
    schemas = app.openapi()["components"]["schemas"]
    assert {"CatalogResponse", "EstimateResult", "Plan"} <= set(schemas)
    assert paths["/api/plans"]["post"]["responses"]["201"]


DATA = Path(__file__).resolve().parents[1] / "data"
COMMITTED_BUNDLES = f"{DATA / 'synthetic_bundle.json'},{DATA / 'synthetic_bundle_hadith.json'}"


def test_the_committed_synthetic_bundles_load_and_can_be_planned() -> None:
    """The bundles made by the content pipeline (not by the test helpers) work end to end."""
    app = create_app(make_settings(QATRA_CONTENT_BUNDLES=COMMITTED_BUNDLES))
    editions = {e["editionKey"]: e for e in TestClient(app).get("/api/catalog").json()["editions"]}
    quran = editions["quran-hafs-quranenc"]
    assert [s["wordCount"] for s in quran["sections"]] == [12, 23, 65]
    assert [s["passageCount"] for s in quran["sections"]] == [1, 1, 2]
    hadith = editions["nawawi40-hadeethenc"]
    assert hadith["defaultPaths"] == ["matn"]
    assert [s["wordCount"] for s in hadith["sections"]] == [6, 72, 10, 7]
    assert hadith["sections"][2]["paths"] == [
        "matn"
    ]  # hadith 3 has an empty grade and no sanad passage

    login_as(app)
    with browser(app) as client:
        body = {
            "editionId": quran["editionId"],
            "targetScope": {"sectionOrdinals": [1, 2, 3]},
            "paths": ["quran"],
            "sessionMinutes": 5,
        }
        estimate = client.post("/api/plans/estimate", json=body).json()["estimate"]
        assert (estimate["totalWords"], estimate["passageCount"]) == (100, 4)
        created = client.post("/api/plans", json=body | {"confirmedEstimate": estimate})
        assert created.status_code == 201
        assert created.json()["titleEn"] == "Synthetic book"
