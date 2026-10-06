"""The E23 and E25 request schemas: strict bodies and the rule names of API-spec E23."""

from __future__ import annotations

import uuid
from typing import Any

import pytest

from app.contracts_offline import (
    MAX_TARGET_REFS,
    parse_create_snapshot_request,
    parse_revalidate_request,
)
from app.contracts_sessions import RequestViolation

OP = str(uuid.uuid4())
P1, P2 = str(uuid.uuid4()), str(uuid.uuid4())


def create(**changes: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "clientOperationId": OP,
        "expectedPlanVersion": 2,
        "downloadTargetRefs": [P1, P2],
    }
    body.update(changes)
    return {k: v for k, v in body.items() if v is not ...}


def violations(raw: Any, parse=parse_create_snapshot_request) -> list[tuple[str, str]]:
    with pytest.raises(RequestViolation) as caught:
        parse(raw)
    return list(caught.value.fields)


def test_a_valid_body_parses_with_and_without_refs() -> None:
    parsed = parse_create_snapshot_request(create())
    assert [str(r) for r in parsed.download_target_refs or []] == [P1, P2]
    omitted = parse_create_snapshot_request(create(downloadTargetRefs=...))
    assert omitted.download_target_refs is None
    assert (
        parse_create_snapshot_request(create(downloadTargetRefs=None)).download_target_refs is None
    )


def test_the_body_must_be_an_object() -> None:
    assert violations([1]) == [("body", "object_required")]
    assert violations("x", parse_revalidate_request) == [("body", "object_required")]


@pytest.mark.parametrize("name", ["userId", "mode", "planId", "downloadedTargetRefs", "extra"])
def test_unknown_properties_are_forbidden(name: str) -> None:
    assert violations(create(**{name: "x"})) == [(name, "forbidden_field")]


@pytest.mark.parametrize("value", ["", "nope", 5, None, ...])
def test_a_bad_operation_id_is_client_operation_id_invalid(value: Any) -> None:
    assert violations(create(clientOperationId=value)) == [
        ("clientOperationId", "client_operation_id_invalid")
    ]


@pytest.mark.parametrize("value", [0, -1, "2", 1.5, True, None, ...])
def test_a_bad_plan_version_is_refused(value: Any) -> None:
    found = violations(create(expectedPlanVersion=value))
    assert [field for field, _ in found] == ["expectedPlanVersion"]


@pytest.mark.parametrize(
    "refs",
    [
        [],
        [P1, P1],
        [P1, P1.upper()],
        ["not-a-uuid"],
        [P1, 7],
        "x",
        {"a": 1},
        [str(uuid.uuid4()) for _ in range(MAX_TARGET_REFS + 1)],
    ],
)
def test_bad_target_references_are_target_refs_invalid(refs: Any) -> None:
    assert violations(create(downloadTargetRefs=refs)) == [
        ("downloadTargetRefs", "target_refs_invalid")
    ]


def test_sixty_references_are_accepted() -> None:
    refs = [str(uuid.uuid4()) for _ in range(MAX_TARGET_REFS)]
    parsed = parse_create_snapshot_request(create(downloadTargetRefs=refs))
    assert len(parsed.download_target_refs or []) == 60


def test_the_revalidate_body_is_strict() -> None:
    good = {
        "snapshotId": str(uuid.uuid4()),
        "expectedPlanVersion": 2,
        "editionId": str(uuid.uuid4()),
        "bankVersion": 1,
    }
    assert parse_revalidate_request(good).bank_version == 1
    assert violations({**good, "userId": "x"}, parse_revalidate_request) == [
        ("userId", "forbidden_field")
    ]
    assert violations({**good, "bankVersion": 0}, parse_revalidate_request)[0][0] == "bankVersion"
    missing = {k: v for k, v in good.items() if k != "snapshotId"}
    assert violations(missing, parse_revalidate_request) == [("snapshotId", "required")]
