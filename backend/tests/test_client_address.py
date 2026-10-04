"""The client address behind proxies: ``QATRA_TRUSTED_XFF_DEPTH`` and the one function that feeds
every per-IP limiter and the throttle prefix."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.main import create_app
from app.routers.auth import client_prefix
from app.routers.health import client_key, forwarded_client
from tests.support import make_settings

PEER = "10.1.2.3"


def request_for(
    *forwarded: str,
    depth: int = 0,
    peer: str | None = PEER,
    with_app: bool = True,
) -> Request:
    """A bare request with one ``X-Forwarded-For`` header line per argument."""
    scope: dict[str, object] = {
        "type": "http",
        "method": "GET",
        "headers": [(b"x-forwarded-for", value.encode()) for value in forwarded],
        "client": (peer, 5000) if peer is not None else None,
    }
    if with_app:
        settings = make_settings(QATRA_TRUSTED_XFF_DEPTH=depth)
        scope["app"] = SimpleNamespace(state=SimpleNamespace(settings=settings))
    return Request(scope)


def test_depth_zero_uses_the_peer_and_ignores_the_header() -> None:
    assert client_key(request_for("203.0.113.7", depth=0)) == PEER


def test_the_default_depth_is_zero() -> None:
    assert make_settings().QATRA_TRUSTED_XFF_DEPTH == 0


def test_without_a_peer_the_key_is_unknown_at_every_depth() -> None:
    assert client_key(request_for(depth=0, peer=None)) == "unknown"
    assert client_key(request_for("not an ip", depth=1, peer=None)) == "unknown"


def test_a_request_without_an_application_uses_the_peer() -> None:
    assert client_key(request_for("203.0.113.7", with_app=False)) == PEER


def test_depth_one_is_the_last_entry() -> None:
    assert client_key(request_for("198.51.100.1, 203.0.113.7", depth=1)) == "203.0.113.7"
    assert client_key(request_for("203.0.113.7", depth=1)) == "203.0.113.7"


def test_depth_two_is_the_second_entry_from_the_right() -> None:
    header = "198.51.100.1, 203.0.113.7, 192.0.2.9"
    assert client_key(request_for(header, depth=2)) == "203.0.113.7"


def test_entries_written_by_the_client_on_the_left_are_never_believed() -> None:
    forged = "9.9.9.9, 8.8.8.8, 203.0.113.7, 192.0.2.9"
    assert client_key(request_for(forged, depth=2)) == "203.0.113.7"
    assert client_key(request_for(forged, depth=1)) == "192.0.2.9"


def test_whitespace_around_entries_is_ignored() -> None:
    assert client_key(request_for("  203.0.113.7  ,   192.0.2.9 ", depth=2)) == "203.0.113.7"


def test_several_header_lines_count_as_one_list_in_order() -> None:
    assert client_key(request_for("198.51.100.1", "203.0.113.7, 192.0.2.9", depth=2)) == (
        "203.0.113.7"
    )
    assert client_key(request_for("198.51.100.1", "203.0.113.7", depth=1)) == "203.0.113.7"


@pytest.mark.parametrize(
    ("header", "depth"),
    [
        ("203.0.113.7", 2),
        ("203.0.113.7, 192.0.2.9", 3),
        ("", 1),
    ],
)
def test_a_header_with_fewer_entries_than_the_depth_falls_back_to_the_peer(
    header: str, depth: int
) -> None:
    assert client_key(request_for(header, depth=depth)) == PEER


def test_a_missing_header_falls_back_to_the_peer() -> None:
    assert client_key(request_for(depth=1)) == PEER
    assert client_key(request_for(depth=2)) == PEER


@pytest.mark.parametrize(
    "entry",
    [
        "garbage",
        "999.1.1.1",
        "1.2.3",
        "1.2.3.4:5678",
        "[2001:db8::1]",
        "01.2.3.4",
        "unknown",
        "2001:db8::1%eth0",
        "203.0.113.7/24",
        "-1",
        "",
    ],
)
def test_an_entry_that_is_not_an_ip_falls_back_to_the_peer(entry: str) -> None:
    assert client_key(request_for(f"198.51.100.1, {entry}", depth=1)) == PEER
    assert client_key(request_for(f"{entry}, 192.0.2.9", depth=2)) == PEER


def test_a_garbage_entry_beyond_the_depth_does_not_matter() -> None:
    assert client_key(request_for("garbage, 203.0.113.7", depth=1)) == "203.0.113.7"


def test_an_empty_entry_from_a_trailing_comma_is_garbage_not_skipped() -> None:
    assert client_key(request_for("203.0.113.7,", depth=1)) == PEER


def test_an_ipv6_entry_is_returned_in_canonical_form() -> None:
    assert client_key(request_for("2001:DB8:0:0:0:0:0:1", depth=1)) == "2001:db8::1"
    assert client_key(request_for("198.51.100.1, 2001:db8::1", depth=1)) == "2001:db8::1"


def test_one_client_has_one_key_whatever_the_spelling() -> None:
    spellings = ["2001:db8::1", "2001:DB8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"]
    assert {client_key(request_for(s, depth=1)) for s in spellings} == {"2001:db8::1"}


def test_an_ipv4_mapped_ipv6_entry_is_the_ipv4_address() -> None:
    assert client_key(request_for("::ffff:203.0.113.7", depth=1)) == "203.0.113.7"


def test_ipv4_and_ipv6_entries_can_be_mixed_in_one_header() -> None:
    header = "2001:db8::5, 203.0.113.7, 2001:db8::9"
    assert client_key(request_for(header, depth=1)) == "2001:db8::9"
    assert client_key(request_for(header, depth=2)) == "203.0.113.7"
    assert client_key(request_for(header, depth=3)) == "2001:db8::5"


def test_forwarded_client_is_pure() -> None:
    assert forwarded_client("203.0.113.7, 192.0.2.9", 2) == "203.0.113.7"
    assert forwarded_client("203.0.113.7", 0) is None
    assert forwarded_client("203.0.113.7", 2) is None


def test_the_throttle_prefix_follows_the_trusted_address() -> None:
    assert client_prefix(request_for("198.51.100.77", depth=1)) == "198.51.100.0/24"
    assert client_prefix(request_for("2001:db8:1:2::5", depth=1)) == "2001:db8:1::/48"
    assert client_prefix(request_for("198.51.100.77", depth=0)) == "10.1.2.0/24"


def test_the_throttle_prefix_of_a_peer_that_is_not_an_address_is_the_shared_unknown() -> None:
    assert client_prefix(request_for(depth=0, peer="testclient")) == "unknown/0"


def limited_app(depth: int, **overrides: int) -> FastAPI:
    return create_app(make_settings(QATRA_TRUSTED_XFF_DEPTH=depth, **overrides))


def get_from(client: TestClient, path: str, forwarded: str) -> int:
    return client.get(path, headers={"X-Forwarded-For": forwarded}).status_code


@pytest.mark.parametrize(
    ("path", "overrides"),
    [
        ("/api/health/ready", {"QATRA_READY_RATE_PER_MIN": 1}),
        ("/api/catalog", {"QATRA_RATE_PUBLIC_READ_PER_MIN": 1}),
    ],
)
def test_limiters_count_each_trusted_address_separately(
    path: str, overrides: dict[str, int]
) -> None:
    with TestClient(limited_app(2, **overrides)) as client:
        first = "1.1.1.1, 198.51.100.1, 10.0.0.9"
        second = "1.1.1.1, 198.51.100.2, 10.0.0.9"
        assert get_from(client, path, first) == 200
        assert get_from(client, path, second) == 200  # same peer and left entry, other client
        assert get_from(client, path, first) == 429


@pytest.mark.parametrize(
    ("path", "overrides"),
    [
        ("/api/health/ready", {"QATRA_READY_RATE_PER_MIN": 1}),
        ("/api/catalog", {"QATRA_RATE_PUBLIC_READ_PER_MIN": 1}),
    ],
)
def test_at_depth_zero_the_header_cannot_buy_another_window(
    path: str, overrides: dict[str, int]
) -> None:
    with TestClient(limited_app(0, **overrides)) as client:
        assert get_from(client, path, "198.51.100.1") == 200
        assert get_from(client, path, "198.51.100.2") == 429


def test_a_client_cannot_rotate_the_entries_the_proxies_did_not_write() -> None:
    with TestClient(limited_app(1, QATRA_RATE_PUBLIC_READ_PER_MIN=1)) as client:
        statuses = [
            get_from(client, "/api/catalog", f"{forged}, 203.0.113.7")
            for forged in ("1.1.1.1", "2.2.2.2", "3.3.3.3")
        ]
    assert statuses == [200, 429, 429]
