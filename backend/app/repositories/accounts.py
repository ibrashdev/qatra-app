"""Account storage: the restricted database role, its in-memory twin, and the profile stores.

Two boundaries (API-spec §1.4, Database-schema §5, §8):

- ``AccountRepository``: the 16 ``srv_*`` functions the identity packages call, over the
  separate limited login role ``QATRA_SERVER_DB`` (``qatra_server``: ``EXECUTE`` on those
  functions only, never a table). ``PostgresAccountRepository`` opens one connection per call,
  sets ``statement_timeout`` to 5 s inside the transaction, and replaces every library error
  with a typed exception that carries no detail (library messages can contain host names, user
  names or fingerprints). SQLSTATEs map as the migrations define them: ``unique_violation`` and
  ``check_violation`` (registration), ``QT001`` epoch mismatch, ``QT003`` invalid state and
  ``no_data_found``.
- ``ProfileStore``: ``public.profiles`` reads and writes. In supabase mode they go through
  PostgREST with the learner's OWN access token, so row-level security applies and only the
  five learner-updatable columns can change (Database-schema §5.2). ``PostgrestProfileStore``
  makes its own small ``httpx`` calls; it does not use the shared ``PostgrestClient``.

``InMemoryAccounts`` implements both Protocols for memory mode (development and tests) with the
same observable semantics as the SQL functions (uniqueness, atomic registration, the recovery
reservation, the epoch rule, the throttle buckets). It is refused in production by configuration.
"""

from __future__ import annotations

import re
import threading
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol
from uuid import UUID, uuid4

import httpx
import psycopg

from app.config import Settings, StartupConfigError
from app.domain.auth_policy import LANGUAGES, SESSION_MINUTES_OPTIONS, is_valid_time_zone

CONNECT_TIMEOUT_SEC = 5
STATEMENT_TIMEOUT = "5s"
PROFILE_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
PROFILE_COLUMNS = (
    "language,time_zone,session_minutes,reminder_settings,pending_settings,"
    "terms_version,terms_accepted_at,is_demo,created_at"
)
LEARNER_UPDATABLE_COLUMNS = frozenset(
    {"language", "time_zone", "session_minutes", "reminder_settings", "pending_settings"}
)


# Typed failures carry no message and no cause.
class RepositoryUnavailable(Exception):
    """The restricted database cannot be reached or failed. Carries no connection detail."""


class UsernameTakenError(Exception):
    """``unique_violation`` on registration: the normalized username (or alias) exists."""


class InvalidAccountValueError(Exception):
    """``check_violation`` on registration: a value broke a database check."""


class EpochMismatchError(Exception):
    """``QT001``: the session epoch is not the account's current epoch."""


class InvalidStateError(Exception):
    """``QT003``: the grant is not in the state the operation needs."""


class AccountNotFoundError(Exception):
    """``no_data_found``: no such account or profile."""


class ProfileUnavailable(Exception):
    """The profile store cannot be reached or answered with an error."""


class ProfileMissing(Exception):
    """No profile row is visible to the caller."""


class ProfileValueRejected(Exception):
    """The database rejected a profile value (an unknown time zone)."""


@dataclass(frozen=True, slots=True)
class Handle:
    user_id: UUID
    username_display: str
    internal_auth_alias: str
    auth_epoch: int
    is_demo: bool


@dataclass(frozen=True, slots=True)
class ActiveRecoveryCode:
    code_id: UUID
    code_hash: bytes


@dataclass(frozen=True, slots=True)
class GrantTicket:
    grant_id: UUID
    user_id: UUID


@dataclass(frozen=True, slots=True)
class StoredSession:
    session_id: UUID
    user_id: UUID
    username_display: str
    internal_auth_alias: str
    auth_epoch: int
    encrypted_auth_tokens: bytes = field(repr=False)
    expires_at: datetime
    is_demo: bool


@dataclass(frozen=True, slots=True)
class ProfileRow:
    language: str
    time_zone: str
    session_minutes: int
    reminder_settings: dict[str, Any]
    pending_settings: dict[str, Any] | None
    terms_version: str
    terms_accepted_at: datetime
    is_demo: bool
    created_at: datetime


