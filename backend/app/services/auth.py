"""Authentication services: the session resolver, the auth throttle and the flows of E03-E10.

Layout
- ``ConsentCache``: remembers, per account, that the stored terms version is the current one.
- ``AuthThrottle``: the auth throttle of API-spec §1.7/§1.8 (A-03).
- ``SessionService``: resolves a cookie to a live session (``require_session``), refreshes the
  Supabase tokens, enforces the re-consent gate, issues and revokes app sessions.
- ``AuthService``: register (E03), login (E04), consent (E05), recovery verify/reset/rotate
  (E06-E08), password change (E09), logout (E10) and the shared current-password check.

Rules that hold throughout
- Identity comes from the server-side session only. The browser never receives a Supabase token.
- Failures that reveal nothing: an unknown username, a wrong password, a wrong or used recovery
  code and a lost reservation all raise the same ``invalid_credentials``; the throttle is
  checked BEFORE credentials; an unknown account costs the same provider/database calls as a
  known one.
- Nothing personal is logged: only event names of failed cleanups, never ids, names or values.
- A storage failure is ``503 unavailable``; the services never leak a library message.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import NoReturn, TypeVar
from uuid import UUID, uuid4

from pydantic import SecretStr

from app.config import Settings
from app.contracts_auth import Profile
from app.dependencies import ResolvedSession, SessionContext, SessionEndedError
from app.domain import auth_policy as policy
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.providers.supabase_auth import (
    AuthInvalidCredentials,
    AuthProviderError,
    AuthRefreshRejected,
    AuthTokens,
    SupabaseAuth,
    new_internal_alias,
)
from app.repositories.accounts import (
    AccountNotFoundError,
    AccountRepository,
    EpochMismatchError,
    Handle,
    InvalidAccountValueError,
    InvalidStateError,
    ProfileMissing,
    ProfileRow,
    ProfileStore,
    ProfileUnavailable,
    RepositoryUnavailable,
    StoredSession,
    UsernameTakenError,
)
from app.services.account import profile_from_row
from app.services.session_crypto import (
    SessionCrypto,
    TokenBundle,
    TokenDecryptionError,
    cookie_name_for,
)

logger = logging.getLogger("qatra.auth")

T = TypeVar("T")

_MAX_GRANT_LENGTH = 128  # a real grant has 43 characters; anything longer cannot match
_REFRESH_LOCK_STRIPES = 32
_COMMIT_ATTEMPTS = 2


def _storage(call: Callable[..., T], *args: object, **kwargs: object) -> T:
    """Run a repository call; a storage failure becomes ``503 unavailable`` without detail."""
    try:
        return call(*args, **kwargs)
    except RepositoryUnavailable:
        raise AppError(ErrorCode.unavailable) from None


def _validation(*fields: dict[str, str]) -> AppError:
    return AppError(ErrorCode.validation_error, details={"fields": list(fields)})


def _terms_required(required_version: str) -> AppError:
    return AppError(ErrorCode.terms_required, details={"requiredVersion": required_version})


# --- results --------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Registration:
    profile: Profile
    recovery_code: str = field(repr=False)
    cookie_value: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class LoginResult:
    profile: Profile
    reconsent_required: bool
    cookie_value: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class ResetGrantIssue:
    reset_grant: str = field(repr=False)
    expires_in_sec: int


@dataclass(frozen=True, slots=True)
class PasswordChange:
    profile: Profile
    cookie_value: str = field(repr=False)


# --- terms memo -----------------------------------------------------------------------------------


class ConsentCache:
    """Accounts known to have accepted the CURRENT terms version.

    The re-consent gate (O-10) needs ``profiles.terms_version`` on every Session request, but no
    ``srv_*`` function returns it and ``app_sessions`` does not hold it. A stored version can
    only move forward (registration, ``srv_accept_terms``) and the required version is fixed for
    the life of the process, so "current" is a permanent fact: it is read once per account and
    process, and observed for free whenever a profile row is read anyway (login, E05, E11, E12).
    An account that is not current is re-checked on every request until it consents."""

    def __init__(self, required_version: str, *, max_entries: int = 10_000) -> None:
        self._required = required_version
        self._max = max_entries
        self._current: OrderedDict[UUID, None] = OrderedDict()
        self._lock = threading.Lock()

    def is_current(self, user_id: UUID) -> bool:
        with self._lock:
            return user_id in self._current

    def observe(self, user_id: UUID, stored_version: str | None) -> None:
        if not policy.terms_are_current(stored_version, self._required):
            return
        with self._lock:
            self._current[user_id] = None
            self._current.move_to_end(user_id)
            while len(self._current) > self._max:
                self._current.popitem(last=False)

    def forget(self, user_id: UUID) -> None:
        with self._lock:
            self._current.pop(user_id, None)


# --- throttle -------------------------------------------------------------------------------------


class AuthThrottle:
    """The auth throttle (API-spec §1.7, §1.8; A-03).

    Keys: ``HMAC(QATRA_THROTTLE_HMAC_KEY, normalized username)`` and ``HMAC(..., IP prefix)``;
    the database holds one-minute buckets of failures and answers only the trailing 15-minute
    sum per key. Policy on top of it:

    - 20 failures in the window lock the key: ``429`` with ``Retry-After: 900``, even for a
      correct password (the check runs BEFORE the credentials). Locked attempts are not recorded,
      so the lock is never extended by an attack and ends when the buckets age out.
    - From the 5th failure the next attempt must wait 1, 2, 4, 8, 10, 20, ... up to 60 seconds
      after the last failure (``throttle_delay_sec``). The database cannot tell WHEN the last
      failure was, so that moment is kept in process memory (one Render instance, D48/D72); a
      process that does not know it (restart) skips only this soft delay, never the lock. The
      wait is a ``429`` with the remaining seconds in ``Retry-After``: no worker thread sleeps.
    - A success clears the username key (login only); registrations never count; failed
      password checks of E08, E09 and E13 count under the same keys.
    """

    def __init__(
        self,
        repository: AccountRepository,
        crypto: SessionCrypto,
        *,
        monotonic: Callable[[], float] = time.monotonic,
        max_tracked: int = 10_000,
    ) -> None:
        self._repo = repository
        self._crypto = crypto
        self._monotonic = monotonic
        self._max = max_tracked
        self._last_failure: OrderedDict[bytes, float] = OrderedDict()
        self._lock = threading.Lock()

    def _keys(self, username: str | None, prefix: str) -> list[bytes]:
        keys = [self._crypto.throttle_key_ip(prefix)]
        if username is not None:
            keys.insert(0, self._crypto.throttle_key_username(username))
        return keys

    def check(self, *, username: str | None, ip_prefix: str) -> None:
        keys = self._keys(username, ip_prefix)
        counts = _storage(self._repo.throttle_check, keys)
        if any(policy.throttle_locked(counts.get(key, 0)) for key in keys):
            raise AppError(ErrorCode.throttled, retry_after=policy.THROTTLE_LOCK_SEC)
        now = self._monotonic()
        wait = 0.0
        with self._lock:
            for key in keys:
                delay = policy.throttle_delay_sec(counts.get(key, 0))
                last = self._last_failure.get(key)
                if delay and last is not None:
                    wait = max(wait, last + delay - now)
        if wait > 0:
            raise AppError(ErrorCode.throttled, retry_after=max(1, math.ceil(wait)))

    def record_failure(self, *, username: str | None, ip_prefix: str) -> None:
        keys = self._keys(username, ip_prefix)
        _storage(self._repo.throttle_record, keys, "failure")
        now = self._monotonic()
        with self._lock:
            for key in keys:
                self._last_failure[key] = now
                self._last_failure.move_to_end(key)
            while len(self._last_failure) > self._max:
                self._last_failure.popitem(last=False)

    def record_success(self, *, username: str) -> None:
        """Clear the username key. Best effort: a login that succeeded is not undone because
        the counters could not be cleared."""
        key = self._crypto.throttle_key_username(username)
        with self._lock:
            self._last_failure.pop(key, None)
        try:
            self._repo.throttle_record([key], "success")
        except RepositoryUnavailable:
            log_event(logger, "throttle_clear_failed")


# --- sessions -------------------------------------------------------------------------------------


class SessionService:
    """Resolves cookies to sessions and issues, refreshes and revokes them.

    ``resolve`` implements API-spec §1.3 for ``require_session``: the cookie is decoded to its
    32 bytes, hashed and looked up through ``srv_read_app_session`` (which already refuses a
    revoked, expired or epoch-stale session); the stored Supabase tokens are decrypted (a blob
    that does not decrypt ends the session); an access token that is expired or expires within 60
    seconds is refreshed with the refresh token under a per-session lock, so concurrent requests
    refresh once, and the rotated tokens are stored. A refresh the provider REJECTS ends the
    session (401); a provider that is merely unavailable is 503 and the session survives, so a
    provider outage is a connectivity state and never a log-out (API-spec §1.11)."""

    def __init__(
        self,
        *,
        settings: Settings,
        repository: AccountRepository,
        provider: SupabaseAuth,
        crypto: SessionCrypto,
        profiles: ProfileStore,
        consent: ConsentCache,
        clock: Callable[[], datetime],
        expose_access_token: bool,
    ) -> None:
        if settings.TERMS_VERSION is None:
            raise ValueError("TERMS_VERSION is required")
        self._required_terms: str = settings.TERMS_VERSION
        self._repo = repository
        self._provider = provider
        self._crypto = crypto
        self._profiles = profiles
        self._consent = consent
        self._clock = clock
        self._expose = expose_access_token
        self._locks = [threading.Lock() for _ in range(_REFRESH_LOCK_STRIPES)]
        self.cookie_name = cookie_name_for(settings)

    # -- resolve --------------------------------------------------------------------------------

    def resolve(self, cookie_value: str | None, *, enforce_terms: bool) -> ResolvedSession:
        token = self._crypto.decode_cookie_value(cookie_value)
        if token is None:
            raise SessionEndedError()
        session_hash = self._crypto.session_hash(token)
        stored = self._read(session_hash)
        tokens = self._decrypt(stored, session_hash)
        if tokens.exp - self._clock().timestamp() <= policy.TOKEN_REFRESH_MARGIN_SEC:
            stored, tokens = self._refresh(stored, session_hash)
        context = SessionContext(
            user_id=stored.user_id,
            is_demo=stored.is_demo,
            auth_epoch=stored.auth_epoch,
            session_id=stored.session_id,
            access_token=SecretStr(tokens.access) if self._expose else None,
        )
        if enforce_terms:
            self._enforce_terms(stored.user_id, tokens.access)
        return ResolvedSession(
            context=context,
            username=stored.username_display,
            internal_alias=stored.internal_auth_alias,
            session_hash=session_hash,
            tokens=tokens,
        )

    def _read(self, session_hash: bytes) -> StoredSession:
        stored = _storage(self._repo.read_app_session, session_hash)
        if stored is None:
            raise SessionEndedError()
        return stored

    def _decrypt(self, stored: StoredSession, session_hash: bytes) -> TokenBundle:
        try:
            return self._crypto.decrypt_tokens(stored.encrypted_auth_tokens, stored.user_id)
        except TokenDecryptionError:
            self._revoke_quietly(session_hash)
            raise SessionEndedError() from None

    def _refresh(
        self, stored: StoredSession, session_hash: bytes
    ) -> tuple[StoredSession, TokenBundle]:
        with self._locks[hash(stored.session_id) % _REFRESH_LOCK_STRIPES]:
            # Another request may have refreshed while this one waited for the lock.
            stored = self._read(session_hash)
            tokens = self._decrypt(stored, session_hash)
            if tokens.exp - self._clock().timestamp() > policy.TOKEN_REFRESH_MARGIN_SEC:
                return stored, tokens
            try:
                granted = self._provider.refresh(tokens.refresh)
            except AuthRefreshRejected:
                self._revoke_quietly(session_hash)
                raise SessionEndedError() from None
            except AuthProviderError:
                raise AppError(ErrorCode.unavailable) from None
            renewed = TokenBundle(granted.access, granted.refresh, granted.expires_at)
            blob = self._crypto.encrypt_tokens(renewed, stored.user_id)
            # The provider has already rotated its refresh token: losing this write would end
            # the session at the next refresh, so it is tried twice.
            for attempt in range(_COMMIT_ATTEMPTS):
                try:
                    self._repo.update_session_tokens(stored.session_id, blob)
                    break
                except RepositoryUnavailable:
                    if attempt + 1 == _COMMIT_ATTEMPTS:
                        raise AppError(ErrorCode.unavailable) from None
            return stored, renewed

    def _enforce_terms(self, user_id: UUID, access_token: str) -> None:
        if self._consent.is_current(user_id):
            return
        try:
            stored = self._profiles.read_terms_version(user_id=user_id, access_token=access_token)
        except (ProfileUnavailable, ProfileMissing):
            raise AppError(ErrorCode.unavailable) from None
        self._consent.observe(user_id, stored)
        if not policy.terms_are_current(stored, self._required_terms):
            raise _terms_required(self._required_terms)

    # -- issue and revoke -----------------------------------------------------------------------

    def issue(self, *, user_id: UUID, auth_epoch: int, tokens: TokenBundle) -> str:
        """Create an app session bound to ``auth_epoch`` and return its cookie value (30 days,
        no sliding renewal). ``EpochMismatchError`` is left to the caller."""
        token = self._crypto.new_session_token()
        expires_at = self._clock() + timedelta(seconds=policy.SESSION_LIFETIME_SEC)
        _storage(
            self._repo.create_app_session,
            user_id=user_id,
            session_hash=self._crypto.session_hash(token),
            encrypted_auth_tokens=self._crypto.encrypt_tokens(tokens, user_id),
            auth_epoch=auth_epoch,
            expires_at=expires_at,
        )
        return self._crypto.encode_cookie_value(token)

    def revoke(self, cookie_value: str | None) -> None:
        """Revoke the session behind a cookie value; anything that is not a session is ignored.
        A storage failure is ``503`` (the caller may repeat: revocation is idempotent)."""
        token = self._crypto.decode_cookie_value(cookie_value)
        if token is not None:
            _storage(self._repo.revoke_app_session, self._crypto.session_hash(token))

    def _revoke_quietly(self, session_hash: bytes) -> None:
        try:
            self._repo.revoke_app_session(session_hash)
        except RepositoryUnavailable:
            log_event(logger, "session_revoke_failed")

    # -- profile rows ---------------------------------------------------------------------------

    def load_profile_row(self, user_id: UUID, access_token: str | None) -> ProfileRow:
        try:
            row = self._profiles.read_profile(user_id=user_id, access_token=access_token)
        except (ProfileUnavailable, ProfileMissing):
            raise AppError(ErrorCode.unavailable) from None
        self._consent.observe(user_id, row.terms_version)
        return row


# --- the flows ------------------------------------------------------------------------------------


class AuthService:
    def __init__(
        self,
        *,
        settings: Settings,
        repository: AccountRepository,
        provider: SupabaseAuth,
        crypto: SessionCrypto,
        profiles: ProfileStore,
        sessions: SessionService,
        throttle: AuthThrottle,
        consent: ConsentCache,
        clock: Callable[[], datetime],
    ) -> None:
        if settings.TERMS_VERSION is None:
            raise ValueError("TERMS_VERSION is required")
        self._required_terms: str = settings.TERMS_VERSION
        self._repo = repository
        self._provider = provider
        self._crypto = crypto
        self._profiles = profiles
        self._sessions = sessions
        self._throttle = throttle
        self._consent = consent
        self._clock = clock

    # -- shared helpers -------------------------------------------------------------------------

    def _fail(self, username: str | None, ip_prefix: str) -> NoReturn:
        """The generic failure: counted against the throttle, revealing nothing."""
        self._throttle.record_failure(username=username, ip_prefix=ip_prefix)
        raise AppError(ErrorCode.invalid_credentials)

    def _find_handle(self, normalized: str) -> Handle | None:
        if not policy.is_storable_text(normalized):
            return None  # cannot match any stored name
        return _storage(self._repo.find_handle, normalized)

    def _check_password(self, alias: str, password: str) -> AuthTokens | None:
        """The identity provider's verdict: tokens for the right password, ``None`` for a wrong
        one. A password above 72 bytes cannot match and does not reach the provider."""
        if not policy.password_can_authenticate(password):
            return None
        try:
            return self._provider.password_grant(alias, password)
        except AuthInvalidCredentials:
            return None
        except AuthProviderError:
            raise AppError(ErrorCode.unavailable) from None

    def _equalize(self, password: str) -> None:
        """An unknown account costs the same provider call as a known one (no timing oracle)."""
        if not policy.password_can_authenticate(password):
            return
        try:
            self._provider.password_grant(new_internal_alias(), password)
        except AuthProviderError:
            pass

    def _delete_identity(self, user_id: UUID) -> None:
        try:
            self._provider.admin_delete_user(user_id)
        except AuthProviderError:
            log_event(logger, "identity_cleanup_failed")

    @staticmethod
    def _require_password_policy(password: str, field_name: str) -> None:
        rules = policy.password_violations(password)
        if rules:
            raise _validation(*({"field": field_name, "rule": rule} for rule in rules))

    def verify_current_password(
        self, session: ResolvedSession, password: str, ip_prefix: str
    ) -> None:
        """Re-authentication for E08, E09 and E13: throttle first, then the provider. A wrong
        password counts under the session's username key (A-03) and is ``invalid_credentials``."""
        username = policy.normalize_username(session.username)
        self._throttle.check(username=username, ip_prefix=ip_prefix)
        if self._check_password(session.internal_alias, password) is None:
            self._fail(username, ip_prefix)

    # -- E03 register ---------------------------------------------------------------------------

    def register_account(
        self,
        *,
        username: str,
        password: str,
        time_zone: str,
        language: str,
        terms_accepted: bool,
        terms_version: str,
        is_demo: bool = False,
    ) -> Registration:
        """Create an account and its first session (E03; E26 reuses it with ``is_demo``).

        Order: terms (400), field rules (422), username uniqueness (409), then Auth user, first
        password grant, ``srv_register_account`` and the app session. Every failure after the
        Auth user exists is compensated, so no usable Auth user is left without application
        rows (API-spec E03). Registrations never count against the throttle."""
        if terms_accepted is not True or terms_version != self._required_terms:
            raise _terms_required(self._required_terms)
        problems = [{"field": "username", "rule": r} for r in policy.username_violations(username)]
        problems += [{"field": "password", "rule": r} for r in policy.password_violations(password)]
        if not policy.is_valid_time_zone(time_zone):
            problems.append({"field": "timeZone", "rule": "time_zone_invalid"})
        if language not in policy.LANGUAGES:
            problems.append({"field": "language", "rule": "language_invalid"})
        if problems:
            raise _validation(*problems)

        normalized = policy.normalize_username(username)
        display = policy.username_display(username)
        if _storage(self._repo.find_handle, normalized) is not None:
            raise AppError(ErrorCode.username_taken)

        alias = new_internal_alias()
        try:
            user_id = self._provider.create_user(alias, password)
        except AuthProviderError:
            raise AppError(ErrorCode.unavailable) from None

        code = policy.generate_recovery_code()
        try:
            granted = self._provider.password_grant(alias, password)
            self._repo.register_account(
                user_id=user_id,
                username_display=display,
                username_normalized=normalized,
                internal_auth_alias=alias,
                is_demo=is_demo,
                terms_version=self._required_terms,
                language=language,
                time_zone=time_zone,
                recovery_code_hash=self._crypto.recovery_fingerprint(code),
            )
        except UsernameTakenError:
            self._delete_identity(user_id)
            raise AppError(ErrorCode.username_taken) from None
        except InvalidAccountValueError:
            self._delete_identity(user_id)
            raise _validation({"field": "timeZone", "rule": "time_zone_invalid"}) from None
        except (RepositoryUnavailable, AuthProviderError):
            self._delete_identity(user_id)
            raise AppError(ErrorCode.unavailable) from None
        except Exception:
            self._delete_identity(user_id)
            raise

        tokens = TokenBundle(granted.access, granted.refresh, granted.expires_at)
        try:
            cookie_value = self._sessions.issue(user_id=user_id, auth_epoch=0, tokens=tokens)
        except Exception:
            self._roll_back_registration(user_id, normalized)
            raise AppError(ErrorCode.unavailable) from None

        now = self._clock()
        try:
            row = self._profiles.read_profile(user_id=user_id, access_token=granted.access)
        except (ProfileUnavailable, ProfileMissing):
            # The account is complete; answer from what was just written rather than fail.
            row = ProfileRow(
                language=language,
                time_zone=time_zone,
                session_minutes=policy.DEFAULT_SESSION_MINUTES,
                reminder_settings={},
                pending_settings=None,
                terms_version=self._required_terms,
                terms_accepted_at=now,
                is_demo=is_demo,
                created_at=now,
            )
        self._consent.observe(user_id, row.terms_version)
        return Registration(
            profile=profile_from_row(display, row, now),
            recovery_code=policy.format_recovery_code(code),
            cookie_value=cookie_value,
        )

    def _roll_back_registration(self, user_id: UUID, normalized: str) -> None:
        try:
            self._repo.delete_personal_rows(user_id, self._crypto.throttle_key_username(normalized))
        except RepositoryUnavailable:
            log_event(logger, "registration_rollback_failed")
        self._delete_identity(user_id)

    # -- E04 login ------------------------------------------------------------------------------

    def authenticate(
        self, *, username: str, password: str, ip_prefix: str, previous_cookie: str | None
    ) -> LoginResult:
        """Open a session with a username and password (E04).

        The registration rules are NOT applied: a well-formed pair that does not authenticate
        is ``invalid_credentials``, never a format error. The throttle is checked before the
        credentials. Success creates a fresh session bound to the account's current epoch
        (the presented old session is revoked) and clears the username's throttle key."""
        normalized = policy.normalize_username(username)
        self._throttle.check(username=normalized, ip_prefix=ip_prefix)
        handle = self._find_handle(normalized)
        if handle is None:
            self._equalize(password)
            self._fail(normalized, ip_prefix)
        granted = self._check_password(handle.internal_auth_alias, password)
        if granted is None:
            self._fail(normalized, ip_prefix)

        # Read the profile before the session exists: a failure leaves nothing behind.
        row = self._sessions.load_profile_row(handle.user_id, granted.access)
        tokens = TokenBundle(granted.access, granted.refresh, granted.expires_at)
        cookie_value = self._issue_current(handle, normalized, tokens)
        self._throttle.record_success(username=normalized)
        try:
            self._sessions.revoke(previous_cookie)
        except AppError:
            log_event(logger, "session_revoke_failed")
        return LoginResult(
            profile=profile_from_row(handle.username_display, row, self._clock()),
            reconsent_required=not policy.terms_are_current(
                row.terms_version, self._required_terms
            ),
            cookie_value=cookie_value,
        )

    def _issue_current(self, handle: Handle, normalized: str, tokens: TokenBundle) -> str:
        """Issue a session at the account's current epoch; one retry if the epoch moved
        between the lookup and the insert (a concurrent password change)."""
        epoch = handle.auth_epoch
        for attempt in range(_COMMIT_ATTEMPTS):
            try:
                return self._sessions.issue(user_id=handle.user_id, auth_epoch=epoch, tokens=tokens)
            except EpochMismatchError:
                renewed = self._find_handle(normalized)
                if attempt + 1 == _COMMIT_ATTEMPTS or renewed is None:
                    break
                epoch = renewed.auth_epoch
        raise AppError(ErrorCode.unavailable)

    # -- E05 consent ----------------------------------------------------------------------------

    def accept_terms(self, session: ResolvedSession, terms_version: str) -> Profile:
        """Record acceptance of the current terms (E05). Idempotent: a stored version that
        already equals ``terms_version`` returns the unchanged profile without a write."""
        if terms_version != self._required_terms:
            raise _terms_required(self._required_terms)
        user_id, token = session.context.user_id, session.tokens.access
        row = self._sessions.load_profile_row(user_id, token)
        if row.terms_version != terms_version:
            try:
                self._repo.accept_terms(user_id, terms_version)
            except (AccountNotFoundError, RepositoryUnavailable):
                raise AppError(ErrorCode.unavailable) from None
            row = self._sessions.load_profile_row(user_id, token)
        return profile_from_row(session.username, row, self._clock())

    # -- E06 recovery verify --------------------------------------------------------------------

    def verify_recovery(
        self, *, username: str, recovery_code: str, ip_prefix: str
    ) -> ResetGrantIssue:
        """Exchange a username and recovery code for a short reset grant (E06).

        Every failure (unknown name, malformed or wrong code, used code, a reservation held by
        another request) is the same generic 401 and counts against the throttle. The code is
        reserved atomically, so two simultaneous requests never yield two active grants."""
        normalized = policy.normalize_username(username)
        self._throttle.check(username=normalized, ip_prefix=ip_prefix)
        code = policy.normalize_recovery_code(recovery_code)
        handle = self._find_handle(normalized)
        # Equal work for every outcome: the lookup and the fingerprint also run for an unknown
        # name or a malformed code.
        user_id = handle.user_id if handle is not None else uuid4()
        active = _storage(self._repo.recovery_active_code, user_id)
        candidate = self._crypto.recovery_fingerprint(code or "0" * policy.RECOVERY_CODE_HEX_LENGTH)
        matches = (
            handle is not None
            and code is not None
            and active is not None
            and self._crypto.fingerprints_match(active.code_hash, candidate)
        )
        if not matches or active is None:
            self._fail(normalized, ip_prefix)

        grant = policy.new_reset_grant()
        reserved = _storage(
            self._repo.recovery_reserve,
            user_id=user_id,
            code_id=active.code_id,
            grant_id=uuid4(),
            grant_hash=self._crypto.grant_fingerprint(grant),
            grant_expires_at=self._clock() + timedelta(seconds=policy.RESET_GRANT_LIFETIME_SEC),
        )
        if not reserved:
            self._fail(normalized, ip_prefix)
        return ResetGrantIssue(reset_grant=grant, expires_in_sec=policy.RESET_GRANT_LIFETIME_SEC)

    # -- E07 recovery reset ---------------------------------------------------------------------

    def reset_password(self, *, reset_grant: str, new_password: str, ip_prefix: str) -> str:
        """Set a new password with a reset grant and return the new recovery code (E07).

        Order (API-spec E07): validate the password policy, take the grant (``active`` to
        ``executing``, once), set the password through Supabase Auth, and ONLY after that
        consume the old code, kill the grant, issue the new code, bump ``auth_epoch`` and revoke
        every app session. If Auth fails the grant is released, so nothing is consumed and the
        learner verifies the code again. There is no automatic login."""
        self._require_password_policy(new_password, "newPassword")
        self._throttle.check(username=None, ip_prefix=ip_prefix)
        ticket = None
        if len(reset_grant) <= _MAX_GRANT_LENGTH:
            ticket = _storage(
                self._repo.recovery_begin, self._crypto.grant_fingerprint(reset_grant)
            )
        if ticket is None:
            self._fail(None, ip_prefix)
        try:
            self._provider.admin_set_password(ticket.user_id, new_password)
        except AuthProviderError:
            # The provider call is retried once inside the provider; the password is not known
            # to have changed, so the grant and the reservation are released.
            self._release_quietly(ticket.grant_id)
            raise AppError(ErrorCode.unavailable) from None

        new_code = policy.generate_recovery_code()
        fingerprint = self._crypto.recovery_fingerprint(new_code)
        unconfirmed = False
        for attempt in range(_COMMIT_ATTEMPTS):
            try:
                self._repo.recovery_consume(ticket.grant_id, fingerprint)
                break
            except InvalidStateError:
                # Either the reservation was lost, or an earlier attempt of this request
                # committed although its answer did not arrive: the stored code tells which.
                if unconfirmed and self._stored_code_is(ticket.user_id, fingerprint):
                    break
                raise AppError(ErrorCode.invalid_credentials) from None
            except AccountNotFoundError:
                raise AppError(ErrorCode.invalid_credentials) from None
            except RepositoryUnavailable:
                unconfirmed = True
                if attempt + 1 == _COMMIT_ATTEMPTS:
                    # Give up, but do not leave the grant ``executing``: no function can reopen
                    # it and it would block this account's recovery for good. Releasing is safe
                    # whatever happened: it does nothing to a grant that was in fact consumed.
                    self._release_quietly(ticket.grant_id)
                    raise AppError(ErrorCode.unavailable) from None
        return policy.format_recovery_code(new_code)

    def _stored_code_is(self, user_id: UUID, fingerprint: bytes) -> bool:
        try:
            active = self._repo.recovery_active_code(user_id)
        except RepositoryUnavailable:
            return False
        return active is not None and self._crypto.fingerprints_match(active.code_hash, fingerprint)

    def _release_quietly(self, grant_id: UUID) -> None:
        try:
            self._repo.recovery_release(grant_id)
        except RepositoryUnavailable:
            log_event(logger, "recovery_release_failed")

    # -- E08 recovery rotate --------------------------------------------------------------------

    def rotate_recovery(self, session: ResolvedSession, *, password: str, ip_prefix: str) -> str:
        """Replace the recovery code from settings (E08). Needs the current password; the old
        code is invalidated and the new one is shown once. Sessions and the epoch are unchanged."""
        self.verify_current_password(session, password, ip_prefix)
        code = policy.generate_recovery_code()
        _storage(
            self._repo.recovery_rotate,
            session.context.user_id,
            self._crypto.recovery_fingerprint(code),
        )
        return policy.format_recovery_code(code)

    # -- E09 password change --------------------------------------------------------------------

    def change_password(
        self, session: ResolvedSession, *, current_password: str, new_password: str, ip_prefix: str
    ) -> PasswordChange:
        """Change the password from settings (E09; demo accounts included, D71).

        The change is made with the user's OWN Supabase token (O-14). Then ``auth_epoch`` is
        bumped, which revokes every session including this one, and the caller receives a new
        session bound to the new epoch (C-02): the other sessions are dead, this device stays
        signed in. The same password as the current one changes nothing at the provider but
        still ends the other sessions."""
        self._require_password_policy(new_password, "newPassword")
        user_id = session.context.user_id
        # Everything that can fail without side effects comes first.
        row = self._sessions.load_profile_row(user_id, session.tokens.access)
        self.verify_current_password(session, current_password, ip_prefix)
        if new_password != current_password:
            try:
                self._provider.change_password(session.tokens.access, new_password)
            except AuthProviderError:
                raise AppError(ErrorCode.unavailable) from None
        try:
            epoch = self._repo.bump_auth_epoch(user_id)
        except AccountNotFoundError:
            raise SessionEndedError() from None
        except RepositoryUnavailable:
            raise AppError(ErrorCode.unavailable) from None
        try:
            cookie_value = self._sessions.issue(
                user_id=user_id, auth_epoch=epoch, tokens=session.tokens
            )
        except EpochMismatchError:
            raise AppError(ErrorCode.unavailable) from None
        return PasswordChange(
            profile=profile_from_row(session.username, row, self._clock()),
            cookie_value=cookie_value,
        )

    # -- E10 logout -----------------------------------------------------------------------------

    def logout(self, cookie_value: str | None) -> None:
        """End the session behind the cookie. Tolerant (O-14): no cookie, a malformed cookie, an
        unknown or an already revoked session are all fine; only a storage failure is reported."""
        self._sessions.revoke(cookie_value)
