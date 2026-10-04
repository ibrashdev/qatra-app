"""Authentication and account policy (pure: standard library only, no framework or database).

Sources: Implementation-contract §6 and Authentication-and-privacy.md (the owning policy), API-spec
§1.7, §1.8 (auth throttle, A-03), §1.10 (learning dates), §4.2 and §4.3 (E03-E13).

Everything here is a rule or a number; storage, cryptography and HTTP live elsewhere. Do not
confuse username normalization with ``arabic-norm-v1`` (``normalization.py``): that policy grades
words and is never applied to usernames, passwords or recovery codes.

Numbers that the contract approves are plain constants. Numbers that are architect configuration
defaults (API-spec A-03 and A-12, not owner-approved numbers) are marked as such.
"""

from __future__ import annotations

import functools
import ipaddress
import secrets
import unicodedata
import zoneinfo
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any, Final

# --- approved numbers (contract §6, API-spec §1.7) ------------------------------------------------

USERNAME_MIN_LENGTH: Final = 3
USERNAME_MAX_LENGTH: Final = 24
PASSWORD_MIN_CHARS: Final = 15
PASSWORD_MAX_BYTES: Final = 72
RECOVERY_CODE_BYTES: Final = 16
RECOVERY_CODE_HEX_LENGTH: Final = 32
RESET_GRANT_LIFETIME_SEC: Final = 600
SESSION_LIFETIME_SEC: Final = 30 * 24 * 60 * 60
THROTTLE_FAILURES_BEFORE_DELAY: Final = 5
THROTTLE_FAILURES_LOCK: Final = 20
THROTTLE_LOCK_SEC: Final = 15 * 60

# --- configuration defaults (A-03, A-12), not approved numbers ------------------------------------

THROTTLE_DELAY_STEPS_SEC: Final = (1, 2, 4, 8)
THROTTLE_DELAY_PER_FAILURE_SEC: Final = 10
THROTTLE_DELAY_CAP_SEC: Final = 60
TOKEN_REFRESH_MARGIN_SEC: Final = 60
# Shared prefix of addresses that cannot be parsed. It contains "/", which no username can
# contain, so it never equals the throttle key of a username.
UNKNOWN_IP_PREFIX: Final = "unknown/0"

LANGUAGES: Final = ("ar", "en")
SESSION_MINUTES_OPTIONS: Final = (5, 10, 15)
DEFAULT_SESSION_MINUTES: Final = 10  # A-07 (Database-schema OPEN-09)

# --- usernames (contract §6, API-spec E03 and O-11) -----------------------------------------------

_ARABIC_INDIC_DIGITS: Final = {0x0660 + i: ord("0") + i for i in range(10)}
_LATIN_LOWER: Final = {code: code + 32 for code in range(ord("A"), ord("Z") + 1)}

# Characters that are invisible or blank although some are not whitespace or format characters.
_INVISIBLE_CATEGORIES: Final = frozenset({"Cc", "Cf", "Zl", "Zp", "Zs"})
_INVISIBLE_CODE_POINTS: Final = frozenset(
    {0x034F, 0x115F, 0x1160, 0x17B4, 0x17B5, 0x2800, 0x3164, 0xFFA0}
)
_INVISIBLE_RANGES: Final = (
    (0x180B, 0x180F),  # Mongolian free variation selectors and vowel separator
    (0xFE00, 0xFE0F),  # variation selectors
    (0xE0000, 0xE007F),  # tag characters
    (0xE0100, 0xE01EF),  # variation selectors supplement
)


def username_display(raw: str) -> str:
    """The stored display form: NFKC, Arabic-Indic digits mapped to ASCII, case preserved.

    NFKC is applied first so the 3-24 length is counted after it (O-11); the display form is
    what the database length check sees."""
    return unicodedata.normalize("NFKC", raw).translate(_ARABIC_INDIC_DIGITS)


