"""Workflow exceptions and the CLI exit codes they map to.

Messages never contain source text or secrets: only counts, ids, names of fields and steps.
"""

from __future__ import annotations

from enum import IntEnum
from typing import Any


class ExitCode(IntEnum):
    """Exit codes of ``scripts/content_tools.py`` (API-spec §5.4 leaves them open, [O-26])."""

    OK = 0
    UNEXPECTED = 1
    USAGE = 2
    PRECONDITION = 3
    VERIFICATION_FAILED = 4
    NOT_CONFIGURED = 5
    NOT_IMPLEMENTED = 6
    SOURCE_UNREACHABLE = 7


class WorkflowError(Exception):
    """Base class of workflow errors; ``exit_code`` is what the CLI returns."""

    exit_code: ExitCode = ExitCode.UNEXPECTED


class InputError(WorkflowError):
    """A command-line argument or an input file is invalid (nothing was stored)."""

    exit_code = ExitCode.USAGE


class PreconditionError(WorkflowError):
    """Step order, scope, independence or another precondition is violated."""

    exit_code = ExitCode.PRECONDITION


class ObjectConflictError(PreconditionError):
    """An existing raw object has a different hash: refused, a correction needs a new
    ``bank_version`` (API-spec §5.3 ``acquire``)."""


class ObjectNotFoundError(PreconditionError):
    """A raw object that a later step needs is not in the storage."""


class StorageError(WorkflowError):
    """The raw storage answered unexpectedly (status code only; never a body or a key)."""


class IntegrityError(WorkflowError):
    """A stored raw object does not match its recorded hash."""

    exit_code = ExitCode.VERIFICATION_FAILED


class NotConfiguredError(WorkflowError):
    """Supabase (or another required service) is not configured or not available in B7."""

    exit_code = ExitCode.NOT_CONFIGURED


class StepNotImplementedError(WorkflowError):
    """The step exists in the workflow but is not implemented in B7 (B8 / C6)."""

    exit_code = ExitCode.NOT_IMPLEMENTED


class SourceUnreachableError(WorkflowError):
    """The Islamic Content host could not be reached, or answered outside the MCP protocol."""

    exit_code = ExitCode.SOURCE_UNREACHABLE


class McpProtocolError(SourceUnreachableError):
    """The MCP server answered with a JSON-RPC error or an unexpected envelope."""


class McpParseError(SourceUnreachableError):
    """A tool response does not have the observed layout (so nothing is stored from it)."""


class StepFailure(WorkflowError):
    """A step ran and failed: the runner records ``failed`` with the step cursor.

    ``cursor`` is the resume position and ``summary`` the (text-free) evidence to persist.
    """

    exit_code = ExitCode.UNEXPECTED

    def __init__(
        self,
        message: str,
        *,
        cursor: dict[str, Any] | None = None,
        summary: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.cursor = cursor
        self.summary = summary


class VerificationFailedError(StepFailure):
    """At least one unit failed verbatim verification: the affected units are blocked."""

    exit_code = ExitCode.VERIFICATION_FAILED


class AcquisitionInterruptedError(StepFailure):
    """Acquisition over HTTP stopped midway; the cursor keeps what was stored so far."""

    exit_code = ExitCode.SOURCE_UNREACHABLE
