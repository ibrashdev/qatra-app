"""Raw storage: local staging, the identical-object/different-hash rule, the Supabase Storage
adapter (httpx.MockTransport only: no live project) and the CLI settings."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.workflow.errors import (
    InputError,
    NotConfiguredError,
    ObjectConflictError,
    ObjectNotFoundError,
    StorageError,
)
from app.workflow.models import sha256_hex
from app.workflow.settings import (
    SupabaseConfig,
    load_supabase_config,
    resolve_data_backend,
)
from app.workflow.storage import BUCKET, LocalStagingStorage, SupabaseRawStorage

EDITION = "quran-hafs-quranenc"
SECRET = "service-role-secret-do-not-leak"
CONFIG = SupabaseConfig(url="https://project.example", service_role_key=SECRET)


# --- local staging -------------------------------------------------------------------------


def test_local_put_exists_sha_read_list(tmp_path: Path) -> None:
    storage = LocalStagingStorage(tmp_path / "raw")
    assert storage.list_raw(EDITION) == []
    assert not storage.exists(EDITION, "a.json")
    assert storage.sha256(EDITION, "a.json") is None
    assert storage.put_raw(EDITION, "a.json", b"one") == "created"
    assert storage.put_raw(EDITION, "b.json", b"two") == "created"
    assert storage.exists(EDITION, "a.json")
    assert storage.sha256(EDITION, "a.json") == sha256_hex(b"one")
    assert storage.read_raw(EDITION, "b.json") == b"two"
    assert storage.list_raw(EDITION) == ["a.json", "b.json"]
    assert (tmp_path / "raw" / EDITION / "a.json").read_bytes() == b"one"


def test_local_put_is_idempotent_and_refuses_a_different_hash(tmp_path: Path) -> None:
    storage = LocalStagingStorage(tmp_path)
    storage.put_raw(EDITION, "a.json", b"one")
    assert storage.put_raw(EDITION, "a.json", b"one") == "unchanged"
    with pytest.raises(ObjectConflictError, match="new bank_version"):
        storage.put_raw(EDITION, "a.json", b"changed")
    assert storage.read_raw(EDITION, "a.json") == b"one"  # untouched
    assert sorted(p.name for p in (tmp_path / EDITION).iterdir()) == ["a.json"]  # no temp leftovers


def test_local_read_of_a_missing_object(tmp_path: Path) -> None:
    with pytest.raises(ObjectNotFoundError):
        LocalStagingStorage(tmp_path).read_raw(EDITION, "missing.json")


@pytest.mark.parametrize("name", ["../x.json", "a/b.json", "", ".hidden", "a..b", "x" * 200, "a b"])
def test_local_rejects_unsafe_names(tmp_path: Path, name: str) -> None:
    storage = LocalStagingStorage(tmp_path)
    with pytest.raises(InputError):
        storage.put_raw(EDITION, name, b"x")
    assert not any(tmp_path.rglob("*.json"))


def test_local_rejects_unknown_editions(tmp_path: Path) -> None:
    with pytest.raises(InputError):
        LocalStagingStorage(tmp_path).put_raw("../escape", "a.json", b"x")
    with pytest.raises(InputError):
        LocalStagingStorage(tmp_path).list_raw("other-edition")


# --- Supabase adapter ----------------------------------------------------------------------


class FakeBucket:
    """A tiny in-memory Storage REST API."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.requests: list[httpx.Request] = []
        self.missing_status = 404

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        prefix = "/storage/v1/object/"
        if request.method == "POST" and path == f"{prefix}list/{BUCKET}":
            body = json.loads(request.content)
            base = body["prefix"] + "/"
            names = sorted(k[len(base) :] for k in self.objects if k.startswith(base))
            page = names[body["offset"] : body["offset"] + body["limit"]]
            return httpx.Response(
                200,
                json=[{"name": n, "id": f"id-{n}"} for n in page]
                + [{"name": "folder", "id": None}][: 1 if body["offset"] == 0 else 0],
            )
        key = path[len(prefix) :]
        assert key.startswith(f"{BUCKET}/")
        key = key[len(BUCKET) + 1 :]
        if request.method == "GET":
            if key in self.objects:
                return httpx.Response(200, content=self.objects[key])
            if self.missing_status == 400:
                return httpx.Response(400, json={"statusCode": "404", "error": "not_found"})
            return httpx.Response(404, json={"error": "not_found"})
        if request.method == "POST":
            if key in self.objects:
                return httpx.Response(409, json={"error": "Duplicate"})
            self.objects[key] = request.content
            return httpx.Response(200, json={"Key": f"{BUCKET}/{key}"})
        return httpx.Response(405)


