"""D89: emails, phone numbers, links and @handles never reach the model payload."""

from __future__ import annotations

import json

import pytest

from app.contracts_plan_chat import CreatePlanChatRequest, PlanChat, SendMessageRequest
from app.domain.plan_chat_policy import REDACTION_TOKEN, redact_contact_details
from app.domain.plan_chat_templates import quick_reply_label
from tests.plan_chat.pc_support import USER_ID, Env, composed_body, ctx, make_env

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


# --- emails ---

EMAIL_CASES = [
    ("subdomains", "reach me at sara@mail.dept.example.co.uk today", f"reach me at {R} today"),
    ("plus addressing", "sara+quran.plan@example.com", R),
    ("mixed case", "MAIL Sara.K@Mail.Example.CO.UK ok", f"MAIL {R} ok"),
    ("hyphenated domain", "me@my-site.example.org please", f"{R} please"),
    ("in parentheses", "mail (a@b.com), now", f"mail ({R}), now"),
    ("sentence period", "mail a@b.com.", f"mail {R}."),
    ("arabic sentence", "بريدي sara+quran@mail.example.com وشكرا", f"بريدي {R} وشكرا"),
    ("arabic punctuation", "ايميلي: a@b.com، شكرا", f"ايميلي: {R}، شكرا"),
    ("arabic letters glued to the local part", "راسلنيa@b.com", R),
    ("arabic domain label", "مستخدم@مثال.com", R),
    ("two emails", "a@b.com and c.d@e.org", f"{R} and {R}"),
]


@pytest.mark.parametrize(
    ("text", "expected"), [case[1:] for case in EMAIL_CASES], ids=[c[0] for c in EMAIL_CASES]
)
def test_emails(text: str, expected: str) -> None:
    assert redact_contact_details(text) == expected


@pytest.mark.parametrize("text", ["a@b", "user@localhost", "sara@gmail", "x@@y", "the @ sign"])
def test_incomplete_email_shapes_are_left_alone(text: str) -> None:
    assert redact_contact_details(text) == text


# --- phone numbers ---

PHONE_CASES = [
    ("plus with spaces", "call +971 50 123 4567 tonight", f"call {R} tonight"),
    ("plus with dashes", "call +971-50-123-4567 now", f"call {R} now"),
    ("plus with dots", "call +971.50.123.4567 now", f"call {R} now"),
    ("plus with a bracketed area code", "call +971 (50) 123 4567", f"call {R}"),
    ("plus glued prefix", "tel: +97150 1234567", f"tel: {R}"),
    ("double-zero prefix", "call 00971501234567 tonight", f"call {R} tonight"),
    ("no plus", "call 971501234567", f"call {R}"),
    ("local with spaces", "phone 050 123 4567", f"phone {R}"),
    ("local with dots", "phone 050.123.4567", f"phone {R}"),
    ("non-breaking spaces", "+971 50 123 4567", R),
    ("single digits with spaces", "0 5 0 1 2 3 4 5 6 7", R),
    ("exactly nine digits", "my number 123456789 ok", f"my number {R} ok"),
    ("nine digits split by a space", "12345678 9", R),
    ("arabic-indic digits", "اتصل ٠٥٠١٢٣٤٥٦٧ الليلة", f"اتصل {R} الليلة"),
    ("arabic-indic with spaces", "جوالي ٠٥٠ ١٢٣ ٤٥٦٧", f"جوالي {R}"),
    ("arabic-indic with dashes", "٠٥٠-١٢٣-٤٥٦٧", R),
    ("arabic-indic with plus", "+٩٧١ ٥٠ ١٢٣ ٤٥٦٧", R),
    ("arabic-indic with dots", "٠٥٠.١٢٣.٤٥٦٧", R),
    ("extended arabic-indic digits", "رقمي ۰۵۰۱۲۳۴۵۶۷ شكرا", f"رقمي {R} شكرا"),
    ("ten arabic-indic digits", "٠٥٠١٢٣٤٥٦٧٨", R),
    ("fullwidth digits", "０５０１２３４５６７", R),
    ("arabic words around a number", "ايميلي a@b.com وجوالي 0501234567", f"ايميلي {R} وجوالي {R}"),
]


@pytest.mark.parametrize(
    ("text", "expected"), [case[1:] for case in PHONE_CASES], ids=[c[0] for c in PHONE_CASES]
)
def test_phone_numbers(text: str, expected: str) -> None:
    assert redact_contact_details(text) == expected


EN = "\N{EN DASH}"
EM = "\N{EM DASH}"


