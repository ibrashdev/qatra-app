"""Test helpers. Tests run in memory mode and need no database and no secrets."""

from __future__ import annotations

import base64
import secrets
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


def random_key_b64(size: int = 32) -> str:
    """A fresh random key as base64 (contract §8). Tests generate their keys; none is stored."""
    return base64.b64encode(secrets.token_bytes(size)).decode("ascii")


def production_values(**overrides: Any) -> dict[str, Any]:
    """A complete production configuration: dummy hosts and tokens, and freshly generated random
    keys (production startup validates that the four keys decode to the required lengths)."""
    values: dict[str, Any] = {
        "APP_ENV": "production",
        "QATRA_DATA_BACKEND": "supabase",
        "FRONTEND_ORIGIN": "https://qatra.example",
        "TERMS_VERSION": "2026-10-04",
        "SUPABASE_URL": "https://dummy-project.example",
        "SUPABASE_ANON_KEY": "dummy-anon",
        "SUPABASE_SERVICE_ROLE_KEY": "dummy-service-role",
        "QATRA_SERVER_DB": "postgresql://dummy@db.example/dummy",
        "QATRA_SESSION_KEY": random_key_b64(),
        "QATRA_SESSION_HMAC_KEY": random_key_b64(),
        "QATRA_RECOVERY_HMAC_KEY": random_key_b64(),
        "QATRA_THROTTLE_HMAC_KEY": random_key_b64(),
    }
    values.update(overrides)
    return values