def storage_with(bucket: FakeBucket) -> SupabaseRawStorage:
    return SupabaseRawStorage(CONFIG, transport=httpx.MockTransport(bucket))


def test_supabase_storage_needs_both_variables() -> None:
    with pytest.raises(NotConfiguredError):
        SupabaseRawStorage(None)


def test_supabase_put_creates_then_is_idempotent_then_refuses_a_different_hash() -> None:
    bucket = FakeBucket()
    storage = storage_with(bucket)
    assert storage.put_raw(EDITION, "surah-112.json", b"one") == "created"
    assert bucket.objects[f"{EDITION}/raw/surah-112.json"] == b"one"
    posts = [r for r in bucket.requests if r.method == "POST"]
    assert len(posts) == 1
    post = posts[0]
    assert post.url.path == f"/storage/v1/object/{BUCKET}/{EDITION}/raw/surah-112.json"
    assert post.headers["authorization"] == f"Bearer {SECRET}"
    assert post.headers["apikey"] == SECRET
    assert post.headers["x-upsert"] == "false"
    assert post.headers["content-type"] == "application/json"
    assert post.content == b"one"

    assert storage.put_raw(EDITION, "surah-112.json", b"one") == "unchanged"
    assert len([r for r in bucket.requests if r.method == "POST"]) == 1  # no second upload
    with pytest.raises(ObjectConflictError):
        storage.put_raw(EDITION, "surah-112.json", b"different")
    assert bucket.objects[f"{EDITION}/raw/surah-112.json"] == b"one"


def test_supabase_exists_sha256_read() -> None:
    bucket = FakeBucket()
    storage = storage_with(bucket)
    assert not storage.exists(EDITION, "a.json")
    assert storage.sha256(EDITION, "a.json") is None
    with pytest.raises(ObjectNotFoundError):
        storage.read_raw(EDITION, "a.json")
    storage.put_raw(EDITION, "a.json", b"data")
    assert storage.exists(EDITION, "a.json")
    assert storage.sha256(EDITION, "a.json") == sha256_hex(b"data")
    assert storage.read_raw(EDITION, "a.json") == b"data"


def test_supabase_treats_the_legacy_400_not_found_answer_as_missing() -> None:
    bucket = FakeBucket()
    bucket.missing_status = 400
    assert not storage_with(bucket).exists(EDITION, "a.json")


def test_supabase_list_skips_folders_and_paginates() -> None:
    bucket = FakeBucket()
    for index in range(130):
        bucket.objects[f"{EDITION}/raw/obj-{index:03d}.json"] = b"x"
    bucket.objects["other-edition/raw/zzz.json"] = b"x"
    names = storage_with(bucket).list_raw(EDITION)
    assert len(names) == 130 and names[0] == "obj-000.json" and "folder" not in names
    lists = [
        json.loads(r.content) for r in bucket.requests if r.url.path.endswith(f"list/{BUCKET}")
    ]
    assert [item["offset"] for item in lists] == [0, 100]
    assert all(item["prefix"] == f"{EDITION}/raw" for item in lists)


@pytest.mark.parametrize("status", [401, 403, 500])
def test_supabase_errors_name_the_status_but_never_the_key_or_body(status: int) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text=f"body mentions {SECRET}")

    storage = SupabaseRawStorage(CONFIG, transport=httpx.MockTransport(handler))
    with pytest.raises(StorageError) as error:
        storage.exists(EDITION, "a.json")
    assert str(status) in str(error.value)
    assert SECRET not in str(error.value)


