"""Session cryptography: AES-256-GCM token blobs, HMAC fingerprints, cookie codec, key loading, and
the cookie attributes (contract §6; API-spec §1.3; Database-schema §6.2)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from uuid import UUID

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import Settings, StartupConfigError
from app.domain import auth_policy as policy
from app.routers.auth import clear_session_cookie, session_cookie_header, set_session_cookie
from app.services.session_crypto import (
    AAD_PREFIX,
    COOKIE_NAME_DEVELOPMENT,
    COOKIE_NAME_PRODUCTION,
    FORMAT_VERSION,
    NONCE_BYTES,
    SessionCrypto,
    TokenBundle,
    TokenDecryptionError,
    cookie_is_secure,
    cookie_name_for,
)
from tests.support import make_settings, production_values, random_key_b64

ACCOUNT = UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000001")
OTHER_ACCOUNT = UUID("aaaaaaaa-aaaa-4aaa-8aaa-000000000002")


def keys() -> dict[str, bytes]:
    return {
        "session_key": secrets.token_bytes(32),
        "session_hmac_key": secrets.token_bytes(32),
        "recovery_hmac_key": secrets.token_bytes(32),
        "throttle_hmac_key": secrets.token_bytes(32),
    }


@pytest.fixture
def material() -> dict[str, bytes]:
    return keys()


@pytest.fixture
def crypto(material: dict[str, bytes]) -> SessionCrypto:
    return SessionCrypto(**material)


BUNDLE = TokenBundle(access="access-token-value", refresh="refresh-token-value", exp=1_790_000_000)


# --- AES-256-GCM ----------------------------------------------------------------------------------


def test_round_trip(crypto: SessionCrypto) -> None:
    blob = crypto.encrypt_tokens(BUNDLE, ACCOUNT)
    assert crypto.decrypt_tokens(blob, ACCOUNT) == BUNDLE


def test_stored_layout_is_version_nonce_ciphertext_and_tag(
    crypto: SessionCrypto, material: dict[str, bytes]
) -> None:
    """Decrypt with the library directly: this pins the documented format, not just a round trip."""
    blob = crypto.encrypt_tokens(BUNDLE, ACCOUNT)
    assert blob[:1] == FORMAT_VERSION == b"\x01"
    nonce, sealed = blob[1 : 1 + NONCE_BYTES], blob[1 + NONCE_BYTES :]
    assert NONCE_BYTES == 12 and len(sealed) >= 16
    aad = b"qatra/app-session-tokens/v1|" + ACCOUNT.bytes
    assert AAD_PREFIX + ACCOUNT.bytes == aad
    plaintext = AESGCM(material["session_key"]).decrypt(nonce, sealed, aad)
    assert plaintext == (
        b'{"access":"access-token-value","refresh":"refresh-token-value","exp":1790000000}'
    )


def test_every_encryption_uses_a_fresh_nonce(crypto: SessionCrypto) -> None:
    blobs = {crypto.encrypt_tokens(BUNDLE, ACCOUNT) for _ in range(50)}
    assert len(blobs) == 50
    assert len({blob[1 : 1 + NONCE_BYTES] for blob in blobs}) == 50


def test_tokens_do_not_appear_in_the_blob(crypto: SessionCrypto) -> None:
    blob = crypto.encrypt_tokens(BUNDLE, ACCOUNT)
    assert b"access-token-value" not in blob and b"refresh-token-value" not in blob


@pytest.mark.parametrize("position", [0, 1, 5, 12, 13, 20, -1, -16, -17])
def test_any_flipped_byte_fails_authentication(crypto: SessionCrypto, position: int) -> None:
    blob = bytearray(crypto.encrypt_tokens(BUNDLE, ACCOUNT))
    blob[position] ^= 0x01
    with pytest.raises(TokenDecryptionError):
        crypto.decrypt_tokens(bytes(blob), ACCOUNT)


@pytest.mark.parametrize("size", [0, 1, 12, 28, 29])
def test_truncated_blobs_fail(crypto: SessionCrypto, size: int) -> None:
    blob = crypto.encrypt_tokens(BUNDLE, ACCOUNT)
    with pytest.raises(TokenDecryptionError):
        crypto.decrypt_tokens(blob[:size], ACCOUNT)
    with pytest.raises(TokenDecryptionError):
        crypto.decrypt_tokens(blob + b"\x00", ACCOUNT)


def test_a_blob_does_not_decrypt_for_another_account(crypto: SessionCrypto) -> None:
    """The associated data binds the tokens to the account: a blob copied into another
    account's session row is rejected."""
    blob = crypto.encrypt_tokens(BUNDLE, ACCOUNT)
    with pytest.raises(TokenDecryptionError):
        crypto.decrypt_tokens(blob, OTHER_ACCOUNT)


