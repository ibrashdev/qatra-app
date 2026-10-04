from __future__ import annotations

from pathlib import Path

import pytest

import app.config as config_module
from app.config import Settings, StartupConfigError, load_settings, validate_startup
from app.main import create_app
from tests.support import CONFIG_NAMES, make_settings, production_values

PRODUCTION_REQUIRED = [
    "FRONTEND_ORIGIN",
    "TERMS_VERSION",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "QATRA_SERVER_DB",
    "QATRA_SESSION_KEY",
    "QATRA_SESSION_HMAC_KEY",
    "QATRA_RECOVERY_HMAC_KEY",
    "QATRA_THROTTLE_HMAC_KEY",
]

CONTRACT_NAMES = {
    "APP_ENV",
    "FRONTEND_ORIGIN",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "QATRA_SERVER_DB",
    "QATRA_SESSION_KEY",
    "QATRA_SESSION_HMAC_KEY",
    "QATRA_RECOVERY_HMAC_KEY",
    "QATRA_THROTTLE_HMAC_KEY",
    "TERMS_VERSION",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODELS",
    "QATRA_DATA_BACKEND",
    "QATRA_CONTENT_BUNDLES",
}


def test_settings_names_are_the_contract_names_plus_the_documented_additions() -> None:
    assert set(CONFIG_NAMES) == CONTRACT_NAMES | {
        "APP_VERSION",
        "QATRA_READY_RATE_PER_MIN",
        "QATRA_BODY_LIMIT_BYTES",
    }


def test_env_example_lists_every_name_with_an_empty_value() -> None:
    lines = (Path(__file__).resolve().parent.parent / ".env.example").read_text().splitlines()
    assignments = [line for line in lines if line.strip() and not line.startswith("#")]
    names = [line.partition("=")[0] for line in assignments]
    assert sorted(names) == sorted(CONFIG_NAMES)
    assert all(line.partition("=")[2] == "" for line in assignments)


def test_defaults(clean_env: pytest.MonkeyPatch) -> None:
    settings = make_settings()
    assert settings.QATRA_READY_RATE_PER_MIN == 6
    assert settings.QATRA_BODY_LIMIT_BYTES == 65536
    assert settings.APP_VERSION == "dev"
    assert Settings(_env_file=None).APP_ENV == "development"  # type: ignore[call-arg]
    assert Settings(_env_file=None).QATRA_DATA_BACKEND == "supabase"  # type: ignore[call-arg]


def test_production_requires_every_secret_and_key(clean_env: pytest.MonkeyPatch) -> None:
    settings = Settings(_env_file=None, APP_ENV="production")  # type: ignore[call-arg]
    assert settings.missing_required_for("production") == PRODUCTION_REQUIRED
    with pytest.raises(StartupConfigError) as raised:
        validate_startup(settings)
    for name in PRODUCTION_REQUIRED:
        assert name in str(raised.value)


def test_error_message_lists_names_and_never_values(clean_env: pytest.MonkeyPatch) -> None:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        APP_ENV="production",
        QATRA_SESSION_KEY="SENTINEL-secret-one",
        SUPABASE_SERVICE_ROLE_KEY="SENTINEL-secret-two",
        FRONTEND_ORIGIN="https://sentinel-origin.example",
    )
    missing = settings.missing_required_for("production")
    assert "QATRA_SESSION_KEY" not in missing
    assert "SUPABASE_SERVICE_ROLE_KEY" not in missing
    with pytest.raises(StartupConfigError) as raised:
        validate_startup(settings)
    message = str(raised.value)
    assert "QATRA_SERVER_DB" in message
    assert "SENTINEL" not in message
    assert "sentinel-origin" not in message
    assert "SENTINEL" not in repr(settings)


def test_memory_backend_is_refused_in_production() -> None:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None, **production_values(QATRA_DATA_BACKEND="memory")
    )
    with pytest.raises(StartupConfigError) as raised:
        validate_startup(settings)
    message = str(raised.value)
    assert "QATRA_DATA_BACKEND" in message
    assert "dummy" not in message