def test_supabase_network_failure_is_a_storage_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"cannot connect with {SECRET}", request=request)

    storage = SupabaseRawStorage(CONFIG, transport=httpx.MockTransport(handler))
    with pytest.raises(StorageError) as error:
        storage.put_raw(EDITION, "a.json", b"x")
    assert SECRET not in str(error.value) and "ConnectError" in str(error.value)


def test_supabase_rejects_unsafe_names_before_any_request() -> None:
    bucket = FakeBucket()
    with pytest.raises(InputError):
        storage_with(bucket).put_raw(EDITION, "../x", b"x")
    assert bucket.requests == []


def test_supabase_config_repr_hides_the_key() -> None:
    assert SECRET not in repr(CONFIG)
    assert "project.example" in repr(CONFIG)


# --- settings ------------------------------------------------------------------------------


def test_supabase_config_needs_both_variables() -> None:
    assert load_supabase_config({}) is None
    assert load_supabase_config({"SUPABASE_URL": "https://p.example"}) is None
    assert load_supabase_config({"SUPABASE_SERVICE_ROLE_KEY": "k"}) is None
    assert (
        load_supabase_config(
            {"SUPABASE_URL": "https://p.example", "SUPABASE_SERVICE_ROLE_KEY": " "}
        )
        is None
    )
    config = load_supabase_config(
        {"SUPABASE_URL": "https://p.example/", "SUPABASE_SERVICE_ROLE_KEY": "k"}
    )
    assert config == SupabaseConfig(url="https://p.example", service_role_key="k")


@pytest.mark.parametrize(
    "url",
    [
        "http://p.example",
        "https://u:p@p.example",
        "https://p.example/path",
        "https://p.example?x=1",
        "ftp://p.example",
    ],
)
def test_supabase_url_must_be_a_bare_https_project_url(url: str) -> None:
    with pytest.raises(NotConfiguredError) as error:
        load_supabase_config({"SUPABASE_URL": url, "SUPABASE_SERVICE_ROLE_KEY": "k"})
    assert url not in str(error.value)


def test_localhost_may_use_plain_http() -> None:
    config = load_supabase_config(
        {"SUPABASE_URL": "http://127.0.0.1:54321", "SUPABASE_SERVICE_ROLE_KEY": "k"}
    )
    assert config is not None and config.url == "http://127.0.0.1:54321"


def test_data_backend_resolution() -> None:
    assert resolve_data_backend({}) == "memory"
    assert resolve_data_backend({"QATRA_DATA_BACKEND": "supabase"}) == "supabase"
    assert resolve_data_backend({"QATRA_DATA_BACKEND": "MEMORY"}) == "memory"
    assert resolve_data_backend({"QATRA_DATA_BACKEND": "nonsense"}) == "memory"


def test_dotenv_file_is_read_when_no_environment_is_injected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "QATRA_DATA_BACKEND"):
        monkeypatch.delenv(name, raising=False)
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "SUPABASE_URL=https://dotenv.example\nSUPABASE_SERVICE_ROLE_KEY=dotenv-key\n"
        "QATRA_DATA_BACKEND=supabase\nUNRELATED=1\n",
        encoding="utf-8",
    )
    config = load_supabase_config(dotenv_path=dotenv)
    assert config == SupabaseConfig(url="https://dotenv.example", service_role_key="dotenv-key")
    assert resolve_data_backend(dotenv_path=dotenv) == "supabase"
    assert load_supabase_config(dotenv_path=tmp_path / "missing.env") is None
    monkeypatch.setenv("SUPABASE_URL", "https://process.example")
    assert load_supabase_config(dotenv_path=dotenv) is not None
    loaded = load_supabase_config(dotenv_path=dotenv)
    assert loaded is not None and loaded.url == "https://process.example"  # process env wins