def normalize_username(raw: str) -> str:
    """The uniqueness and lookup key: NFKC, Arabic-Indic digits to ASCII, Latin letters lower
    case, and nothing else (no Arabic letter folding). Total: it never fails on odd input."""
    return username_display(raw).translate(_LATIN_LOWER)


def _classify_username_char(char: str) -> str:
    code = ord(char)
    if (
        char == "_"
        or "0" <= char <= "9"
        or "a" <= char <= "z"
        or "A" <= char <= "Z"
        or 0x0621 <= code <= 0x064A  # Arabic letters (O-11)
    ):
        return "ok"
    if (
        char.isspace()
        or unicodedata.category(char) in _INVISIBLE_CATEGORIES
        or code in _INVISIBLE_CODE_POINTS
        or any(low <= code <= high for low, high in _INVISIBLE_RANGES)
    ):
        return "invisible"
    return "invalid"


def username_violations(raw: str) -> list[str]:
    """Rule names (API-spec E03) a username breaks, in a fixed order; empty when it is valid.

    ``username_length`` counts code points after NFKC; ``username_chars`` is any character
    outside Arabic letters U+0621-U+064A, ASCII letters, digits and underscore;
    ``username_invisible_or_space`` is any whitespace or invisible character (reported instead
    of, not in addition to, ``username_chars`` for that character)."""
    name = username_display(raw)
    rules: list[str] = []
    if not USERNAME_MIN_LENGTH <= len(name) <= USERNAME_MAX_LENGTH:
        rules.append("username_length")
    classes = {_classify_username_char(char) for char in name}
    if "invalid" in classes:
        rules.append("username_chars")
    if "invisible" in classes:
        rules.append("username_invisible_or_space")
    return rules


def is_storable_text(text: str) -> bool:
    """True when ``text`` can be sent to the database as a text parameter: strictly encodable
    as UTF-8 and without NUL. A lookup key that is not storable cannot match any account."""
    if "\x00" in text:
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


# --- passwords (contract §6, API-spec E03) --------------------------------------------------------


def password_byte_length(password: str) -> int:
    """UTF-8 length; a password that is not encodable counts as over the limit."""
    try:
        return len(password.encode("utf-8"))
    except UnicodeEncodeError:
        return PASSWORD_MAX_BYTES + 1


def password_violations(password: str) -> list[str]:
    """``password_min_chars`` (fewer than 15 Unicode code points) and ``password_max_bytes``
    (more than 72 bytes in UTF-8, or not encodable). The password is never truncated, trimmed
    or normalized, and no composition rule applies."""
    rules: list[str] = []
    if len(password) < PASSWORD_MIN_CHARS:
        rules.append("password_min_chars")
    if password_byte_length(password) > PASSWORD_MAX_BYTES:
        rules.append("password_max_bytes")
    return rules


def password_can_authenticate(password: str) -> bool:
    """A password above 72 bytes cannot match any stored password (API-spec E04): it is a
    failed login without calling the identity provider."""
    return password_byte_length(password) <= PASSWORD_MAX_BYTES


# --- recovery codes and reset grants (contract §6) ------------------------------------------------

_RECOVERY_NORMALIZE: Final = {
    **{0x0660 + i: ord("0") + i for i in range(10)},
    **{ord("A") + i: ord("a") + i for i in range(6)},
}
_HEX_DIGITS: Final = frozenset("0123456789abcdef")
_RECOVERY_GROUP: Final = 4


def generate_recovery_code() -> str:
    """16 random bytes from the cryptographic generator, as 32 lowercase hexadecimal characters."""
    return secrets.token_hex(RECOVERY_CODE_BYTES)


def format_recovery_code(code: str) -> str:
    """Display form: groups of four separated by ``-`` (never part of the stored value)."""
    return "-".join(code[i : i + _RECOVERY_GROUP] for i in range(0, len(code), _RECOVERY_GROUP))


