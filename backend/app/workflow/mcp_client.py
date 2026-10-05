"""Islamic Content MCP: response parsers and a JSON-RPC client (contract §2.7, D68).

**Observed response layout** (``references/source-acquisition/mcp-evidence.json``, a probe
through the Claude connector on 4 October 2026):

- ``get_quran_verses`` (``language="ar"``): a header ``[Surah 112, translation "arabic_moyassar"]``,
  one ``[EXACT] ... [/EXACT]`` block holding, per ayah, a marker line ``[112:1]``, the Uthmani
  verse line and then a tafsir line, and a ``Source: https://islamenc.com/ar/quran/112`` line.
  Only the verse line is kept; the tafsir line is never stored (D20, D26, D68).
- ``get_hadith`` (``language="ar"``): a title line, an ``[EXACT]`` block with the narration, an
  ``[ATTRIBUTION]`` block with ``Narrator:`` and ``Grade:`` lines, a ``[COMMENTARY]`` block
  (never read, never stored), a ``Source: https://hadeethenc.com/ar/browse/hadith/<id>`` line and
  a sentence listing the published languages.

The parsers are tolerant of extra lines outside the blocks and strict about the blocks and the
``Source:`` URL. The languages sentence is the least certain part of the layout: it is read
loosely (text after the last colon of the first line that mentions "language") and is not
needed for any later step.

**Live use.** The unit tests use ``httpx.MockTransport`` only. The first run against the live host
was the operator run of 5 October 2026 (Quran surah 112, a re-acquisition, and HadeethEnc record
66511 in two passes): the parsers read the live layout without change and the answers matched the
layout above. That is one observation, not a guarantee for other surahs or records. The client
follows the MCP Streamable HTTP transport (``initialize``, ``notifications/initialized``,
``tools/call``; JSON or SSE answers), sends an honest descriptive ``User-Agent``, accepts only the
approved host, never follows redirects and uses a request timeout. A parse error names counts of
the layout (``layout_summary``), never any of the text.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from types import TracebackType
from typing import Any, Final
from urllib.parse import urlsplit

import httpx

from app.workflow.editions import (
    MCP_ENDPOINT,
    MCP_HOST,
    TOOL_HADITH,
    TOOL_QURAN,
    hadith_url_id,
    quran_url_surah,
)
from app.workflow.errors import (
    InputError,
    McpParseError,
    McpProtocolError,
    SourceUnreachableError,
)
from app.workflow.models import HadithRecord, QuranRecord

PROTOCOL_VERSION: Final = "2025-06-18"
CLIENT_NAME: Final = "qatra-content-workflow"
CLIENT_VERSION: Final = "0.1"
# An honest, descriptive client identity. A probe that carried a default client signature was
# refused by the provider's edge (mcp-evidence.json); the identity says what this is and nothing
# else, it never imitates a browser.
USER_AGENT: Final = f"{CLIENT_NAME}/{CLIENT_VERSION} (operator CLI; read-only acquisition)"
DEFAULT_TIMEOUT_SECONDS: Final = 30.0  # an operational default, not a contract value

_LAYOUT_WS = " \t\r\n"  # layout whitespace stripped around a line; NBSP and ZWNJ stay untouched
_HEADER_RE = re.compile(r'^\[Surah\s+(\d+),\s*translation\s+"[^"]*"\]\s*$', re.MULTILINE)
_MARKER_RE = re.compile(r"^\[(\d{1,3}):(\d{1,3})\]$")
_SOURCE_RE = re.compile(r"^Source:[ \t]*(\S+)[ \t\r]*$", re.MULTILINE)
_BLOCK_TAGS = ("EXACT", "ATTRIBUTION", "COMMENTARY")


def quran_arguments(surah: int) -> dict[str, Any]:
    return {"surah": surah, "language": "ar"}


def hadith_arguments(hadeethenc_id: int) -> dict[str, Any]:
    return {"id": hadeethenc_id, "language": "ar"}


# --- parsers -------------------------------------------------------------------------------


def _block(text: str, tag: str, *, required: bool) -> str | None:
    match = re.search(rf"\[{tag}\](.*?)\[/{tag}\]", text, re.DOTALL)
    if match is None:
        if required:
            raise McpParseError(f"the response has no [{tag}] block")
        return None
    return match.group(1)


def _outside_blocks(text: str) -> str:
    """The response without its [EXACT], [ATTRIBUTION] and [COMMENTARY] blocks."""
    for tag in _BLOCK_TAGS:
        text = re.sub(rf"\[{tag}\].*?\[/{tag}\]", "", text, flags=re.DOTALL)
    return text


def _source_url(text: str) -> str:
    match = _SOURCE_RE.search(_outside_blocks(text))
    if match is None:
        raise McpParseError("the response has no 'Source:' line")
    return match.group(1)


def parse_quran_response(text: str) -> list[QuranRecord]:
    """Records ``{surah, ayah, text, url}`` of a ``get_quran_verses`` answer.

    Keeps only the verse line after each ``[surah:ayah]`` marker and drops every following line
    (the tafsir) up to the next marker. Raises ``McpParseError`` when the layout is not met.
    """
    exact = _block(text, "EXACT", required=True) or ""
    url = _source_url(text)
    url_surah = quran_url_surah(url)
    if url_surah is None:
        raise McpParseError("the 'Source:' URL is not a canonical QuranEnc surah URL")
    header = _HEADER_RE.search(text)
    if header is not None and int(header.group(1)) != url_surah:
        raise McpParseError("the response header and the 'Source:' URL name different surahs")

    records: list[QuranRecord] = []
    seen: set[int] = set()
    marker: tuple[int, int] | None = None
    verse: str | None = None

    def flush() -> None:
        if marker is None:
            return
        if verse is None:
            raise McpParseError("an ayah marker has no verse line")
        records.append(QuranRecord(surah=marker[0], ayah=marker[1], text=verse, url=url))

    for raw_line in exact.splitlines():
        line = raw_line.strip(_LAYOUT_WS)
        if not line:
            continue
        match = _MARKER_RE.match(line)
        if match:
            flush()
            marker, verse = (int(match.group(1)), int(match.group(2))), None
            if marker[0] != url_surah:
                raise McpParseError("an ayah marker names a surah other than the response's")
            if marker[1] in seen:
                raise McpParseError("an ayah marker appears twice")
            seen.add(marker[1])
        elif marker is not None and verse is None:
            verse = line  # the first line after the marker is the verse; later lines are tafsir
    flush()
    if not records:
        raise McpParseError("the response contains no ayah markers")
    return records


def parse_hadith_response(text: str, hadeethenc_id: int, forty_number: int) -> HadithRecord:
    """Record of a ``get_hadith`` answer. The commentary block is never read.

    ``hadeethenc_id`` is the argument of the call; the ``Source:`` URL must carry the same id.
    """
    narration = (_block(text, "EXACT", required=True) or "").strip(_LAYOUT_WS)
    if not narration:
        raise McpParseError("the [EXACT] block is empty")
    url = _source_url(text)
    if hadith_url_id(url) != hadeethenc_id:
        raise McpParseError("the 'Source:' URL does not carry the requested hadith id")

    attribution = _block(text, "ATTRIBUTION", required=False) or ""
    narrator = _labelled_value(attribution, "Narrator")
    grade = _labelled_value(attribution, "Grade")

    title = ""
    languages: list[str] = []
    for raw_line in _outside_blocks(text).splitlines():
        line = raw_line.strip(_LAYOUT_WS)
        if not line or line.startswith(("Source:", "[")):
            continue
        if not title:
            title = line
        elif not languages and re.search(r"\blanguages?\b", line, re.IGNORECASE) and ":" in line:
            tail = line.rsplit(":", 1)[1]
            languages = [
                item.strip(" .\t") for item in re.split(r"[,،;]", tail) if item.strip(" .\t")
            ]
    return HadithRecord(
        hadeethenc_id=hadeethenc_id,
        forty_number=forty_number,
        title=title,
        narration=narration,
        narrator=narrator,
        grade=grade,
        url=url,
        languages=languages,
    )


def _labelled_value(block: str, label: str) -> str:
    match = re.search(rf"^[ \t]*{label}:[ \t]*(.*?)[ \t\r]*$", block, re.MULTILINE)
    return match.group(1) if match else ""


def layout_summary(text: str) -> str:
    """Counts that describe the layout of a tool answer, for a parse error: sizes, how many of
    each block tag and ayah marker and how many ``Source:`` lines. Never any of the text."""
    lines = text.splitlines()
    tags = []
    for tag in _BLOCK_TAGS:
        opened = len(re.findall(re.escape(f"[{tag}]"), text))
        closed = len(re.findall(re.escape(f"[/{tag}]"), text))
        tags.append(f"{tag} {opened}/{closed}")
    markers = sum(1 for line in lines if _MARKER_RE.match(line.strip(_LAYOUT_WS)))
    return (
        f"layout: {len(text)} characters, {len(lines)} lines; block tags open/close "
        f"{', '.join(tags)}; ayah markers {markers}; Source lines {len(_SOURCE_RE.findall(text))}"
    )


# --- JSON-RPC client -----------------------------------------------------------------------


def _parse_sse(body: str) -> list[Any]:
    messages: list[Any] = []
    data: list[str] = []

    def flush() -> None:
        if data:
            try:
                messages.append(json.loads("\n".join(data)))
            except json.JSONDecodeError:
                raise McpProtocolError("an SSE event is not valid JSON") from None
            data.clear()

    for line in body.splitlines():
        if line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
        elif not line.strip():
            flush()
    flush()
    return messages


class McpJsonRpcClient:
    """Minimal MCP client over HTTP (JSON-RPC 2.0): ``initialize``, then ``tools/call``.

    Only the approved host is accepted and redirects are refused (API-spec: URL acquisition
    validates the approved host and each redirect). See the module docstring for live use.
    """

    def __init__(
        self,
        *,
        endpoint: str = MCP_ENDPOINT,
        transport: httpx.BaseTransport | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        parts = urlsplit(endpoint)
        if parts.scheme != "https" or parts.hostname != MCP_HOST:
            raise InputError(f"the MCP endpoint must be https://{MCP_HOST}/...")
        self._endpoint = endpoint
        self._http = httpx.Client(transport=transport, timeout=timeout, follow_redirects=False)
        self._next_id = 0
        self._session_id: str | None = None
        self._protocol_version: str | None = None
        self._initialized = False

    def __enter__(self) -> McpJsonRpcClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def _headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "User-Agent": USER_AGENT,
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        if self._protocol_version:
            headers["MCP-Protocol-Version"] = self._protocol_version
        return headers

    def _post(self, message: dict[str, Any]) -> httpx.Response:
        try:
            response = self._http.post(self._endpoint, headers=self._headers(), json=message)
        except httpx.HTTPError as exc:
            raise SourceUnreachableError(f"MCP request failed ({type(exc).__name__})") from None
        if 300 <= response.status_code < 400:
            raise SourceUnreachableError("the MCP host answered with a redirect; refused")
        if response.status_code >= 400:
            raise SourceUnreachableError(f"the MCP host answered status {response.status_code}")
        return response

    def _rpc(self, method: str, params: dict[str, Any]) -> tuple[dict[str, Any], httpx.Response]:
        self._next_id += 1
        request_id = self._next_id
        response = self._post(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        )
        content_type = response.headers.get("content-type", "")
        try:
            if "text/event-stream" in content_type:
                messages = _parse_sse(response.text)
            else:
                body = response.json()
                messages = body if isinstance(body, list) else [body]
        except ValueError:
            raise McpProtocolError("the MCP answer is not valid JSON") from None
        for message in messages:
            if isinstance(message, dict) and message.get("id") == request_id:
                if "error" in message:
                    error = message["error"] if isinstance(message["error"], dict) else {}
                    raise McpProtocolError(f"JSON-RPC error code {error.get('code', '?')}")
                result = message.get("result")
                if not isinstance(result, dict):
                    raise McpProtocolError("the MCP answer has no result object")
                return result, response
        raise McpProtocolError("the MCP answer has no message for the request id")

    def initialize(self) -> None:
        """MCP handshake: ``initialize`` then the ``notifications/initialized`` notification."""
        result, response = self._rpc(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": CLIENT_NAME, "version": CLIENT_VERSION},
            },
        )
        self._session_id = response.headers.get("mcp-session-id") or self._session_id
        version = result.get("protocolVersion")
        self._protocol_version = version if isinstance(version, str) else PROTOCOL_VERSION
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self._initialized = True

    def call_tool(self, name: str, arguments: Mapping[str, Any]) -> str:
        """``tools/call``: the text content of the tool result, or an exception."""
        if not self._initialized:
            self.initialize()
        result, _ = self._rpc("tools/call", {"name": name, "arguments": dict(arguments)})
        if result.get("isError"):
            raise McpProtocolError("the tool reported an error")
        content = result.get("content")
        texts = [
            item["text"]
            for item in (content if isinstance(content, list) else [])
            if isinstance(item, dict)
            and item.get("type") == "text"
            and isinstance(item.get("text"), str)
        ]
        if not texts:
            raise McpProtocolError("the tool result has no text content")
        return "\n".join(texts)

    def get_quran_verses_text(self, surah: int) -> str:
        return self.call_tool(TOOL_QURAN, quran_arguments(surah))

    def get_hadith_text(self, hadeethenc_id: int) -> str:
        return self.call_tool(TOOL_HADITH, hadith_arguments(hadeethenc_id))

    def fetch_quran_surah(self, surah: int) -> list[QuranRecord]:
        text = self.get_quran_verses_text(surah)
        try:
            return parse_quran_response(text)
        except McpParseError as exc:
            raise McpParseError(f"{exc} ({layout_summary(text)})") from None

    def fetch_hadith(self, hadeethenc_id: int, forty_number: int) -> HadithRecord:
        text = self.get_hadith_text(hadeethenc_id)
        try:
            return parse_hadith_response(text, hadeethenc_id, forty_number)
        except McpParseError as exc:
            raise McpParseError(f"{exc} ({layout_summary(text)})") from None
