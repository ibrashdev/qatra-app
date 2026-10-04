"""Pydantic DTOs of the authentication and account operations E03-E13 (API-spec §4.2, §4.3).

JSON names are camelCase (aliases); Python names are snake_case. Request bodies are STRICT
(API-spec §1.2): a missing field, a value of the wrong JSON type or an unknown property is a
``422 validation_error`` (an unknown property carries the rule ``forbidden_field``). The rules
on the VALUES (username classes, password length, time zone, language, terms) are not checked
here: the validation order of E03 is Origin, schema, terms, field rules, uniqueness, so the
service applies them afterwards and names the rule in ``details.fields``.

This module is pure pydantic: no FastAPI, Starlette or database client.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt, StrictStr, model_serializer
from pydantic.alias_generators import to_camel

Language = Literal["ar", "en"]
SessionMinutes = Literal[5, 10, 15]


class CamelModel(BaseModel):
    """Base of response models: camelCase aliases, built by field name."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RequestModel(BaseModel):
    """Base of request bodies: camelCase names only, unknown fields forbidden."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        extra="forbid",
    )


# --- responses ------------------------------------------------------------------------------------


class ReminderSettings(CamelModel):
    in_app: bool


class PendingSettings(CamelModel):
    """A time zone or session-minutes change that waits for its learning day (D57)."""

    session_minutes: SessionMinutes | None = None
    time_zone: str | None = None
    effective_date: date

    @model_serializer(mode="wrap")
    def _drop_empty_fields(self, handler: Any) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        for name in ("sessionMinutes", "session_minutes", "timeZone", "time_zone"):
            if name in data and data[name] is None:
                del data[name]
        return data


class Profile(CamelModel):
    """Implementation-contract §7 ``Profile``. ``pendingSettings`` is always present (null when
    nothing waits)."""

    username: str
    language: Language
    time_zone: str
    session_minutes: SessionMinutes
    reminder_settings: ReminderSettings
    is_demo: bool
    terms_version: str
    terms_accepted_at: datetime
    created_at: datetime
    pending_settings: PendingSettings | None


class RegisterResponse(CamelModel):
    profile: Profile
    recovery_code: str


class LoginResponse(CamelModel):
    profile: Profile
    reconsent_required: bool


class ProfileEnvelope(CamelModel):
    profile: Profile


class ResetGrantResponse(CamelModel):
    reset_grant: str
    expires_in_sec: int


class RecoveryCodeResponse(CamelModel):
    recovery_code: str


# --- requests (strict types; value rules are applied by the services) -----------------------------


class RegisterRequest(RequestModel):
    username: StrictStr
    password: StrictStr
    time_zone: StrictStr
    language: StrictStr
    terms_accepted: StrictBool
    terms_version: StrictStr


class LoginRequest(RequestModel):
    username: StrictStr
    password: StrictStr


class ConsentRequest(RequestModel):
    terms_version: StrictStr


class RecoveryVerifyRequest(RequestModel):
    username: StrictStr
    recovery_code: StrictStr


class RecoveryResetRequest(RequestModel):
    reset_grant: StrictStr
    new_password: StrictStr


class RotateRecoveryRequest(RequestModel):
    password: StrictStr


class ChangePasswordRequest(RequestModel):
    current_password: StrictStr
    new_password: StrictStr


class ProfilePatchRequest(RequestModel):
    """E12: every field is optional, at least one must be sent (rule ``no_fields``). A field that
    is sent as ``null`` is a type error, not "not sent": the defaults are ``None`` only to tell
    the two apart through ``model_fields_set``."""

    language: StrictStr = None  # type: ignore[assignment]
    time_zone: StrictStr = None  # type: ignore[assignment]
    session_minutes: StrictInt = None  # type: ignore[assignment]
    reminder_settings: dict[str, Any] = None  # type: ignore[assignment]


class DeleteAccountRequest(RequestModel):
    password: StrictStr
    confirm: StrictStr
