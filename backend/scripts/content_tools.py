"""Operator CLI of the content workflow (API-spec §5, Programming-guide §5, B7).

Run from ``backend/``::

    uv run python -m scripts.content_tools <command> --edition <key> --bank-version <N> [...]
    uv run python scripts/content_tools.py <command> ...        # equivalent

Commands: ``acquire``, ``verify``, ``segment``, ``propose-questions``, ``build-bank``,
``validate``, ``approve``, ``publish``, ``withdraw``, ``archive``, ``delete-unused-draft``. B7
implemented ``acquire`` and ``verify``; B8 added ``segment``, ``build-bank`` and ``validate``;
``approve`` and ``publish`` are implemented below. ``propose-questions`` (D90) is an optional step
between ``segment`` and ``build-bank``: a free model picks the question words, the program checks
them, and the owner reads ``question-proposals.md`` before ``approve`` (it writes no job row).
``withdraw``, ``archive`` and ``delete-unused-draft`` are registered,
check their preconditions through ``app.domain.content_policy`` and then exit with code 6 and
the message "not implemented in B7 (B8/C6)" (C6 implements them).

``verify --source-only-decision D83`` accepts, for exactly surah 112 and Forty hadith 1 at bank
version 1, two independent HTTP acquisitions from the service in place of the oracle and the
skeleton (no other source is fetched). ``segment``, ``build-bank`` and ``validate`` follow the
scope recorded by ``acquire``. ``approve`` records the owner's approval only from explicit
inputs (the owner's verbatim words, their source and time, the reviewer, the scope of the review
and a note) and refuses when any is missing or empty. ``publish --sql-out PATH`` writes ONE
transactional SQL file below the build directory and applies nothing.

Common options: ``--edition {quran-hafs-quranenc,nawawi40-hadeethenc}``, ``--bank-version N``,
``--build-dir DIR`` (default ``backend/.content-build``, gitignored) and
``--data-backend {memory,supabase}`` (default: ``QATRA_DATA_BACKEND`` if set, else ``memory``;
memory keeps jobs and raw objects in the local build area, ``supabase`` needs
``SUPABASE_URL`` and ``SUPABASE_SERVICE_ROLE_KEY`` and is not available in B7).

Exit codes (API-spec §5.4 leaves the values open, [O-26]):

====  ==================================================================================
0     success (including ``acquire`` stored and still waiting for more input)
1     unexpected internal error (only the exception type is printed)
2     usage error or an invalid input file (nothing was stored)
3     precondition, step order or refused overwrite (policy refusal, hash conflict, scope)
4     verification or validation failed (units blocked, issues found), or a stored object
      fails its integrity check
5     not configured: Supabase variables missing, or a Supabase repository not in B7
6     not implemented in B7 (B8/C6)
7     source host unreachable or MCP protocol/layout error
====  ==================================================================================

Output: counts and ids only. Source text and secrets are never printed. Reports and raw
objects are written below the gitignored build directory only.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from pydantic import SecretStr

if __package__ in (None, ""):  # started as ``python scripts/content_tools.py``
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Settings, StartupConfigError, load_settings  # noqa: E402
from app.domain.content_policy import (  # noqa: E402
    ContentPolicyError,
    PublishRefusedError,
    assert_approvable,
    assert_delete_unused_draft_allowed,
    assert_publishable,
    assert_step_allowed,
)
from app.providers.openrouter import build_default_provider  # noqa: E402
from app.workflow import source_only  # noqa: E402
from app.workflow.approval import (  # noqa: E402
    is_complete_approval,
    make_approve_handler,
    parse_approval_input,
    read_owner_words_file,
)
from app.workflow.content_management import (  # noqa: E402
    FileSource,
    HttpSource,
    load_id_map,
    load_records_file,
    make_acquire_handler,
    make_verify_handler,
)
from app.workflow.edition_build import (  # noqa: E402
    make_build_bank_handler,
    make_segment_handler,
    make_validate_handler,
    proposals_report_path,
    run_propose_questions,
)
from app.workflow.editions import (  # noqa: E402
    EDITION_KEYS,
    FORTY_COUNT,
    QURAN_FIRST_SURAH,
    QURAN_LAST_SURAH,
    EditionScope,
    EditionSpec,
    edition_spec,
    parse_number_spec,
)
from app.workflow.errors import (  # noqa: E402
    ExitCode,
    InputError,
    NotConfiguredError,
    StepNotImplementedError,
    WorkflowError,
)
from app.workflow.jobs import (  # noqa: E402
    JobRepository,
    LocalJobRepository,
    SupabaseJobRepository,
    completed_steps,
)
from app.workflow.license_record import build_license_record  # noqa: E402
from app.workflow.mcp_client import McpJsonRpcClient  # noqa: E402
from app.workflow.models import ContentJob, derive_edition_state  # noqa: E402
from app.workflow.paths import DEFAULT_BUILD_DIR, BuildPaths  # noqa: E402
from app.workflow.publication import (  # noqa: E402
    build_final_publication,
    resolve_sql_out,
    write_sql_file,
)
from app.workflow.question_proposals import (  # noqa: E402
    DEFAULT_MAX_REQUESTS,
    DEFAULT_PAUSE_SEC,
    DEFAULT_TIMEOUT_SEC,
    ProposalProvider,
)
from app.workflow.runner import JobResult, run_content_job  # noqa: E402
from app.workflow.settings import (  # noqa: E402
    SupabaseConfig,
    load_supabase_config,
    resolve_data_backend,
)
from app.workflow.storage import (  # noqa: E402
    LocalStagingStorage,
    RawStorage,
    SupabaseRawStorage,
)

COMMANDS = (
    "acquire",
    "verify",
    "segment",
    "propose-questions",
    "build-bank",
    "validate",
    "approve",
    "publish",
    "withdraw",
    "archive",
    "delete-unused-draft",
)
STEP_OF_COMMAND = {
    "withdraw": "withdrawn",
    "archive": "archived",
}
NOT_IMPLEMENTED = "not implemented in B7 (B8/C6)"


@dataclass(slots=True)
class CliRuntime:
    """Injection points (tests); the defaults are the real process environment, terminal,
    network and clock. ``interactive()`` is kept for callers but no command uses it any more:
    ``approve`` takes the owner's recorded words, not a terminal confirmation."""

    environ: Mapping[str, str] | None = None
    stdin_isatty: Callable[[], bool] | None = None
    transport: httpx.BaseTransport | None = None
    clock: Callable[[], datetime] | None = None
    # ``propose-questions`` uses it in place of the OpenRouter provider (tests only).
    proposal_provider: ProposalProvider | None = None

    def now(self) -> datetime:
        return self.clock() if self.clock else datetime.now(UTC)

    def interactive(self) -> bool:
        if self.stdin_isatty is not None:
            return self.stdin_isatty()
        return sys.stdin.isatty() and sys.stdout.isatty()


