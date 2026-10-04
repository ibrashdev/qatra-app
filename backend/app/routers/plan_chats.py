"""Plan conversation endpoints E31-E34 (API-spec §4.10; Plan-conversation.md §2.3).

Every mutation lists ``require_valid_origin`` before ``require_session`` and then the per-IP
"Chat write" limiter (20 per client IP per minute). Bodies, goal text, messages and model
output are never logged here (API-spec §1.12). Handlers are synchronous: the model call blocks
for up to 8 s, so they run in the framework's thread pool, not on the event loop.

The service is created at startup by the package that supplies the ports (B3/B4) with
``build_plan_chat_service`` and stored on ``app.state.plan_chat_service``; without it the
endpoints answer ``503 unavailable`` (nothing is faked).
"""

from __future__ import annotations

import threading
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from app.contracts import ErrorEnvelope
from app.contracts_plan_chat import (
    ConfirmRequest,
    CreatePlanChatRequest,
    Plan,
    PlanChat,
    SendMessageRequest,
)
from app.dependencies import SessionContext, require_session, require_valid_origin
from app.domain.rate_limit import SlidingWindowLimiter
from app.errors import AppError, ErrorCode
from app.routers.health import client_key
from app.services.plan_chat import PlanChatService

router = APIRouter(prefix="/api", tags=["plan-chats"])

CHAT_WRITE_RATE_PER_MIN = 20  # configuration default (API-spec §1.8), not an approved number
_NO_STORE = "no-store"
_limiter_lock = threading.Lock()

_ERRORS = {
    401: {"model": ErrorEnvelope, "description": "unauthenticated"},
    403: {"model": ErrorEnvelope, "description": "forbidden_origin"},
    404: {"model": ErrorEnvelope, "description": "not_found"},
    409: {"model": ErrorEnvelope, "description": "version_conflict"},
    422: {"model": ErrorEnvelope, "description": "validation_error"},
    429: {"model": ErrorEnvelope, "description": "throttled"},
    503: {"model": ErrorEnvelope, "description": "unavailable"},
}


def get_plan_chat_service(request: Request) -> PlanChatService:
    service: PlanChatService | None = getattr(request.app.state, "plan_chat_service", None)
    if service is None:
        raise AppError(ErrorCode.unavailable)
    return service


def enforce_chat_write_limit(request: Request) -> None:
    """Chat write class: E31, E32 and E34, per client IP (the address is never logged)."""
    limiter: SlidingWindowLimiter | None = getattr(request.app.state, "chat_write_limiter", None)
    if limiter is None:
        with _limiter_lock:
            limiter = getattr(request.app.state, "chat_write_limiter", None)
            if limiter is None:
                limiter = SlidingWindowLimiter(CHAT_WRITE_RATE_PER_MIN)
                request.app.state.chat_write_limiter = limiter
    decision = limiter.check(client_key(request))
    if not decision.allowed:
        raise AppError(ErrorCode.throttled, retry_after=decision.retry_after_sec)


Service = Annotated[PlanChatService, Depends(get_plan_chat_service)]
Session = Annotated[SessionContext, Depends(require_session)]
_WRITE_GUARDS = [
    Depends(require_valid_origin),
    Depends(require_session),
    Depends(enforce_chat_write_limit),
]


@router.post(
    "/plan-chats",
    response_model=PlanChat,
    response_model_by_alias=True,
    status_code=201,
    summary="Create a plan conversation (E31)",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def create_plan_chat(
    body: CreatePlanChatRequest, response: Response, ctx: Session, service: Service
) -> PlanChat:
    response.headers["Cache-Control"] = _NO_STORE
    return service.create_conversation(ctx, body)


@router.post(
    "/plan-chats/{chat_id}/messages",
    response_model=PlanChat,
    response_model_by_alias=True,
    summary="Send one learner turn (E32)",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def send_plan_chat_message(
    chat_id: UUID,
    body: SendMessageRequest,
    response: Response,
    ctx: Session,
    service: Service,
) -> PlanChat:
    response.headers["Cache-Control"] = _NO_STORE
    return service.send_message(ctx, chat_id, body)


@router.get(
    "/plan-chats/{chat_id}",
    response_model=PlanChat,
    response_model_by_alias=True,
    summary="Read a plan conversation (E33)",
    responses=_ERRORS,
)
def read_plan_chat(chat_id: UUID, response: Response, ctx: Session, service: Service) -> PlanChat:
    response.headers["Cache-Control"] = _NO_STORE
    return service.read_conversation(ctx, chat_id)


@router.post(
    "/plan-chats/{chat_id}/confirm",
    response_model=Plan,
    response_model_by_alias=True,
    status_code=201,
    summary="Confirm the current proposal (E34)",
    responses=_ERRORS,
    dependencies=_WRITE_GUARDS,
)
def confirm_plan_chat(
    chat_id: UUID,
    body: ConfirmRequest,
    response: Response,
    ctx: Session,
    service: Service,
) -> Plan:
    response.headers["Cache-Control"] = _NO_STORE
    plan, created = service.confirm_plan(ctx, chat_id, body.proposal_version)
    response.status_code = 201 if created else 200
    return plan
