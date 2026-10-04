from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
DOMAIN = BACKEND / "app" / "domain"
MODULES = sorted(
    f"app.domain.{path.stem}" if path.stem != "__init__" else "app.domain"
    for path in DOMAIN.glob("*.py")
)
FORBIDDEN = ("fastapi", "starlette", "psycopg", "httpx", "uvicorn", "supabase", "sqlalchemy")


def test_domain_modules_exist() -> None:
    assert "app.domain" in MODULES
    assert "app.domain.rate_limit" in MODULES


@pytest.mark.parametrize("module", MODULES)
def test_domain_module_imports_no_framework_or_database_client(module: str) -> None:
    """Import in a fresh interpreter, so transitive imports count too."""
    code = textwrap.dedent(
        f"""
        import importlib, sys
        importlib.import_module({module!r})
        loaded = [name for name in {FORBIDDEN!r} if name in sys.modules]
        if loaded:
            print("forbidden:", ",".join(loaded))
            raise SystemExit(1)
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=BACKEND, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stdout + result.stderr
