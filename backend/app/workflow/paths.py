"""Local build-area layout under ``backend/.content-build/`` (gitignored, contract §1, §10).

Everything that can contain source text is written only below this root.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.workflow.editions import edition_spec

BACKEND_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BUILD_DIR = BACKEND_ROOT / ".content-build"


@dataclass(frozen=True, slots=True)
class BuildPaths:
    """Resolved paths of one build area."""

    root: Path = DEFAULT_BUILD_DIR

    @property
    def raw_root(self) -> Path:
        """Local staging copy of the raw objects: ``<root>/raw/<editionKey>/``."""
        return self.root / "raw"

    def edition_dir(self, edition_key: str) -> Path:
        edition_spec(edition_key)  # rejects unknown keys (no path traversal through the key)
        return self.root / edition_key

    def jobs_file(self, edition_key: str) -> Path:
        return self.edition_dir(edition_key) / "jobs.json"

    def acquisition_report(self, edition_key: str | None = None) -> Path:
        """Per-edition report, or the aggregate ``<root>/acquisition_report.md``."""
        if edition_key is None:
            return self.root / "acquisition_report.md"
        return self.edition_dir(edition_key) / "acquisition_report.md"

    def verification_json(self, edition_key: str) -> Path:
        return self.edition_dir(edition_key) / "verification.json"

    def verification_report(self, edition_key: str) -> Path:
        return self.edition_dir(edition_key) / "verification_report.md"

    def gap_report(self, edition_key: str) -> Path:
        return self.edition_dir(edition_key) / "gap_report.md"
