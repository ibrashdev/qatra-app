"""Plan conversation endpoints E31-E34 (API-spec §4.10; Plan-conversation.md §2.3).

Every mutation lists ``require_valid_origin`` before ``require_session`` and then the per-IP
"Chat write" limiter (``QATRA_RATE_CHAT_WRITE_PER_MIN``). Bodies, goal text, messages and model
output are never logged here (API-spec §1.12). Handlers are synchronous: the model call blocks
for up to 8 s, so they run in the framework's thread pool, not on the event loop.

The service is created at startup by the package that supplies the ports (B3/B4) with
``build_plan_chat_service`` and stored on ``app.state.plan_chat_service``; without it the
endpoints answer ``503 unavailable`` (nothing is faked).
"""

from __future__ import annotations

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
from app.errors import AppError, ErrorCode
from app.routers.health import ip_rate_limit
from app.services.plan_chat import PlanChatService

router = APIRouter(prefix="/api", tags=["plan-chats"])

_NO_STORE = "no-store"

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


# Chat write class: E31, E32 and E34.
enforce_chat_write_limit = ip_rate_limit("chat_write_limiter", "QATRA_RATE_CHAT_WRITE_PER_MIN")


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
