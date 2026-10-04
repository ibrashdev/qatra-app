"""Pure policy: usernames, passwords, recovery codes, time zones, client prefixes, the throttle
table and the account-settings rules (API-spec E03, E11, E12, §1.7, §1.10; contract §6)."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from app.domain import auth_policy as policy
from app.domain.auth_policy import AccountSettings, SettingsPatch

# --- usernames ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "abc",
        "sample_user_01",
        "A_b_3",
        "_" * 3,
        "123",
        "a" * 24,
        "أحمد",
        "اسم_مستخدم",
        "ـــ",  # tatweel U+0640 lies inside the approved letter range U+0621-U+064A
        "user١٢٣",  # Arabic-Indic digits are allowed (mapped to ASCII)
        "ＵＳＥＲ１",  # fullwidth Latin letters and digit: NFKC makes them ASCII
        "ﻻﻻﻻ",  # lam-alef ligature: NFKC expands each to two letters
    ],
)
def test_valid_usernames_have_no_violations(name: str) -> None:
    assert policy.username_violations(name) == []


def test_display_and_normalized_forms() -> None:
    assert policy.username_display("Sample_User_01") == "Sample_User_01"
    assert policy.normalize_username("Sample_User_01") == "sample_user_01"
    assert policy.username_display("User١٢٣") == "User123"
    assert policy.normalize_username("User١٢٣") == "user123"
    assert policy.normalize_username("ＵＳＥＲ１") == "user1"
    assert policy.normalize_username("ﻻ") == "لا"  # NFKC of the lam-alef ligature


def test_equivalent_spellings_share_one_normalized_name() -> None:
    spellings = ["USER_1", "user_1", "ｕｓｅｒ_１", "User_١", "uSeR_1"]
    assert {policy.normalize_username(s) for s in spellings} == {"user_1"}


def test_no_arabic_letter_folding_is_applied() -> None:
    # arabic-norm-v1 is for grading words only: alef variants and heh/teh marbuta stay distinct.
    assert policy.normalize_username("أحمد") != policy.normalize_username("احمد")
    assert policy.normalize_username("مدرسة") != policy.normalize_username("مدرسه")
    assert policy.normalize_username("أحمد") == "أحمد"


def test_normalization_lowercases_latin_letters_only() -> None:
    assert policy.normalize_username("ABCxyz") == "abcxyz"
    assert policy.normalize_username("أAب") == "أaب"


def test_length_is_counted_after_nfkc() -> None:
    composed = "آ" * 15  # alef + combining maddah: 30 code points, NFKC composes to 15
    assert len(composed) == 30
    assert policy.username_violations(composed) == []
    expanding = "ﷲ" * 7  # one code point each, four letters after NFKC: 28 letters
    assert len(expanding) == 7
    assert policy.username_violations(expanding) == ["username_length"]


@pytest.mark.parametrize("name", ["", "a", "ab", "a" * 25, "ا" * 25])
def test_length_rule(name: str) -> None:
    assert policy.username_violations(name) == ["username_length"]


@pytest.mark.parametrize(
    "name",
    [
        "user-name",
        "user.name",
        "user@name",
        "ab$",
        "café",  # a Latin letter outside ASCII
        "user۱۲۳",  # extended Arabic-Indic digits are not in the approved classes
        "أَحمد",  # an Arabic diacritic (fatha) is outside U+0621-U+064A
        "\U0001f600\U0001f600\U0001f600",
        "名前名前",
        "\ud800abc",  # a lone surrogate
    ],
)
def test_character_class_rule(name: str) -> None:
    assert policy.username_violations(name) == ["username_chars"]


@pytest.mark.parametrize(
    "name",
    [
        "a b c",
        "ab c",
        "user\tname",
        "user\nname",
        "ab\u200bc",  # zero width space
        "ab\u200dc",  # zero width joiner
        "\u200f\u202eabc",  # bidi controls
        "a\u00a0b",  # no-break space (NFKC: ordinary space)
        "a\u3000b",  # ideographic space
        "abc\ufeff",  # byte order mark
        "ab\u3164c",  # hangul filler (a blank letter)
        "ab\u2800c",  # braille blank
        "ab\u061cc",  # arabic letter mark
        "ab\u00adc",  # soft hyphen
        "ab\ufe0fc",  # variation selector
    ],
)
def test_invisible_or_space_rule(name: str) -> None:
    assert policy.username_violations(name) == ["username_invisible_or_space"]


def test_several_rules_are_reported_in_a_fixed_order() -> None:
    assert policy.username_violations("a-") == ["username_length", "username_chars"]
    assert policy.username_violations("a b-c") == [
        "username_chars",
        "username_invisible_or_space",
    ]
    assert policy.username_violations("\u200b$") == [
        "username_length",
        "username_chars",
        "username_invisible_or_space",
    ]


def test_normalization_is_total() -> None:
    for text in ["", "\x00", "\ud800", "\u200b", "Ａ" * 1000, "آ"]:
        assert isinstance(policy.normalize_username(text), str)


def test_storable_text() -> None:
    assert policy.is_storable_text("sample_user_01")
    assert policy.is_storable_text("أحمد")
    assert not policy.is_storable_text("a\x00b")
    assert not policy.is_storable_text("a\ud800b")


# --- passwords ------------------------------------------------------------------------------------


def test_password_minimum_counts_unicode_code_points() -> None:
    assert policy.password_violations("a" * 14) == ["password_min_chars"]
    assert policy.password_violations("a" * 15) == []
    assert policy.password_violations("ب" * 15) == []  # 30 bytes
    assert policy.password_violations("\U0001f600" * 15) == []  # 15 code points, 60 bytes
    assert policy.password_violations("") == ["password_min_chars"]


def test_password_maximum_counts_utf8_bytes_not_characters() -> None:
    assert policy.password_violations("a" * 72) == []
    assert policy.password_violations("a" * 73) == ["password_max_bytes"]
    assert policy.password_violations("ب" * 36) == []  # 72 bytes
    assert policy.password_violations("ب" * 37) == ["password_max_bytes"]  # 74 bytes
    assert policy.password_violations("\U0001f600" * 18) == []  # 72 bytes
    assert policy.password_violations("\U0001f600" * 19) == ["password_max_bytes"]  # 76 bytes


def test_a_password_that_cannot_be_encoded_is_over_the_limit() -> None:
    assert policy.password_violations("a" * 15 + "\ud800") == ["password_max_bytes"]
    assert policy.password_byte_length("\ud800") > policy.PASSWORD_MAX_BYTES


def test_there_is_no_composition_rule_and_nothing_is_normalized() -> None:
    assert policy.password_violations(" " * 15) == []  # spaces only: no composition rule
    assert policy.password_violations("a" * 15) == []
    # the policy functions only judge; they never return a modified password
    assert policy.password_can_authenticate("x" * 72)
    assert not policy.password_can_authenticate("x" * 73)
    assert not policy.password_can_authenticate("\ud800")


# --- recovery codes -------------------------------------------------------------------------------


def test_generated_codes_are_32_lowercase_hex_characters_and_unique() -> None:
    codes = {policy.generate_recovery_code() for _ in range(200)}
    assert len(codes) == 200
    for code in codes:
        assert len(code) == 32
        assert set(code) <= set("0123456789abcdef")


def test_display_format_is_eight_groups_of_four() -> None:
    code = "0123456789abcdef0123456789abcdef"
    shown = policy.format_recovery_code(code)
    assert shown == "0123-4567-89ab-cdef-0123-4567-89ab-cdef"
    assert policy.normalize_recovery_code(shown) == code


@pytest.mark.parametrize(
    ("typed", "expected"),
    [
        ("0123-4567-89ab-cdef-0123-4567-89ab-cdef", "0123456789abcdef0123456789abcdef"),
        ("0123456789abcdef0123456789abcdef", "0123456789abcdef0123456789abcdef"),
        ("0123-4567-89AB-CDEF-0123-4567-89AB-CDEF", "0123456789abcdef0123456789abcdef"),
        ("٠١٢٣-٤٥٦٧-89ab-cdef-٠١٢٣-٤٥٦٧-89ab-cdef", "0123456789abcdef0123456789abcdef"),
        ("0-1-2-3-4-5-6-7-8-9-a-b-c-d-e-f-0123456789abcdef", "0123456789abcdef0123456789abcdef"),
    ],
)
def test_recovery_code_normalization(typed: str, expected: str) -> None:
    assert policy.normalize_recovery_code(typed) == expected


@pytest.mark.parametrize(
    "typed",
    [
        "",
        "0123-4567",
        "0123456789abcdef0123456789abcde",  # 31
        "0123456789abcdef0123456789abcdef0",  # 33
        "0123456789abcdef0123456789abcdeg",  # not hexadecimal
        " 0123456789abcdef0123456789abcdef",  # a space is not a display separator
        "0123456789abcdef0123456789abcdef\n",
        "۰۱۲۳456789abcdef0123456789abcdef",  # extended Arabic-Indic digits are not mapped
        "0123–4567–89ab–cdef–0123–4567–89ab–cdef",  # en dashes are not display separators
    ],
)
def test_malformed_recovery_codes_do_not_normalize(typed: str) -> None:
    assert policy.normalize_recovery_code(typed) is None


def test_reset_grants_are_opaque_and_never_look_like_a_code() -> None:
    grants = {policy.new_reset_grant() for _ in range(100)}
    assert len(grants) == 100
    for grant in grants:
        assert len(grant) == 43
        assert policy.normalize_recovery_code(grant) is None


# --- time zones and client prefixes ---------------------------------------------------------------


@pytest.mark.parametrize(
    "zone", ["Asia/Dubai", "UTC", "Etc/UTC", "Europe/London", "America/New_York"]
)
def test_known_time_zones(zone: str) -> None:
    assert policy.is_valid_time_zone(zone)


@pytest.mark.parametrize(
    "zone",
    [
        "",
        "asia/dubai",
        "Mars/Olympus",
        "../etc/passwd",
        "localtime",
        "Asia\\Dubai",
        "A" * 300,
        None,
        5,
    ],
)
def test_unknown_time_zones(zone: object) -> None:
    assert not policy.is_valid_time_zone(zone)


@pytest.mark.parametrize(
    ("address", "prefix"),
    [
        ("203.0.113.9", "203.0.113.0/24"),
        ("203.0.113.255", "203.0.113.0/24"),
        ("2001:db8:1234:5678::1", "2001:db8:1234::/48"),
        ("::ffff:203.0.113.9", "203.0.113.0/24"),
        ("fe80::1%eth0", "fe80::/48"),
        (" 198.51.100.7 ", "198.51.100.0/24"),
    ],
)
def test_client_prefix(address: str, prefix: str) -> None:
    assert policy.ip_prefix(address) == prefix


@pytest.mark.parametrize("address", ["testclient", "unknown", "", "999.1.1.1", "not-an-ip"])
def test_unparsable_addresses_share_one_prefix_that_no_username_can_equal(address: str) -> None:
    prefix = policy.ip_prefix(address)
    assert prefix == policy.UNKNOWN_IP_PREFIX
    assert "/" in prefix and policy.username_violations(prefix) != []


# --- throttle table -------------------------------------------------------------------------------


def test_delay_follows_the_progressive_table() -> None:
    expected = {0: 0, 1: 0, 4: 0, 5: 1, 6: 2, 7: 4, 8: 8, 9: 10, 10: 20, 11: 30, 12: 40}
    for failures, delay in expected.items():
        assert policy.throttle_delay_sec(failures) == delay
    assert [policy.throttle_delay_sec(n) for n in range(13, 21)] == [50, 60, 60, 60, 60, 60, 60, 60]
    assert max(policy.throttle_delay_sec(n) for n in range(0, 500)) == 60


def test_twenty_failures_lock_the_key() -> None:
    assert not policy.throttle_locked(19)
    assert policy.throttle_locked(20)
    assert policy.throttle_locked(500)
    assert policy.THROTTLE_LOCK_SEC == 900


# --- terms ----------------------------------------------------------------------------------------


def test_terms_are_current_only_when_equal() -> None:
    assert policy.terms_are_current("2026-10-04", "2026-10-04")
    assert not policy.terms_are_current("2026-09-01", "2026-10-04")
    assert not policy.terms_are_current("2027-01-01", "2026-10-04")  # versions are not ordered
    assert not policy.terms_are_current(None, "2026-10-04")


# --- settings -------------------------------------------------------------------------------------

NOON_UTC = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)  # 16:00 in Dubai
LATE_UTC = datetime(2026, 10, 4, 20, 30, tzinfo=UTC)  # 00:30 on the 5th in Dubai


def settings(**overrides: object) -> AccountSettings:
    values: dict[str, object] = {
        "language": "ar",
        "time_zone": "Asia/Dubai",
        "session_minutes": 10,
        "reminder_in_app": True,
        "pending": None,
    }
    values.update(overrides)
    return AccountSettings(**values)  # type: ignore[arg-type]


def test_next_learning_date_follows_the_zone_in_force() -> None:
    assert policy.next_learning_date("Asia/Dubai", NOON_UTC) == date(2026, 10, 5)
    assert policy.next_learning_date("Asia/Dubai", LATE_UTC) == date(2026, 10, 6)
    assert policy.next_learning_date("UTC", LATE_UTC) == date(2026, 10, 5)
    assert policy.next_learning_date("Pacific/Kiritimati", NOON_UTC) == date(2026, 10, 6)


def test_an_unloadable_zone_reads_as_utc() -> None:
    assert policy.local_date("Mars/Olympus", LATE_UTC) == date(2026, 10, 4)


def test_language_and_reminder_apply_at_once() -> None:
    after = policy.apply_patch(
        settings(), SettingsPatch(language="en", reminder_in_app=False), NOON_UTC
    )
    assert (after.language, after.reminder_in_app, after.pending) == ("en", False, None)


def test_minutes_and_zone_become_pending_for_the_next_learning_day() -> None:
    after = policy.apply_patch(
        settings(), SettingsPatch(session_minutes=15, time_zone="Europe/London"), NOON_UTC
    )
    assert after.session_minutes == 10 and after.time_zone == "Asia/Dubai"
    assert after.pending == {
        "sessionMinutes": 15,
        "timeZone": "Europe/London",
        "effectiveDate": "2026-10-05",
    }


def test_the_effective_date_uses_the_zone_in_force_not_the_requested_one() -> None:
    after = policy.apply_patch(settings(), SettingsPatch(time_zone="Pacific/Kiritimati"), LATE_UTC)
    assert after.pending == {"timeZone": "Pacific/Kiritimati", "effectiveDate": "2026-10-06"}


def test_a_later_request_replaces_the_pending_value_of_the_same_field_only() -> None:
    first = policy.apply_patch(
        settings(), SettingsPatch(session_minutes=15, time_zone="Europe/London"), NOON_UTC
    )
    second = policy.apply_patch(first, SettingsPatch(session_minutes=5), NOON_UTC)
    assert second.pending == {
        "sessionMinutes": 5,
        "timeZone": "Europe/London",
        "effectiveDate": "2026-10-05",
    }


def test_asking_for_the_value_in_force_withdraws_a_pending_change() -> None:
    pending = {"sessionMinutes": 15, "effectiveDate": "2026-10-05"}
    after = policy.apply_patch(
        settings(pending=pending), SettingsPatch(session_minutes=10), NOON_UTC
    )
    assert after.pending is None
    unchanged = policy.apply_patch(settings(), SettingsPatch(session_minutes=10), NOON_UTC)
    assert unchanged.pending is None  # nothing pending is created for the value already in force


def test_repeating_a_patch_gives_the_same_state() -> None:
    patch = SettingsPatch(language="en", session_minutes=15)
    once = policy.apply_patch(settings(), patch, NOON_UTC)
    twice = policy.apply_patch(once, patch, NOON_UTC)
    assert once == twice


def test_a_pending_change_waits_until_its_learning_day_begins() -> None:
    pending = {"sessionMinutes": 15, "timeZone": "Europe/London", "effectiveDate": "2026-10-05"}
    waiting = policy.settings_in_force(settings(pending=pending), NOON_UTC)
    assert (waiting.session_minutes, waiting.time_zone, waiting.pending) == (
        10,
        "Asia/Dubai",
        pending,
    )
    started = policy.settings_in_force(
        settings(pending=pending), datetime(2026, 10, 4, 20, 1, tzinfo=UTC)
    )
    assert (started.session_minutes, started.time_zone, started.pending) == (
        15,
        "Europe/London",
        None,
    )


def test_a_malformed_pending_value_is_ignored_in_the_view() -> None:
    for pending in ({"sessionMinutes": 15}, {"sessionMinutes": 15, "effectiveDate": "soon"}, {}):
        view = policy.settings_in_force(settings(pending=pending), NOON_UTC)
        assert view.pending is None and view.session_minutes == 10
    junk = {"sessionMinutes": 7, "timeZone": "Mars/Olympus", "effectiveDate": "2026-10-01"}
    view = policy.settings_in_force(settings(pending=junk), NOON_UTC)
    assert (view.session_minutes, view.time_zone) == (10, "Asia/Dubai")


def test_a_patch_after_the_effective_date_stores_the_promotion() -> None:
    pending = {"sessionMinutes": 15, "effectiveDate": "2026-10-04"}
    stored = settings(pending=pending)
    new = policy.apply_patch(stored, SettingsPatch(language="en"), LATE_UTC)
    assert policy.settings_changes(stored, new) == {
        "language": "en",
        "session_minutes": 15,
        "pending_settings": None,
    }


def test_settings_changes_lists_only_what_differs() -> None:
    stored = settings()
    assert policy.settings_changes(stored, stored) == {}
    new = policy.apply_patch(
        stored, SettingsPatch(language="en", reminder_in_app=False, session_minutes=5), NOON_UTC
    )
    assert policy.settings_changes(stored, new) == {
        "language": "en",
        "reminder_settings": {"inApp": False},
        "pending_settings": {"sessionMinutes": 5, "effectiveDate": "2026-10-05"},
    }


@pytest.mark.parametrize(
    ("value", "valid"),
    [
        ({"inApp": True}, True),
        ({"inApp": False}, True),
        ({}, False),
        ({"inApp": 1}, False),
        ({"inApp": "true"}, False),
        ({"inApp": True, "push": False}, False),
        ({"push": True}, False),
        (None, False),
        ([], False),
    ],
)
def test_reminder_settings_are_exactly_in_app(value: object, valid: bool) -> None:
    assert policy.validate_reminder_settings(value) is valid


def test_empty_patch() -> None:
    assert SettingsPatch().is_empty()
    assert not SettingsPatch(language="en").is_empty()
