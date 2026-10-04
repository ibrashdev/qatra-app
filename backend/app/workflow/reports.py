"""Markdown and JSON reports: counts and ids only, never source text (API-spec §5.4).

Written below the gitignored build area: the per-edition ``acquisition_report.md`` plus the
aggregate ``<build>/acquisition_report.md`` (contract §10), ``verification.json``,
``verification_report.md`` and ``gap_report.md``.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from app.workflow.editions import EDITION_KEYS, MCP_SOURCE_URL, EditionScope, edition_spec
from app.workflow.paths import BuildPaths
from app.workflow.results import AcquisitionSnapshot, VerificationOutcome


def _iso(value: datetime | None) -> str:
    return value.isoformat().replace("+00:00", "Z") if value else "-"


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as tmp:
            tmp.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def _scope_text(scope: EditionScope, kind: str) -> str:
    if kind == "quran":
        surahs = scope.surahs
        span = f"surah {surahs[0]}" if len(surahs) == 1 else f"surahs {surahs[0]}-{surahs[-1]}"
        noun = "surah" if len(surahs) == 1 else "surahs"
        return f"{len(surahs)} {noun} ({span}), {scope.ayah_total()} ayat"
    numbers = scope.forty_numbers
    return f"{len(numbers)} hadiths sought (Forty numbers {numbers[0]}-{numbers[-1]})"


def render_acquisition_report(snapshot: AcquisitionSnapshot) -> str:
    spec = edition_spec(snapshot.edition_key)
    records = sum(len(o.record_ids) for o in snapshot.objects)
    lines = [
        f"# Acquisition report: {snapshot.edition_key} (bank version {snapshot.bank_version})",
        "",
        f"Generated {_iso(snapshot.generated_at)}. Source: Islamic Content MCP ({MCP_SOURCE_URL}), "
        f"tool `{spec.tool_name}`. This report holds counts and ids only; no source text.",
        "",
        "| Item | Value |",
        "|---|---|",
        f"| Scope | {_scope_text(snapshot.scope, spec.kind)} |",
        f"| Status | {'complete' if snapshot.complete else 'INCOMPLETE'} |",
        f"| Raw objects | {len(snapshot.objects)} (created {snapshot.created}, "
        f"unchanged {snapshot.unchanged} in this run) |",
        f"| Records | {records} |",
        f"| source rawSha256 | `{snapshot.source_raw_sha256 or '-'}` |",
        f"| source retrievedAt | {_iso(snapshot.source_retrieved_at)} |",
        f"| source acquisition | {snapshot.source_acquisition or '-'} |",
    ]
    if spec.kind == "quran":
        missing = ", ".join(str(s) for s in snapshot.missing_surahs) or "none"
        lines.append(f"| Missing surahs | {missing} |")
    else:
        passes = ", ".join(str(p) for p in snapshot.passes_present) or "none"
        lines.append(f"| Passes present | {passes} (two independent passes are required) |")
    lines += [
        "",
        "## Raw objects",
        "",
        "| Object | Pass | Records | Ids | rawSha256 | retrievedAt |",
    ]
    lines.append("|---|---|---|---|---|---|")
    for obj in snapshot.objects:
        ids = (
            ", ".join(obj.record_ids)
            if len(obj.record_ids) <= 6
            else (f"{obj.record_ids[0]} .. {obj.record_ids[-1]}")
        )
        lines.append(
            f"| {obj.name} | {obj.pass_number or '-'} | {len(obj.record_ids)} | {ids} | "
            f"`{obj.raw_sha256[:16]}...` | {_iso(obj.retrieved_at)} |"
        )
    return "\n".join(lines) + "\n"


def write_acquisition_report(paths: BuildPaths, snapshot: AcquisitionSnapshot) -> Path:
    """Write the per-edition report and refresh the aggregate ``acquisition_report.md``."""
    per_edition = paths.acquisition_report(snapshot.edition_key)
    _write_atomic(per_edition, render_acquisition_report(snapshot))
    sections = []
    for key in EDITION_KEYS:
        candidate = paths.acquisition_report(key)
        if candidate.is_file():
            sections.append(candidate.read_text(encoding="utf-8").rstrip("\n"))
    _write_atomic(paths.acquisition_report(), "\n\n---\n\n".join(sections) + "\n")
    return per_edition


def render_gap_report(outcome: VerificationOutcome) -> str:
    lines = [
        f"# Gap report: {outcome.edition_key} (bank version {outcome.bank_version})",
        "",
        f"Generated {_iso(outcome.generated_at)}. Hadiths without a verifiable record in the "
        "Forty's own wording are left out of the build and never filled from memory, another "
        "wording or another source (D68). Ids only.",
        "",
        f"Gaps: {len(outcome.gaps)}",
        "",
    ]
    if outcome.gaps:
        lines += ["| Forty number | Reason |", "|---|---|"]
        lines += [f"| {gap.forty_number} | {gap.reason} |" for gap in outcome.gaps]
    return "\n".join(lines) + "\n"


def render_verification_report(outcome: VerificationOutcome) -> str:
    by_method = Counter((u.method, u.result) for u in outcome.units)
    lines = [
        f"# Verification report: {outcome.edition_key} (bank version {outcome.bank_version})",
        "",
        f"Generated {_iso(outcome.generated_at)}. Counts and unit refs only; no source text.",
        "",
        f"Result: **{outcome.source.result}**. Method: `{outcome.source.method}`.",
        "",
        outcome.source.details,
        "",
        "| Method | Result | Units |",
        "|---|---|---|",
    ]
    lines += [f"| {m} | {r} | {n} |" for (m, r), n in sorted(by_method.items())]
    failed = outcome.failed_refs()
    lines += ["", f"Blocked units: {len(failed)}"]
    if failed:
        lines += ["", "| Unit | Method | Details |", "|---|---|---|"]
        lines += [
            f"| {u.unit_ref} | {u.method} | {u.details} |"
            for u in outcome.units
            if u.result == "failed"
        ]
    lines += [
        "",
        f"Documented gaps: {len(outcome.gaps)}",
        f"Flagged for review: {len(outcome.suspected)}",
    ]
    if outcome.suspected:
        lines += ["", "| Unit | Kind | Details |", "|---|---|---|"]
        lines += [f"| {s['unit']} | {s['kind']} | {s['details']} |" for s in outcome.suspected]
    return "\n".join(lines) + "\n"


def verification_json(outcome: VerificationOutcome) -> dict[str, Any]:
    return {
        "editionKey": outcome.edition_key,
        "bankVersion": outcome.bank_version,
        "scope": outcome.scope.to_dict(),
        "generatedAt": _iso(outcome.generated_at),
        "source": outcome.source.model_dump(mode="json", exclude={"unit_ref"}),
        "units": [
            {"unitRef": u.unit_ref, "method": u.method, "result": u.result, "details": u.details}
            for u in outcome.units
        ],
        "gaps": [gap.to_dict() for gap in outcome.gaps],
        "suspectedErrors": outcome.suspected,
        "counts": outcome.counts,
    }


def write_verification_files(paths: BuildPaths, outcome: VerificationOutcome) -> list[Path]:
    key = outcome.edition_key
    written = [paths.verification_json(key), paths.verification_report(key)]
    _write_atomic(
        written[0],
        json.dumps(verification_json(outcome), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )
    _write_atomic(written[1], render_verification_report(outcome))
    if edition_spec(key).kind == "hadith":
        written.append(paths.gap_report(key))
        _write_atomic(written[2], render_gap_report(outcome))
    return written


def render_edition_report(
    bundle: Mapping[str, Any],
    *,
    validation: Mapping[str, Any] | None,
    skipped: Sequence[Mapping[str, str]],
    generated_at: datetime | None,
) -> str:
    """``report.md`` of a built edition: counts, validation, provenance, discrepancies. Counts,
    ids and codes only; never source text."""
    units = bundle["units"]
    tokens = sum(len(u["tokens"]) for u in units)
    words = sum(1 for u in units for t in u["tokens"] if t["k"] == "word")
    by_path = Counter(p["path"] for p in bundle["passages"])
    parts = sum(len(p["parts"]) for p in bundle["passages"])
    types = Counter(
        q["type"] + (f"/{q['variant']}" if q["variant"] else "") for q in bundle["questions"]
    )
    source, edition = bundle["source"], bundle["edition"]
    verification = source["verification"]
    path_text = ", ".join(f"{k} {v}" for k, v in sorted(by_path.items())) or "-"
    lines = [
        f"# Edition report: {bundle['editionKey']} (bank version {bundle['bankVersion']})",
        "",
        f"Generated {_iso(generated_at)}. Counts, ids and codes only; no source text.",
        "",
        "## Counts",
        "",
        "| Item | Value |",
        "|---|---|",
        f"| Sections | {len(bundle['sections'])} |",
        f"| Units | {len(units)} |",
        f"| Tokens (words) | {tokens} ({words}) |",
        f"| Passages | {len(bundle['passages'])} ({path_text}) |",
        f"| Parts | {parts} |",
        f"| Lessons | {len(bundle['lessons'])} |",
        f"| Questions | {len(bundle['questions'])} |",
    ]
    lines += [f"| Questions {name} | {count} |" for name, count in sorted(types.items())]
    lines += [
        "",
        "## Provenance",
        "",
        "| Item | Value |",
        "|---|---|",
        f"| Source | {source['title']} via {source['provider']} |",
        f"| Tool / acquisition | {source['toolName']} / {source['acquisition']} |",
        f"| rawSha256 | `{source['rawSha256']}` |",
        f"| retrievedAt | {source['retrievedAt']} |",
        f"| Verification | {verification['result']} ({verification['method']}) |",
        f"| contentHash | `{edition['contentHash']}` |",
        f"| Rights status | {source['rightsStatus']} |",
        "",
        "## Validation",
        "",
    ]
    if validation is None:
        lines.append("Not run yet.")
    else:
        lines.append(f"Result: **{validation['result']}**. Issues: {len(validation['issues'])}.")
        if validation["issues"]:
            lines += ["", "| Code | Ref |", "|---|---|"]
            lines += [f"| {i['code']} | {i['ref']} |" for i in validation["issues"][:200]]
        lines += ["", "| Check | Value |", "|---|---|"]
        lines += [f"| {k} | {v} |" for k, v in sorted(validation["info"].items())]
    record = edition["reviewRecord"]
    lines += [
        "",
        "## Discrepancies",
        "",
        f"Known gaps: {len(record['knownGaps'])}. Suspected errors flagged for review: "
        f"{len(record['suspectedErrors'])}. Items the bank could not build: {len(skipped)}.",
    ]
    if record["knownGaps"]:
        lines += ["", "| Forty number | Reason |", "|---|---|"]
        lines += [f"| {g['fortyNumber']} | {g['reason']} |" for g in record["knownGaps"]]
    if record["suspectedErrors"]:
        lines += ["", "| Unit | Kind | Details |", "|---|---|---|"]
        lines += [
            f"| {s['unit']} | {s['kind']} | {s['details']} |" for s in record["suspectedErrors"]
        ]
    if skipped:
        lines += ["", "| Kind | Ref |", "|---|---|"]
        lines += [f"| {s['kind']} | {s['ref']} |" for s in skipped]
    return "\n".join(lines) + "\n"


def write_text(path: Path, text: str) -> None:
    """Atomic write used for ``bundle.json``, ``publish.sql`` and ``report.md``."""
    _write_atomic(path, text)
