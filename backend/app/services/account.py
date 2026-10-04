"""Account services: profile read (E11), settings update (E12) and account deletion (E13).

E11 and E12 read and write ``public.profiles`` through the profile store (PostgREST with the
learner's own token under row-level security in supabase mode). E12 follows D57: language and
the in-app reminder change at once; a time zone or session-minutes change becomes
``pendingSettings`` and takes effect on the next learning date of the zone in force. The pending
promotion is a read-time projection (``settings_in_force``): ``GET /api/me`` never writes
(API-spec E11), and the promoted values are stored by the next successful E12.

E13 follows Database-schema §12.1: the password and the confirmation are checked, then
``srv_delete_personal_rows`` removes every personal row and the username's throttle rows in one
transaction (which also ends every session), then the Auth user is deleted through the Admin
API (idempotent, retried once; a failure there leaves only an alias-only Auth record, decided
A-10, and the answer stays 204).
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any

from app.config import Settings
from app.contracts_auth import PendingSettings, Profile, ProfilePatchRequest, ReminderSettings
from app.dependencies import ResolvedSession
from app.domain import auth_policy as policy
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.providers.supabase_auth import AuthProviderError, SupabaseAuth
from app.repositories.accounts import (
    AccountRepository,
    ProfileMissing,
    ProfileRow,
    ProfileStore,
    ProfileUnavailable,
    ProfileValueRejected,
    RepositoryUnavailable,
)
from app.services.session_crypto import SessionCrypto

if TYPE_CHECKING:
    from app.services.auth import AuthService, ConsentCache, SessionService

logger = logging.getLogger("qatra.account")

DELETE_CONFIRMATION = "DELETE"


def settings_of(row: ProfileRow) -> policy.AccountSettings:
    """The settings columns of a stored profile row (a missing ``inApp`` reads as ``true``)."""
    in_app = row.reminder_settings.get("inApp")
    return policy.AccountSettings(
        language=row.language,
        time_zone=row.time_zone,
        session_minutes=row.session_minutes,
        reminder_in_app=in_app if isinstance(in_app, bool) else True,
        pending=row.pending_settings,
    )


def _whole_seconds(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(microsecond=0)


def profile_from_row(username: str, row: ProfileRow, now: datetime) -> Profile:
    """The ``Profile`` DTO: the settings in force at ``now`` (a pending change whose learning
    day has begun already applies) and the pending change that still waits, if any."""
    view = policy.settings_in_force(settings_of(row), now)
    pending: PendingSettings | None = None
    if view.pending is not None:
        effective = date.fromisoformat(view.pending["effectiveDate"])
        minutes = view.pending.get("sessionMinutes")
        zone = view.pending.get("timeZone")
        pending = PendingSettings(
            session_minutes=minutes if minutes in policy.SESSION_MINUTES_OPTIONS else None,
            time_zone=zone if policy.is_valid_time_zone(zone) else None,
            effective_date=effective,
        )
    return Profile(
        username=username,
        language=view.language,  # type: ignore[arg-type]
        time_zone=view.time_zone,
        session_minutes=view.session_minutes,  # type: ignore[arg-type]
        reminder_settings=ReminderSettings(in_app=view.reminder_in_app),
        is_demo=row.is_demo,
        terms_version=row.terms_version,
        terms_accepted_at=_whole_seconds(row.terms_accepted_at),
        created_at=_whole_seconds(row.created_at),
        pending_settings=pending,
    )


def _validation(*fields: dict[str, str]) -> AppError:
    return AppError(ErrorCode.validation_error, details={"fields": list(fields)})


class AccountService:
    def __init__(
        self,
        *,
        settings: Settings,
        repository: AccountRepository,
        provider: SupabaseAuth,
        crypto: SessionCrypto,
        profiles: ProfileStore,
        sessions: SessionService,
        auth: AuthService,
        consent: ConsentCache,
        clock: Callable[[], datetime],
    ) -> None:
        self._settings = settings
        self._repo = repository
        self._provider = provider
        self._crypto = crypto
        self._profiles = profiles
        self._sessions = sessions
        self._auth = auth
        self._consent = consent
        self._clock = clock

    def read_profile(self, session: ResolvedSession) -> Profile:
        row = self._sessions.load_profile_row(session.context.user_id, session.tokens.access)
        return profile_from_row(session.username, row, self._clock())

    @staticmethod
    def _patch_problems(body: ProfilePatchRequest) -> list[dict[str, str]]:
        sent = body.model_fields_set
        problems: list[dict[str, str]] = []
        if not sent:
            return [{"field": "body", "rule": "no_fields"}]
        if "language" in sent and body.language not in policy.LANGUAGES:
            problems.append({"field": "language", "rule": "language_invalid"})
        if "time_zone" in sent and not policy.is_valid_time_zone(body.time_zone):
            problems.append({"field": "timeZone", "rule": "time_zone_invalid"})
        if "session_minutes" in sent and body.session_minutes not in policy.SESSION_MINUTES_OPTIONS:
            problems.append({"field": "sessionMinutes", "rule": "session_minutes_invalid"})
        if "reminder_settings" in sent and not policy.validate_reminder_settings(
            body.reminder_settings
        ):
            problems.append({"field": "reminderSettings", "rule": "reminder_settings_invalid"})
        return problems

    def update_profile(self, session: ResolvedSession, body: ProfilePatchRequest) -> Profile:
        problems = self._patch_problems(body)
        if problems:
            raise _validation(*problems)
        sent = body.model_fields_set
        patch = policy.SettingsPatch(
            language=body.language if "language" in sent else None,
            time_zone=body.time_zone if "time_zone" in sent else None,
            session_minutes=body.session_minutes if "session_minutes" in sent else None,
            reminder_in_app=(
                body.reminder_settings["inApp"] if "reminder_settings" in sent else None
            ),
        )
        user_id, token = session.context.user_id, session.tokens.access
        now = self._clock()
        row = self._sessions.load_profile_row(user_id, token)
        stored = settings_of(row)
        changes = policy.settings_changes(stored, policy.apply_patch(stored, patch, now))
        if changes:
            row = self._write(user_id, token, changes)
        return profile_from_row(session.username, row, now)

    def _write(self, user_id: Any, token: str, changes: dict[str, Any]) -> ProfileRow:
        try:
            return self._profiles.update_profile(
                user_id=user_id, access_token=token, changes=changes
            )
        except ProfileValueRejected:
            pending = changes.get("pending_settings") or {}
            if "time_zone" in changes or "timeZone" in pending:
                raise _validation({"field": "timeZone", "rule": "time_zone_invalid"}) from None
            raise AppError(ErrorCode.internal) from None
        except (ProfileUnavailable, ProfileMissing):
            raise AppError(ErrorCode.unavailable) from None

    def delete_account(
        self, session: ResolvedSession, *, password: str, confirm: str, ip_prefix: str
    ) -> None:
        """Delete the account and every personal row at once and for good.

        The throttle is checked first and a wrong password counts as a failure under the same
        username key (A-03). Until the personal rows are gone nothing has changed and the
        request may be repeated (503); afterwards the answer is 204 whatever the Auth deletion
        does."""
        if confirm != DELETE_CONFIRMATION:
            raise _validation({"field": "confirm", "rule": "confirm_literal"})
        self._auth.verify_current_password(session, password, ip_prefix)
        user_id = session.context.user_id
        username_key = self._crypto.throttle_key_username(
            policy.normalize_username(session.username)
        )
        try:
            self._repo.delete_personal_rows(user_id, username_key)
        except RepositoryUnavailable:
            raise AppError(ErrorCode.unavailable) from None
        self._consent.forget(user_id)
        try:
            self._provider.admin_delete_user(user_id)
        except AuthProviderError:
            # Residue: an unreachable Auth record that holds only the alias (OPEN-14, A-10).
            log_event(logger, "identity_delete_failed", operation="account_delete")