class AccountRepository(Protocol):
    """The ``srv_*`` functions (Database-schema §8.2 items 1-17 used by B3)."""

    def find_handle(self, username_normalized: str) -> Handle | None: ...

    def register_account(
        self,
        *,
        user_id: UUID,
        username_display: str,
        username_normalized: str,
        internal_auth_alias: str,
        is_demo: bool,
        terms_version: str,
        language: str,
        time_zone: str,
        recovery_code_hash: bytes,
    ) -> None:
        """One transaction: handle, profile and first recovery code. ``UsernameTakenError`` or
        ``InvalidAccountValueError``; no partial rows."""

    def accept_terms(self, user_id: UUID, terms_version: str) -> datetime: ...

    def recovery_active_code(self, user_id: UUID) -> ActiveRecoveryCode | None: ...

    def recovery_reserve(
        self,
        *,
        user_id: UUID,
        code_id: UUID,
        grant_id: UUID,
        grant_hash: bytes,
        grant_expires_at: datetime,
    ) -> bool: ...

    def recovery_begin(self, grant_hash: bytes) -> GrantTicket | None: ...

    def recovery_release(self, grant_id: UUID) -> None: ...

    def recovery_consume(self, grant_id: UUID, new_code_hash: bytes) -> int: ...

    def recovery_rotate(self, user_id: UUID, new_code_hash: bytes) -> None: ...

    def create_app_session(
        self,
        *,
        user_id: UUID,
        session_hash: bytes,
        encrypted_auth_tokens: bytes,
        auth_epoch: int,
        expires_at: datetime,
    ) -> UUID: ...

    def read_app_session(self, session_hash: bytes) -> StoredSession | None: ...

    def update_session_tokens(self, session_id: UUID, encrypted_auth_tokens: bytes) -> None: ...

    def revoke_app_session(self, session_hash: bytes) -> None: ...

    def bump_auth_epoch(self, user_id: UUID) -> int: ...

    def throttle_check(self, key_hashes: Sequence[bytes]) -> dict[bytes, int]: ...

    def throttle_record(self, key_hashes: Sequence[bytes], outcome: str) -> None: ...

    def delete_personal_rows(self, user_id: UUID, username_throttle_key: bytes | None) -> None: ...


class ProfileStore(Protocol):
    """``public.profiles`` reads and writes. ``access_token`` is the learner's own Supabase
    token (``None`` in memory mode, where it is ignored)."""

    def read_profile(self, *, user_id: UUID, access_token: str | None) -> ProfileRow: ...

    def read_terms_version(self, *, user_id: UUID, access_token: str | None) -> str: ...

    def update_profile(
        self, *, user_id: UUID, access_token: str | None, changes: Mapping[str, Any]
    ) -> ProfileRow: ...