def normalize_recovery_code(text: str) -> str | None:
    """Remove display separators ``-``, map Arabic-Indic digits to 0-9 and ``A``-``F`` to
    ``a``-``f``; the result must be exactly 32 hexadecimal characters, else ``None``."""
    code = text.replace("-", "").translate(_RECOVERY_NORMALIZE)
    if len(code) != RECOVERY_CODE_HEX_LENGTH or not _HEX_DIGITS.issuperset(code):
        return None
    return code


def new_reset_grant() -> str:
    """An opaque reset grant: 32 random bytes as 43 base64url characters. Its length can never
    equal a recovery code's 32 hexadecimal characters."""
    return secrets.token_urlsafe(32)


# --- time zones, client address -------------------------------------------------------------------


# Files that live next to the IANA zones on some systems but are not IANA zone names.
_SYSTEM_ZONE_ARTIFACTS: Final = frozenset({"localtime", "posixrules"})


@functools.cache
def _known_time_zones() -> frozenset[str]:
    return frozenset(zoneinfo.available_timezones()) - _SYSTEM_ZONE_ARTIFACTS


def is_valid_time_zone(name: object) -> bool:
    """A member of the IANA database (API-spec §1.10)."""
    return isinstance(name, str) and name in _known_time_zones()


def ip_prefix(address: str) -> str:
    """The throttle prefix of a client address: IPv4 /24, IPv6 /48 (an IPv4-mapped IPv6 address
    counts as IPv4). Anything that is not an address maps to one shared ``unknown`` prefix."""
    try:
        ip = ipaddress.ip_address(address.strip().split("%", 1)[0])
    except ValueError:
        return UNKNOWN_IP_PREFIX
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    bits = 24 if ip.version == 4 else 48
    return str(ipaddress.ip_network((ip, bits), strict=False))


# --- auth throttle (A-03, API-spec §1.7) ---------------------------------------------------------


def throttle_delay_sec(failures: int) -> int:
    """The pause demanded after the ``failures``-th failure inside the 15-minute window.

    Nothing below 5 failures. From the 5th: 1, 2, 4 and 8 seconds, then 10 seconds more per
    further failure (10, 20, 30, ...), never above 60 (A-03; the reading of "10 s per failure"
    as a growing step is recorded in the B3 report)."""
    if failures < THROTTLE_FAILURES_BEFORE_DELAY:
        return 0
    step = failures - THROTTLE_FAILURES_BEFORE_DELAY
    if step < len(THROTTLE_DELAY_STEPS_SEC):
        return THROTTLE_DELAY_STEPS_SEC[step]
    grown = THROTTLE_DELAY_PER_FAILURE_SEC * (step - len(THROTTLE_DELAY_STEPS_SEC) + 1)
    return min(THROTTLE_DELAY_CAP_SEC, grown)


def throttle_locked(failures: int) -> bool:
    """20 failures inside the window lock the key (429 for 15 minutes)."""
    return failures >= THROTTLE_FAILURES_LOCK


# --- terms (D52) ----------------------------------------------------------------------------------


def terms_are_current(stored_version: str | None, required_version: str) -> bool:
    """The accepted version is the current one. Any other value, older or not, asks for new
    consent: versions are opaque labels and are never ordered."""
    return stored_version == required_version


# --- account settings (API-spec E11, E12; D57) ----------------------------------------------------


@dataclass(frozen=True, slots=True)
class AccountSettings:
    """The settings columns of a profile, as stored.

    ``pending`` is ``None`` or ``{"sessionMinutes"?, "timeZone"?, "effectiveDate": "YYYY-MM-DD"}``:
    a change that waits for its learning day (D57)."""

    language: str
    time_zone: str
    session_minutes: int
    reminder_in_app: bool
    pending: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class SettingsPatch:
    """The fields of a ``PATCH /api/me`` request that were sent (``None`` = not sent)."""

    language: str | None = None
    time_zone: str | None = None
    session_minutes: int | None = None
    reminder_in_app: bool | None = None

    def is_empty(self) -> bool:
        return (
            self.language is None
            and self.time_zone is None
            and self.session_minutes is None
            and self.reminder_in_app is None
        )


