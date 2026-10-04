"""Pydantic DTOs shared by routers and services (API-spec §1.5, §4.1)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.errors import ErrorCode


class HealthResponse(BaseModel):
    """E01 body. No account data, secrets or internal details."""

    status: Literal["ok"]
    version: str
    time: datetime


class ReadyResponse(BaseModel):
    """E02 body: deliberately minimal."""

    status: Literal["ok"]


class ErrorBody(BaseModel):
    code: ErrorCode
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class ErrorEnvelope(BaseModel):
    error: ErrorBody
