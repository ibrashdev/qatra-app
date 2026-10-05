"""JSON-RPC client against httpx.MockTransport.

These tests use httpx.MockTransport and never touch the network: nothing here proves the client
works against the real server, only that it speaks the documented protocol. The one live run is
recorded in the module docstring of ``app/workflow/mcp_client.py``.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from app.workflow.errors import (
    InputError,
    McpParseError,
    McpProtocolError,
    SourceUnreachableError,
)
from app.workflow.mcp_client import (
    USER_AGENT,
    McpJsonRpcClient,
    hadith_arguments,
    layout_summary,
    quran_arguments,
)
from tests.workflow.wf_support import DATA, assert_no_source_text

QURAN_TEXT = (DATA / "synthetic_mcp_quran_response.txt").read_text(encoding="utf-8")
HADITH_TEXT = (DATA / "synthetic_mcp_hadith_response.txt").read_text(encoding="utf-8")


class FakeServer:
    """Records requests and answers like a minimal MCP server."""

    def __init__(self, *, sse: bool = False, session: str | None = "sess-1") -> None:
        self.requests: list[httpx.Request] = []
        self.sse = sse
        self.session = session
        self.tool_text = QURAN_TEXT
        self.is_error = False
        self.rpc_error: dict[str, object] | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        body = json.loads(request.content)
        method = body["method"]
        if "id" not in body:
            return httpx.Response(202)
        if self.rpc_error is not None:
            return self._reply({"jsonrpc": "2.0", "id": body["id"], "error": self.rpc_error})
        if method == "initialize":
            result: dict[str, object] = {"protocolVersion": "2025-06-18", "capabilities": {}}
            response = self._reply({"jsonrpc": "2.0", "id": body["id"], "result": result})
            if self.session:
                response.headers["Mcp-Session-Id"] = self.session
            return response
        assert method == "tools/call"
        result = {"content": [{"type": "text", "text": self.tool_text}], "isError": self.is_error}
        return self._reply({"jsonrpc": "2.0", "id": body["id"], "result": result})

    def _reply(self, message: dict[str, object]) -> httpx.Response:
        if self.sse:
            text = f"event: message\ndata: {json.dumps(message)}\n\n"
            return httpx.Response(200, text=text, headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json=message)

    def bodies(self) -> list[dict[str, object]]:
        return [json.loads(r.content) for r in self.requests]


def client_for(server: Callable[[httpx.Request], httpx.Response]) -> McpJsonRpcClient:
    return McpJsonRpcClient(transport=httpx.MockTransport(server))


def test_handshake_then_tools_call_with_headers_and_arguments() -> None:
    server = FakeServer()
    with client_for(server) as client:
        text = client.get_quran_verses_text(112)
    assert text == QURAN_TEXT
    methods = [b["method"] for b in server.bodies()]
    assert methods == ["initialize", "notifications/initialized", "tools/call"]
    call = server.bodies()[2]
    assert call["params"] == {
        "name": "get_quran_verses",
        "arguments": {"surah": 112, "language": "ar"},
    }
    assert call["jsonrpc"] == "2.0"
    first, *rest = server.requests
    assert first.url == "https://mcp.islamiccontent.org/mcp"
    assert first.method == "POST"
    assert (
        "text/event-stream" in first.headers["accept"]
        and "application/json" in first.headers["accept"]
    )
    assert "mcp-session-id" not in first.headers
    assert all(r.headers["mcp-session-id"] == "sess-1" for r in rest)
    assert all(r.headers["mcp-protocol-version"] == "2025-06-18" for r in rest)


def test_second_call_does_not_repeat_the_handshake() -> None:
    server = FakeServer()
    with client_for(server) as client:
        client.get_quran_verses_text(112)
        server.tool_text = HADITH_TEXT
        text = client.get_hadith_text(990001)
    assert text == HADITH_TEXT
    assert [b["method"] for b in server.bodies()].count("initialize") == 1
    assert server.bodies()[-1]["params"] == {
        "name": "get_hadith",
        "arguments": {"id": 990001, "language": "ar"},
    }


def test_sse_answers_are_parsed() -> None:
    server = FakeServer(sse=True, session=None)
    with client_for(server) as client:
        assert client.get_quran_verses_text(112) == QURAN_TEXT
    assert all("mcp-session-id" not in r.headers for r in server.requests)


def test_fetch_helpers_parse_the_tool_text() -> None:
    server = FakeServer()
    with client_for(server) as client:
        records = client.fetch_quran_surah(112)
        server.tool_text = HADITH_TEXT
        record = client.fetch_hadith(990001, 1)
    assert [r.ayah for r in records] == [1, 2, 3, 4]
    assert record.forty_number == 1 and record.grade == "تجريبي"


def test_tool_error_and_json_rpc_error_are_protocol_errors() -> None:
    server = FakeServer()
    server.is_error = True
    with client_for(server) as client, pytest.raises(McpProtocolError):
        client.get_quran_verses_text(112)
    server = FakeServer()
    server.rpc_error = {"code": -32601, "message": "echoed text must not matter"}
    with client_for(server) as client, pytest.raises(McpProtocolError) as error:
        client.get_quran_verses_text(112)
    assert "-32601" in str(error.value) and "echoed" not in str(error.value)


def test_unparseable_tool_text_is_a_parse_error() -> None:
    server = FakeServer()
    server.tool_text = "plain words without any block"
    with client_for(server) as client, pytest.raises(McpParseError):
        client.fetch_quran_surah(112)


def test_http_errors_redirects_and_network_failures_map_to_unreachable() -> None:
    with (
        client_for(lambda r: httpx.Response(503)) as client,
        pytest.raises(SourceUnreachableError) as e1,
    ):
        client.get_quran_verses_text(112)
    assert "503" in str(e1.value)

    def redirect(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://evil.example/"})

    with client_for(redirect) as client, pytest.raises(SourceUnreachableError) as e2:
        client.get_quran_verses_text(112)
    assert "redirect" in str(e2.value)

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("blocked", request=request)

    with client_for(boom) as client, pytest.raises(SourceUnreachableError) as e3:
        client.get_quran_verses_text(112)
    assert "ConnectError" in str(e3.value)


def test_non_json_answer_is_a_protocol_error() -> None:
    with (
        client_for(lambda r: httpx.Response(200, text="<html>")) as client,
        pytest.raises(McpProtocolError),
    ):
        client.get_quran_verses_text(112)


def test_only_the_approved_host_over_https_is_accepted() -> None:
    for endpoint in (
        "https://evil.example/mcp",
        "http://mcp.islamiccontent.org/mcp",
        "https://mcp.islamiccontent.org.evil.example/mcp",
    ):
        with pytest.raises(InputError):
            McpJsonRpcClient(endpoint=endpoint)
    McpJsonRpcClient(endpoint="https://mcp.islamiccontent.org/mcp").close()


def test_argument_builders() -> None:
    assert quran_arguments(78) == {"surah": 78, "language": "ar"}
    assert hadith_arguments(66511) == {"id": 66511, "language": "ar"}


def test_every_request_carries_an_honest_descriptive_identity() -> None:
    server = FakeServer()
    with client_for(server) as client:
        client.get_quran_verses_text(112)
    assert len(server.requests) == 3  # initialize, initialized, tools/call
    assert {r.headers["user-agent"] for r in server.requests} == {USER_AGENT}
    assert USER_AGENT.startswith("qatra-content-workflow/") and "read-only" in USER_AGENT
    assert "mozilla" not in USER_AGENT.lower() and "python" not in USER_AGENT.lower()


def test_a_parse_error_names_counts_of_the_layout_and_never_the_text() -> None:
    server = FakeServer()
    broken = QURAN_TEXT.replace("[/EXACT]", "")  # the block never closes
    server.tool_text = broken
    with client_for(server) as client, pytest.raises(McpParseError) as error:
        client.fetch_quran_surah(112)
    message = str(error.value)
    assert "no [EXACT] block" in message and "layout:" in message
    assert f"{len(broken)} characters" in message and "EXACT 1/0" in message
    assert "ayah markers 4" in message and "Source lines 1" in message
    assert_no_source_text(message)
    assert QURAN_TEXT.splitlines()[3] not in message  # a verse line

    server = FakeServer()
    server.tool_text = HADITH_TEXT.replace("[EXACT]", "").replace("[/EXACT]", "")
    with client_for(server) as client, pytest.raises(McpParseError) as error:
        client.fetch_hadith(990001, 1)
    assert "layout:" in str(error.value) and "EXACT 0/0" in str(error.value)
    assert_no_source_text(str(error.value))


def test_layout_summary_counts_only() -> None:
    text = "[EXACT]\n[112:1]\nabc\n[112:2]\ndef\n[/EXACT]\nSource: https://example.invalid/x\n"
    summary = layout_summary(text)
    assert summary == (
        f"layout: {len(text)} characters, 7 lines; block tags open/close "
        "EXACT 1/1, ATTRIBUTION 0/0, COMMENTARY 0/0; ayah markers 2; Source lines 1"
    )
    assert "abc" not in summary and "def" not in summary
