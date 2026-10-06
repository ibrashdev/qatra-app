"""E27 ``GET /api/demo/scenarios`` and E29 ``GET /api/demo/simulations`` (API-spec §4.9), and the
fixture store behind them: roles, shapes, resolution against the published catalog, and what
happens when a fixture file is missing or damaged. Fixtures live in a temporary directory; the
real simulations file is never read here."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest

from app.domain.demo_policy import FixtureError
from app.errors import AppError
from app.services.demo import FixtureStore
from tests.demo.demo_support import (
    DATA,
    Env,
    FakeJsonProvider,
    build_env,
    error_of,
    real_scenarios,
    simulation_file,
)

SCENARIO_KEYS = {"scenarioId", "titleAr", "titleEn", "editionKey", "targetScope"}


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return build_env(tmp_path, provider=FakeJsonProvider())


# --- roles ---------------------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/api/demo/scenarios", "/api/demo/simulations"])
def test_a_visitor_is_unauthenticated(env: Env, path: str) -> None:
    response = env.visitor().get(path)
    assert response.status_code == 401 and error_of(response)["code"] == "unauthenticated"


@pytest.mark.parametrize("path", ["/api/demo/scenarios", "/api/demo/simulations"])
def test_a_learner_is_forbidden(env: Env, path: str) -> None:
    response = env.learner().client.get(path)
    assert response.status_code == 403 and error_of(response)["code"] == "forbidden"


@pytest.mark.parametrize("path", ["/api/demo/scenarios", "/api/demo/simulations"])
def test_a_demo_account_may_read(env: Env, path: str) -> None:
    response = env.demo().client.get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"


def test_the_read_class_limit_applies(tmp_path: Path) -> None:
    env = build_env(tmp_path, QATRA_RATE_SESSION_READ_PER_MIN=2)
    client = env.demo().client
    assert client.get("/api/demo/scenarios").status_code == 200
    assert client.get("/api/demo/simulations").status_code == 200
    limited = client.get("/api/demo/scenarios")
    assert limited.status_code == 429 and "retry-after" in limited.headers


def test_reads_make_no_model_call_and_write_no_usage(env: Env) -> None:
    client = env.demo().client
    client.get("/api/demo/scenarios")
    client.get("/api/demo/simulations")
    assert env.provider is not None and env.provider.calls == []  # type: ignore[union-attr]
    assert env.ledger.rows == []


# --- E27 -----------------------------------------------------------------------------------------


def test_the_scenarios_are_listed_in_file_order_with_exactly_the_contract_fields(env: Env) -> None:
    body = env.demo().client.get("/api/demo/scenarios").json()
    assert set(body) == {"scenarios"}
    scenarios = body["scenarios"]
    assert [s["scenarioId"] for s in scenarios] == [f"scenario-{n:02d}" for n in range(1, 11)]
    for item in scenarios:
        assert set(item) == SCENARIO_KEYS
        assert set(item["targetScope"]) == {"sectionOrdinals"}
        assert item["titleAr"] and item["titleEn"]
    first, last = scenarios[0], scenarios[-1]
    assert first["editionKey"] == "quran-hafs-quranenc"
    assert first["targetScope"] == {"sectionOrdinals": [1]}
    assert last["editionKey"] == "nawawi40-hadeethenc"
    assert last["targetScope"] == {"sectionOrdinals": [1, 2, 3, 4]}


def test_the_goal_sentences_and_the_internal_fields_are_never_returned(env: Env) -> None:
    text = env.demo().client.get("/api/demo/scenarios").text
    for entry in real_scenarios()["scenarios"]:
        assert entry["goalTextEn"] not in text and entry["goalTextAr"] not in text
    for internal in ("goalText", "sectionRefs", "qaCase", "placement", "absenceDays", "paths"):
        assert internal not in text


def test_scenarios_of_an_unpublished_edition_are_left_out(tmp_path: Path) -> None:
    env = build_env(tmp_path, bundles=str(DATA / "synthetic_bundle.json"))
    ids = [
        s["scenarioId"] for s in env.demo().client.get("/api/demo/scenarios").json()["scenarios"]
    ]
    assert ids == [f"scenario-{n:02d}" for n in range(1, 8)]


def test_no_published_edition_means_an_empty_list(tmp_path: Path) -> None:
    env = build_env(tmp_path, bundles=None)  # type: ignore[arg-type]
    response = env.demo().client.get("/api/demo/scenarios")
    assert response.status_code == 200 and response.json() == {"scenarios": []}


def renamed_bundle(tmp_path: Path, source: str, key: str, version: int) -> Path:
    data = json.loads((DATA / source).read_text(encoding="utf-8"))
    data["editionKey"] = key
    data["bankVersion"] = version
    data["edition"]["id"] = str(uuid.uuid5(uuid.NAMESPACE_DNS, key))
    data["book"]["id"] = str(uuid.uuid5(uuid.NAMESPACE_DNS, "book-" + key))
    for index, passage in enumerate(data["passages"]):
        passage["id"] = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{key}-{index}"))
    path = tmp_path / f"{key}.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def test_a_rebuilt_edition_under_a_new_key_is_found_by_prefix(tmp_path: Path) -> None:
    quran = renamed_bundle(tmp_path, "synthetic_bundle.json", "quran-hafs-quranenc-v2", 1)
    env = build_env(tmp_path, bundles=str(quran))
    scenarios = env.demo().client.get("/api/demo/scenarios").json()["scenarios"]
    assert {s["editionKey"] for s in scenarios} == {"quran-hafs-quranenc-v2"}
    assert len(scenarios) == 7


def test_the_latest_version_of_an_edition_is_the_one_offered(tmp_path: Path) -> None:
    old = renamed_bundle(tmp_path, "synthetic_bundle.json", "quran-hafs-quranenc", 1)
    new = renamed_bundle(tmp_path, "synthetic_bundle.json", "quran-hafs-quranenc-v2", 2)
    env = build_env(tmp_path, bundles=f"{old},{new}")
    scenarios = env.demo().client.get("/api/demo/scenarios").json()["scenarios"]
    assert {s["editionKey"] for s in scenarios} == {"quran-hafs-quranenc-v2"}


def test_a_catalog_service_that_is_missing_is_unavailable(env: Env) -> None:
    client = env.demo().client
    env.app.state.catalog_service = None
    response = client.get("/api/demo/scenarios")
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"


# --- E29 -----------------------------------------------------------------------------------------


def test_the_simulations_are_returned_exactly_as_the_file_holds_them(env: Env) -> None:
    body = env.demo().client.get("/api/demo/simulations").json()
    assert body == {"simulations": simulation_file()["simulations"]}
    assert body["simulations"][0]["label"] == "precomputed_synthetic"


def test_the_response_is_not_reshaped_by_the_models(tmp_path: Path) -> None:
    data = simulation_file()
    data["simulations"][0]["learnerScript"]["dailyCorrectRate"] = 0.8
    data["simulations"][0]["days"][0]["adjustment"] = None
    env = build_env(tmp_path, simulations=data)
    body = env.demo().client.get("/api/demo/simulations").json()
    assert body["simulations"] == data["simulations"]
    assert body["simulations"][0]["days"][0]["adjustment"] is None


# --- fixture files that are missing or damaged ----------------------------------------------------


def test_a_missing_scenario_file_makes_e27_and_e28_unavailable_and_is_logged_by_name(
    tmp_path: Path, log_lines: list[str]
) -> None:
    env = build_env(tmp_path, scenarios="missing")
    client = env.demo().client
    for response in (
        client.get("/api/demo/scenarios"),
        client.post("/api/demo/plans", json={"scenarioId": "scenario-07"}),
    ):
        assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    events = [json.loads(line) for line in log_lines if "demo_fixtures_invalid" in line]
    assert events and events[0]["fixture"] == "scenarios" and events[0]["reason"] == "missing"
    # the simulations file is independent
    assert client.get("/api/demo/simulations").status_code == 200


def test_a_damaged_scenario_file_is_unavailable_and_its_content_is_not_logged(
    tmp_path: Path, log_lines: list[str]
) -> None:
    damaged = real_scenarios()
    damaged["scenarios"][0]["secretField"] = "do-not-log-this-value"
    env = build_env(tmp_path, scenarios=damaged)
    response = env.demo().client.get("/api/demo/scenarios")
    assert response.status_code == 503
    text = " ".join(log_lines)
    assert "demo_fixtures_invalid" in text and "invalid_shape" in text
    assert "do-not-log-this-value" not in text and "secretField" not in text


@pytest.mark.parametrize(
    "simulations",
    [
        "missing",
        "not json at all",
        simulation_file(label="live"),
        simulation_file(contentHash="short"),
    ],
    ids=["missing", "text", "live-label", "bad-hash"],
)
def test_a_missing_or_damaged_simulation_file_is_unavailable(
    tmp_path: Path, simulations: Any
) -> None:
    env = build_env(tmp_path, simulations=simulations)
    client = env.demo().client
    response = client.get("/api/demo/simulations")
    assert response.status_code == 503 and error_of(response)["code"] == "unavailable"
    # E27 does not depend on the simulations file
    assert client.get("/api/demo/scenarios").status_code == 200


def test_the_application_starts_without_the_fixtures(tmp_path: Path) -> None:
    env = build_env(tmp_path, scenarios="missing", simulations="missing")
    assert env.visitor().get("/api/health").status_code == 200


def test_an_oversized_fixture_file_is_refused(tmp_path: Path) -> None:
    env = build_env(tmp_path, scenarios=" " * (2 * 1024 * 1024 + 10))
    assert env.demo().client.get("/api/demo/scenarios").status_code == 503


# --- the fixture store ---------------------------------------------------------------------------


class Ticker:
    def __init__(self) -> None:
        self.value = 100.0

    def __call__(self) -> float:
        return self.value


def test_a_valid_file_is_read_once(tmp_path: Path) -> None:
    directory = tmp_path / "fx"
    directory.mkdir()
    (directory / "demo_scenarios.json").write_text(json.dumps(real_scenarios()), encoding="utf-8")
    store = FixtureStore(directory)
    first = store.scenarios()
    (directory / "demo_scenarios.json").unlink()
    assert store.scenarios() is first  # no second read


def test_an_invalid_file_is_read_again_after_the_retry_delay(tmp_path: Path) -> None:
    directory = tmp_path / "fx"
    directory.mkdir()
    ticker = Ticker()
    store = FixtureStore(directory, monotonic=ticker)
    with pytest.raises(AppError):
        store.scenarios()  # missing
    (directory / "demo_scenarios.json").write_text(json.dumps(real_scenarios()), encoding="utf-8")
    ticker.value += 10
    with pytest.raises(AppError):
        store.scenarios()  # inside the delay: still unavailable, no read
    ticker.value += 30
    assert len(store.scenarios().scenarios) == 10


def test_the_default_directory_is_the_repository_fixtures_directory() -> None:
    from app.services.demo import DEFAULT_FIXTURES_DIR

    assert (DEFAULT_FIXTURES_DIR / "demo_scenarios.json").is_file()
    assert FixtureStore().scenarios().scenarios[0].scenario_id == "scenario-01"


def test_a_read_error_is_a_fixture_error_with_a_code(tmp_path: Path) -> None:
    with pytest.raises(FixtureError) as caught:
        FixtureStore._read(tmp_path)  # a directory cannot be read as a file
    assert caught.value.reason in {"unreadable", "missing"}