def validate_reminder_settings(value: object) -> bool:
    """Exactly ``{"inApp": boolean}``: in-app reminder only, push and email are out of this
    build (API-spec E12)."""
    return isinstance(value, dict) and set(value) == {"inApp"} and isinstance(value["inApp"], bool)


def local_date(time_zone: str, now: datetime) -> date:
    """The learning date of ``now`` in ``time_zone`` (a zone this process cannot load is read
    as UTC rather than failing the request)."""
    try:
        zone: Any = zoneinfo.ZoneInfo(time_zone)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        zone = UTC
    return now.astimezone(zone).date()


def next_learning_date(time_zone: str, now: datetime) -> date:
    """The next learning date in the zone in force: local midnight starts a new day (D57)."""
    return local_date(time_zone, now) + timedelta(days=1)


def _pending_date(pending: dict[str, Any]) -> date | None:
    value = pending.get("effectiveDate")
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def settings_in_force(stored: AccountSettings, now: datetime) -> AccountSettings:
    """The settings that apply at ``now``: a pending change whose learning day has begun is
    applied (read-time projection; nothing is written); one that still waits is kept."""
    pending = stored.pending
    if not pending:
        return replace(stored, pending=None)
    effective = _pending_date(pending)
    if effective is None:
        return replace(stored, pending=None)
    if local_date(stored.time_zone, now) < effective:
        return stored
    zone = pending.get("timeZone")
    minutes = pending.get("sessionMinutes")
    return replace(
        stored,
        time_zone=zone if is_valid_time_zone(zone) else stored.time_zone,
        session_minutes=minutes if minutes in SESSION_MINUTES_OPTIONS else stored.session_minutes,
        pending=None,
    )


def apply_patch(stored: AccountSettings, patch: SettingsPatch, now: datetime) -> AccountSettings:
    """The settings after a patch (D57): language and the reminder change at once; a time zone
    or session-minutes change is recorded as pending for the next learning date in the zone in
    force. A later request replaces the pending value of the same field; asking for the value
    already in force withdraws a pending change of that field."""
    current = settings_in_force(stored, now)
    pending = {
        key: current.pending[key]
        for key in ("sessionMinutes", "timeZone")
        if current.pending and key in current.pending
    }
    if patch.time_zone is not None:
        if patch.time_zone == current.time_zone:
            pending.pop("timeZone", None)
        else:
            pending["timeZone"] = patch.time_zone
    if patch.session_minutes is not None:
        if patch.session_minutes == current.session_minutes:
            pending.pop("sessionMinutes", None)
        else:
            pending["sessionMinutes"] = patch.session_minutes
    new_pending: dict[str, Any] | None = None
    if pending:
        new_pending = {
            **pending,
            "effectiveDate": next_learning_date(current.time_zone, now).isoformat(),
        }
    return AccountSettings(
        language=patch.language if patch.language is not None else current.language,
        time_zone=current.time_zone,
        session_minutes=current.session_minutes,
        reminder_in_app=(
            patch.reminder_in_app if patch.reminder_in_app is not None else current.reminder_in_app
        ),
        pending=new_pending,
    )


def settings_changes(stored: AccountSettings, new: AccountSettings) -> dict[str, Any]:
    """The profile columns to write so that the stored row equals ``new`` (empty when the row
    already matches). Only the five columns a learner may update appear."""
    changes: dict[str, Any] = {}
    if new.language != stored.language:
        changes["language"] = new.language
    if new.time_zone != stored.time_zone:
        changes["time_zone"] = new.time_zone
    if new.session_minutes != stored.session_minutes:
        changes["session_minutes"] = new.session_minutes
    if new.reminder_in_app != stored.reminder_in_app:
        changes["reminder_settings"] = {"inApp": new.reminder_in_app}
    if new.pending != stored.pending:
        changes["pending_settings"] = new.pending
    return changes
