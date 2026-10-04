"""Operator CLI configuration: Supabase access by variable NAME (contract §8).

Only ``SUPABASE_URL`` and ``SUPABASE_SERVICE_ROLE_KEY`` (publishing scope) and the optional
``QATRA_DATA_BACKEND`` are read. The CLI never reads ``QATRA_SERVER_DB`` or any learner
secret, and never prints a value.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Literal
from urllib.parse import urlsplit

from pydantic import SecretStr, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.workflow.errors import NotConfiguredError
from app.workflow.paths import BACKEND_ROOT

DataBackend = Literal["memory", "supabase"]
DEFAULT_DOTENV: Final = BACKEND_ROOT / ".env"
_LOCAL_HOSTS: Final = {"localhost", "127.0.0.1", "::1"}


@dataclass(frozen=True, slots=True)
class SupabaseConfig:
    """Project URL and the ``service_role`` key; ``repr`` never shows the key."""

    url: str
    service_role_key: str = field(repr=False)


class _CliEnv(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=None, extra="ignore", case_sensitive=False, env_ignore_empty=True
    )

    SUPABASE_URL: str | None = None
    SUPABASE_SERVICE_ROLE_KEY: SecretStr | None = None
    QATRA_DATA_BACKEND: str | None = None


def _read(
    environ: Mapping[str, str] | None, dotenv_path: Path | None
) -> tuple[str | None, str | None, str | None]:
    if environ is not None:
        return (
            environ.get("SUPABASE_URL") or None,
            environ.get("SUPABASE_SERVICE_ROLE_KEY") or None,
            environ.get("QATRA_DATA_BACKEND") or None,
        )
    path = dotenv_path if dotenv_path is not None else DEFAULT_DOTENV
    try:
        env = _CliEnv(_env_file=path if path.is_file() else None)  # type: ignore[call-arg]
    except ValidationError as exc:
        names = sorted({str(e["loc"][0]) for e in exc.errors() if e["loc"]})
        raise NotConfiguredError(f"invalid configuration values for: {', '.join(names)}") from None
    secret = env.SUPABASE_SERVICE_ROLE_KEY
    key = secret.get_secret_value() if secret else None
    return env.SUPABASE_URL, key, env.QATRA_DATA_BACKEND


def resolve_data_backend(
    environ: Mapping[str, str] | None = None, *, dotenv_path: Path | None = None
) -> DataBackend:
    """``QATRA_DATA_BACKEND`` when set to ``supabase`` or ``memory``; otherwise ``memory``
    (the local build area, the only backend B7 can run)."""
    value = (_read(environ, dotenv_path)[2] or "memory").strip().lower()
    return "supabase" if value == "supabase" else "memory"


def load_supabase_config(
    environ: Mapping[str, str] | None = None, *, dotenv_path: Path | None = None
) -> SupabaseConfig | None:
    """The Supabase configuration, or ``None`` unless BOTH variables are set. A URL that is not
    ``https://`` (``http://`` is accepted for localhost only) or that carries a path, query or
    credentials raises ``NotConfiguredError`` (names only)."""
    url, key, _ = _read(environ, dotenv_path)
    if not url or not key or not key.strip():
        return None
    parts = urlsplit(url.strip())
    local = (parts.hostname or "") in _LOCAL_HOSTS
    if (
        parts.scheme not in {"https", "http"}
        or (parts.scheme == "http" and not local)
        or not parts.netloc
        or "@" in parts.netloc
        or parts.path.strip("/")
        or parts.query
        or parts.fragment
    ):
        raise NotConfiguredError("SUPABASE_URL must be a bare https project URL")
    return SupabaseConfig(url=f"{parts.scheme}://{parts.netloc}", service_role_key=key.strip())


def process_environ() -> Mapping[str, str]:
    """The real process environment (kept behind a function so tests never touch it)."""
    return os.environ