@pytest.mark.parametrize(
    "text",
    [
        f"+971{EN}50{EN}123{EN}4567",
        f"٠٥٠{EN}١٢٣{EN}٤٥٦٧",
        f"+971{EM}50{EM}123{EM}4567",
        f"050{EM}123{EM}4567",
        "050\N{HYPHEN}123\N{HYPHEN}4567",
        "050\N{NON-BREAKING HYPHEN}123\N{NON-BREAKING HYPHEN}4567",
        "050\N{HORIZONTAL BAR}123\N{HORIZONTAL BAR}4567",
        "050\N{MINUS SIGN}123\N{MINUS SIGN}4567",
    ],
    ids=[
        "en dash",
        "en dash arabic-indic",
        "em dash +971",
        "em dash local",
        "hyphen u2010",
        "non-breaking hyphen",
        "horizontal bar",
        "minus sign",
    ],
)
def test_phone_numbers_with_unicode_dashes(text: str) -> None:
    assert redact_contact_details(text) == R
    assert redact_contact_details(f"call {text} now") == f"call {R} now"


@pytest.mark.parametrize(
    "text",
    [
        f"2026{EN}10{EN}05",  # 8 digits: a date, not a phone number
        f"2026{EM}10{EM}05",
        f"١٩{EN}١٠{EN}٢٠٢٦",
        f"1{EN}10",
        f"surah 78{EN}114",
        f"juz 1{EM}30",
        f"from 2026{EN}10{EN}20 to 2026{EN}11{EN}20",
        "05/10/2026",  # "/" is deliberately not a phone separator
    ],
)
def test_unicode_dashes_in_dates_and_ranges_do_not_redact(text: str) -> None:
    result = redact_contact_details(text)
    assert result == text
    assert result is text


# --- numbers that must survive (dates, plan numbers, references) ---

PRESERVED = [
    "2026-10-05",
    "05/10/2026",
    "5.10.2026",
    "٢٠٢٦-١٠-٠٥",
    "٢٠٢٦/١٠/٠٥",
    "من 2026-10-05 إلى 2026-11-05",
    "٢٠٢٦-١٠-٠٥ - ٢٠٢٦-١١-٠٥",
    "12345678",
    "8 digits 12345678 ok",
    "١٢٣٤٥٦٧٨",
    "15 دقيقة",
    "أريد ١٥ دقيقة يوميا",
    "I can do 15 minutes a day",
    "سورة 112",
    "سورة ١١٢ و ١١٣",
    "الحديث 40 في 15 يوما",
    "juz 30 and 40 and 12345678 and 15",
    "اكتب 3.5 ساعات",
    "version v1.2.3 of file.txt, e.g. this",
    "plan 2026",
]


@pytest.mark.parametrize("text", PRESERVED)
def test_dates_and_plan_numbers_are_preserved(text: str) -> None:
    result = redact_contact_details(text)
    assert result == text
    assert result is text


# --- links ---

LINK_CASES = [
    ("https with path and query", "see https://example.com/a?b=1&c=2 now", f"see {R} now"),
    ("http", "see http://foo.bar/x now", f"see {R} now"),
    ("upper-case scheme", "HTTPS://X.COM/Page ok", f"{R} ok"),
    ("arabic idn host", "https://مثال.com/ar", R),
    ("www", "visit www.quran-site.net/path today", f"visit {R} today"),
    ("www without a tld", "see www.example now", f"see {R} now"),
    ("bare domain", "my site is mysite.com ok", f"my site is {R} ok"),
    ("bare domain with path", "open Example.com/path?x=1", f"open {R}"),
    ("country tld", "موقعي mysite.ae/ar للمزيد", f"موقعي {R} للمزيد"),
    ("short link", "bit.ly/abc", R),
    ("social link", "instagram.com/sara", R),
    ("messaging link", "wa.me/971501234567", R),
    ("two links", "https://a.com and www.b.org", f"{R} and {R}"),
]


@pytest.mark.parametrize(
    ("text", "expected"), [case[1:] for case in LINK_CASES], ids=[c[0] for c in LINK_CASES]
)
def test_links(text: str, expected: str) -> None:
    assert redact_contact_details(text) == expected


# --- @handles ---

HANDLE_CASES = [
    ("underscore", "follow me @sara_k on social", f"follow me {R} on social"),
    ("dot and digits", "تابعني @ahmad.99 هنا", f"تابعني {R} هنا"),
    ("two letters", "@ab", R),
    ("at line start", "@sara", R),
    ("trailing comma and period", "tweet @sara_k, and @ahmad.99.", f"tweet {R}, and {R}"),
]


@pytest.mark.parametrize(
    ("text", "expected"), [case[1:] for case in HANDLE_CASES], ids=[c[0] for c in HANDLE_CASES]
)
def test_handles(text: str, expected: str) -> None:
    assert redact_contact_details(text) == expected


@pytest.mark.parametrize("text", ["@a", "the @ sign", "x@@y", "see @ 5 pm"])
def test_a_lone_at_sign_is_not_a_handle(text: str) -> None:
    assert redact_contact_details(text) == text


