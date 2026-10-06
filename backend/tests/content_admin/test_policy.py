"""The pure rules of the content manager admin (``app/domain/content_admin_policy.py``)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.domain import content_admin_policy as policy
from app.domain.content_policy import ContentPolicyError, RemovalRefusedError

AT = datetime(2026, 10, 5, 9, 0, tzinfo=UTC)
APPROVAL = {"who": "Synthetic Owner", "at": "2026-10-04T08:00:00+04:00", "note": "n"}


# --- who may use the admin ------------------------------------------------------------------------


@pytest.mark.parametrize("raw", [None, "", "   ", " , ,, "])
def test_an_empty_setting_names_nobody(raw: str | None) -> None:
    assert policy.configured_manager_names(raw) == frozenset()
    assert policy.is_content_manager(raw, "sample_user_01", is_demo=False) is False


def test_names_are_normalized_like_a_username_lookup_key() -> None:
    names = policy.configured_manager_names(" Sample_User_01 , ٢٣أحمد,other_USER ,")
    assert names == frozenset({"sample_user_01", "23أحمد", "other_user"})


@pytest.mark.parametrize("username", ["sample_user_01", "SAMPLE_USER_01", " Sample_User_01 "])
def test_a_listed_name_matches_whatever_its_case(username: str) -> None:
    assert policy.is_content_manager("Sample_User_01", username, is_demo=False) is True


def test_an_unlisted_name_and_a_demo_session_are_not_managers() -> None:
    assert policy.is_content_manager("sample_user_01", "second_user", is_demo=False) is False
    assert policy.is_content_manager("sample_user_01", "sample_user_01", is_demo=True) is False


def test_a_blank_username_is_never_a_manager() -> None:
    assert policy.is_content_manager("sample_user_01", "   ", is_demo=False) is False


# --- text and link rules --------------------------------------------------------------------------


def test_text_violation_counts_characters_after_trimming() -> None:
    limit = policy.TITLE_MAX_LENGTH
    assert policy.text_violation("x" * limit, max_length=limit) is None
    assert policy.text_violation("x" * (limit + 1), max_length=limit) == "text_length"
    assert policy.text_violation("", max_length=limit) == "text_length"
    assert policy.text_violation("ع" * limit, max_length=limit) is None


@pytest.mark.parametrize("text", ["a\x00b", "a\nb", "a\tb", "a\x1fb", "a b", "a\ud800b"])
def test_control_characters_are_refused(text: str) -> None:
    assert policy.text_violation(text, max_length=50) == "text_control_chars"


def test_ordinary_unicode_text_is_accepted() -> None:
    assert policy.text_violation("عنوان بسيط ـ مثال", max_length=50) is None
    assert policy.text_violation("naïve café", max_length=50) is None


@pytest.mark.parametrize(
    ("url", "rule"),
    [
        ("https://example.invalid/license", None),
        ("http://example.invalid/license", "url_https"),
        ("https://", "url_https"),
        ("ftp://example.invalid", "url_https"),
        ("https://exa mple.invalid", "url_chars"),
        ("https://example.invalid/\x00", "url_chars"),
    ],
)
def test_license_link_rules(url: str, rule: str | None) -> None:
    assert policy.url_violation(url) == rule


def test_license_link_length_limit_is_500_characters() -> None:
    assert policy.url_violation("https://" + "a" * 492) is None
    assert policy.url_violation("https://" + "a" * 493) == "url_length"


# --- edition actions ------------------------------------------------------------------------------


def actions(status: str, *, hidden: bool = False, record=None, jobs=()) -> policy.EditionActions:
    return policy.edition_actions(
        status=status, catalog_hidden=hidden, review_record=record, jobs=list(jobs)
    )


def test_actions_of_a_visible_published_edition() -> None:
    assert actions("published") == policy.EditionActions(
        edit_label=True, archive=True, unarchive=False, withdraw=True, delete=False
    )


def test_actions_of_a_hidden_published_edition() -> None:
    assert actions("published", hidden=True) == policy.EditionActions(
        edit_label=True, archive=False, unarchive=True, withdraw=True, delete=False
    )


def test_a_never_published_draft_may_be_deleted_and_renamed_only() -> None:
    assert actions("draft") == policy.EditionActions(
        edit_label=True, archive=False, unarchive=False, withdraw=False, delete=True
    )


def test_a_draft_with_a_published_job_is_never_deleted() -> None:
    assert actions("draft", jobs=[{"step": "published", "status": "failed"}]).delete is False
    assert actions("draft", jobs=[{"step": "approved", "status": "succeeded"}]).delete is True


@pytest.mark.parametrize("status", ["validated", "superseded"])
def test_other_states_only_allow_a_rename(status: str) -> None:
    assert actions(status) == policy.EditionActions(
        edit_label=True, archive=False, unarchive=False, withdraw=False, delete=False
    )


def test_a_revoked_edition_cannot_be_renamed_or_withdrawn_again() -> None:
    done = [{"step": "withdrawn", "status": "succeeded"}]
    record = {"approval": APPROVAL, "withdrawal": {"reason": "rights"}}
    assert actions("revoked", record=record, jobs=done) == policy.EditionActions(
        edit_label=False, archive=False, unarchive=False, withdraw=False, delete=False
    )


def test_a_half_finished_withdrawal_can_be_repeated() -> None:
    record = {"approval": APPROVAL, "withdrawal": {"reason": "rights"}}
    assert actions("revoked", record=record, jobs=[]).withdraw is True
    failed = [{"step": "withdrawn", "status": "failed"}]
    assert actions("revoked", record=record, jobs=failed).withdraw is True
    assert actions("revoked", record={"approval": APPROVAL}, jobs=[]).withdraw is False


def test_the_preconditions_agree_with_the_actions() -> None:
    for status in policy_statuses():
        for hidden in (False, True):
            allowed = actions(status, hidden=hidden)
            for name, check in (
                ("archive", lambda s=status, h=hidden: policy.assert_can_archive(s, h)),
                ("unarchive", lambda s=status, h=hidden: policy.assert_can_unarchive(s, h)),
            ):
                if getattr(allowed, name):
                    check()
                else:
                    with pytest.raises(policy.AdminStateError):
                        check()


def policy_statuses() -> tuple[str, ...]:
    return ("draft", "validated", "published", "superseded", "revoked")


def test_edit_label_and_section_rules() -> None:
    for status in ("draft", "validated", "published", "superseded"):
        policy.assert_can_edit_label(status)
        policy.assert_can_edit_section(status)
    with pytest.raises(policy.AdminStateError):
        policy.assert_can_edit_label("revoked")
    with pytest.raises(policy.AdminStateError):
        policy.assert_can_edit_section("revoked")


def test_archive_and_unarchive_preconditions_carry_a_reason_code() -> None:
    with pytest.raises(policy.AdminStateError) as hidden:
        policy.assert_can_archive("published", True)
    assert hidden.value.code == "already_hidden"
    with pytest.raises(policy.AdminStateError) as visible:
        policy.assert_can_unarchive("published", False)
    assert visible.value.code == "not_hidden"
    with pytest.raises(policy.AdminStateError) as draft:
        policy.assert_can_archive("draft", False)
    assert draft.value.code == "not_published"


def test_withdrawal_mode() -> None:
    assert policy.withdrawal_mode("published", {"approval": APPROVAL}) == "fresh"
    assert policy.withdrawal_mode("revoked", {"withdrawal": {"reason": "rights"}}) == "retry"
    for status, record in (
        ("superseded", {"approval": APPROVAL}),
        ("draft", {}),
        ("validated", {}),
        ("revoked", {"approval": APPROVAL}),
        ("revoked", {"withdrawal": "not an object"}),
    ):
        with pytest.raises(policy.AdminStateError):
            policy.withdrawal_mode(status, record)


def test_delete_rule_reuses_the_workflow_rule() -> None:
    policy.assert_can_delete_edition("draft", [{"step": "approved"}])
    with pytest.raises(RemovalRefusedError):
        policy.assert_can_delete_edition("draft", [{"step": "published"}])
    with pytest.raises(RemovalRefusedError):
        policy.assert_can_delete_edition("published", [])
    with pytest.raises(ContentPolicyError):
        policy.assert_can_delete_edition("unknown-status", [])


# --- review_record helpers ------------------------------------------------------------------------


def test_a_withdrawal_keeps_every_key_and_adds_its_entry() -> None:
    record = {"approval": APPROVAL, "acquisition": {"tool": "synthetic"}}
    updated = policy.with_withdrawal(record, reason="rights", note="synthetic note", at=AT)
    assert updated["approval"] == APPROVAL
    assert updated["acquisition"] == {"tool": "synthetic"}
    assert updated["withdrawal"] == {
        "reason": "rights",
        "note": "synthetic note",
        "at": "2026-10-05T09:00:00+00:00",
        "via": "admin_web",
    }
    assert "withdrawal" not in record  # the input is not changed


def test_the_stamp_is_utc_whatever_the_clock_zone() -> None:
    dubai = datetime(2026, 10, 5, 13, 0, tzinfo=timezone(timedelta(hours=4)))
    updated = policy.with_withdrawal({}, reason="rights", note="n", at=dubai)
    assert updated["withdrawal"]["at"] == "2026-10-05T09:00:00+00:00"


def test_catalog_visibility_entries_are_appended_in_order() -> None:
    first = policy.with_catalog_visibility({"approval": APPROVAL}, action="hidden", at=AT)
    second = policy.with_catalog_visibility(first, action="shown", at=AT + timedelta(hours=1))
    assert [entry["action"] for entry in second["catalogVisibility"]] == ["hidden", "shown"]
    assert second["catalogVisibility"][1]["at"] == "2026-10-05T10:00:00+00:00"
    assert second["approval"] == APPROVAL
    assert len(first["catalogVisibility"]) == 1  # the earlier record is not changed


@pytest.mark.parametrize("existing", [None, "text", {"a": 1}, 5])
def test_a_malformed_visibility_list_starts_a_new_one(existing: object) -> None:
    updated = policy.with_catalog_visibility(
        {"catalogVisibility": existing}, action="hidden", at=AT
    )
    assert [entry["action"] for entry in updated["catalogVisibility"]] == ["hidden"]


def test_a_missing_record_is_treated_as_empty() -> None:
    assert policy.with_withdrawal(None, reason="rights", note="n", at=AT)["withdrawal"]["via"]
    assert policy.with_catalog_visibility(None, action="hidden", at=AT)["catalogVisibility"]


def test_the_views_expose_only_the_documented_keys() -> None:
    record = {
        "approval": {**APPROVAL, "scope": "s", "words": "w", "source": "u", "extra": "hidden"},
        "withdrawal": {"reason": "rights", "note": "n", "at": "t", "via": "admin_web"},
    }
    assert policy.approval_view(record) == {
        "who": "Synthetic Owner",
        "at": "2026-10-04T08:00:00+04:00",
        "scope": "s",
        "words": "w",
        "source": "u",
    }
    assert policy.withdrawal_view(record) == {"reason": "rights", "note": "n", "at": "t"}
    assert policy.approval_view({}) is None
    assert policy.approval_view({"approval": "text"}) is None
    assert policy.withdrawal_view(None) is None


def test_pipeline_version_comes_from_the_published_job() -> None:
    jobs = [
        {"step": "approved", "bank_version": 1, "pipeline_version": "approved-version"},
        {"step": "published", "bank_version": 1, "pipeline_version": "published-version"},
    ]
    assert policy.pipeline_version_for(jobs, 1) == "published-version"


def test_pipeline_version_prefers_the_same_bank_version() -> None:
    jobs = [
        {"step": "published", "bank_version": 1, "pipeline_version": "old"},
        {"step": "published", "bank_version": 2, "pipeline_version": "new"},
    ]
    assert policy.pipeline_version_for(jobs, 2) == "new"
    assert policy.pipeline_version_for(jobs, 3) == "old"


@pytest.mark.parametrize("jobs", [[], [{"step": "approved", "pipeline_version": "x"}]])
def test_pipeline_version_defaults_to_admin_web(jobs: list[dict]) -> None:
    assert policy.pipeline_version_for(jobs, 1) == "admin-web"
