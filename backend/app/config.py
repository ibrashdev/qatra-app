"""Configuration, validated by NAME only (contract §8).

Rules:
- Variable names match contract §8 exactly. Values never appear in errors, logs or ``repr``
  (secrets are ``SecretStr``).
- In production every secret and key is required, and a local ``.env`` file is never read.
  In development and test only ``FRONTEND_ORIGIN`` and ``TERMS_VERSION`` are required.
- ``QATRA_DATA_BACKEND=memory`` is refused when ``APP_ENV=production``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

AppEnv = Literal["production", "development", "test"]
DataBackend = Literal["supabase", "memory"]

_DOTENV_PATH = Path(__file__).resolve().parent.parent / ".env"

# Required in every environment (development and test included).
_REQUIRED_EVERYWHERE = ("FRONTEND_ORIGIN", "TERMS_VERSION")

# Additionally required when APP_ENV=production, in declaration order.
_REQUIRED_IN_PRODUCTION = (
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "QATRA_SERVER_DB",
    "QATRA_SESSION_KEY",
    "QATRA_SESSION_HMAC_KEY",
    "QATRA_RECOVERY_HMAC_KEY",
    "QATRA_THROTTLE_HMAC_KEY",
)


class StartupConfigError(RuntimeError):
    """Raised at startup. The message lists variable NAMES only, never values."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = list(problems)
        super().__init__("Invalid configuration: " + "; ".join(self.problems))


class Settings(BaseSettings):
    """Backend settings. Attribute names are the environment variable names."""

    model_config = SettingsConfigDict(
        env_file=None,
        extra="ignore",
        case_sensitive=False,
        env_ignore_empty=True,
    )

    APP_ENV: AppEnv = "development"
    FRONTEND_ORIGIN: str | None = None
    SUPABASE_URL: str | None = None
    SUPABASE_ANON_KEY: SecretStr | None = None
    SUPABASE_SERVICE_ROLE_KEY: SecretStr | None = None
    QATRA_SERVER_DB: SecretStr | None = None
    QATRA_SESSION_KEY: SecretStr | None = None
    QATRA_SESSION_HMAC_KEY: SecretStr | None = None
    QATRA_RECOVERY_HMAC_KEY: SecretStr | None = None
    QATRA_THROTTLE_HMAC_KEY: SecretStr | None = None
    TERMS_VERSION: str | None = None
    OPENROUTER_API_KEY: SecretStr | None = None
    OPENROUTER_MODELS: str | None = None
    QATRA_DATA_BACKEND: DataBackend = "supabase"
    QATRA_CONTENT_BUNDLES: str | None = None

    # The version string reported by E01. API-spec O-08 leaves its source to provisioning
    # (for example the Render commit id); until then it defaults to "dev".
    APP_VERSION: str = "dev"

    # Configuration defaults (A-12), not approved numbers.
    QATRA_READY_RATE_PER_MIN: int = 6
    QATRA_BODY_LIMIT_BYTES: int = 65536

    # Plan conversation (Plan-conversation.md §2.5; D75). Configuration defaults, not approved
    # numbers: caps follow OpenRouter's published free-tier limits, verified at provisioning.
    QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY: int = Field(default=50, ge=0)
    QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE: int = Field(default=20, ge=0)
    QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY: int = Field(default=10, ge=0)
    QATRA_CHAT_MODEL_TURNS_PER_CHAT: int = Field(default=6, ge=0)
    QATRA_CHAT_MODEL_TIMEOUT_SEC: float = Field(default=8, gt=0)
    QATRA_CHAT_MAX_TOKENS: int = Field(default=400, ge=1)
    QATRA_CHAT_GUARD_VERSION: str = "guard-v1"
    # When false, every conversation of a non-demo account is rules-only (no provider call).
    QATRA_CHAT_MODEL_FOR_LEARNERS: bool = True

    def is_missing(self, name: str) -> bool:
        value = getattr(self, name)
        if value is None:
            return True
        raw = value.get_secret_value() if isinstance(value, SecretStr) else str(value)
        return not raw.strip()

    def missing_required_for(self, env: AppEnv) -> list[str]:
        """Names of required variables that are missing for ``env`` (names only)."""
        required = list(_REQUIRED_EVERYWHERE)
        if env == "production":
            required += list(_REQUIRED_IN_PRODUCTION)
        return [name for name in required if self.is_missing(name)]


def _origin_problem(origin: str, env: AppEnv) -> str | None:
    """Return a names-only problem text if ``origin`` is not a bare origin."""
    try:
        parts = urlsplit(origin)
    except ValueError:
        return "FRONTEND_ORIGIN must be an origin such as scheme://host[:port]"
    if parts.scheme not in {"http", "https"} or not parts.netloc or "@" in parts.netloc:
        return "FRONTEND_ORIGIN must be an origin such as scheme://host[:port]"
    if parts.path or parts.query or parts.fragment or origin.endswith("/"):
        return "FRONTEND_ORIGIN must be a bare origin without a path, query or trailing slash"
    if env == "production" and parts.scheme != "https":
        return "FRONTEND_ORIGIN must use https when APP_ENV is production"
    return None


def validate_startup(settings: Settings) -> None:
    """Fail fast with names only. Called by ``create_app`` before the app is built."""
    problems: list[str] = []
    missing = settings.missing_required_for(settings.APP_ENV)
    if missing:
        problems.append(
            f"missing required variables for APP_ENV={settings.APP_ENV}: " + ", ".join(missing)
        )
    if settings.APP_ENV == "production" and settings.QATRA_DATA_BACKEND == "memory":
        problems.append("QATRA_DATA_BACKEND must not select the memory backend in production")
    if settings.QATRA_READY_RATE_PER_MIN < 1:
        problems.append("QATRA_READY_RATE_PER_MIN must be at least 1")
    if settings.QATRA_BODY_LIMIT_BYTES < 1:
        problems.append("QATRA_BODY_LIMIT_BYTES must be at least 1")
    origin = settings.FRONTEND_ORIGIN
    if origin is not None and "FRONTEND_ORIGIN" not in missing:
        origin_problem = _origin_problem(origin, settings.APP_ENV)
        if origin_problem:
            problems.append(origin_problem)
    if problems:
        raise StartupConfigError(problems)


def load_settings() -> Settings:
    """Load settings from the process environment (and a local ``.env`` outside production).

    A ``.env`` file is never read in production, and it may not switch the environment to
    production. Pydantic errors are reduced to variable names: they can echo values.
    """
    declared_env = os.environ.get("APP_ENV", "development").strip().lower()
    env_file = None if declared_env == "production" else _DOTENV_PATH
    try:
        settings = Settings(_env_file=env_file)  # type: ignore[call-arg]
    except ValidationError as exc:
        names = sorted({str(error["loc"][0]) for error in exc.errors() if error["loc"]})
        raise StartupConfigError(
            ["invalid values for variables: " + ", ".join(names or ["unknown"])]
        ) from None
    if env_file is not None and settings.APP_ENV == "production":
        raise StartupConfigError(["APP_ENV=production must come from the process environment"])
    return settings