def test_a_blob_does_not_decrypt_under_another_key(crypto: SessionCrypto) -> None:
    other = SessionCrypto(**keys())
    with pytest.raises(TokenDecryptionError):
        other.decrypt_tokens(crypto.encrypt_tokens(BUNDLE, ACCOUNT), ACCOUNT)


def test_the_format_version_is_checked(crypto: SessionCrypto) -> None:
    blob = crypto.encrypt_tokens(BUNDLE, ACCOUNT)
    with pytest.raises(TokenDecryptionError):
        crypto.decrypt_tokens(b"\x02" + blob[1:], ACCOUNT)


@pytest.mark.parametrize(
    "plaintext",
    [
        b"not json",
        b"[]",
        b'{"access":"a","refresh":"r"}',
        b'{"access":1,"refresh":"r","exp":1}',
        b'{"access":"a","refresh":2,"exp":1}',
        b'{"access":"a","refresh":"r","exp":"soon"}',
        b'{"access":"a","refresh":"r","exp":true}',
        b'{"access":"a","refresh":"r","exp":1.5}',
    ],
)
def test_a_well_authenticated_but_malformed_plaintext_is_rejected(
    crypto: SessionCrypto, material: dict[str, bytes], plaintext: bytes
) -> None:
    nonce = secrets.token_bytes(NONCE_BYTES)
    sealed = AESGCM(material["session_key"]).encrypt(nonce, plaintext, AAD_PREFIX + ACCOUNT.bytes)
    with pytest.raises(TokenDecryptionError):
        crypto.decrypt_tokens(FORMAT_VERSION + nonce + sealed, ACCOUNT)


def test_the_error_and_repr_reveal_nothing(crypto: SessionCrypto) -> None:
    with pytest.raises(TokenDecryptionError) as raised:
        crypto.decrypt_tokens(b"\x01" + b"\x00" * 40, ACCOUNT)
    assert str(raised.value) == ""
    assert raised.value.__cause__ is None and raised.value.__suppress_context__
    assert "access-token-value" not in repr(BUNDLE) and "redacted" in repr(BUNDLE)
    assert "redacted" in repr(crypto)


# --- session cookie token -------------------------------------------------------------------------


def test_new_tokens_are_32_random_bytes() -> None:
    tokens = {SessionCrypto.new_session_token() for _ in range(100)}
    assert len(tokens) == 100 and {len(t) for t in tokens} == {32}


def test_cookie_value_round_trip_is_unpadded_base64url() -> None:
    token = SessionCrypto.new_session_token()
    value = SessionCrypto.encode_cookie_value(token)
    assert (
        len(value) == 43
        and "=" not in value
        and set(value) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    )
    assert SessionCrypto.decode_cookie_value(value) == token


@pytest.mark.parametrize(
    "value",
    [
        None,
        "",
        "short",
        "A" * 42,
        "A" * 44,
        "A" * 42 + "=",
        "A" * 42 + "+",  # standard-alphabet character
        "A" * 42 + "/",
        "A" * 42 + "!",
        "é" * 43,
        " " + "A" * 42,
        "A" * 42 + "B",  # 43 characters, but the last character carries non-zero spare bits
    ],
)
def test_malformed_cookie_values_are_not_sessions(value: str | None) -> None:
    assert SessionCrypto.decode_cookie_value(value) is None


def test_only_the_canonical_encoding_is_accepted() -> None:
    token = SessionCrypto.new_session_token()
    canonical = SessionCrypto.encode_cookie_value(token)
    padded = canonical + "="
    assert SessionCrypto.decode_cookie_value(padded) is None
    assert SessionCrypto.decode_cookie_value(canonical) == token


def test_session_hash_is_hmac_sha256_of_the_token(
    crypto: SessionCrypto, material: dict[str, bytes]
) -> None:
    token = SessionCrypto.new_session_token()
    expected = hmac.new(material["session_hmac_key"], token, hashlib.sha256).digest()
    assert crypto.session_hash(token) == expected and len(expected) == 32
    assert crypto.session_hash(token) == crypto.session_hash(token)
    assert SessionCrypto(**keys()).session_hash(token) != expected
    assert crypto.session_hash(SessionCrypto.new_session_token()) != expected