def test_complete_production_configuration_is_accepted() -> None:
    settings = Settings(_env_file=None, **production_values())  # type: ignore[call-arg]
    assert settings.missing_required_for("production") == []
    validate_startup(settings)


@pytest.mark.parametrize(
    "origin",
    [
        "http://qatra.example",
        "https://qatra.example/",
        "https://qatra.example/app",
        "qatra.example",
    ],
)
def test_production_origin_must_be_a_bare_https_origin(origin: str) -> None:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None, **production_values(FRONTEND_ORIGIN=origin)
    )
    with pytest.raises(StartupConfigError) as raised:
        validate_startup(settings)
    assert "FRONTEND_ORIGIN" in str(raised.value)
    assert origin not in str(raised.value)


def test_development_with_minimal_env_succeeds(clean_env: pytest.MonkeyPatch) -> None:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        APP_ENV="development",
        FRONTEND_ORIGIN="http://localhost:3000",
        TERMS_VERSION="2026-10-04",
    )
    assert settings.missing_required_for("development") == []
    assert settings.missing_required_for("test") == []
    validate_startup(settings)
    assert create_app(settings) is not None


def test_development_requires_only_origin_and_terms(clean_env: pytest.MonkeyPatch) -> None:
    settings = Settings(_env_file=None, APP_ENV="development")  # type: ignore[call-arg]
    assert settings.missing_required_for("development") == ["FRONTEND_ORIGIN", "TERMS_VERSION"]
    with pytest.raises(StartupConfigError):
        validate_startup(settings)


def test_blank_values_count_as_missing(clean_env: pytest.MonkeyPatch) -> None:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None, APP_ENV="development", FRONTEND_ORIGIN="  ", TERMS_VERSION=""
    )
    assert settings.missing_required_for("development") == ["FRONTEND_ORIGIN", "TERMS_VERSION"]


def test_create_app_refuses_an_invalid_production_configuration() -> None:
    settings = Settings(_env_file=None, APP_ENV="production")  # type: ignore[call-arg]
    with pytest.raises(StartupConfigError):
        create_app(settings)


def test_load_settings_reads_the_process_environment(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("APP_ENV", "development")
    clean_env.setenv("FRONTEND_ORIGIN", "http://localhost:3000")
    clean_env.setenv("TERMS_VERSION", "2026-10-04")
    clean_env.setenv("QATRA_READY_RATE_PER_MIN", "9")
    settings = load_settings()
    assert settings.QATRA_READY_RATE_PER_MIN == 9


def test_dotenv_is_read_in_development_but_never_in_production(
    clean_env: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("FRONTEND_ORIGIN=http://localhost:3000\nTERMS_VERSION=2026-10-04\n")
    clean_env.setattr(config_module, "_DOTENV_PATH", dotenv)

    clean_env.setenv("APP_ENV", "development")
    assert load_settings().FRONTEND_ORIGIN == "http://localhost:3000"

    clean_env.setenv("APP_ENV", "production")
    settings = load_settings()
    assert settings.FRONTEND_ORIGIN is None  # the file was not read
    assert settings.TERMS_VERSION is None


def test_dotenv_cannot_switch_the_environment_to_production(
    clean_env: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text("APP_ENV=production\n")
    clean_env.setattr(config_module, "_DOTENV_PATH", dotenv)
    with pytest.raises(StartupConfigError):
        load_settings()


def test_invalid_values_are_reported_by_name_without_the_value(
    clean_env: pytest.MonkeyPatch,
) -> None:
    clean_env.setenv("QATRA_DATA_BACKEND", "SENTINEL-bad-value")
    clean_env.setenv("QATRA_READY_RATE_PER_MIN", "SENTINEL-not-int")
    with pytest.raises(StartupConfigError) as raised:
        load_settings()
    message = str(raised.value)
    assert "QATRA_DATA_BACKEND" in message
    assert "QATRA_READY_RATE_PER_MIN" in message
    assert "SENTINEL" not in message
    assert raised.value.__cause__ is None