@pytest.mark.parametrize("email", ["a@b.com", "sara.k+quran@mail.example.org", "x_y@z-w.co.uk"])
def test_an_email_is_one_redaction_not_an_email_plus_a_handle(email: str) -> None:
    """The email pass runs first, so the part after the ``@`` is never redacted a second time."""
    assert redact_contact_details(email) == R
    assert redact_contact_details(f"mail {email} or @sara") == f"mail {R} or {R}"


# --- mixed text and idempotence ---

MIXED = [
    (
        "mail a@b.com or call 0501234567 or see www.x.org or follow @sara",
        f"mail {R} or call {R} or see {R} or follow {R}",
    ),
    (
        "أريد خطة لـ 15 دقيقة حتى 2026-10-20، راسلني a@b.com أو ٠٥٠١٢٣٤٥٦٧ أو @sara_k",
        f"أريد خطة لـ 15 دقيقة حتى 2026-10-20، راسلني {R} أو {R} أو {R}",
    ),
    (
        "finish by 05/10/2026 in 15 days, juz 30; contact +971 50 123 4567, https://x.org/me",
        f"finish by 05/10/2026 in 15 days, juz 30; contact {R}, {R}",
    ),
    ("a@b.com\n0501234567\nwww.x.org", f"{R}\n{R}\n{R}"),
]


@pytest.mark.parametrize(("text", "expected"), MIXED)
def test_mixed_text(text: str, expected: str) -> None:
    assert redact_contact_details(text) == expected


ALL_INPUTS = [
    *(case[1] for case in EMAIL_CASES),
    *(case[1] for case in PHONE_CASES),
    *(case[1] for case in LINK_CASES),
    *(case[1] for case in HANDLE_CASES),
    *(case[0] for case in MIXED),
    *PRESERVED,
    "",
    R,
    f"{R} {R}",
]


@pytest.mark.parametrize("text", ALL_INPUTS)
def test_redaction_is_idempotent(text: str) -> None:
    once = redact_contact_details(text)
    assert redact_contact_details(once) == once


def test_the_token_itself_is_never_changed() -> None:
    assert redact_contact_details(R) is R


# --- integration: only the model payload is redacted (D89) ---

EMAIL = "learner.name@example.com"
PHONE = "+971 50 123 4567"
LINK = "https://example.org/me"
HANDLE = "@learner_name"
PRIVATE = (EMAIL, PHONE, LINK, HANDLE, "learner.name", "123 4567", "example.org")
CONTACT = f"mail {EMAIL} or call {PHONE} or see {LINK} or follow {HANDLE}"


def _open_chat(env: Env) -> PlanChat:
    return env.service.create_conversation(
        ctx(), CreatePlanChatRequest.model_validate(composed_body())
    )


def _send(env: Env, chat: PlanChat, **payload: str) -> PlanChat:
    return env.service.send_message(ctx(), chat.chat_id, SendMessageRequest.model_validate(payload))


def test_the_model_payload_is_redacted_and_the_stored_messages_are_not() -> None:
    env = make_env()
    chat = _open_chat(env)
    text = f"please make the plan shorter, {CONTACT}"
    result = _send(env, chat, text=text)
    (payload,) = env.provider.calls
    wire = json.dumps(payload, ensure_ascii=False)
    for private in PRIVATE:
        assert private not in wire
    sent = [m["text"] for m in payload["messages"]]
    assert (
        sent[-1] == f"please make the plan shorter, mail {R} or call {R} or see {R} or follow {R}"
    )
    stored = env.repo.get(USER_ID, chat.chat_id)
    assert stored is not None
    assert text in [m.text for m in stored.messages]
    assert text in [m.text for m in result.messages]  # the DTO also shows the original


def test_the_redacted_text_is_what_later_turns_send_as_history() -> None:
    env = make_env()
    chat = _open_chat(env)
    _send(env, chat, text=f"please make the plan shorter, {CONTACT}")
    _send(env, chat, text="and please keep the schedule as it is")
    _, second = env.provider.calls
    assert EMAIL not in json.dumps(second, ensure_ascii=False)
    assert any(R in m["text"] for m in second["messages"])
    assert [m["text"] for m in second["messages"]][-1] == "and please keep the schedule as it is"


def test_the_guard_classifies_the_original_text_and_never_calls_the_model() -> None:
    env = make_env()
    chat = _open_chat(env)
    text = f"ما حكم هذا؟ راسلني على {EMAIL} أو {PHONE}"
    result = _send(env, chat, text=text)
    assert env.provider.calls == []
    assert result.messages[-1].kind == "refusal"
    stored = env.repo.get(USER_ID, chat.chat_id)
    assert stored is not None and text in [m.text for m in stored.messages]


def test_quick_replies_are_stored_with_their_own_unredacted_label() -> None:
    env = make_env()
    chat = _open_chat(env)
    result = _send(env, chat, quickReply="fewer_minutes")
    assert env.provider.calls == []
    label = quick_reply_label("fewer_minutes", "en")
    assert [m.text for m in result.messages if m.kind == "quick_reply"] == [label]
    assert R not in label
