"""Test helpers. Tests run in memory mode and need no database and no secrets."""

from __future__ import annotations

from typing import Any

from app.config import Settings

FRONTEND_ORIGIN = "http://localhost:3000"

# Every variable name the Settings class reads (used to isolate tests from the process env).
CONFIG_NAMES = tuple(Settings.model_fields)


def make_settings(**overrides: Any) -> Settings:
    """Settings for tests: explicit values, no .env file, memory backend."""
    values: dict[str, Any] = {
        "APP_ENV": "test",
        "QATRA_DATA_BACKEND": "memory",
        "FRONTEND_ORIGIN": FRONTEND_ORIGIN,
        "TERMS_VERSION": "2026-10-04",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


def production_values(**overrides: Any) -> dict[str, Any]:
    """A complete production configuration made of obvious dummy values."""
    values: dict[str, Any] = {
        "APP_ENV": "production",
        "QATRA_DATA_BACKEND": "supabase",
        "FRONTEND_ORIGIN": "https://qatra.example",
        "TERMS_VERSION": "2026-10-04",
        "SUPABASE_URL": "https://dummy-project.example",
        "SUPABASE_ANON_KEY": "dummy-anon",
        "SUPABASE_SERVICE_ROLE_KEY": "dummy-service-role",
        "QATRA_SERVER_DB": "postgresql://dummy@db.example/dummy",
        "QATRA_SESSION_KEY": "dummy-session-key",
        "QATRA_SESSION_HMAC_KEY": "dummy-session-hmac",
        "QATRA_RECOVERY_HMAC_KEY": "dummy-recovery-hmac",
        "QATRA_THROTTLE_HMAC_KEY": "dummy-throttle-hmac",
    }
    values.update(overrides)
    return values
