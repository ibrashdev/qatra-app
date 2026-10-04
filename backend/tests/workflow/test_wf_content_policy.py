"""Content workflow policy (pure): step order, publishing gate, removal rules."""

from __future__ import annotations

import pytest

from app.domain import content_policy as cp
from app.domain.content_policy import (
    ContentPolicyError,
    PublishRefusedError,
    RemovalRefusedError,
    StepOrderError,
    assert_approvable,
    assert_delete_unused_draft_allowed,
    assert_publishable,
    assert_step_allowed,
    decide_removal,
)

WEB = ["acquired", "verified", "segmented", "bank_built", "validated", "approved", "published"]
PASSED = [{"method": "m", "result": "passed", "details": ""}]
APPROVAL = {"who": "owner", "at": "2026-10-04T12:00:00Z", "note": "automated gates only"}
LICENSE = {"terms": "recorded"}


def test_vocabulary_matches_database_schema_section_4_4() -> None:
    assert set(cp.STEP_VOCABULARY) == {
        "acquired",
        "verified",
        "segmented",
        "bank_built",
        "validated",
        "approved",
        "published",
        "withdrawn",
        "archived",
        "uploaded",
        "extracted",
        "page_mapped",
        "embedded",
    }
    assert set(cp.JOB_STATUSES) == {"pending", "running", "succeeded", "failed", "skipped"}
    assert set(cp.EDITION_STATUSES) == {"draft", "validated", "published", "superseded", "revoked"}
    assert set(cp.RIGHTS_STATUSES) == {
        "owner_accepted_pending_verification",
        "verified",
        "rejected",
    }
    assert cp.WEB_STEP_ORDER == tuple(WEB)
    assert cp.SKIPPED_STEPS == ("page_mapped", "embedded")


@pytest.mark.parametrize("index", range(len(WEB)))
def test_each_web_step_is_allowed_after_all_earlier_steps(index: int) -> None:
    assert_step_allowed(WEB[:index], WEB[index])


def test_first_step_needs_nothing_and_is_repeatable_before_publication() -> None:
    assert_step_allowed([], "acquired")
    assert_step_allowed(WEB[:5], "acquired")  # idempotent re-run
    assert_step_allowed(WEB[:5], "verified")


@pytest.mark.parametrize("index", range(1, len(WEB)))
def test_a_step_cannot_start_when_an_earlier_step_is_missing(index: int) -> None:
    with pytest.raises(StepOrderError) as error:
        assert_step_allowed(WEB[: index - 1], WEB[index])
    assert error.value.code == "step_order"
    assert WEB[index - 1] in str(error.value)


def test_a_gap_in_the_recorded_steps_is_refused() -> None:
    with pytest.raises(StepOrderError):
        assert_step_allowed(["acquired", "segmented"], "bank_built")


def test_published_version_is_immutable() -> None:
    for step in WEB:
        with pytest.raises(StepOrderError) as error:
            assert_step_allowed(WEB, step)
        assert error.value.code == "version_published"


@pytest.mark.parametrize("step", ["withdrawn", "archived"])
def test_audit_steps_need_publication(step: str) -> None:
    with pytest.raises(StepOrderError) as error:
        assert_step_allowed(WEB[:6], step)
    assert error.value.code == "not_published"
    assert_step_allowed(WEB, step)


def test_audit_steps_cannot_repeat() -> None:
    for step in ("withdrawn", "archived"):
        with pytest.raises(StepOrderError) as error:
            assert_step_allowed([*WEB, step], step)
        assert error.value.code == "already_recorded"


def test_archive_after_withdraw_is_refused_but_withdraw_after_archive_is_allowed() -> None:
    assert_step_allowed([*WEB, "archived"], "withdrawn")
    with pytest.raises(StepOrderError) as error:
        assert_step_allowed([*WEB, "withdrawn"], "archived")
    assert error.value.code == "revoked"


@pytest.mark.parametrize("step", ["page_mapped", "embedded", "uploaded", "extracted"])
def test_skipped_and_reserved_steps_do_not_apply_to_web_editions(step: str) -> None:
    with pytest.raises(StepOrderError) as error:
        assert_step_allowed(WEB, step)
    assert error.value.code == "step_not_applicable"


