"""Raw-object storage (API-spec §5.3 ``acquire``, Database-schema §9).

Raw publisher records are saved unmodified. ``LocalStagingStorage`` is the gitignored copy
under ``backend/.content-build/raw/<editionKey>/``; ``SupabaseRawStorage`` talks to the private
bucket ``sources`` (``<editionKey>/raw/<name>``) through the Storage REST API with the
``service_role`` key, only when ``SUPABASE_URL`` and ``SUPABASE_SERVICE_ROLE_KEY`` are both set.

Idempotency: writing the same bytes again changes nothing; an existing object whose bytes differ
is refused with ``ObjectConflictError`` (a correction needs a new ``bank_version``).
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Literal, Protocol
from urllib.parse import quote

import httpx

from app.workflow.editions import edition_spec
from app.workflow.errors import (
    InputError,
    NotConfiguredError,
    ObjectConflictError,
    ObjectNotFoundError,
    StorageError,
)
from app.workflow.models import sha256_hex
from app.workflow.settings import SupabaseConfig

BUCKET = "sources"
PutOutcome = Literal["created", "unchanged"]
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def validate_name(edition_key: str, name: str) -> None:
    """Reject unknown editions and names that could escape the edition directory."""
    edition_spec(edition_key)
    if not _NAME_RE.fullmatch(name) or ".." in name:
        raise InputError("invalid raw object name")


class RawStorage(Protocol):
    """Where raw objects live. ``put_raw`` is idempotent (see module docstring)."""

    def put_raw(self, edition_key: str, name: str, data: bytes) -> PutOutcome: ...

    def exists(self, edition_key: str, name: str) -> bool: ...

    def sha256(self, edition_key: str, name: str) -> str | None: ...

    def read_raw(self, edition_key: str, name: str) -> bytes: ...

    def list_raw(self, edition_key: str) -> list[str]: ...


class LocalStagingStorage:
    """Local staging copy under ``<root>/<editionKey>/`` (gitignored build area)."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, edition_key: str, name: str) -> Path:
        validate_name(edition_key, name)
        return self.root / edition_key / name

    def put_raw(self, edition_key: str, name: str, data: bytes) -> PutOutcome:
        path = self._path(edition_key, name)
        if path.exists():
            if sha256_hex(path.read_bytes()) == sha256_hex(data):
                return "unchanged"
            raise ObjectConflictError(
                "an existing raw object has a different hash; a correction needs a new bank_version"
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".part")
        try:
            with os.fdopen(handle, "wb") as tmp:
                tmp.write(data)
            os.replace(tmp_name, path)
        except BaseException:
            Path(tmp_name).unlink(missing_ok=True)
            raise
        return "created"

    def exists(self, edition_key: str, name: str) -> bool:
        return self._path(edition_key, name).is_file()

    def sha256(self, edition_key: str, name: str) -> str | None:
        path = self._path(edition_key, name)
        return sha256_hex(path.read_bytes()) if path.is_file() else None

    def read_raw(self, edition_key: str, name: str) -> bytes:
        path = self._path(edition_key, name)
        if not path.is_file():
            raise ObjectNotFoundError("a raw object needed by this step is missing")
        return path.read_bytes()

    def list_raw(self, edition_key: str) -> list[str]:
        directory = self.root / edition_key
        edition_spec(edition_key)
        if not directory.is_dir():
            return []
        found = (p.name for p in directory.iterdir() if p.is_file())
        return sorted(name for name in found if _NAME_RE.fullmatch(name))


class SupabaseRawStorage:
    """Private Supabase Storage bucket ``sources`` through the Storage REST API.

    Needs the ``service_role`` key (publishing scope only). Not exercised against a live
    project in B7: unit-tested with ``httpx.MockTransport`` only.
    """

    def __init__(
        self,
        config: SupabaseConfig | None,
        *,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        if config is None:
            raise NotConfiguredError(
                "Supabase Storage needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
            )
        self._config = config
        self._transport = transport
        self._timeout = timeout

    def _client(self) -> httpx.Client:
        key = self._config.service_role_key
        return httpx.Client(
            base_url=self._config.url,
            headers={"Authorization": f"Bearer {key}", "apikey": key},
            timeout=self._timeout,
            transport=self._transport,
            follow_redirects=False,
        )

    @staticmethod
    def _object_path(edition_key: str, name: str) -> str:
        validate_name(edition_key, name)
        return f"{BUCKET}/{quote(edition_key)}/raw/{quote(name)}"

    @staticmethod
    def _is_missing(response: httpx.Response) -> bool:
        if response.status_code == 404:
            return True
        if response.status_code == 400:  # older Storage versions answer 400 + statusCode "404"
            try:
                return str(response.json().get("statusCode")) == "404"
            except ValueError:
                return False
        return False

    def _get(self, edition_key: str, name: str) -> bytes | None:
        path = self._object_path(edition_key, name)
        try:
            with self._client() as client:
                response = client.get(f"/storage/v1/object/{path}")
        except httpx.HTTPError as exc:
            raise StorageError(f"storage request failed ({type(exc).__name__})") from None
        if response.status_code == 200:
            return response.content
        if self._is_missing(response):
            return None
        raise StorageError(f"storage answered status {response.status_code}")

    def exists(self, edition_key: str, name: str) -> bool:
        return self._get(edition_key, name) is not None

    def sha256(self, edition_key: str, name: str) -> str | None:
        data = self._get(edition_key, name)
        return None if data is None else sha256_hex(data)

    def read_raw(self, edition_key: str, name: str) -> bytes:
        data = self._get(edition_key, name)
        if data is None:
            raise ObjectNotFoundError("a raw object needed by this step is missing")
        return data

    def put_raw(self, edition_key: str, name: str, data: bytes) -> PutOutcome:
        existing = self._get(edition_key, name)
        if existing is not None:
            if sha256_hex(existing) == sha256_hex(data):
                return "unchanged"
            raise ObjectConflictError(
                "an existing raw object has a different hash; a correction needs a new bank_version"
            )
        path = self._object_path(edition_key, name)
        try:
            with self._client() as client:
                response = client.post(
                    f"/storage/v1/object/{path}",
                    content=data,
                    headers={"Content-Type": "application/json", "x-upsert": "false"},
                )
        except httpx.HTTPError as exc:
            raise StorageError(f"storage request failed ({type(exc).__name__})") from None
        if response.status_code in (200, 201):
            return "created"
        if response.status_code == 409:
            raise ObjectConflictError("the raw object was created concurrently; refused")
        raise StorageError(f"storage answered status {response.status_code}")

    def list_raw(self, edition_key: str) -> list[str]:
        edition_spec(edition_key)
        names: list[str] = []
        offset = 0
        limit = 100
        while True:
            try:
                with self._client() as client:
                    response = client.post(
                        f"/storage/v1/object/list/{BUCKET}",
                        json={
                            "prefix": f"{edition_key}/raw",
                            "limit": limit,
                            "offset": offset,
                            "sortBy": {"column": "name", "order": "asc"},
                        },
                    )
            except httpx.HTTPError as exc:
                raise StorageError(f"storage request failed ({type(exc).__name__})") from None
            if response.status_code != 200:
                raise StorageError(f"storage answered status {response.status_code}")
            items = response.json()
            if not isinstance(items, list):
                raise StorageError("storage list answered with an unexpected shape")
            names.extend(
                str(item["name"])
                for item in items
                if isinstance(item, dict) and item.get("id") is not None and "name" in item
            )
            if len(items) < limit:
                return sorted(n for n in names if _NAME_RE.fullmatch(n))
            offset += limit