# --- argument parsing ----------------------------------------------------------------------


def _bank_version(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be an integer") from None
    if number < 1:
        raise argparse.ArgumentTypeError("must be 1 or greater")
    return number


def _non_negative_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be an integer") from None
    if number < 0:
        raise argparse.ArgumentTypeError("must be 0 or greater")
    return number


def _seconds(value: str) -> float:
    try:
        number = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a number of seconds") from None
    if not 0 <= number <= 3600:
        raise argparse.ArgumentTypeError("must be between 0 and 3600")
    return number


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--edition", required=True, choices=EDITION_KEYS, help="edition key")
    common.add_argument(
        "--bank-version",
        required=True,
        type=_bank_version,
        metavar="N",
        help="bank version (1 first)",
    )
    common.add_argument(
        "--build-dir", type=Path, default=DEFAULT_BUILD_DIR, help="local build area (gitignored)"
    )
    common.add_argument(
        "--data-backend", choices=("memory", "supabase"), default=None, help="default: memory"
    )

    parser = argparse.ArgumentParser(
        prog="content_tools",
        description="Qatra content workflow operator CLI. Prints counts and ids only.",
        epilog="Exit codes: 0 ok, 1 unexpected, 2 usage/input, 3 precondition, 4 verification "
        "failed, 5 not configured, 6 not implemented in B7, 7 source unreachable.",
    )
    sub = parser.add_subparsers(dest="command", required=True, metavar="command")

    acquire = sub.add_parser(
        "acquire", parents=[common], help="acquire raw records (step acquired)"
    )
    origin = acquire.add_mutually_exclusive_group(required=True)
    origin.add_argument(
        "--records", type=Path, help="records file captured through the MCP connector"
    )
    origin.add_argument(
        "--http", action="store_true", help="fetch over MCP JSON-RPC (host must be reachable)"
    )
    acquire.add_argument(
        "--pass", dest="pass_number", type=int, choices=(1, 2), help="hadith pass (1 or 2)"
    )
    acquire.add_argument("--surahs", help="Quran scope, e.g. 112 or 78-114 (default 78-114)")
    acquire.add_argument("--forty", help="hadith scope, e.g. 1,3 or 1-42 (default 1-42)")
    acquire.add_argument("--id-map", type=Path, help="JSON {fortyNumber: hadeethencId} for --http")

    verify = sub.add_parser(
        "verify", parents=[common], help="verbatim verification (step verified)"
    )
    verify.add_argument("--oracle", type=Path, help="Quran oracle file 'surah|ayah|text' per line")
    verify.add_argument("--skeleton", type=Path, help="hadith reference file 'fortyNumber|text'")
    verify.add_argument(
        "--http-recheck", action="store_true", help="re-fetch over HTTP, diff bytes"
    )
    verify.add_argument(
        "--source-only-decision",
        choices=(source_only.DECISION_ID,),
        help="D83: two HTTP acquisitions from the service replace --oracle and --skeleton "
        "(surah 112 and hadith 1, bank version 1 only; the Quran also needs --http-recheck)",
    )

    segment = sub.add_parser(
        "segment", parents=[common], help="units, passages and parts (step segmented)"
    )
    segment.add_argument("--labels", type=Path, help="edition labels file (default: packaged)")
    segment.add_argument(
        "--boundaries", type=Path, help="hadith matn/sanad boundaries file (default: packaged)"
    )
    propose = sub.add_parser(
        "propose-questions",
        parents=[common],
        help="a free model proposes the question words; the program checks them (D90); read "
        "question-proposals.md before approve; needs segment, writes no job row",
    )
    propose.add_argument(
        "--max-requests",
        type=_non_negative_int,
        default=DEFAULT_MAX_REQUESTS,
        metavar="N",
        help=f"most requests this run (default {DEFAULT_MAX_REQUESTS}; also capped by "
        "QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY, an allowance shared with the live app)",
    )
    propose.add_argument(
        "--timeout",
        type=_seconds,
        default=DEFAULT_TIMEOUT_SEC,
        metavar="S",
        help=f"seconds per request (default {DEFAULT_TIMEOUT_SEC:g})",
    )
    propose.add_argument(
        "--pause",
        type=_seconds,
        default=DEFAULT_PAUSE_SEC,
        metavar="S",
        help=f"seconds between requests (default {DEFAULT_PAUSE_SEC:g}, for 20 requests a minute)",
    )
    propose.add_argument(
        "--refresh", action="store_true", help="ask again for passages that already have a proposal"
    )
    propose.add_argument(
        "--dry-run", action="store_true", help="print the plan and send nothing (no key needed)"
    )
    sub.add_parser("build-bank", parents=[common], help="lessons and questions (step bank_built)")
    sub.add_parser("validate", parents=[common], help="fail-closed validation (step validated)")
    for name, text in (
        ("archive", "hide a published edition from new selection (C6)"),
        ("delete-unused-draft", "delete an unused draft (C6)"),
    ):
        sub.add_parser(name, parents=[common], help=f"not implemented in B7: {text}")
    approve = sub.add_parser(
        "approve",
        parents=[common],
        help="record the owner's approval from explicit inputs (nothing is inferred)",
    )
    approve.add_argument("--reviewer", required=True, help="reviewer identity as recorded")
    approve.add_argument("--review-scope", required=True, help="scope of the review actually done")
    approve.add_argument("--note", required=True, help="notes")
    words = approve.add_mutually_exclusive_group(required=True)
    words.add_argument("--owner-words", help="the owner's words, verbatim")
    words.add_argument(
        "--owner-words-file", type=Path, help="UTF-8 file holding the owner's words, verbatim"
    )
    approve.add_argument("--source", required=True, help="session URL where the owner wrote them")
    approve.add_argument(
        "--at", required=True, help="time of the owner's words, ISO 8601 with a time zone"
    )
    publish = sub.add_parser(
        "publish",
        parents=[common],
        help="write ONE transactional SQL file that publishes the approved edition (applies "
        "nothing)",
    )
    publish.add_argument(
        "--sql-out", required=True, type=Path, help="output file below the build directory"
    )
    withdraw = sub.add_parser(
        "withdraw", parents=[common], help="withdraw a published edition (not implemented in B7)"
    )
    withdraw.add_argument(
        "--reason", required=True, choices=("transmission", "rights", "accreditation")
    )
    withdraw.add_argument("--note", default="", help="notes")
    return parser


# --- helpers -------------------------------------------------------------------------------


def _scope_from_args(spec: EditionSpec, args: argparse.Namespace) -> EditionScope | None:
    if spec.kind == "quran":
        if args.forty:
            raise InputError("--forty applies to the hadith edition only")
        if args.surahs:
            return EditionScope(
                surahs=parse_number_spec(
                    args.surahs, low=QURAN_FIRST_SURAH, high=QURAN_LAST_SURAH, label="--surahs"
                )
            )
        return None
    if args.surahs:
        raise InputError("--surahs applies to the Quran edition only")
    if args.forty:
        return EditionScope(
            forty_numbers=parse_number_spec(args.forty, low=1, high=FORTY_COUNT, label="--forty")
        )
    return None


@dataclass(slots=True)
class _Context:
    args: argparse.Namespace
    rt: CliRuntime
    paths: BuildPaths
    backend: str
    config: SupabaseConfig | None

    @property
    def edition(self) -> str:
        return self.args.edition

    @property
    def bank_version(self) -> int:
        return self.args.bank_version

    def jobs(self) -> JobRepository:
        if self.backend == "supabase":
            return SupabaseJobRepository(self.config)  # not available in B7: raises
        return LocalJobRepository(self.paths)


def _format(command: str, ctx: _Context, result: JobResult, extra: str = "") -> str:
    counts = " ".join(f"{key}={value}" for key, value in result.counts.items())
    pieces = [
        command,
        ctx.edition,
        f"bank_version={ctx.bank_version}",
        f"status={result.status}",
        f"changed={'yes' if result.changed else 'no'}",
        counts,
        extra,
    ]
    return " ".join(p for p in pieces if p)


# --- commands ------------------------------------------------------------------------------


def _cmd_acquire(ctx: _Context) -> int:
    args = ctx.args
    spec = edition_spec(ctx.edition)
    scope = _scope_from_args(spec, args)
    if spec.kind == "hadith" and args.pass_number is None:
        raise InputError("the hadith edition needs --pass 1 or --pass 2 (two independent passes)")
    if spec.kind == "quran" and args.pass_number is not None:
        raise InputError("--pass applies to the hadith edition only")
    if args.records is not None and args.id_map is not None:
        raise InputError("--id-map applies to --http only")

    storages: list[RawStorage] = [LocalStagingStorage(ctx.paths.raw_root)]
    if ctx.backend == "supabase":
        storages.insert(0, SupabaseRawStorage(ctx.config))
    jobs = ctx.jobs()

    client: McpJsonRpcClient | None = None
    try:
        if args.records is not None:
            source: FileSource | HttpSource = FileSource(
                load_records_file(args.records, ctx.edition)
            )
        else:
            id_map: dict[int, int] = {}
            if spec.kind == "hadith":
                if args.id_map is None:
                    raise InputError("--http for the hadith edition needs --id-map")
                id_map = load_id_map(args.id_map)
            client = McpJsonRpcClient(transport=ctx.rt.transport)
            source = HttpSource(client, id_map)
        handler = make_acquire_handler(
            edition_key=ctx.edition,
            bank_version=ctx.bank_version,
            requested_scope=scope,
            pass_number=args.pass_number,
            source=source,
            storages=storages,
            paths=ctx.paths,
            clock=ctx.rt.now,
        )
        result = run_content_job(
            ctx.edition,
            ctx.bank_version,
            "acquired",
            jobs=jobs,
            handlers={"acquired": handler},
            clock=ctx.rt.now,
        )
    finally:
        if client is not None:
            client.close()
    pass_text = f"pass={args.pass_number}" if args.pass_number else ""
    print(_format("acquire", ctx, result, pass_text))
    if result.status == "running":
        print(
            "acquisition is not complete yet; run acquire again to continue "
            "(see acquisition_report.md)"
        )
    return int(ExitCode.OK)


def _cmd_verify(ctx: _Context) -> int:
    args = ctx.args
    spec = edition_spec(ctx.edition)
    decision = args.source_only_decision
    if decision is not None:
        if args.oracle is not None or args.skeleton is not None:
            raise InputError(
                "--source-only-decision replaces --oracle and --skeleton; pass neither"
            )
        if spec.kind == "quran" and not args.http_recheck:
            raise InputError(
                "--source-only-decision for the Quran edition needs --http-recheck: the second "
                "acquisition is made during verify"
            )
    storage: RawStorage = (
        SupabaseRawStorage(ctx.config)
        if ctx.backend == "supabase"
        else LocalStagingStorage(ctx.paths.raw_root)
    )
    jobs = ctx.jobs()
    client = McpJsonRpcClient(transport=ctx.rt.transport) if args.http_recheck else None
    try:
        handler = make_verify_handler(
            edition_key=ctx.edition,
            bank_version=ctx.bank_version,
            jobs=jobs,
            storage=storage,
            paths=ctx.paths,
            oracle_path=args.oracle,
            skeleton_path=args.skeleton,
            recheck_client=client,
            source_only_decision=decision,
            clock=ctx.rt.now,
        )
        result = run_content_job(
            ctx.edition,
            ctx.bank_version,
            "verified",
            jobs=jobs,
            handlers={"verified": handler},
            clock=ctx.rt.now,
        )
    finally:
        if client is not None:
            client.close()
    gaps = (result.job.validation_summary or {}).get("gaps", [])
    pieces: list[str] = []
    if spec.kind == "hadith":
        numbers = ",".join(str(g["fortyNumber"]) for g in gaps)
        pieces.append(f"gap_forty_numbers=[{numbers}]")
    if decision is not None:
        pieces.append(f"source_only={decision}")
    print(_format("verify", ctx, result, " ".join(pieces)))
    return int(ExitCode.OK)


def _raw_storage(ctx: _Context) -> RawStorage:
    if ctx.backend == "supabase":
        return SupabaseRawStorage(ctx.config)
    return LocalStagingStorage(ctx.paths.raw_root)


def _cmd_segment(ctx: _Context) -> int:
    args = ctx.args
    spec = edition_spec(ctx.edition)
    if spec.kind == "quran" and args.boundaries is not None:
        raise InputError("--boundaries applies to the hadith edition only")
    storage = _raw_storage(ctx)
    jobs = ctx.jobs()
    handler = make_segment_handler(
        edition_key=ctx.edition,
        bank_version=ctx.bank_version,
        jobs=jobs,
        storage=storage,
        paths=ctx.paths,
        labels_path=args.labels,
        boundaries_path=args.boundaries,
        clock=ctx.rt.now,
    )
    result = run_content_job(
        ctx.edition,
        ctx.bank_version,
        "segmented",
        jobs=jobs,
        handlers={"segmented": handler},
        clock=ctx.rt.now,
    )
    flagged = (result.job.validation_summary or {}).get("suspectedErrors", [])
    doubts = [s["unit"] for s in flagged if s["kind"] == "matn_boundary_doubt"]
    omitted = [s["unit"] for s in flagged if s["kind"] == "grade_path_unavailable"]
    pieces = []
    if doubts:
        pieces.append(f"boundary_doubts=[{','.join(doubts)}]")
    if omitted:
        pieces.append(f"grade_passages_omitted=[{','.join(omitted)}]")
    print(_format("segment", ctx, result, " ".join(pieces)))
    return int(ExitCode.OK)


def _proposal_settings(rt: CliRuntime) -> Settings:
    """The OpenRouter settings. Normally the process environment and the gitignored
    ``backend/.env`` (as the app reads them, names only in errors); with an injected
    ``environ`` (tests) only that mapping, so a real key can never leak into a test."""
    if rt.environ is None:
        try:
            return load_settings()
        except StartupConfigError as exc:
            raise NotConfiguredError(str(exc)) from None
    values: dict[str, Any] = {}
    key = (rt.environ.get("OPENROUTER_API_KEY") or "").strip()
    if key:
        values["OPENROUTER_API_KEY"] = SecretStr(key)
    if (rt.environ.get("OPENROUTER_MODELS") or "").strip():
        values["OPENROUTER_MODELS"] = rt.environ["OPENROUTER_MODELS"]
    daily = (rt.environ.get("QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY") or "").strip()
    if daily:
        if not daily.isdecimal():
            raise NotConfiguredError("QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY must be an integer")
        values["QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY"] = int(daily)
    return Settings.model_construct(**values)


def _cmd_propose_questions(ctx: _Context) -> int:
    """D90: send the published source text, one passage at a time, to a FREE model that picks
    the question words (by reference). Without a free model nothing is sent or written and
    ``build-bank`` keeps using the rules."""
    args = ctx.args
    settings = _proposal_settings(ctx.rt)
    provider: ProposalProvider | None = None
    if not args.dry_run:
        provider = ctx.rt.proposal_provider or build_default_provider(settings, ctx.rt.transport)
        if provider is None:
            print("rules fallback: no free model configured")
            return int(ExitCode.OK)
    run = run_propose_questions(
        edition_key=ctx.edition,
        bank_version=ctx.bank_version,
        jobs=ctx.jobs(),
        paths=ctx.paths,
        provider=provider,
        timeout_sec=args.timeout,
        max_requests=args.max_requests,
        daily_limit=settings.QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY,
        pause_sec=args.pause,
        refresh=args.refresh,
        dry_run=args.dry_run,
    )
    counts = " ".join(f"{key}={value}" for key, value in run.counts.items())
    pieces = [
        "propose-questions",
        ctx.edition,
        f"bank_version={ctx.bank_version}",
        f"status={'dry_run' if run.dry_run else 'proposed'}",
        counts,
    ]
    if run.stopped:
        pieces.append(f"stopped={run.stopped}")
    if run.failures:
        reasons = Counter(reason for _passage, reason in run.failures)
        pieces.append("failures=" + ",".join(f"{r}:{n}" for r, n in sorted(reasons.items())))
    if run.models:
        pieces.append("models=" + ",".join(run.models))
    print(" ".join(pieces))
    if run.dry_run:
        print("dry run: nothing was sent")
    elif run.wrote:
        print(
            f"review {proposals_report_path(ctx.paths, ctx.edition)} before approve; "
            "then run build-bank (a part the program rejected keeps the rules choice)"
        )
    return int(ExitCode.OK)


def _cmd_build_bank(ctx: _Context) -> int:
    jobs = ctx.jobs()
    handler = make_build_bank_handler(
        edition_key=ctx.edition,
        bank_version=ctx.bank_version,
        jobs=jobs,
        paths=ctx.paths,
        clock=ctx.rt.now,
    )
    result = run_content_job(
        ctx.edition,
        ctx.bank_version,
        "bank_built",
        jobs=jobs,
        handlers={"bank_built": handler},
        clock=ctx.rt.now,
    )
    print(_format("build-bank", ctx, result))
    return int(ExitCode.OK)


def _cmd_validate(ctx: _Context) -> int:
    storage = _raw_storage(ctx)
    jobs = ctx.jobs()
    handler = make_validate_handler(
        edition_key=ctx.edition,
        bank_version=ctx.bank_version,
        jobs=jobs,
        storage=storage,
        paths=ctx.paths,
        clock=ctx.rt.now,
    )
    result = run_content_job(
        ctx.edition,
        ctx.bank_version,
        "validated",
        jobs=jobs,
        handlers={"validated": handler},
        clock=ctx.rt.now,
    )
    print(_format("validate", ctx, result))
    return int(ExitCode.OK)


def _verification_results(rows: Sequence[ContentJob]) -> list[Mapping[str, Any]]:
    """The verification records of the succeeded ``verified`` step (the policy input)."""
    return [
        row.validation_summary["verification"]
        for row in rows
        if row.step == "verified"
        and row.status == "succeeded"
        and row.validation_summary
        and "verification" in row.validation_summary
    ]


def _cmd_approve(ctx: _Context) -> int:
    """Record the owner's approval from explicit inputs (``approval.py``). Inputs are checked
    first (exit 2), then the policy preconditions (exit 3); nothing is written on a refusal."""
    args = ctx.args
    words = args.owner_words
    if args.owner_words_file is not None:
        words = read_owner_words_file(args.owner_words_file)
    approval = parse_approval_input(
        reviewer=args.reviewer,
        review_scope=args.review_scope,
        note=args.note,
        owner_words=words,
        source=args.source,
        at=args.at,
        now=ctx.rt.now(),
    )
    jobs = ctx.jobs()
    rows = jobs.list_jobs(ctx.edition, ctx.bank_version)
    state = derive_edition_state(ctx.edition, ctx.bank_version, rows)
    assert_step_allowed(completed_steps(rows), "approved")
    assert_approvable(state.status, _verification_results(rows))
    handler = make_approve_handler(
        edition_key=ctx.edition,
        bank_version=ctx.bank_version,
        jobs=jobs,
        paths=ctx.paths,
        approval=approval,
    )
    result = run_content_job(
        ctx.edition,
        ctx.bank_version,
        "approved",
        jobs=jobs,
        handlers={"approved": handler},
        clock=ctx.rt.now,
    )
    print(_format("approve", ctx, result))
    return int(ExitCode.OK)


def _cmd_publish(ctx: _Context) -> int:
    """Write the final publishing SQL file (``publication.py``). Applies nothing and leaves the
    local job rows as they are; refuses unless ``assert_publishable`` passes."""
    target = resolve_sql_out(ctx.args.sql_out, ctx.paths.root)
    jobs = ctx.jobs()
    rows = jobs.list_jobs(ctx.edition, ctx.bank_version)
    state = derive_edition_state(ctx.edition, ctx.bank_version, rows)
    assert_step_allowed(completed_steps(rows), "published")
    approved = next((r for r in rows if r.step == "approved" and r.status == "succeeded"), None)
    approval = (approved.validation_summary or {}).get("approval") if approved else None
    if approval and not is_complete_approval(approval):
        raise PublishRefusedError(
            "approval_incomplete",
            "the recorded approval must hold who, at, note, scope, words and source",
        )
    license_record = build_license_record(approval) if approval else None
    assert_publishable(state.status, _verification_results(rows), approval, license_record)
    assert approval is not None and license_record is not None  # assert_publishable passed
    publication = build_final_publication(
        edition_key=ctx.edition,
        bank_version=ctx.bank_version,
        jobs=jobs,
        paths=ctx.paths,
        approval=approval,
        license_record=license_record,
    )
    written = write_sql_file(target, publication.sql)
    counts = " ".join(f"{key}={value}" for key, value in publication.counts.items())
    print(
        f"publish {ctx.edition} bank_version={ctx.bank_version} status=sql_written "
        f"changed={'yes' if written else 'no'} {counts} sql_bytes={len(publication.sql.encode())} "
        f"sql_sha256={publication.sql_sha256} applied=no"
    )
    return int(ExitCode.OK)


def _cmd_not_implemented(ctx: _Context) -> int:
    """Registered commands: validate the preconditions through ``content_policy`` first, then
    refuse with exit code 6. Nothing is written."""
    command = ctx.args.command
    jobs = ctx.jobs()
    rows = jobs.list_jobs(ctx.edition, ctx.bank_version)
    done = completed_steps(rows)
    state = derive_edition_state(ctx.edition, ctx.bank_version, rows)
    if command == "delete-unused-draft":
        # Learner references are unknowable from the local build area (the CLI never reads
        # learner tables); the Supabase implementation (C6) supplies the real answer.
        assert_delete_unused_draft_allowed(state.status, False, [r.step for r in rows])
    else:
        assert_step_allowed(done, STEP_OF_COMMAND[command])
    raise StepNotImplementedError(f"{NOT_IMPLEMENTED}: {command}")


def _dispatch(args: argparse.Namespace, rt: CliRuntime) -> int:
    backend = args.data_backend or resolve_data_backend(rt.environ)
    config = load_supabase_config(rt.environ) if backend == "supabase" else None
    ctx = _Context(
        args=args, rt=rt, paths=BuildPaths(args.build_dir), backend=backend, config=config
    )
    if args.command == "acquire":
        return _cmd_acquire(ctx)
    if args.command == "verify":
        return _cmd_verify(ctx)
    if args.command == "segment":
        return _cmd_segment(ctx)
    if args.command == "propose-questions":
        return _cmd_propose_questions(ctx)
    if args.command == "build-bank":
        return _cmd_build_bank(ctx)
    if args.command == "validate":
        return _cmd_validate(ctx)
    if args.command == "approve":
        return _cmd_approve(ctx)
    if args.command == "publish":
        return _cmd_publish(ctx)
    return _cmd_not_implemented(ctx)


def main(argv: Sequence[str] | None = None, *, runtime: CliRuntime | None = None) -> int:
    """Entry point. Returns the exit code (see the module docstring)."""
    rt = runtime or CliRuntime()
    parser = build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else int(ExitCode.USAGE)
    try:
        return _dispatch(args, rt)
    except ContentPolicyError as exc:
        print(f"refused ({exc.code}): {exc}", file=sys.stderr)
        return int(ExitCode.PRECONDITION)
    except WorkflowError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return int(exc.exit_code)
    except Exception as exc:  # message omitted on purpose: it could echo source text
        print(f"unexpected error ({type(exc).__name__})", file=sys.stderr)
        return int(ExitCode.UNEXPECTED)


if __name__ == "__main__":
    raise SystemExit(main())
