"""Request DTOs of the content manager admin: trimming, limits, nulls, no_fields, strictness."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.contracts_content_admin import (
    ExpectedVersionRequest,
    PatchBookRequest,
    PatchCategoryRequest,
    PatchEditionRequest,
    PatchSectionRequest,
    PatchSourceRequest,
    WithdrawEditionRequest,
)

STAMP = "2026-10-05T09:00:00.123456Z"


def rules(error: ValidationError) -> list[tuple[str, str]]:
    return [(".".join(str(part) for part in e["loc"]), e["type"]) for e in error.errors()]


def check(model: type, payload: dict[str, Any]) -> list[tuple[str, str]]:
    with pytest.raises(ValidationError) as caught:
        model.model_validate(payload)
    return rules(caught.value)


def test_expected_updated_at_is_parsed_into_an_aware_instant() -> None:
    body = ExpectedVersionRequest.model_validate({"expectedUpdatedAt": STAMP})
    assert body.expected_updated_at == datetime(2026, 10, 5, 9, 0, 0, 123456, tzinfo=UTC)
    shifted = ExpectedVersionRequest.model_validate(
        {"expectedUpdatedAt": "2026-10-05T13:00:00.123456+04:00"}
    )
    assert shifted.expected_updated_at == body.expected_updated_at


@pytest.mark.parametrize(
    "value", ["2026-10-05T09:00:00", "yesterday", "", 20261005, None, ["2026-10-05T09:00:00Z"]]
)
def test_expected_updated_at_needs_a_zoned_iso_string(value: object) -> None:
    assert check(ExpectedVersionRequest, {"expectedUpdatedAt": value}) == [
        ("expectedUpdatedAt", "timestamp_invalid")
    ]


def test_expected_updated_at_is_required_and_unknown_fields_are_refused() -> None:
    assert check(ExpectedVersionRequest, {}) == [("expectedUpdatedAt", "missing")]
    assert check(ExpectedVersionRequest, {"expectedUpdatedAt": STAMP, "force": True}) == [
        ("force", "extra_forbidden")
    ]


def test_only_the_camel_case_names_are_accepted() -> None:
    assert check(PatchEditionRequest, {"expected_updated_at": STAMP, "edition_label": "x"}) == [
        ("expectedUpdatedAt", "missing"),
        ("editionLabel", "missing"),
        ("expected_updated_at", "extra_forbidden"),
        ("edition_label", "extra_forbidden"),
    ]


def test_text_is_trimmed_and_counted_after_trimming() -> None:
    body = PatchEditionRequest.model_validate(
        {"expectedUpdatedAt": STAMP, "editionLabel": "  " + "x" * 120 + "\n"}
    )
    assert body.edition_label == "x" * 120
    assert check(PatchEditionRequest, {"expectedUpdatedAt": STAMP, "editionLabel": "x" * 121}) == [
        ("editionLabel", "text_length")
    ]
    assert check(PatchEditionRequest, {"expectedUpdatedAt": STAMP, "editionLabel": " \n "}) == [
        ("editionLabel", "text_length")
    ]


@pytest.mark.parametrize("value", ["a\x00b", "a\nb", "a\tb", "a b"])
def test_control_characters_inside_a_text_are_refused(value: str) -> None:
    assert check(PatchEditionRequest, {"expectedUpdatedAt": STAMP, "editionLabel": value}) == [
        ("editionLabel", "text_control_chars")
    ]


@pytest.mark.parametrize("value", [5, True, ["x"], {"a": 1}])
def test_text_is_not_coerced(value: object) -> None:
    assert check(PatchEditionRequest, {"expectedUpdatedAt": STAMP, "editionLabel": value}) == [
        ("editionLabel", "string_type")
    ]


def test_withdraw_reason_and_note() -> None:
    body = WithdrawEditionRequest.model_validate(
        {"expectedUpdatedAt": STAMP, "reason": "rights", "note": " synthetic note "}
    )
    assert (body.reason, body.note) == ("rights", "synthetic note")
    for reason in ("transmission", "rights", "accreditation"):
        WithdrawEditionRequest.model_validate(
            {"expectedUpdatedAt": STAMP, "reason": reason, "note": "n"}
        )
    assert check(
        WithdrawEditionRequest, {"expectedUpdatedAt": STAMP, "reason": "other", "note": "n"}
    ) == [("reason", "literal_error")]
    assert check(
        WithdrawEditionRequest, {"expectedUpdatedAt": STAMP, "reason": "rights", "note": "x" * 501}
    ) == [("note", "text_length")]
    assert check(WithdrawEditionRequest, {"expectedUpdatedAt": STAMP, "reason": "rights"}) == [
        ("note", "missing")
    ]


# --- PATCH bodies ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "model", [PatchSectionRequest, PatchBookRequest, PatchCategoryRequest, PatchSourceRequest]
)
def test_a_patch_without_a_change_is_refused(model: type) -> None:
    payload = {} if model is PatchSectionRequest else {"expectedUpdatedAt": STAMP}
    assert check(model, payload) == [("", "no_fields")]


def test_a_section_needs_no_concurrency_token_and_rejects_one() -> None:
    body = PatchSectionRequest.model_validate({"titleAr": " عنوان "})
    assert body.to_changes() == {"title_ar": "عنوان"}
    assert check(PatchSectionRequest, {"titleAr": "x", "expectedUpdatedAt": STAMP}) == [
        ("expectedUpdatedAt", "extra_forbidden")
    ]


def test_a_section_english_title_does_not_accept_null() -> None:
    assert check(PatchSectionRequest, {"titleEn": None}) == [("", "null_not_allowed")]
    assert check(PatchSectionRequest, {"titleAr": None}) == [("", "null_not_allowed")]


def test_book_changes_only_name_what_was_sent() -> None:
    category = "c0c0c0c0-0000-4000-8000-000000000001"
    body = PatchBookRequest.model_validate(
        {"expectedUpdatedAt": STAMP, "titleEn": None, "categoryId": category}
    )
    assert body.to_changes() == {"title_en": None, "category_id": category}
    assert isinstance(body.category_id, UUID)


@pytest.mark.parametrize("field", ["titleAr", "author", "categoryId"])
def test_a_book_field_that_is_not_nullable_refuses_null(field: str) -> None:
    assert check(PatchBookRequest, {"expectedUpdatedAt": STAMP, field: None}) == [
        ("", "null_not_allowed")
    ]


def test_a_book_category_must_be_a_uuid() -> None:
    errors = check(PatchBookRequest, {"expectedUpdatedAt": STAMP, "categoryId": "not-an-id"})
    assert errors == [("categoryId", "uuid_parsing")]


def test_category_display_order_is_an_integer_from_0_to_9999() -> None:
    for value in (0, 9999, 5):
        body = PatchCategoryRequest.model_validate(
            {"expectedUpdatedAt": STAMP, "displayOrder": value}
        )
        assert body.to_changes() == {"display_order": value}
    for value, rule in ((-1, "greater_than_equal"), (10000, "less_than_equal")):
        assert check(PatchCategoryRequest, {"expectedUpdatedAt": STAMP, "displayOrder": value}) == [
            ("displayOrder", rule)
        ]
    for value in (True, 5.5, "5"):
        assert check(PatchCategoryRequest, {"expectedUpdatedAt": STAMP, "displayOrder": value}) == [
            ("displayOrder", "int_type")
        ]


def test_category_english_label_accepts_null_and_the_arabic_one_does_not() -> None:
    body = PatchCategoryRequest.model_validate({"expectedUpdatedAt": STAMP, "labelEn": None})
    assert body.to_changes() == {"label_en": None}
    assert check(PatchCategoryRequest, {"expectedUpdatedAt": STAMP, "labelAr": None}) == [
        ("", "null_not_allowed")
    ]


def test_source_license_link_rules_and_null() -> None:
    body = PatchSourceRequest.model_validate({"expectedUpdatedAt": STAMP, "licenseUrl": None})
    assert body.to_changes() == {"license_url": None}
    ok = PatchSourceRequest.model_validate(
        {"expectedUpdatedAt": STAMP, "licenseUrl": " https://example.invalid/terms "}
    )
    assert ok.to_changes() == {"license_url": "https://example.invalid/terms"}
    for value, rule in (
        ("http://example.invalid", "url_https"),
        ("https://example.invalid/" + "a" * 500, "url_length"),
        ("https://exa mple.invalid", "url_chars"),
        ("", "url_https"),
    ):
        assert check(PatchSourceRequest, {"expectedUpdatedAt": STAMP, "licenseUrl": value}) == [
            ("licenseUrl", rule)
        ]


def test_source_title_allows_200_and_provider_120() -> None:
    PatchSourceRequest.model_validate({"expectedUpdatedAt": STAMP, "title": "x" * 200})
    assert check(PatchSourceRequest, {"expectedUpdatedAt": STAMP, "title": "x" * 201}) == [
        ("title", "text_length")
    ]
    assert check(PatchSourceRequest, {"expectedUpdatedAt": STAMP, "provider": "x" * 121}) == [
        ("provider", "text_length")
    ]


def test_source_rights_status_is_one_of_three_values() -> None:
    for value in ("owner_accepted_pending_verification", "verified", "rejected"):
        PatchSourceRequest.model_validate({"expectedUpdatedAt": STAMP, "rightsStatus": value})
    assert check(PatchSourceRequest, {"expectedUpdatedAt": STAMP, "rightsStatus": "ok"}) == [
        ("rightsStatus", "literal_error")
    ]
    assert check(PatchSourceRequest, {"expectedUpdatedAt": STAMP, "rightsStatus": None}) == [
        ("", "null_not_allowed")
    ]


@pytest.mark.parametrize(
    ("model", "field"),
    [
        (PatchBookRequest, "contentFormat"),
        (PatchBookRequest, "id"),
        (PatchCategoryRequest, "slug"),
        (PatchSourceRequest, "sourceUrl"),
        (PatchSourceRequest, "eligibilityRecord"),
        (PatchSourceRequest, "approvedRuleId"),
        (PatchEditionRequest, "status"),
        (PatchEditionRequest, "contentHash"),
        (PatchEditionRequest, "version"),
        (PatchSectionRequest, "ordinal"),
        (PatchSectionRequest, "reference"),
    ],
)
def test_fields_that_are_never_changed_here_are_unknown_properties(model: type, field: str) -> None:
    payload: dict[str, Any] = {"expectedUpdatedAt": STAMP, field: "x"}
    if model is PatchEditionRequest:
        payload["editionLabel"] = "x"
    elif model is PatchSectionRequest:
        payload = {"titleAr": "x", field: 1}
    else:
        payload["title" + ("Ar" if model is PatchBookRequest else "")] = "x"
        if model is PatchCategoryRequest:
            payload = {"expectedUpdatedAt": STAMP, "labelAr": "x", field: "x"}
    assert (field, "extra_forbidden") in check(model, payload)
