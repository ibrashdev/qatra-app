"""Production key validation in ``app/config.py``: the four keys must decode from base64 to the
required lengths and differ from each other; errors name variables and never print values."""

from __future__ import annotations

import base64
import secrets

import pytest

from app.config import (
    Settings,
    StartupConfigError,
    decode_key_material,
    key_material_problems,
    validate_startup,
)
from app.main import create_app
from tests.support import make_settings, production_values, random_key_b64

NAMES = (
    "QATRA_SESSION_KEY",
    "QATRA_SESSION_HMAC_KEY",
    "QATRA_RECOVERY_HMAC_KEY",
    "QATRA_THROTTLE_HMAC_KEY",
)


def production(**overrides: str) -> Settings:
    return Settings(_env_file=None, **production_values(**overrides))  # type: ignore[call-arg]


# --- decoding -------------------------------------------------------------------------------------


def test_standard_base64_with_or_without_padding_decodes() -> None:
    raw = secrets.token_bytes(32)
    padded = base64.b64encode(raw).decode()
    assert padded.endswith("=")
    assert decode_key_material(padded) == raw
    assert decode_key_material(padded.rstrip("=")) == raw
    assert decode_key_material(f"  {padded}\n") == raw


@pytest.mark.parametrize("value", ["not base64!", "a-b_c", "ab=cd", "%%%", "ä" * 8, "AAAA\nAAAA"])
def test_anything_that_is_not_base64_does_not_decode(value: str) -> None:
    assert decode_key_material(value) is None


def test_an_empty_value_decodes_to_nothing() -> None:
    assert decode_key_material("") == b""


# --- validation -----------------------------------------------------------------------------------


def test_a_complete_production_configuration_has_no_key_problems() -> None:
    assert key_material_problems(production()) == []
    validate_startup(production())


def test_hmac_keys_may_be_longer_than_32_bytes() -> None:
    assert key_material_problems(production(QATRA_SESSION_HMAC_KEY=random_key_b64(64))) == []


@pytest.mark.parametrize(
    ("name", "value", "text"),
    [
        ("QATRA_SESSION_KEY", "definitely not base64", "must be base64"),
        ("QATRA_SESSION_KEY", random_key_b64(31), "exactly 32 bytes"),
        ("QATRA_SESSION_KEY", random_key_b64(33), "exactly 32 bytes"),
        ("QATRA_SESSION_KEY", random_key_b64(16), "exactly 32 bytes"),
        ("QATRA_SESSION_HMAC_KEY", random_key_b64(31), "at least 32 bytes"),
        ("QATRA_RECOVERY_HMAC_KEY", random_key_b64(1), "at least 32 bytes"),
        ("QATRA_THROTTLE_HMAC_KEY", "dummy-throttle-hmac", "must be base64"),
    ],
)
def test_an_invalid_key_stops_startup_naming_the_variable_only(
    name: str, value: str, text: str
) -> None:
    settings = production(**{name: value})
    with pytest.raises(StartupConfigError) as raised:
        validate_startup(settings)
    message = str(raised.value)
    assert name in message and text in message
    assert value not in message
    with pytest.raises(StartupConfigError):
        create_app(settings)


def test_every_invalid_key_is_listed_at_once() -> None:
    settings = production(
        QATRA_SESSION_KEY="x", QATRA_SESSION_HMAC_KEY="y", QATRA_THROTTLE_HMAC_KEY="z"
    )
    problems = key_material_problems(settings)
    assert len(problems) == 3
    for name in ("QATRA_SESSION_KEY", "QATRA_SESSION_HMAC_KEY", "QATRA_THROTTLE_HMAC_KEY"):
        assert any(problem.startswith(name) for problem in problems)


def test_one_key_per_purpose() -> None:
    shared = random_key_b64()
    settings = production(QATRA_SESSION_HMAC_KEY=shared, QATRA_RECOVERY_HMAC_KEY=shared)
    problems = key_material_problems(settings)
    assert problems == [
        "QATRA_RECOVERY_HMAC_KEY and QATRA_SESSION_HMAC_KEY must be different keys "
        "(one per purpose)"
    ]
    assert shared not in " ".join(problems)
    same_aes_and_hmac = production(QATRA_SESSION_KEY=shared, QATRA_THROTTLE_HMAC_KEY=shared)
    assert len(key_material_problems(same_aes_and_hmac)) == 1


def test_a_missing_key_is_reported_as_missing_not_as_invalid() -> None:
    values = production_values()
    del values["QATRA_SESSION_KEY"]
    settings = Settings(_env_file=None, **values)  # type: ignore[call-arg]
    assert key_material_problems(settings) == []  # reported by the required-variables check
    with pytest.raises(StartupConfigError) as raised:
        validate_startup(settings)
    assert "QATRA_SESSION_KEY" in str(raised.value) and "missing" in str(raised.value)


def test_blank_keys_are_missing() -> None:
    settings = production(QATRA_THROTTLE_HMAC_KEY="   ")
    with pytest.raises(StartupConfigError) as raised:
        validate_startup(settings)
    assert "QATRA_THROTTLE_HMAC_KEY" in str(raised.value)


def test_outside_production_validate_startup_does_not_check_the_keys() -> None:
    settings = make_settings(
        QATRA_SESSION_KEY="whatever", QATRA_SESSION_HMAC_KEY="whatever", APP_ENV="development"
    )
    validate_startup(settings)
    # create_app installs authentication, which refuses a key that is set but invalid.
    with pytest.raises(StartupConfigError) as raised:
        create_app(settings)
    assert "QATRA_SESSION_KEY" in str(raised.value) and "whatever" not in str(raised.value)


def test_the_production_check_runs_beside_the_other_production_checks() -> None:
    settings = production(FRONTEND_ORIGIN="http://not-https.example", QATRA_SESSION_KEY="bad")
    with pytest.raises(StartupConfigError) as raised:
        validate_startup(settings)
    assert "FRONTEND_ORIGIN" in str(raised.value) and "QATRA_SESSION_KEY" in str(raised.value)
    assert "not-https" not in str(raised.value) and "bad" not in str(raised.value).replace(
        "QATRA_SESSION_KEY must be base64", ""
    )


@pytest.mark.parametrize("name", NAMES)
def test_secret_values_never_appear_in_the_settings_repr(name: str) -> None:
    value = random_key_b64()
    settings = production(**{name: value})
    assert value not in repr(settings) and value not in str(settings)
