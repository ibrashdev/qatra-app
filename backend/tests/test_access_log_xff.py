"""The access log fields ``xff_entries`` and ``via_vercel``.

They measure the proxy chain in front of the API, so that ``QATRA_TRUSTED_XFF_DEPTH`` can be
chosen from evidence. They are a count and a flag: no address, no header value and no hash of
either may reach a log line.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence

import pytest
from fastapi.testclient import TestClient
from starlette.types import Message, Receive, Scope, Send

from app.logging_config import configure_logging
from app.middleware import AccessLogMiddleware

# Documentation addresses (RFC 5737), a made-up request id and a reserved ``.invalid`` origin.
# None of them may appear in a log line.
FORWARDED_A = "192.0.2.10"
FORWARDED_B = "198.51.100.7"
FORWARDED_C = "203.0.113.5"
PEER = "192.0.2.55"
VERCEL_ID = "fra1::SENTINEL-request-id"
OTHER_ORIGIN = "https://other.invalid"

FIELDS = [
    "event",
    "method",
    "route",
    "status",
    "latency_ms",
    "error_code",
    "xff_entries",
    "via_vercel",
]

HeaderLines = Sequence[tuple[str, str]]


def request_entries(lines: list[str]) -> list[dict]:
    return [json.loads(line) for line in lines if '"event":"request"' in line]


def logged(client: TestClient, log_lines: list[str], headers: HeaderLines = ()) -> dict:
    """The one access log entry written for a ``GET /api/health`` sent with ``headers``."""
    assert client.get("/api/health", headers=list(headers)).status_code == 200
    (entry,) = request_entries(log_lines)
    return entry


def run_raw(headers: list[tuple[bytes, bytes]]) -> Scope:
    """Send one request with exactly these raw headers, from the peer ``PEER``, through the
    middleware around a stub application. Returns the scope as the middleware left it."""
    configure_logging()  # idempotent; the access log is written at INFO once configured

    async def stub(scope: Scope, receive: Receive, send: Send) -> None:
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        pass

    scope: Scope = {
        "type": "http",
        "method": "GET",
        "path": "/probe",
        "headers": headers,
        "client": (PEER, 40000),
    }
    asyncio.run(AccessLogMiddleware(stub)(scope, receive, send))
    return scope


def test_without_either_header_the_entry_says_zero_and_false(
    client: TestClient, log_lines: list[str]
) -> None:
    entry = logged(client, log_lines)
    assert entry["xff_entries"] == 0
    assert entry["via_vercel"] is False


def test_one_forwarded_entry_counts_as_one(client: TestClient, log_lines: list[str]) -> None:
    entry = logged(client, log_lines, [("X-Forwarded-For", FORWARDED_A)])
    assert entry["xff_entries"] == 1
    assert entry["via_vercel"] is False


def test_entries_are_counted_across_header_lines(client: TestClient, log_lines: list[str]) -> None:
    sent = [("X-Forwarded-For", FORWARDED_A), ("X-Forwarded-For", f"{FORWARDED_B}, {FORWARDED_C}")]
    assert logged(client, log_lines, sent)["xff_entries"] == 3


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("", 0),
        (",", 0),
        (" , , ,", 0),
        (f"{FORWARDED_A},", 1),
        (f",{FORWARDED_A}", 1),
        (f"{FORWARDED_A},,{FORWARDED_B}", 2),
        (f"  {FORWARDED_A}  ,   {FORWARDED_B} ", 2),
    ],
    ids=["empty", "comma", "blanks", "trailing", "leading", "gap", "padded"],
)
def test_empty_entries_are_ignored(
    client: TestClient, log_lines: list[str], value: str, expected: int
) -> None:
    entry = logged(client, log_lines, [("X-Forwarded-For", value)])
    assert entry["xff_entries"] == expected


@pytest.mark.parametrize("value", [VERCEL_ID, ""], ids=["with-value", "empty-value"])
def test_x_vercel_id_present_logs_true(
    client: TestClient, log_lines: list[str], value: str
) -> None:
    entry = logged(client, log_lines, [("X-Vercel-Id", value)])  # presence only, never the value
    assert entry["via_vercel"] is True
    assert entry["xff_entries"] == 0


def test_headers_with_similar_names_do_not_count(client: TestClient, log_lines: list[str]) -> None:
    lookalikes = [
        ("X-Vercel-Forwarded-For", FORWARDED_A),
        ("X-Forwarded-For-Extra", FORWARDED_B),
        ("X-Vercel-Id-Extra", VERCEL_ID),
        ("X-Real-IP", FORWARDED_C),
    ]
    entry = logged(client, log_lines, lookalikes)
    assert (entry["xff_entries"], entry["via_vercel"]) == (0, False)


def test_both_measures_are_reported_together(client: TestClient, log_lines: list[str]) -> None:
    sent = [("X-Forwarded-For", f"{FORWARDED_A}, {FORWARDED_B}"), ("X-Vercel-Id", VERCEL_ID)]
    entry = logged(client, log_lines, sent)
    assert (entry["xff_entries"], entry["via_vercel"]) == (2, True)


def test_the_existing_fields_keep_their_order_and_the_new_ones_follow(
    client: TestClient, log_lines: list[str]
) -> None:
    sent = [("X-Forwarded-For", FORWARDED_A), ("X-Vercel-Id", VERCEL_ID)]
    entry = logged(client, log_lines, sent)
    assert list(entry) == FIELDS
    assert type(entry["xff_entries"]) is int
    assert entry["via_vercel"] is True


def test_header_names_are_matched_without_regard_to_case(log_lines: list[str]) -> None:
    run_raw(
        [
            (b"X-Forwarded-For", f"{FORWARDED_A}, {FORWARDED_B}".encode()),
            (b"x-FORWARDED-for", FORWARDED_C.encode()),
            (b"X-Vercel-ID", VERCEL_ID.encode()),
        ]
    )
    (entry,) = request_entries(log_lines)
    assert (entry["xff_entries"], entry["via_vercel"]) == (3, True)


def test_the_application_still_gets_the_original_headers() -> None:
    headers = [(b"x-forwarded-for", FORWARDED_A.encode()), (b"x-vercel-id", VERCEL_ID.encode())]
    original = list(headers)
    assert run_raw(headers)["headers"] == original


def test_no_address_or_header_value_reaches_any_log_line(
    client: TestClient, log_lines: list[str]
) -> None:
    sent = [
        ("X-Forwarded-For", f"{FORWARDED_A}, {FORWARDED_B}"),
        ("X-Forwarded-For", FORWARDED_C),
        ("X-Vercel-Id", VERCEL_ID),
        ("X-Real-IP", FORWARDED_A),
    ]
    assert client.get("/api/health", headers=sent).status_code == 200
    assert client.get("/api/does-not-exist", headers=sent).status_code == 404
    # A wrong Origin is answered by the guard before routing: still one entry, same fields.
    assert client.post("/api/health", headers=[*sent, ("Origin", OTHER_ORIGIN)]).status_code == 403

    entries = request_entries(log_lines)
    assert [entry["status"] for entry in entries] == [200, 404, 403]
    for entry in entries:
        # Exactly the known fields: there is no room for an address, a value or a hash of one.
        assert list(entry) == FIELDS
        assert (entry["xff_entries"], entry["via_vercel"]) == (3, True)
    joined = "\n".join(log_lines)
    for leaked in (FORWARDED_A, FORWARDED_B, FORWARDED_C, "SENTINEL", "fra1", "other.invalid"):
        assert leaked not in joined


def test_the_peer_address_is_never_logged(log_lines: list[str]) -> None:
    run_raw([(b"x-forwarded-for", f"{FORWARDED_A}, {FORWARDED_B}".encode())])
    (entry,) = request_entries(log_lines)
    assert entry["xff_entries"] == 2
    joined = "\n".join(log_lines)
    for leaked in (PEER, FORWARDED_A, FORWARDED_B):
        assert leaked not in joined