# --- recovery fingerprints, throttle keys ---------------------------------------------------------


def test_recovery_fingerprints_use_the_recovery_key_and_the_normalized_code(
    crypto: SessionCrypto, material: dict[str, bytes]
) -> None:
    code = "0123456789abcdef0123456789abcdef"
    expected = hmac.new(material["recovery_hmac_key"], code.encode(), hashlib.sha256).digest()
    assert crypto.recovery_fingerprint(code) == expected
    assert crypto.recovery_fingerprint(code) != crypto.recovery_fingerprint(code[::-1])
    grant = "g" * 43
    assert (
        crypto.grant_fingerprint(grant)
        == hmac.new(material["recovery_hmac_key"], grant.encode(), hashlib.sha256).digest()
    )


def test_fingerprints_are_compared_in_constant_time(
    crypto: SessionCrypto, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[bytes, bytes]] = []
    real = hmac.compare_digest

    def spy(a: bytes, b: bytes) -> bool:
        calls.append((a, b))
        return real(a, b)

    monkeypatch.setattr("app.services.session_crypto.hmac.compare_digest", spy)
    one = crypto.recovery_fingerprint("a" * 32)
    assert crypto.fingerprints_match(one, one) is True
    assert crypto.fingerprints_match(one, crypto.recovery_fingerprint("b" * 32)) is False
    assert len(calls) == 2


def test_throttle_keys_hash_the_username_and_the_prefix_under_their_own_key(
    crypto: SessionCrypto, material: dict[str, bytes]
) -> None:
    user = crypto.throttle_key_username("sample_user_01")
    assert (
        user == hmac.new(material["throttle_hmac_key"], b"sample_user_01", hashlib.sha256).digest()
    )
    prefix = crypto.throttle_key_ip("203.0.113.0/24")
    assert (
        prefix
        == hmac.new(material["throttle_hmac_key"], b"203.0.113.0/24", hashlib.sha256).digest()
    )
    assert user != prefix and len(user) == len(prefix) == 32
    # neither value contains its input
    assert b"sample_user_01" not in user and b"203.0.113" not in prefix
    assert crypto.throttle_key_username("أحمد") != crypto.throttle_key_username("احمد")


def test_keys_of_different_purposes_do_not_interchange(material: dict[str, bytes]) -> None:
    crypto = SessionCrypto(**material)
    text = "0123456789abcdef0123456789abcdef"
    values = {
        crypto.recovery_fingerprint(text),
        crypto.throttle_key_username(text),
        crypto.session_hash(text.encode()),
    }
    assert len(values) == 3


# --- key loading ----------------------------------------------------------------------------------


def test_constructor_checks_key_lengths(material: dict[str, bytes]) -> None:
    with pytest.raises(ValueError):
        SessionCrypto(**{**material, "session_key": b"x" * 31})
    with pytest.raises(ValueError):
        SessionCrypto(**{**material, "session_hmac_key": b"x" * 31})
    SessionCrypto(**{**material, "recovery_hmac_key": b"x" * 64})  # a longer HMAC key is fine


def test_from_settings_decodes_the_four_keys() -> None:
    aes = secrets.token_bytes(32)
    settings = make_settings(
        QATRA_SESSION_KEY=base64.b64encode(aes).decode(),
        QATRA_SESSION_HMAC_KEY=random_key_b64(),
        QATRA_RECOVERY_HMAC_KEY=random_key_b64(48),
        QATRA_THROTTLE_HMAC_KEY=random_key_b64(),
    )
    crypto = SessionCrypto.from_settings(settings)
    assert crypto.decrypt_tokens(crypto.encrypt_tokens(BUNDLE, ACCOUNT), ACCOUNT) == BUNDLE
    nonce = secrets.token_bytes(12)
    blob = (
        FORMAT_VERSION
        + nonce
        + AESGCM(aes).encrypt(
            nonce,
            json.dumps({"access": "a", "refresh": "r", "exp": 1}).encode(),
            AAD_PREFIX + ACCOUNT.bytes,
        )
    )
    assert crypto.decrypt_tokens(blob, ACCOUNT).access == "a"  # the configured AES key is used