class PostgresAccountRepository:
    """The ``srv_*`` functions over ``QATRA_SERVER_DB``. The DSN is never echoed or logged."""

    def __init__(self, dsn: str | None) -> None:
        self._dsn = dsn

    def __repr__(self) -> str:
        return "PostgresAccountRepository(<redacted>)"

    def _run(
        self,
        sql: str,
        params: tuple[Any, ...],
        *,
        errors: Mapping[str, type[Exception]] | None = None,
        fetch: bool = True,
    ) -> list[tuple[Any, ...]]:
        if not self._dsn:
            raise RepositoryUnavailable()
        try:
            # ``set local`` keeps the timeout inside this transaction (works behind a pooler);
            # ``prepare_threshold=None`` keeps statements unprepared for the same reason.
            with psycopg.connect(
                self._dsn, connect_timeout=CONNECT_TIMEOUT_SEC, prepare_threshold=None
            ) as connection:
                connection.execute(f"set local statement_timeout = '{STATEMENT_TIMEOUT}'")
                cursor = connection.execute(sql, params)
                return list(cursor.fetchall()) if fetch else []
        except Exception as exc:
            mapped = (errors or {}).get(str(getattr(exc, "sqlstate", None) or ""))
            # Replace the library error: its text can include the host, user or a fingerprint.
            raise (mapped() if mapped else RepositoryUnavailable()) from None

    @staticmethod
    def _bytes(value: Any) -> bytes:
        return bytes(value)

    def find_handle(self, username_normalized: str) -> Handle | None:
        rows = self._run(
            "select user_id, username_display, internal_auth_alias, auth_epoch, is_demo "
            "from public.srv_find_handle(%s::text)",
            (username_normalized,),
        )
        if not rows:
            return None
        user_id, display, alias, epoch, is_demo = rows[0]
        return Handle(UUID(str(user_id)), display, alias, int(epoch), bool(is_demo))

    def register_account(
        self,
        *,
        user_id: UUID,
        username_display: str,
        username_normalized: str,
        internal_auth_alias: str,
        is_demo: bool,
        terms_version: str,
        language: str,
        time_zone: str,
        recovery_code_hash: bytes,
    ) -> None:
        self._run(
            "select public.srv_register_account(%s::uuid, %s::text, %s::text, %s::text, "
            "%s::boolean, %s::text, %s::text, %s::text, %s::bytea)",
            (
                user_id,
                username_display,
                username_normalized,
                internal_auth_alias,
                is_demo,
                terms_version,
                language,
                time_zone,
                recovery_code_hash,
            ),
            errors={"23505": UsernameTakenError, "23514": InvalidAccountValueError},
            fetch=False,
        )

    def accept_terms(self, user_id: UUID, terms_version: str) -> datetime:
        rows = self._run(
            "select public.srv_accept_terms(%s::uuid, %s::text)",
            (user_id, terms_version),
            errors={"P0002": AccountNotFoundError},
        )
        if not rows or not isinstance(rows[0][0], datetime):
            raise RepositoryUnavailable()
        return rows[0][0]

    def recovery_active_code(self, user_id: UUID) -> ActiveRecoveryCode | None:
        rows = self._run(
            "select code_id, code_hash from public.srv_recovery_active_code(%s::uuid)",
            (user_id,),
        )
        if not rows:
            return None
        return ActiveRecoveryCode(UUID(str(rows[0][0])), self._bytes(rows[0][1]))

    def recovery_reserve(
        self,
        *,
        user_id: UUID,
        code_id: UUID,
        grant_id: UUID,
        grant_hash: bytes,
        grant_expires_at: datetime,
    ) -> bool:
        rows = self._run(
            "select public.srv_recovery_reserve(%s::uuid, %s::uuid, %s::uuid, %s::bytea, "
            "%s::timestamptz)",
            (user_id, code_id, grant_id, grant_hash, grant_expires_at),
        )
        return bool(rows and rows[0][0])

    def recovery_begin(self, grant_hash: bytes) -> GrantTicket | None:
        rows = self._run(
            "select grant_id, user_id from public.srv_recovery_begin(%s::bytea)", (grant_hash,)
        )
        if not rows:
            return None
        return GrantTicket(UUID(str(rows[0][0])), UUID(str(rows[0][1])))

    def recovery_release(self, grant_id: UUID) -> None:
        self._run("select public.srv_recovery_release(%s::uuid)", (grant_id,), fetch=False)

    def recovery_consume(self, grant_id: UUID, new_code_hash: bytes) -> int:
        rows = self._run(
            "select public.srv_recovery_consume(%s::uuid, %s::bytea)",
            (grant_id, new_code_hash),
            errors={"QT003": InvalidStateError, "P0002": AccountNotFoundError},
        )
        if not rows:
            raise RepositoryUnavailable()
        return int(rows[0][0])

    def recovery_rotate(self, user_id: UUID, new_code_hash: bytes) -> None:
        self._run(
            "select public.srv_recovery_rotate(%s::uuid, %s::bytea)",
            (user_id, new_code_hash),
            fetch=False,
        )

    def create_app_session(
        self,
        *,
        user_id: UUID,
        session_hash: bytes,
        encrypted_auth_tokens: bytes,
        auth_epoch: int,
        expires_at: datetime,
    ) -> UUID:
        rows = self._run(
            "select public.srv_create_app_session(%s::uuid, %s::bytea, %s::bytea, %s::integer, "
            "%s::timestamptz)",
            (user_id, session_hash, encrypted_auth_tokens, auth_epoch, expires_at),
            errors={"QT001": EpochMismatchError},
        )
        if not rows:
            raise RepositoryUnavailable()
        return UUID(str(rows[0][0]))

    def read_app_session(self, session_hash: bytes) -> StoredSession | None:
        rows = self._run(
            "select session_id, user_id, username_display, internal_auth_alias, auth_epoch, "
            "encrypted_auth_tokens, expires_at, is_demo "
            "from public.srv_read_app_session(%s::bytea)",
            (session_hash,),
        )
        if not rows:
            return None
        session_id, user_id, display, alias, epoch, blob, expires_at, is_demo = rows[0]
        return StoredSession(
            session_id=UUID(str(session_id)),
            user_id=UUID(str(user_id)),
            username_display=display,
            internal_auth_alias=alias,
            auth_epoch=int(epoch),
            encrypted_auth_tokens=self._bytes(blob),
            expires_at=expires_at,
            is_demo=bool(is_demo),
        )

    def update_session_tokens(self, session_id: UUID, encrypted_auth_tokens: bytes) -> None:
        self._run(
            "select public.srv_update_app_session_tokens(%s::uuid, %s::bytea)",
            (session_id, encrypted_auth_tokens),
            fetch=False,
        )

    def revoke_app_session(self, session_hash: bytes) -> None:
        self._run("select public.srv_revoke_app_session(%s::bytea)", (session_hash,), fetch=False)

    def bump_auth_epoch(self, user_id: UUID) -> int:
        rows = self._run(
            "select public.srv_bump_auth_epoch(%s::uuid)",
            (user_id,),
            errors={"P0002": AccountNotFoundError},
        )
        if not rows:
            raise RepositoryUnavailable()
        return int(rows[0][0])

    def throttle_check(self, key_hashes: Sequence[bytes]) -> dict[bytes, int]:
        rows = self._run(
            "select key_hash, attempts from public.srv_throttle_check(%s::bytea[])",
            (list(key_hashes),),
        )
        return {self._bytes(key): int(attempts) for key, attempts in rows}

    def throttle_record(self, key_hashes: Sequence[bytes], outcome: str) -> None:
        self._run(
            "select public.srv_throttle_record(%s::bytea[], %s::text)",
            (list(key_hashes), outcome),
            fetch=False,
        )

    def delete_personal_rows(self, user_id: UUID, username_throttle_key: bytes | None) -> None:
        self._run(
            "select public.srv_delete_personal_rows(%s::uuid, %s::bytea)",
            (user_id, username_throttle_key),
            fetch=False,
        )


