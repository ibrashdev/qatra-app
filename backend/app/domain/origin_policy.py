"""Origin policy (pure): which requests must carry the frontend ``Origin`` (API-spec §1.3).

Shared by ``OriginGuardMiddleware`` (runs first) and the ``require_valid_origin`` dependency
(declared per route; documents and double-checks the guard).
"""

from __future__ import annotations

STATE_CHANGING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def is_origin_allowed(method: str, origin: str | None, frontend_origin: str | None) -> bool:
    """GET, HEAD and OPTIONS are exempt. A state-changing method needs an ``Origin`` equal to
    ``frontend_origin`` exactly; a missing header, or an unset configuration, is a mismatch."""
    if method.upper() not in STATE_CHANGING_METHODS:
        return True
    return origin is not None and frontend_origin is not None and origin == frontend_origin