def test_memory_mode_without_keys_gets_ephemeral_ones() -> None:
    settings = make_settings()
    first = SessionCrypto.from_settings(settings, allow_ephemeral=True)
    second = SessionCrypto.from_settings(settings, allow_ephemeral=True)
    blob = first.encrypt_tokens(BUNDLE, ACCOUNT)
    assert first.decrypt_tokens(blob, ACCOUNT) == BUNDLE
    with pytest.raises(TokenDecryptionError):
        second.decrypt_tokens(blob, ACCOUNT)  # a different process has different keys


def test_missing_keys_are_an_error_by_name_without_ephemeral_mode() -> None:
    with pytest.raises(StartupConfigError) as raised:
        SessionCrypto.from_settings(make_settings())
    for name in (
        "QATRA_SESSION_KEY",
        "QATRA_SESSION_HMAC_KEY",
        "QATRA_RECOVERY_HMAC_KEY",
        "QATRA_THROTTLE_HMAC_KEY",
    ):
        assert name in str(raised.value)


def test_production_never_gets_ephemeral_keys() -> None:
    values = production_values()
    del values["QATRA_SESSION_KEY"]
    settings = Settings(_env_file=None, **values)  # type: ignore[call-arg]
    with pytest.raises(StartupConfigError) as raised:
        SessionCrypto.from_settings(settings, allow_ephemeral=True)
    assert "QATRA_SESSION_KEY" in str(raised.value)


@pytest.mark.parametrize(
    ("name", "value", "text"),
    [
        ("QATRA_SESSION_KEY", "not base64 !!", "must be base64"),
        ("QATRA_SESSION_KEY", random_key_b64(16), "exactly 32 bytes"),
        ("QATRA_SESSION_KEY", random_key_b64(48), "exactly 32 bytes"),
        ("QATRA_SESSION_HMAC_KEY", random_key_b64(16), "at least 32 bytes"),
        ("QATRA_RECOVERY_HMAC_KEY", "", "required"),
        ("QATRA_THROTTLE_HMAC_KEY", "%%%", "must be base64"),
    ],
)
def test_invalid_keys_are_reported_by_name_never_by_value(name: str, value: str, text: str) -> None:
    overrides = {
        "QATRA_SESSION_KEY": random_key_b64(),
        "QATRA_SESSION_HMAC_KEY": random_key_b64(),
        "QATRA_RECOVERY_HMAC_KEY": random_key_b64(),
        "QATRA_THROTTLE_HMAC_KEY": random_key_b64(),
        name: value,
    }
    with pytest.raises(StartupConfigError) as raised:
        SessionCrypto.from_settings(make_settings(**overrides))
    message = str(raised.value)
    assert name in message and text in message
    if value:
        assert value not in message


# --- cookie attributes ----------------------------------------------------------------------------


def production() -> Settings:
    return Settings(_env_file=None, **production_values())  # type: ignore[call-arg]


def test_cookie_name_and_secure_flag_follow_the_environment() -> None:
    assert cookie_name_for(production()) == COOKIE_NAME_PRODUCTION == "__Host-qatra_session"
    assert cookie_is_secure(production()) is True
    for env in ("development", "test"):
        settings = make_settings(APP_ENV=env)
        assert cookie_name_for(settings) == COOKIE_NAME_DEVELOPMENT == "qatra_session"
        assert cookie_is_secure(settings) is False


def test_production_cookie_attributes() -> None:
    header = session_cookie_header(production(), "VALUE", 2_592_000)
    assert header == (
        "__Host-qatra_session=VALUE; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"
    )
    assert "Domain" not in header  # the __Host- prefix forbids it


def test_development_cookie_has_no_prefix_and_no_secure_flag() -> None:
    header = session_cookie_header(make_settings(), "VALUE", 2_592_000)
    assert header == "qatra_session=VALUE; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"


def test_clearing_sends_max_age_zero_with_the_same_attributes() -> None:
    from starlette.responses import Response

    response = Response(status_code=204)
    clear_session_cookie(response, production())
    assert response.headers.getlist("set-cookie") == [
        "__Host-qatra_session=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
    ]
    other = Response()
    set_session_cookie(other, make_settings(), "abc")
    assert other.headers["set-cookie"].endswith("Max-Age=2592000")


def test_session_lifetime_is_thirty_days_and_matches_the_cookie_max_age() -> None:
    assert policy.SESSION_LIFETIME_SEC == 30 * 24 * 60 * 60 == 2_592_000
