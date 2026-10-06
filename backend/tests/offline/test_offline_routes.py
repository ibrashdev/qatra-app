"""E23 to E25 over HTTP: the order of the guards, status codes, the error envelope, no-store, the
rate classes and privacy (API-spec §1.3 to §1.8, §4.8)."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.dependencies import require_session
from tests.offline.off_support import OP, OP2, OfflineWorld
from tests.sessions.ss_support import PLAN_ID, ctx
from tests.support import FRONTEND_ORIGIN
from tests.test_origin import unguarded_mutations

URL = f"/api/plans/{PLAN_ID}/offline-snapshots"
BODY = {"clientOperationId": str(OP), "expectedPlanVersion": 2}


def error_of(response: Any) -> dict[str, Any]:
    assert response.headers["cache-control"] == "no-store"
    return response.json()["error"]


def revalidate_body(snapshot: dict[str, Any], **changes: Any) -> dict[str, Any]:
    return {
        "snapshotId": snapshot["snapshotId"],
        "expectedPlanVersion": snapshot["planVersion"],
        "editionId": snapshot["editionId"],
        "bankVersion": snapshot["bankVersion"],
        **changes,
    }


@pytest.fixture
def world() -> OfflineWorld:
    return OfflineWorld("memory")


# --- guards, in order -----------------------------------------------------------------------------


def test_without_a_session_every_route_is_unauthenticated(world: OfflineWorld) -> None:
    client = world.client(login=False)
    snapshot_id = uuid.uuid4()
    for response in (
        client.post(URL, json=BODY),
        client.get(f"/api/offline-snapshots/{snapshot_id}"),
        client.post("/api/offline/revalidate", json={}),
    ):
        assert response.status_code == 401
        assert error_of(response)["code"] == "unauthenticated"


@pytest.mark.parametrize("origin", [None, "http://evil.example", "http://localhost:3000/"])
def test_the_origin_is_checked_before_the_session_on_both_posts(
    world: OfflineWorld, origin: str | None
) -> None:
    app = world.app(login=False)
    headers = {"Origin": origin} if origin else {}
    with TestClient(app) as bare:
        for path in (URL, "/api/offline/revalidate"):
            response = bare.post(path, json=BODY, headers=headers)
            assert response.status_code == 403
            assert error_of(response)["code"] == "forbidden_origin"


def test_the_get_needs_no_origin_but_a_session(world: OfflineWorld) -> None:
    snapshot, _ = world.create()
    with TestClient(world.app()) as bare:  # no Origin header, a logged-in caller
        response = bare.get(f"/api/offline-snapshots/{snapshot['snapshotId']}")
    assert response.status_code == 200


def test_every_state_changing_route_still_checks_origin_first(world: OfflineWorld) -> None:
    assert unguarded_mutations(world.app()) == []


def test_a_demo_account_may_download(world: OfflineWorld) -> None:
    app = world.app()
    app.dependency_overrides[require_session] = lambda: ctx(demo=True)
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as client:
        assert client.post(URL, json=BODY).status_code == 201


# --- E23 -----------------------------------------------------------------------------------------


def test_a_new_snapshot_is_201_and_a_repeat_is_200_with_the_same_body(
    world: OfflineWorld,
) -> None:
    client = world.client()
    created = client.post(URL, json=BODY)
    assert created.status_code == 201
    assert created.headers["cache-control"] == "no-store"
    snapshot = created.json()
    assert snapshot["planId"] == str(PLAN_ID) and snapshot["preparedSessions"]
    again = client.post(URL, json=BODY)
    assert again.status_code == 200 and again.headers["cache-control"] == "no-store"
    assert again.json() == snapshot


def test_the_body_is_validated_with_the_rules_of_the_spec(world: OfflineWorld) -> None:
    client = world.client()
    response = client.post(URL, json={**BODY, "userId": str(uuid.uuid4()), "mode": "x"})
    assert response.status_code == 422
    error = error_of(response)
    assert error["code"] == "validation_error"
    assert error["details"]["fields"] == [
        {"field": "userId", "rule": "forbidden_field"},
        {"field": "mode", "rule": "forbidden_field"},
    ]
    refs = client.post(URL, json={**BODY, "downloadTargetRefs": []})
    assert error_of(refs)["details"]["fields"] == [
        {"field": "downloadTargetRefs", "rule": "target_refs_invalid"}
    ]
    bad_id = client.post(URL, json={"clientOperationId": "x", "expectedPlanVersion": 2})
    assert error_of(bad_id)["details"]["fields"] == [
        {"field": "clientOperationId", "rule": "client_operation_id_invalid"}
    ]


def test_a_body_that_is_not_an_object_is_refused(world: OfflineWorld) -> None:
    response = world.client().post(URL, json=[1, 2])
    assert response.status_code == 422 and error_of(response)["code"] == "validation_error"


def test_a_stale_version_is_409_with_the_current_version(world: OfflineWorld) -> None:
    response = world.client().post(URL, json={**BODY, "expectedPlanVersion": 1})
    assert response.status_code == 409
    error = error_of(response)
    assert error["code"] == "version_conflict"
    assert error["details"] == {"reason": "plan_version", "currentVersion": 2}


def test_another_input_with_the_same_operation_is_409_idempotency_input(
    world: OfflineWorld,
) -> None:
    client = world.client()
    assert client.post(URL, json=BODY).status_code == 201
    ref = str(
        world.bank.passages(
            world.ctx,
            world.plans.load_for_session(world.ctx, PLAN_ID).edition_id,
            bank_version=1,
            section_ordinals=(1,),
            paths=("quran",),
        )[0].id
    )
    response = client.post(URL, json={**BODY, "downloadTargetRefs": [ref]})
    assert response.status_code == 409
    assert error_of(response)["details"] == {"reason": "idempotency_input"}


def test_an_unknown_plan_is_404_and_a_paused_one_409(world: OfflineWorld) -> None:
    client = world.client()
    missing = client.post(f"/api/plans/{uuid.uuid4()}/offline-snapshots", json=BODY)
    assert missing.status_code == 404 and error_of(missing)["code"] == "not_found"
    world.plans.update(PLAN_ID, status="paused")
    paused = client.post(URL, json=BODY)
    assert paused.status_code == 409
    assert error_of(paused)["details"] == {"reason": "plan_not_active"}


def test_an_edition_that_cannot_be_downloaded_is_422(world: OfflineWorld) -> None:
    client = world.client()
    world.set_edition_status("published", hidden=True)
    response = client.post(URL, json=BODY)
    assert response.status_code == 422
    assert error_of(response)["details"]["fields"] == [
        {"field": "planId", "rule": "edition_not_downloadable"}
    ]


def test_a_body_over_the_cap_is_413(world: OfflineWorld) -> None:
    response = world.client().post(URL, content=b"{" + b" " * 70_000 + b"}")
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


# --- E24 -----------------------------------------------------------------------------------------


def test_the_snapshot_is_read_with_no_store(world: OfflineWorld) -> None:
    client = world.client()
    snapshot = client.post(URL, json=BODY).json()
    response = client.get(f"/api/offline-snapshots/{snapshot['snapshotId']}")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == snapshot


def test_an_unknown_snapshot_is_404_and_a_bad_id_is_422(world: OfflineWorld) -> None:
    client = world.client()
    missing = client.get(f"/api/offline-snapshots/{uuid.uuid4()}")
    assert missing.status_code == 404 and error_of(missing)["code"] == "not_found"
    assert client.get("/api/offline-snapshots/not-a-uuid").status_code == 422


def test_a_snapshot_of_a_revoked_edition_is_404(world: OfflineWorld) -> None:
    client = world.client()
    snapshot = client.post(URL, json=BODY).json()
    world.set_edition_status("revoked")
    response = client.get(f"/api/offline-snapshots/{snapshot['snapshotId']}")
    assert response.status_code == 404
    assert snapshot["lessons"][0]["units"][0]["text"] not in response.text


def test_a_hidden_edition_still_serves_and_revalidates_its_snapshot(world: OfflineWorld) -> None:
    client = world.client()
    snapshot = client.post(URL, json=BODY).json()
    world.set_edition_status("published", hidden=True)
    assert client.get(f"/api/offline-snapshots/{snapshot['snapshotId']}").json() == snapshot
    result = client.post("/api/offline/revalidate", json=revalidate_body(snapshot))
    assert result.status_code == 200 and result.json()["status"] == "available"
    world.set_edition_status("superseded")
    stale = client.post("/api/offline/revalidate", json=revalidate_body(snapshot)).json()
    assert (stale["status"], stale["reasonCode"]) == ("stale", "bank_version_changed")


def test_the_get_never_creates_a_session(world: OfflineWorld) -> None:
    client = world.client()
    snapshot = client.post(URL, json=BODY).json()
    before = world.session_count()
    for _ in range(3):
        client.get(f"/api/offline-snapshots/{snapshot['snapshotId']}")
    assert world.session_count() == before


# --- E25 -----------------------------------------------------------------------------------------


def test_revalidation_answers_200_with_the_status_in_the_body(world: OfflineWorld) -> None:
    client = world.client()
    snapshot = client.post(URL, json=BODY).json()
    response = client.post("/api/offline/revalidate", json=revalidate_body(snapshot))
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "status": "available",
        "currentPlanVersion": 2,
        "allowedSessionRefs": [s["sessionId"] for s in snapshot["preparedSessions"]],
        "catalogVersion": 1,
        "reasonCode": "current",
    }
    world.set_plan_version(3)
    stale = client.post("/api/offline/revalidate", json=revalidate_body(snapshot))
    assert stale.status_code == 200
    assert stale.json()["status"] == "stale" and stale.json()["currentPlanVersion"] == 3
    world.set_edition_status("revoked")
    revoked = client.post("/api/offline/revalidate", json=revalidate_body(snapshot))
    assert revoked.status_code == 200 and revoked.json()["reasonCode"] == "content_revoked"


def test_a_mismatch_is_422_and_an_unknown_snapshot_404(world: OfflineWorld) -> None:
    client = world.client()
    snapshot = client.post(URL, json=BODY).json()
    mismatch = client.post("/api/offline/revalidate", json=revalidate_body(snapshot, bankVersion=5))
    assert mismatch.status_code == 422
    assert error_of(mismatch)["details"]["fields"] == [
        {"field": "bankVersion", "rule": "snapshot_mismatch"}
    ]
    unknown = client.post(
        "/api/offline/revalidate", json=revalidate_body(snapshot, snapshotId=str(uuid.uuid4()))
    )
    assert unknown.status_code == 404
    strict = client.post("/api/offline/revalidate", json=revalidate_body(snapshot, userId="x"))
    assert error_of(strict)["details"]["fields"] == [{"field": "userId", "rule": "forbidden_field"}]


# --- rate classes, availability, documentation ----------------------------------------------------


def test_the_two_posts_share_the_session_write_limit(world: OfflineWorld) -> None:
    client = world.client(QATRA_RATE_SESSION_WRITE_PER_MIN=2)
    assert client.post(URL, json=BODY).status_code == 201
    assert client.post("/api/offline/revalidate", json={}).status_code == 422
    limited = client.post(URL, json={**BODY, "clientOperationId": str(OP2)})
    assert limited.status_code == 429
    assert limited.headers["retry-after"]
    assert error_of(limited)["code"] == "throttled"


def test_the_get_uses_the_session_read_limit(world: OfflineWorld) -> None:
    client = world.client(QATRA_RATE_SESSION_READ_PER_MIN=2)
    snapshot = client.post(URL, json=BODY).json()
    path = f"/api/offline-snapshots/{snapshot['snapshotId']}"
    assert client.get(path).status_code == 200
    assert client.get(path).status_code == 200
    assert client.get(path).status_code == 429
    assert client.post(URL, json=BODY).status_code == 200, "writes have their own class"


def test_without_a_service_the_routes_answer_503(world: OfflineWorld) -> None:
    app = world.app()
    app.state.offline_service = None
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as client:
        assert client.post(URL, json=BODY).status_code == 503
        assert client.get(f"/api/offline-snapshots/{uuid.uuid4()}").status_code == 503
        assert client.post("/api/offline/revalidate", json={}).status_code == 503


def test_the_three_operations_are_documented(world: OfflineWorld) -> None:
    paths = world.app().openapi()["paths"]
    assert "post" in paths["/api/plans/{plan_id}/offline-snapshots"]
    assert "get" in paths["/api/offline-snapshots/{snapshot_id}"]
    assert "post" in paths["/api/offline/revalidate"]


def test_install_sessions_alone_wires_the_offline_routes() -> None:
    """The application wiring needs no change: ``install_sessions`` installs E23 to E25."""
    from app.main import create_app
    from app.routers.sessions import install_sessions
    from tests.sessions.ss_support import Env
    from tests.support import make_settings

    env = Env()
    settings = make_settings()
    app = create_app(settings)
    install_sessions(
        app,
        settings,
        plans=env.plans,
        calendar=env.calendar,
        bank=env.bank,
        learning=env.store,
        new_id=env.service._new_id,
    )
    app.dependency_overrides[require_session] = lambda: ctx()
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as client:
        assert client.post(URL, json=BODY).status_code == 201
