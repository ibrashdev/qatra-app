"""Regenerate the committed synthetic bundles with the real content pipeline.

The bundles are built by ``acquire`` -> ``verify`` -> ``segment`` -> ``build-bank`` ->
``validate`` from the placeholder fixtures in ``tests/data/`` (no source text anywhere):

- ``tests/data/synthetic_bundle.json``: edition ``quran-hafs-quranenc`` (surahs 112-114)
- ``tests/data/synthetic_bundle_hadith.json``: edition ``nawawi40-hadeethenc`` (hadiths 1-4)

Both carry the real edition keys because the CLI accepts only those two, but their content,
titles and labels are synthetic placeholders: they are for tests, memory mode and e2e only and
must never be published.

    uv run python -m scripts.make_synthetic_bundle            # rewrite the committed files
    uv run python -m scripts.make_synthetic_bundle --check    # exit 1 when they are stale
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

if __package__ in (None, ""):  # started as ``python scripts/make_synthetic_bundle.py``
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.workflow.editions import EDITION_HADITH, EDITION_QURAN  # noqa: E402
from scripts.content_tools import CliRuntime  # noqa: E402
from scripts.content_tools import main as content_tools

DATA = Path(__file__).resolve().parent.parent / "tests" / "data"
OUTPUTS = {
    EDITION_QURAN: "synthetic_bundle.json",
    EDITION_HADITH: "synthetic_bundle_hadith.json",
}


def _clock():
    now = datetime(2026, 10, 4, 12, 0, tzinfo=UTC)

    def tick() -> datetime:
        nonlocal now
        now += timedelta(minutes=1)
        return now

    return tick


def build_synthetic_bundles(work: Path) -> dict[str, str]:
    """Run the pipeline for both editions in ``work`` and return ``{file name: bundle text}``."""
    import json

    runtime = CliRuntime(environ={}, stdin_isatty=lambda: False, clock=_clock())
    records = json.loads((DATA / "synthetic_bundle_quran_records.json").read_text("utf-8"))
    oracle = work / "oracle.txt"
    oracle.write_text(
        "\n".join(f"{r['surah']}|{r['ayah']}|{r['text']}" for r in records["records"]) + "\n",
        encoding="utf-8",
    )
    labels = str(DATA / "synthetic_labels.json")
    quran = ["--edition", EDITION_QURAN, "--bank-version", "1", "--build-dir", str(work)]
    hadith = ["--edition", EDITION_HADITH, "--bank-version", "1", "--build-dir", str(work)]
    steps = [
        ["acquire", *quran, "--records", str(DATA / "synthetic_bundle_quran_records.json"),
         "--surahs", "112-114"],
        ["verify", *quran, "--oracle", str(oracle)],
        ["segment", *quran, "--labels", labels],
        ["build-bank", *quran],
        ["validate", *quran],
        ["acquire", *hadith, "--pass", "1", "--records",
         str(DATA / "synthetic_bundle_hadith_pass1.json"), "--forty", "1-4"],
        ["acquire", *hadith, "--pass", "2", "--records",
         str(DATA / "synthetic_bundle_hadith_pass2.json")],
        ["verify", *hadith],
        ["segment", *hadith, "--labels", labels, "--boundaries",
         str(DATA / "synthetic_boundaries.json")],
        ["build-bank", *hadith],
        ["validate", *hadith],
    ]  # fmt: skip
    for step in steps:
        code = content_tools(step, runtime=runtime)
        if code != 0:
            raise SystemExit(f"pipeline step {step[0]} failed with exit code {code}")
    return {
        name: (work / key / "bundle.json").read_text(encoding="utf-8")
        for key, name in OUTPUTS.items()
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="make_synthetic_bundle", description=__doc__)
    parser.add_argument("--check", action="store_true", help="compare, do not write")
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        bundles = build_synthetic_bundles(Path(tmp))
    stale = [name for name, text in bundles.items() if _read(DATA / name) != text]
    if args.check:
        for name in stale:
            print(f"stale: {name}")
        return 1 if stale else 0
    for name, text in bundles.items():
        (DATA / name).write_text(text, encoding="utf-8")
        print(f"written: tests/data/{name} ({len(text)} bytes)")
    return 0


def _read(path: Path) -> str | None:
    return path.read_text(encoding="utf-8") if path.is_file() else None


if __name__ == "__main__":
    raise SystemExit(main())
