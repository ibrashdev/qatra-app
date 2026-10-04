"""Helpers for the content-workflow tests (synthetic data only; no network, no secrets)."""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from scripts.content_tools import CliRuntime, main

DATA = Path(__file__).resolve().parents[1] / "data"
QURAN_ED = "quran-hafs-quranenc"
HADITH_ED = "nawawi40-hadeethenc"
# Placeholder words used by every synthetic fixture: they must never reach a report or output.
PLACEHOLDER_WORDS = ("كلمة", "كَلِمَةٌ", "مثال", "مِثَالٌ", "تجريبي", "تَجْرِيبِيٌّ", "تَفْسِيرٌ")


class TickingClock:
    """Deterministic clock: each call is one minute after the previous one."""

    def __init__(self) -> None:
        self._now = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        self._now += timedelta(minutes=1)
        return self._now


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def fixture_copy(name: str, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(DATA / name, destination)
    return destination


def run_cli(
    argv: list[str],
    build_dir: Path,
    *,
    environ: Mapping[str, str] | None = None,
    transport: httpx.BaseTransport | None = None,
    interactive: bool = False,
    clock: Callable[[], datetime] | None = None,
) -> int:
    """Run ``main`` with the build area in ``build_dir`` and an isolated environment."""
    runtime = CliRuntime(
        environ={} if environ is None else environ,
        stdin_isatty=lambda: interactive,
        transport=transport,
        clock=clock or TickingClock(),
    )
    return main([*argv, "--build-dir", str(build_dir)], runtime=runtime)


def quran_args(command: str, *extra: str, bank: int = 1) -> list[str]:
    return [command, "--edition", QURAN_ED, "--bank-version", str(bank), *extra]


def hadith_args(command: str, *extra: str, bank: int = 1) -> list[str]:
    return [command, "--edition", HADITH_ED, "--bank-version", str(bank), *extra]


def all_report_text(build_dir: Path) -> str:
    """Text of every file below the build area EXCEPT the raw objects (reports, job files)."""
    parts: list[str] = []
    for path in sorted(build_dir.rglob("*")):
        if path.is_file() and "raw" not in path.relative_to(build_dir).parts:
            parts.append(path.read_text(encoding="utf-8"))
    return "\n".join(parts)


_LEAK_NEEDLES = ("كلمه", "مثال", "تجريبي", "تفسير", "المعلم", "شرح", "الراوي")


def assert_no_source_text(*texts: str) -> None:
    """Fail if any placeholder word of the synthetic fixtures (our stand-in for source text)
    appears in the given outputs or reports (compared after normalization, so diacritics and
    letter variants cannot hide a leak)."""
    from app.domain.normalization import normalize

    for text in texts:
        haystack = normalize(text)
        for needle in _LEAK_NEEDLES:
            assert needle not in haystack, f"source text leaked: {needle!r}"
