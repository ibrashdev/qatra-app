"""Account endpoints E11-E13 (API-spec §4.3): profile read, settings update, account deletion.

E11 and E12 return the ``Profile`` DTO itself. E11 is readable while the terms are outdated
(re-consent gate, O-10); E12 and E13 are not. E13 answers ``204`` and clears the cookie. Every
mutation lists ``require_valid_origin`` first, then the per-IP limiter, then the session.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from app.config import Settings
from app.contracts import ErrorEnvelope
from app.contracts_auth import DeleteAccountRequest, Profile, ProfilePatchRequest
from app.dependencies import (
    ResolvedSession,
    get_settings,
    require_session_details,
    require_session_details_allow_reconsent,
    require_valid_origin,
)
from app.routers.auth import (
    clear_session_cookie,
    client_prefix,
    get_account_service,
    limit_session_read,
    limit_session_write,
)
from app.services.account import AccountService

router = APIRouter(prefix="/api", tags=["account"])

_NO_STORE = "no-store"

_ERRORS = {
    400: {"model": ErrorEnvelope, "description": "terms_required"},
    401: {"model": ErrorEnvelope, "description": "unauthenticated or invalid_credentials"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}

Service = Annotated[AccountService, Depends(get_account_service)]
Session = Annotated[ResolvedSession, Depends(require_session_details)]
SessionAllowingReconsent = Annotated[
    ResolvedSession, Depends(require_session_details_allow_reconsent)
]
SettingsDep = Annotated[Settings, Depends(get_settings)]


@router.get(
    "/me",
    response_model=Profile,
    response_model_by_alias=True,
    summary="Read the account (E11)",
    responses={k: v for k, v in _ERRORS.items() if k in (401, 429, 503)},
    dependencies=[
        Depends(limit_session_read),
        Depends(require_session_details_allow_reconsent),
    ],
)
def get_me(response: Response, session: SessionAllowingReconsent, service: Service) -> Profile:
    response.headers["Cache-Control"] = _NO_STORE
    return service.read_profile(session)


@router.patch(
    "/me",
    response_model=Profile,
    response_model_by_alias=True,
    summary="Change the account settings (E12)",
    responses=_ERRORS,
    dependencies=[
        Depends(require_valid_origin),
        Depends(limit_session_write),
        Depends(require_session_details),
    ],
)
def update_me(
    body: ProfilePatchRequest, response: Response, session: Session, service: Service
) -> Profile:
    response.headers["Cache-Control"] = _NO_STORE
    return service.update_profile(session, body)


@router.post(
    "/account/delete",
    status_code=204,
    response_class=Response,
    summary="Delete the account (E13)",
    responses=_ERRORS,
    dependencies=[
        Depends(require_valid_origin),
        Depends(limit_session_write),
        Depends(require_session_details),
    ],
)
def delete_account(
    body: DeleteAccountRequest,
    request: Request,
    session: Session,
    service: Service,
    settings: SettingsDep,
) -> Response:
    service.delete_account(
        session, password=body.password, confirm=body.confirm, ip_prefix=client_prefix(request)
    )
    response = Response(status_code=204, headers={"Cache-Control": _NO_STORE})
    clear_session_cookie(response, settings)
    return response
