"""Session cryptography (contract §6, API-spec §1.3, Database-schema §6.2).

Everything secret-dependent lives here so that the database never receives a key, a raw cookie
token, a raw recovery code or a raw reset grant (Database-schema §8.1):

- **Supabase tokens at rest**: AES-256-GCM with ``QATRA_SESSION_KEY``. Stored bytes are
  ``0x01`` (format version) + 12-byte random nonce + ciphertext with the 16-byte tag. The
  associated data is ``b"qatra/app-session-tokens/v1|" + user_id.bytes``, so a blob copied to
  another account's session row does not decrypt. The plaintext is compact JSON
  ``{"access", "refresh", "exp"}``.
- **Fingerprints**: HMAC-SHA-256, one key per purpose: the session cookie token
  (``QATRA_SESSION_HMAC_KEY``), the recovery code and the reset grant
  (``QATRA_RECOVERY_HMAC_KEY``), and the throttle keys (``QATRA_THROTTLE_HMAC_KEY``: the
  normalized username and the IP prefix, nothing else).
- **Cookie**: 32 random bytes from ``secrets``, carried as base64url without padding; only
  ``HMAC(QATRA_SESSION_HMAC_KEY, raw bytes)`` is stored.

Secrets never appear in ``repr``, errors or logs; every failure is reported without detail.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
from dataclasses import dataclass, field
from typing import Any, Final
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import (
    AES_KEY_BYTES,
    HMAC_KEY_MIN_BYTES,
    Settings,
    StartupConfigError,
    decode_key_material,
)

FORMAT_VERSION: Final = b"\x01"
NONCE_BYTES: Final = 12
TAG_BYTES: Final = 16
AAD_PREFIX: Final = b"qatra/app-session-tokens/v1|"
SESSION_TOKEN_BYTES: Final = 32
_COOKIE_VALUE_RE: Final = re.compile(r"[A-Za-z0-9_-]{43}")

COOKIE_NAME_PRODUCTION: Final = "__Host-qatra_session"
COOKIE_NAME_DEVELOPMENT: Final = "qatra_session"


def cookie_name_for(settings: Settings) -> str:
    """``__Host-qatra_session`` in production; ``qatra_session`` otherwise (local http)."""
    return COOKIE_NAME_PRODUCTION if settings.APP_ENV == "production" else COOKIE_NAME_DEVELOPMENT


def cookie_is_secure(settings: Settings) -> bool:
    """The ``Secure`` attribute is set exactly when the cookie carries the ``__Host-`` prefix."""
    return settings.APP_ENV == "production"


class TokenDecryptionError(Exception):
    """A stored token blob did not decrypt (tampered, wrong key, wrong account or wrong
    format). Carries no detail."""


@dataclass(frozen=True, slots=True)
class TokenBundle:
    """The Supabase tokens of one app session. ``exp`` is the access token's expiry (unix
    seconds). Never shown in ``repr``; never returned to the browser."""

    access: str = field(repr=False)
    refresh: str = field(repr=False)
    exp: int

    def __repr__(self) -> str:
        return "TokenBundle(<redacted>)"


def _require_length(name: str, data: bytes, *, exact: bool) -> str | None:
    if exact and len(data) != AES_KEY_BYTES:
        return f"{name} must decode to exactly {AES_KEY_BYTES} bytes"
    if not exact and len(data) < HMAC_KEY_MIN_BYTES:
        return f"{name} must decode to at least {HMAC_KEY_MIN_BYTES} bytes"
    return None


class SessionCrypto:
    """Holds the four keys (as bytes) and offers every secret-dependent operation."""

    def __init__(
        self,
        *,
        session_key: bytes,
        session_hmac_key: bytes,
        recovery_hmac_key: bytes,
        throttle_hmac_key: bytes,
    ) -> None:
        if len(session_key) != AES_KEY_BYTES:
            raise ValueError("the session key must be 32 bytes")
        for key in (session_hmac_key, recovery_hmac_key, throttle_hmac_key):
            if len(key) < HMAC_KEY_MIN_BYTES:
                raise ValueError("an HMAC key must be at least 32 bytes")
        self._aead = AESGCM(session_key)
        self._session_hmac_key = session_hmac_key
        self._recovery_hmac_key = recovery_hmac_key
        self._throttle_hmac_key = throttle_hmac_key

    def __repr__(self) -> str:
        return "SessionCrypto(<redacted>)"

    @classmethod
    def from_settings(cls, settings: Settings, *, allow_ephemeral: bool = False) -> SessionCrypto:
        """Build from the configured keys. With ``allow_ephemeral`` (memory mode, never
        production) a missing key is replaced by a random one that lives as long as the process;
        a key that is set but invalid always fails. Errors name variables, never values."""
        specs = (
            ("QATRA_SESSION_KEY", True),
            ("QATRA_SESSION_HMAC_KEY", False),
            ("QATRA_RECOVERY_HMAC_KEY", False),
            ("QATRA_THROTTLE_HMAC_KEY", False),
        )
        keys: dict[str, bytes] = {}
        problems: list[str] = []
        for name, exact in specs:
            if settings.is_missing(name):
                if allow_ephemeral and settings.APP_ENV != "production":
                    keys[name] = secrets.token_bytes(AES_KEY_BYTES)
                else:
                    problems.append(f"{name} is required")
                continue
            data = decode_key_material(getattr(settings, name).get_secret_value())
            if data is None:
                problems.append(f"{name} must be base64")
                continue
            length_problem = _require_length(name, data, exact=exact)
            if length_problem:
                problems.append(length_problem)
                continue
            keys[name] = data
        if problems:
            raise StartupConfigError(problems)
        return cls(
            session_key=keys["QATRA_SESSION_KEY"],
            session_hmac_key=keys["QATRA_SESSION_HMAC_KEY"],
            recovery_hmac_key=keys["QATRA_RECOVERY_HMAC_KEY"],
            throttle_hmac_key=keys["QATRA_THROTTLE_HMAC_KEY"],
        )

    @staticmethod
    def new_session_token() -> bytes:
        return secrets.token_bytes(SESSION_TOKEN_BYTES)

    @staticmethod
    def encode_cookie_value(token: bytes) -> str:
        return base64.urlsafe_b64encode(token).rstrip(b"=").decode("ascii")

    @staticmethod
    def decode_cookie_value(value: str | None) -> bytes | None:
        """The raw token behind a cookie value, or ``None`` for anything that is not exactly the
        canonical encoding of 32 bytes (so one session has one cookie string)."""
        if value is None or _COOKIE_VALUE_RE.fullmatch(value) is None:
            return None
        token = base64.urlsafe_b64decode(value + "=")
        if len(token) != SESSION_TOKEN_BYTES or SessionCrypto.encode_cookie_value(token) != value:
            return None
        return token

    def session_hash(self, token: bytes) -> bytes:
        """``HMAC-SHA-256(QATRA_SESSION_HMAC_KEY, token)``: the only form that is stored."""
        return hmac.new(self._session_hmac_key, token, hashlib.sha256).digest()

    @staticmethod
    def _associated_data(user_id: UUID) -> bytes:
        return AAD_PREFIX + user_id.bytes

    def encrypt_tokens(self, bundle: TokenBundle, user_id: UUID) -> bytes:
        plaintext = json.dumps(
            {"access": bundle.access, "refresh": bundle.refresh, "exp": bundle.exp},
            separators=(",", ":"),
        ).encode("utf-8")
        nonce = secrets.token_bytes(NONCE_BYTES)
        sealed = self._aead.encrypt(nonce, plaintext, self._associated_data(user_id))
        return FORMAT_VERSION + nonce + sealed

    def decrypt_tokens(self, blob: bytes, user_id: UUID) -> TokenBundle:
        if len(blob) < len(FORMAT_VERSION) + NONCE_BYTES + TAG_BYTES or not blob.startswith(
            FORMAT_VERSION
        ):
            raise TokenDecryptionError()
        nonce = blob[1 : 1 + NONCE_BYTES]
        try:
            plaintext = self._aead.decrypt(
                nonce, blob[1 + NONCE_BYTES :], self._associated_data(user_id)
            )
            data: Any = json.loads(plaintext)
            access, refresh, exp = data["access"], data["refresh"], data["exp"]
        except (InvalidTag, ValueError, KeyError, TypeError):
            raise TokenDecryptionError() from None
        if (
            not isinstance(access, str)
            or not isinstance(refresh, str)
            or not isinstance(exp, int)
            or isinstance(exp, bool)
        ):
            raise TokenDecryptionError()
        return TokenBundle(access=access, refresh=refresh, exp=exp)

    def recovery_fingerprint(self, normalized_code: str) -> bytes:
        """``HMAC-SHA-256(QATRA_RECOVERY_HMAC_KEY, code)`` over the normalized 32-character
        code. The raw code is never stored."""
        return hmac.new(
            self._recovery_hmac_key, normalized_code.encode("ascii"), hashlib.sha256
        ).digest()

    def grant_fingerprint(self, grant: str) -> bytes:
        """``HMAC-SHA-256(QATRA_RECOVERY_HMAC_KEY, grant)`` (the key also hashes reset grants).
        A grant is 43 base64url characters, a code 32 hexadecimal ones: the inputs of the two
        fingerprints can never coincide."""
        return hmac.new(
            self._recovery_hmac_key, grant.encode("utf-8", "surrogatepass"), hashlib.sha256
        ).digest()

    @staticmethod
    def fingerprints_match(stored: bytes, candidate: bytes) -> bool:
        """Constant-time comparison of two fingerprints."""
        return hmac.compare_digest(stored, candidate)

    def throttle_key_username(self, normalized_username: str) -> bytes:
        """``HMAC(QATRA_THROTTLE_HMAC_KEY, normalized username)``; the name is never stored."""
        return hmac.new(
            self._throttle_hmac_key,
            normalized_username.encode("utf-8", "surrogatepass"),
            hashlib.sha256,
        ).digest()

    def throttle_key_ip(self, prefix: str) -> bytes:
        """``HMAC(QATRA_THROTTLE_HMAC_KEY, IPv4 /24 or IPv6 /48 prefix)``; the address is never
        stored. A prefix contains ``.``, ``:`` or ``/``, which no username can contain, so the
        two key spaces never coincide."""
        return hmac.new(
            self._throttle_hmac_key, prefix.encode("ascii", "replace"), hashlib.sha256
        ).digest()