def _parse_instant(value: Any) -> datetime:
    parsed = datetime.fromisoformat(str(value))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _profile_from_json(item: Any) -> ProfileRow:
    try:
        reminder = item["reminder_settings"]
        pending = item["pending_settings"]
        return ProfileRow(
            language=str(item["language"]),
            time_zone=str(item["time_zone"]),
            session_minutes=int(item["session_minutes"]),
            reminder_settings=dict(reminder) if isinstance(reminder, dict) else {},
            pending_settings=dict(pending) if isinstance(pending, dict) else None,
            terms_version=str(item["terms_version"]),
            terms_accepted_at=_parse_instant(item["terms_accepted_at"]),
            is_demo=bool(item["is_demo"]),
            created_at=_parse_instant(item["created_at"]),
        )
    except (KeyError, TypeError, ValueError):
        raise ProfileUnavailable() from None


class PostgrestProfileStore:
    """``public.profiles`` over PostgREST with the learner's access token (RLS).

    Select and update of the caller's own row only; the update privilege is limited to five
    columns by the database. Tokens, bodies and library messages are never logged or echoed."""

    def __init__(
        self,
        base_url: str,
        anon_key: str,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: httpx.Timeout = PROFILE_TIMEOUT,
    ) -> None:
        self._url = base_url.rstrip("/") + "/rest/v1/profiles"
        self._anon_key = anon_key
        self._transport = transport
        self._timeout = timeout

    def __repr__(self) -> str:
        return "PostgrestProfileStore(<redacted>)"

    @classmethod
    def from_settings(cls, settings: Settings, **kwargs: Any) -> PostgrestProfileStore:
        missing = [n for n in ("SUPABASE_URL", "SUPABASE_ANON_KEY") if settings.is_missing(n)]
        if missing:
            raise StartupConfigError([f"{name} is required" for name in missing])
        assert settings.SUPABASE_URL and settings.SUPABASE_ANON_KEY
        return cls(settings.SUPABASE_URL, settings.SUPABASE_ANON_KEY.get_secret_value(), **kwargs)

    def _call(
        self,
        method: str,
        *,
        user_id: UUID,
        access_token: str | None,
        select: str,
        body: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        if not access_token:
            raise ProfileUnavailable()
        headers = {
            "apikey": self._anon_key,
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
        }
        if body is not None:
            headers["Prefer"] = "return=representation"
        try:
            with httpx.Client(transport=self._transport, timeout=self._timeout) as client:
                return client.request(
                    method,
                    self._url,
                    params={"select": select, "user_id": f"eq.{user_id}"},
                    json=dict(body) if body is not None else None,
                    headers=headers,
                )
        except Exception:
            raise ProfileUnavailable() from None

    @staticmethod
    def _rows(response: httpx.Response) -> list[Any]:
        if response.status_code != 200:
            raise ProfileUnavailable()
        try:
            data = response.json()
        except ValueError:
            raise ProfileUnavailable() from None
        if not isinstance(data, list):
            raise ProfileUnavailable()
        return data

    def read_profile(self, *, user_id: UUID, access_token: str | None) -> ProfileRow:
        response = self._call(
            "GET", user_id=user_id, access_token=access_token, select=PROFILE_COLUMNS
        )
        rows = self._rows(response)
        if not rows:
            raise ProfileMissing()
        return _profile_from_json(rows[0])

    def read_terms_version(self, *, user_id: UUID, access_token: str | None) -> str:
        response = self._call(
            "GET", user_id=user_id, access_token=access_token, select="terms_version"
        )
        rows = self._rows(response)
        if not rows:
            raise ProfileMissing()
        version = rows[0].get("terms_version") if isinstance(rows[0], dict) else None
        if not isinstance(version, str):
            raise ProfileUnavailable()
        return version

    def update_profile(
        self, *, user_id: UUID, access_token: str | None, changes: Mapping[str, Any]
    ) -> ProfileRow:
        if not changes or not set(changes) <= LEARNER_UPDATABLE_COLUMNS:
            raise ProfileUnavailable()
        response = self._call(
            "PATCH",
            user_id=user_id,
            access_token=access_token,
            select=PROFILE_COLUMNS,
            body=changes,
        )
        if response.status_code == 400:
            try:
                code = response.json().get("code")
            except (ValueError, AttributeError):
                code = None
            if code == "23514":  # check_violation: the unknown-time-zone trigger
                raise ProfileValueRejected()
        rows = self._rows(response)
        if not rows:
            raise ProfileMissing()
        return _profile_from_json(rows[0])


_ALIAS_RE = re.compile(
    r"^u\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@qatra\.invalid$"
)
_WINDOW_MINUTES = 15
_PURGE_AFTER = timedelta(hours=24)
_PURGE_LIMIT = 100


@dataclass
class _HandleRec:
    user_id: UUID
    display: str
    normalized: str
    alias: str
    epoch: int
    is_demo: bool


@dataclass
class _CodeRec:
    code_id: UUID
    user_id: UUID
    code_hash: bytes
    reserved_grant_id: UUID | None = None
    reserved_until: datetime | None = None
    consumed_at: datetime | None = None


@dataclass
class _GrantRec:
    grant_id: UUID
    user_id: UUID
    grant_hash: bytes
    expires_at: datetime
    status: str
    created_at: datetime


@dataclass
class _SessionRec:
    session_id: UUID
    user_id: UUID
    session_hash: bytes
    epoch: int
    blob: bytes
    expires_at: datetime
    revoked_at: datetime | None = None


class InMemoryAccounts:
    """Memory-mode twin of the restricted role and of the profile reads and writes.

    Every method follows the SQL of ``0005_rls_functions.sql``. ``clock`` plays the database
    ``now()``; tests move it to expire sessions, grants and throttle windows."""

    def __init__(self, *, clock: Callable[[], datetime] | None = None) -> None:
        self._clock = clock or (lambda: datetime.now(UTC))
        self._lock = threading.RLock()
        self._handles: dict[UUID, _HandleRec] = {}
        self._by_normalized: dict[str, UUID] = {}
        self._profiles: dict[UUID, ProfileRow] = {}
        self._codes: list[_CodeRec] = []
        self._grants: dict[UUID, _GrantRec] = {}
        self._sessions: dict[UUID, _SessionRec] = {}
        self._throttle: dict[tuple[bytes, datetime], int] = {}

    def __repr__(self) -> str:
        return "InMemoryAccounts(<redacted>)"

    def _now(self) -> datetime:
        return self._clock()

    def find_handle(self, username_normalized: str) -> Handle | None:
        with self._lock:
            user_id = self._by_normalized.get(username_normalized)
            if user_id is None:
                return None
            h = self._handles[user_id]
            return Handle(h.user_id, h.display, h.alias, h.epoch, h.is_demo)

    def register_account(
        self,
        *,
        user_id: UUID,
        username_display: str,
        username_normalized: str,
        internal_auth_alias: str,
        is_demo: bool,
        terms_version: str,
        language: str,
        time_zone: str,
        recovery_code_hash: bytes,
    ) -> None:
        with self._lock:
            if (
                username_normalized in self._by_normalized
                or user_id in self._handles
                or any(h.alias == internal_auth_alias for h in self._handles.values())
            ):
                raise UsernameTakenError()
            # the CHECK constraints and the profile trigger of 0002_identity
            if (
                not 3 <= len(username_display) <= 24
                or not 3 <= len(username_normalized) <= 24
                or not unicodedata.is_normalized("NFKC", username_normalized)
                or username_normalized != username_normalized.lower()
                or re.search(r"\s", username_normalized)
                or not _ALIAS_RE.match(internal_auth_alias)
                or language not in LANGUAGES
                or not terms_version.strip()
                or len(recovery_code_hash) != 32
                or not is_valid_time_zone(time_zone)
            ):
                raise InvalidAccountValueError()
            now = self._now()
            self._handles[user_id] = _HandleRec(
                user_id, username_display, username_normalized, internal_auth_alias, 0, is_demo
            )
            self._by_normalized[username_normalized] = user_id
            self._profiles[user_id] = ProfileRow(
                language=language,
                time_zone=time_zone,
                session_minutes=10,
                reminder_settings={},
                pending_settings=None,
                terms_version=terms_version,
                terms_accepted_at=now,
                is_demo=is_demo,
                created_at=now,
            )
            self._codes.append(_CodeRec(uuid4(), user_id, recovery_code_hash))

    def accept_terms(self, user_id: UUID, terms_version: str) -> datetime:
        with self._lock:
            row = self._profiles.get(user_id)
            if row is None:
                raise AccountNotFoundError()
            now = self._now()
            self._profiles[user_id] = replace(
                row, terms_version=terms_version, terms_accepted_at=now
            )
            return now

    def recovery_active_code(self, user_id: UUID) -> ActiveRecoveryCode | None:
        with self._lock:
            now = self._now()
            for code in self._codes:
                if (
                    code.user_id == user_id
                    and code.consumed_at is None
                    and (
                        code.reserved_grant_id is None
                        or code.reserved_until is None
                        or code.reserved_until <= now
                    )
                ):
                    return ActiveRecoveryCode(code.code_id, code.code_hash)
            return None

    def recovery_reserve(
        self,
        *,
        user_id: UUID,
        code_id: UUID,
        grant_id: UUID,
        grant_hash: bytes,
        grant_expires_at: datetime,
    ) -> bool:
        with self._lock:
            now = self._now()
            code = next(
                (
                    c
                    for c in self._codes
                    if c.code_id == code_id and c.user_id == user_id and c.consumed_at is None
                ),
                None,
            )
            if code is None:
                return False
            if (
                code.reserved_grant_id is not None
                and code.reserved_until is not None
                and code.reserved_until > now
            ):
                return False
            # a grant that expired before it was executed releases its slot; an expired grant
            # that is already ``executing`` stays (an uncertain outcome is reviewed first)
            for grant in self._grants.values():
                if (
                    grant.user_id == user_id
                    and grant.status == "active"
                    and grant.expires_at <= now
                ):
                    grant.status = "cancelled"
            if any(
                g.user_id == user_id and g.status in ("active", "executing")
                for g in self._grants.values()
            ):
                return False  # the one-live-grant rule
            self._grants[grant_id] = _GrantRec(
                grant_id, user_id, grant_hash, grant_expires_at, "active", now
            )
            code.reserved_grant_id = grant_id
            code.reserved_until = grant_expires_at
            return True

    def recovery_begin(self, grant_hash: bytes) -> GrantTicket | None:
        with self._lock:
            now = self._now()
            for grant in self._grants.values():
                if (
                    grant.grant_hash == grant_hash
                    and grant.status == "active"
                    and grant.expires_at > now
                ):
                    grant.status = "executing"
                    return GrantTicket(grant.grant_id, grant.user_id)
            return None

    def recovery_release(self, grant_id: UUID) -> None:
        with self._lock:
            grant = self._grants.get(grant_id)
            if grant is not None and grant.status in ("active", "executing"):
                grant.status = "cancelled"
            for code in self._codes:
                if code.reserved_grant_id == grant_id and code.consumed_at is None:
                    code.reserved_grant_id = None
                    code.reserved_until = None

    def recovery_consume(self, grant_id: UUID, new_code_hash: bytes) -> int:
        with self._lock:
            grant = self._grants.get(grant_id)
            if grant is None or grant.status != "executing":
                raise InvalidStateError()
            handle = self._handles.get(grant.user_id)
            if handle is None:
                raise AccountNotFoundError()
            now = self._now()
            for code in self._codes:
                if code.user_id == grant.user_id and code.consumed_at is None:
                    code.consumed_at = now
            grant.status = "consumed"
            self._codes.append(_CodeRec(uuid4(), grant.user_id, new_code_hash))
            handle.epoch += 1
            self._revoke_all(grant.user_id, now)
            return handle.epoch

    def recovery_rotate(self, user_id: UUID, new_code_hash: bytes) -> None:
        with self._lock:
            if user_id not in self._handles:
                raise RepositoryUnavailable()  # the foreign key to auth.users would fail
            now = self._now()
            for code in self._codes:
                if code.user_id == user_id and code.consumed_at is None:
                    code.consumed_at = now
            self._codes.append(_CodeRec(uuid4(), user_id, new_code_hash))
            for grant in self._grants.values():
                if grant.user_id == user_id and grant.status == "active":
                    grant.status = "cancelled"

    def _revoke_all(self, user_id: UUID, now: datetime) -> None:
        for session in self._sessions.values():
            if session.user_id == user_id and session.revoked_at is None:
                session.revoked_at = now

    def _is_live(self, session: _SessionRec, now: datetime) -> bool:
        handle = self._handles.get(session.user_id)
        return (
            session.revoked_at is None
            and session.expires_at > now
            and handle is not None
            and session.epoch == handle.epoch
        )

    def create_app_session(
        self,
        *,
        user_id: UUID,
        session_hash: bytes,
        encrypted_auth_tokens: bytes,
        auth_epoch: int,
        expires_at: datetime,
    ) -> UUID:
        with self._lock:
            handle = self._handles.get(user_id)
            if handle is None or handle.epoch != auth_epoch:
                raise EpochMismatchError()
            if any(s.session_hash == session_hash for s in self._sessions.values()):
                raise RepositoryUnavailable()  # unique (session_hash)
            session_id = uuid4()
            self._sessions[session_id] = _SessionRec(
                session_id, user_id, session_hash, auth_epoch, encrypted_auth_tokens, expires_at
            )
            return session_id

    def read_app_session(self, session_hash: bytes) -> StoredSession | None:
        with self._lock:
            now = self._now()
            for session in self._sessions.values():
                if session.session_hash == session_hash and self._is_live(session, now):
                    handle = self._handles[session.user_id]
                    return StoredSession(
                        session_id=session.session_id,
                        user_id=session.user_id,
                        username_display=handle.display,
                        internal_auth_alias=handle.alias,
                        auth_epoch=session.epoch,
                        encrypted_auth_tokens=session.blob,
                        expires_at=session.expires_at,
                        is_demo=handle.is_demo,
                    )
            return None

    def update_session_tokens(self, session_id: UUID, encrypted_auth_tokens: bytes) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None and self._is_live(session, self._now()):
                session.blob = encrypted_auth_tokens

    def revoke_app_session(self, session_hash: bytes) -> None:
        with self._lock:
            for session in self._sessions.values():
                if session.session_hash == session_hash and session.revoked_at is None:
                    session.revoked_at = self._now()

    def bump_auth_epoch(self, user_id: UUID) -> int:
        with self._lock:
            handle = self._handles.get(user_id)
            if handle is None:
                raise AccountNotFoundError()
            handle.epoch += 1
            self._revoke_all(user_id, self._now())
            return handle.epoch

    def _minute(self) -> datetime:
        return self._now().replace(second=0, microsecond=0)

    def throttle_check(self, key_hashes: Sequence[bytes]) -> dict[bytes, int]:
        with self._lock:
            floor = self._minute() - timedelta(minutes=_WINDOW_MINUTES)
            return {
                key: sum(
                    attempts
                    for (bucket_key, start), attempts in self._throttle.items()
                    if bucket_key == key and start > floor
                )
                for key in set(key_hashes)
            }

    def throttle_record(self, key_hashes: Sequence[bytes], outcome: str) -> None:
        with self._lock:
            if outcome == "failure":
                start = self._minute()
                for key in set(key_hashes):
                    self._throttle[(key, start)] = self._throttle.get((key, start), 0) + 1
            elif outcome == "success":
                wanted = set(key_hashes)
                for bucket in [b for b in self._throttle if b[0] in wanted]:
                    del self._throttle[bucket]
            else:
                raise RepositoryUnavailable()  # invalid_parameter_value
            cutoff = self._now() - _PURGE_AFTER
            old = [bucket for bucket in self._throttle if bucket[1] < cutoff][:_PURGE_LIMIT]
            for bucket in old:
                del self._throttle[bucket]

    def delete_personal_rows(self, user_id: UUID, username_throttle_key: bytes | None) -> None:
        with self._lock:
            handle = self._handles.pop(user_id, None)
            if handle is not None:
                self._by_normalized.pop(handle.normalized, None)
            self._profiles.pop(user_id, None)
            self._sessions = {k: s for k, s in self._sessions.items() if s.user_id != user_id}
            self._grants = {k: g for k, g in self._grants.items() if g.user_id != user_id}
            self._codes = [c for c in self._codes if c.user_id != user_id]
            if username_throttle_key is not None:
                for bucket in [b for b in self._throttle if b[0] == username_throttle_key]:
                    del self._throttle[bucket]

    def read_profile(self, *, user_id: UUID, access_token: str | None) -> ProfileRow:
        with self._lock:
            row = self._profiles.get(user_id)
            if row is None:
                raise ProfileMissing()
            return row

    def read_terms_version(self, *, user_id: UUID, access_token: str | None) -> str:
        return self.read_profile(user_id=user_id, access_token=access_token).terms_version

    def update_profile(
        self, *, user_id: UUID, access_token: str | None, changes: Mapping[str, Any]
    ) -> ProfileRow:
        with self._lock:
            row = self._profiles.get(user_id)
            if row is None:
                raise ProfileMissing()
            if not changes or not set(changes) <= LEARNER_UPDATABLE_COLUMNS:
                raise ProfileUnavailable()
            if "time_zone" in changes and not is_valid_time_zone(changes["time_zone"]):
                raise ProfileValueRejected()
            pending = changes.get("pending_settings")
            if (
                isinstance(pending, dict)
                and "timeZone" in pending
                and not is_valid_time_zone(pending["timeZone"])
            ):
                raise ProfileValueRejected()
            if "language" in changes and changes["language"] not in LANGUAGES:
                raise ProfileValueRejected()
            if "session_minutes" in changes and changes["session_minutes"] not in (
                SESSION_MINUTES_OPTIONS
            ):
                raise ProfileValueRejected()
            updated = replace(row, **dict(changes))
            self._profiles[user_id] = updated
            return updated

    # Test introspection, not part of any Protocol.

    def account_exists(self, user_id: UUID) -> bool:
        with self._lock:
            return user_id in self._handles

    def epoch_of(self, user_id: UUID) -> int:
        with self._lock:
            return self._handles[user_id].epoch

    def live_session_count(self, user_id: UUID) -> int:
        with self._lock:
            now = self._now()
            return sum(
                1 for s in self._sessions.values() if s.user_id == user_id and self._is_live(s, now)
            )

    def session_count(self, user_id: UUID | None = None) -> int:
        with self._lock:
            return sum(1 for s in self._sessions.values() if user_id in (None, s.user_id))

    def grant_statuses(self, user_id: UUID) -> list[str]:
        with self._lock:
            return [g.status for g in self._grants.values() if g.user_id == user_id]

    def code_count(self, user_id: UUID, *, active_only: bool = False) -> int:
        with self._lock:
            return sum(
                1
                for c in self._codes
                if c.user_id == user_id and (not active_only or c.consumed_at is None)
            )

    def throttle_rows(self) -> dict[tuple[bytes, datetime], int]:
        with self._lock:
            return dict(self._throttle)

    def stored_tokens(self, user_id: UUID) -> list[bytes]:
        with self._lock:
            return [s.blob for s in self._sessions.values() if s.user_id == user_id]