def test_unknown_steps_are_refused() -> None:
    with pytest.raises(StepOrderError) as error:
        assert_step_allowed([], "teleport")
    assert error.value.code == "unknown_step"
    with pytest.raises(ContentPolicyError) as recorded:
        assert_step_allowed(["teleport"], "acquired")
    assert recorded.value.code == "unknown_step_recorded"


def test_publishable_when_everything_is_recorded() -> None:
    assert_publishable("validated", PASSED, APPROVAL, LICENSE)


@pytest.mark.parametrize("status", ["draft", "published", "superseded", "revoked", "anything"])
def test_publishing_needs_a_validated_edition(status: str) -> None:
    with pytest.raises(PublishRefusedError) as error:
        assert_publishable(status, PASSED, APPROVAL, LICENSE)
    assert error.value.code == "edition_not_validated"


def test_publishing_fails_closed_without_verification_results() -> None:
    with pytest.raises(PublishRefusedError) as error:
        assert_publishable("validated", [], APPROVAL, LICENSE)
    assert error.value.code == "verification_missing"


def test_publishing_needs_every_verification_to_pass() -> None:
    results = [*PASSED, {"method": "m2", "result": "failed", "details": ""}]
    with pytest.raises(PublishRefusedError) as error:
        assert_publishable("validated", results, APPROVAL, LICENSE)
    assert error.value.code == "verification_not_passed"
    with pytest.raises(PublishRefusedError):
        assert_publishable("validated", [{"method": "m"}], APPROVAL, LICENSE)  # no result at all


@pytest.mark.parametrize(
    "approval",
    [
        None,
        {},
        {"who": "owner", "at": "now"},
        {"who": "", "at": "now", "note": "n"},
        {"who": "o", "at": " ", "note": "n"},
    ],
)
def test_publishing_needs_the_recorded_approval(approval: dict[str, str] | None) -> None:
    with pytest.raises(PublishRefusedError) as error:
        assert_publishable("validated", PASSED, approval, LICENSE)
    assert error.value.code == "approval_missing"


@pytest.mark.parametrize("license_record", [None, {}])
def test_publishing_needs_the_license_record(license_record: dict[str, str] | None) -> None:
    with pytest.raises(PublishRefusedError) as error:
        assert_publishable("validated", PASSED, APPROVAL, license_record)
    assert error.value.code == "license_missing"


def test_approvable_needs_validated_status_and_passed_verification() -> None:
    assert_approvable("validated", PASSED)
    with pytest.raises(PublishRefusedError):
        assert_approvable("draft", PASSED)
    with pytest.raises(PublishRefusedError):
        assert_approvable("validated", [])


def test_decide_removal_matrix() -> None:
    unused = decide_removal("draft", False)
    assert unused.delete_allowed and unused.allowed_actions == ("delete",)

    referenced_draft = decide_removal("draft", True)
    assert not referenced_draft.delete_allowed and referenced_draft.allowed_actions == ()

    for references in (False, True):
        published = decide_removal("published", references)
        assert not published.delete_allowed
        assert published.allowed_actions == ("withdraw", "archive")

    for status in ("validated", "superseded", "revoked"):
        for references in (False, True):
            decision = decide_removal(status, references)
            assert not decision.delete_allowed and decision.allowed_actions == ()
    with pytest.raises(ContentPolicyError):
        decide_removal("nonsense", False)


def test_delete_unused_draft_preconditions() -> None:
    assert_delete_unused_draft_allowed("draft", False, ["acquired", "verified"])
    with pytest.raises(RemovalRefusedError) as error:
        assert_delete_unused_draft_allowed("draft", True, [])
    assert error.value.code == "not_deletable"
    with pytest.raises(RemovalRefusedError) as error:
        assert_delete_unused_draft_allowed("validated", False, [])
    assert error.value.code == "not_deletable"
    with pytest.raises(RemovalRefusedError) as error:
        assert_delete_unused_draft_allowed("draft", False, ["acquired", "published"])
    assert error.value.code == "was_published"


def test_error_messages_never_contain_arbitrary_text() -> None:
    with pytest.raises(StepOrderError) as error:
        assert_step_allowed([], "segmented")
    assert (
        "segmented" in str(error.value) and "acquired" not in str(error.value).split("requires")[0]
    )
