"""Operator CLI of the content workflow (API-spec §5, Programming-guide §5, B7).

Run from ``backend/``::

    uv run python -m scripts.content_tools <command> --edition <key> --bank-version <N> [...]
    uv run python scripts/content_tools.py <command> ...        # equivalent

Commands: ``acquire``, ``verify``, ``segment``, ``build-bank``, ``validate``, ``approve``,
``publish``, ``withdraw``, ``archive``, ``delete-unused-draft``. B7 implements ``acquire`` and
``verify``; the other eight are registered, check their preconditions through
``app.domain.content_policy`` and then exit with code 6 and the message
"not implemented in B7 (B8/C6)". ``approve`` additionally refuses every non-interactive run
(silence, a timeout or a non-interactive run is never an approval) and never records approval
in B7.

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
4     verification failed (units blocked), or a stored object fails its integrity check
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
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx

if __package__ in (None, ""):  # started as ``python scripts/content_tools.py``
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.domain.content_policy import (  # noqa: E402
    ContentPolicyError,
    assert_approvable,
    assert_delete_unused_draft_allowed,
    assert_publishable,
    assert_step_allowed,
)
from app.workflow.content_management import (  # noqa: E402
    FileSource,
    HttpSource,
    load_id_map,
    load_records_file,
    make_acquire_handler,
    make_verify_handler,
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
    PreconditionError,
    StepNotImplementedError,
    WorkflowError,
)
from app.workflow.jobs import (  # noqa: E402
    JobRepository,
    LocalJobRepository,
    SupabaseJobRepository,
    completed_steps,
)
from app.workflow.mcp_client import McpJsonRpcClient  # noqa: E402
from app.workflow.models import derive_edition_state  # noqa: E402
from app.workflow.paths import DEFAULT_BUILD_DIR, BuildPaths  # noqa: E402
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
    "build-bank",
    "validate",
    "approve",
    "publish",
    "withdraw",
    "archive",
    "delete-unused-draft",
)
STEP_OF_COMMAND = {
    "segment": "segmented",
    "build-bank": "bank_built",
    "validate": "validated",
    "approve": "approved",
    "publish": "published",
    "withdraw": "withdrawn",
    "archive": "archived",
}
NOT_IMPLEMENTED = "not implemented in B7 (B8/C6)"


@dataclass(slots=True)
class CliRuntime:
    """Injection points (tests); the defaults are the real process environment, terminal,
    network and clock."""

    environ: Mapping[str, str] | None = None
    stdin_isatty: Callable[[], bool] | None = None
    transport: httpx.BaseTransport | None = None
    clock: Callable[[], datetime] | None = None

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

    for name, text in (
        ("segment", "segmentation into units, passages and parts (B8)"),
        ("build-bank", "lessons and question bank (B8)"),
        ("validate", "edition and bank validation (B8)"),
        ("publish", "publish the approved edition (C6)"),
        ("archive", "hide a published edition from new selection (C6)"),
        ("delete-unused-draft", "delete an unused draft (C6)"),
    ):
        sub.add_parser(name, parents=[common], help=f"not implemented in B7: {text}")
    approve = sub.add_parser(
        "approve", parents=[common], help="owner approval (interactive only; not implemented in B7)"
    )
    approve.add_argument("--reviewer", required=True, help="reviewer identity as recorded")
    approve.add_argument("--review-scope", required=True, help="scope of the review actually done")
    approve.add_argument("--note", default="", help="notes")
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
    extra = ""
    if spec.kind == "hadith":
        numbers = ",".join(str(g["fortyNumber"]) for g in gaps)
        extra = f"gap_forty_numbers=[{numbers}]"
    print(_format("verify", ctx, result, extra))
    return int(ExitCode.OK)


def _cmd_not_implemented(ctx: _Context) -> int:
    """Registered commands: validate the preconditions through ``content_policy`` first, then
    refuse with exit code 6. Nothing is written."""
    command = ctx.args.command
    if command == "approve" and not ctx.rt.interactive():
        raise PreconditionError(
            "approve needs an interactive terminal; silence, a timeout or a non-interactive "
            "run is never an approval"
        )
    jobs = ctx.jobs()
    rows = jobs.list_jobs(ctx.edition, ctx.bank_version)
    done = completed_steps(rows)
    state = derive_edition_state(ctx.edition, ctx.bank_version, rows)
    verification = [
        row.validation_summary["verification"]
        for row in rows
        if row.step == "verified"
        and row.status == "succeeded"
        and row.validation_summary
        and "verification" in row.validation_summary
    ]
    if command == "delete-unused-draft":
        # Learner references are unknowable from the local build area (the CLI never reads
        # learner tables); the Supabase implementation (C6) supplies the real answer.
        assert_delete_unused_draft_allowed(state.status, False, [r.step for r in rows])
    else:
        assert_step_allowed(done, STEP_OF_COMMAND[command])
        if command == "approve":
            assert_approvable(state.status, verification)
        elif command == "publish":
            approved = next((r for r in rows if r.step == "approved"), None)
            approval = (approved.validation_summary or {}).get("approval") if approved else None
            assert_publishable(state.status, verification, approval, None)
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
