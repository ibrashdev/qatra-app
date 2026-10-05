"""D89: emails, phone numbers, links and @handles never reach the model payload."""

from __future__ import annotations

import pytest

from app.domain.plan_chat_policy import REDACTION_TOKEN, redact_contact_details

R = REDACTION_TOKEN


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("write to me at sara.k+quran@example.com please", f"write to me at {R} please"),
        ("راسلني على ahmad_1@mail.example.org شكرا", f"راسلني على {R} شكرا"),
        ("see https://example.com/a?b=1 now", f"see {R} now"),
        ("see http://foo.bar/x now", f"see {R} now"),
        ("visit www.quran-site.net/path today", f"visit {R} today"),
        ("my site is mysite.com ok", f"my site is {R} ok"),
        ("Visit Example.ORG/page ok", f"Visit {R} ok"),
        ("موقعي mysite.ae/ar للمزيد", f"موقعي {R} للمزيد"),
        ("follow me @sara_k on social", f"follow me {R} on social"),
        ("تابعني @ahmad.99 هنا", f"تابعني {R} هنا"),
        ("call +971 50 123 4567 tonight", f"call {R} tonight"),
        ("call 0501234567 tonight", f"call {R} tonight"),
        ("call 00971501234567 tonight", f"call {R} tonight"),
        ("call (04) 123-4567 tonight", f"call {R} tonight"),
        ("اتصل ٠٥٠١٢٣٤٥٦٧ الليلة", f"اتصل {R} الليلة"),
        ("رقمي ۰۵۰۱۲۳۴۵۶۷ شكرا", f"رقمي {R} شكرا"),
        ("mail a@b.com or call 0501234567 or see www.x.org", f"mail {R} or call {R} or see {R}"),
    ],
)
def test_contact_details_are_redacted(text: str, expected: str) -> None:
    assert redact_contact_details(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "2026-10-20",
        "finish by 20/10/2026 please",
        "from 2026-10-20 - 2026-11-20 maybe",
        "10 minutes a day",
        "١٥ دقيقة كل يوم",
        "40 hadith in 15 days",
        "Juz 30",
        "surah 78-114",
        "أريد حفظ جزء عم في ٣٠ يوما",
        "I want to memorize it by the end of 2026.",
    ],
)
def test_plan_text_is_preserved(text: str) -> None:
    result = redact_contact_details(text)
    assert result == text
    assert result is text


def test_text_with_nothing_to_redact_is_returned_unchanged() -> None:
    text = "أريد أن أحفظ سورة النبأ خلال شهر بإذن الله."
    assert redact_contact_details(text) is text
    assert redact_contact_details("") == ""
