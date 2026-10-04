"""The plan conversation service: E31-E34 and the rules-first turn pipeline (D75, B13).

Pipeline per learner turn (Plan-conversation.md §2.4, API-spec §4.10.2):
guard (pure) -> quick reply (rules) -> model turn (only when caps, flag and eligibility allow)
-> fallback (rules) -> record. The rules engine computes every number; the model only
interprets free text into validated parameters and phrases a short reply that passes the output
guard. Nothing is saved as a plan before ``confirm_plan``.

Integration happens through ports (``domain/planning_port.py``) that B3/B4 implement; this
module never reads the session cookie: identity arrives as a ``SessionContext``.

Privacy: learner text, goal text and model output are never logged. The outbound payload is
built from public data only, checked against an allowlist, and sent under a temporary
conversation id that is held in memory and unrelated to the stored conversation id.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID

from app.config import Settings
from app.contracts_plan_chat import (
    MAX_DAILY_TIME_ITEMS,
    MAX_RECENT_ATTEMPTS,
    PATH_ORDER,
    CatalogEdition,
    ChatMessage,
    CreatePlanChatRequest,
    Estimate,
    EstimateResult,
    LearningSummary,
    Plan,
    PlanChat,
    PlanParameters,
    PlanProposal,
    PlanSections,
    QuickReply,
    SendMessageRequest,
    StoredProposal,
    TargetScope,
)
from app.dependencies import SessionContext
from app.domain import plan_chat_policy as policy
from app.domain import plan_chat_templates as templates
from app.domain.planning_port import (
    ActivePlanConflict,
    EstimateChanged,
    LearningSummaryPort,
    PlacementNotFound,
    PlanningRuleError,
    PlanningRules,
    PlanNotActive,
    PlanNotFound,
    PlanVersionConflict,
    PlanWriter,
    RevisablePlan,
)
from app.errors import AppError, ErrorCode
from app.logging_config import log_event
from app.providers.llm import (
    PROMPT_VERSION,
    EditionSectionView,
    EditionView,
    MessageView,
    ModelContext,
    ModelReply,
    ParametersView,
    PlacementView,
    ProviderUnavailable,
    StructuredReplyProvider,
)
from app.providers.openrouter import build_default_provider
from app.repositories.ai_usage import InMemoryUsageLedger, UsageLedger, UsageRecord
from app.repositories.plan_chats import (
    ChatClosedError,
    ChatRecord,
    InMemoryPlanChatRepository,
    MessageRecord,
    PlanChatRepository,
    ProposalStaleError,
)

logger = logging.getLogger("qatra.plan_chat")

MAX_GOAL_CHARS = 500
MAX_TEXT_CHARS = 500
MODEL_CONTEXT_MESSAGES = 10
_TEMP_ID_LIMIT = 1000

_UNSET: Any = object()


def _fields(*pairs: tuple[str, str]) -> AppError:
    return AppError(
        ErrorCode.validation_error,
        details={"fields": [{"field": f, "rule": r} for f, r in pairs]},
    )


class _KeyedLocks:
    """One lock per conversation, so two simultaneous turns of one chat run one after another."""

    def __init__(self) -> None:
        self._locks: dict[UUID, threading.Lock] = {}
        self._guard = threading.Lock()

    def get(self, key: UUID) -> threading.Lock:
        with self._guard:
            if len(self._locks) > _TEMP_ID_LIMIT:
                self._locks = {k: v for k, v in self._locks.items() if v.locked()}
            return self._locks.setdefault(key, threading.Lock())


@dataclass
class _Turn:
    """The outcome of the model path for one learner message."""

    kind: (
        str  # fixed_religious | fixed_out_of_scope | confirm | text | applied | rejected | fallback
    )
    params: PlanParameters
    reply: str | None = None  # model text that passed the output guard
    model: str | None = None
    accepted: tuple[str, ...] = ()
    rejected: tuple[str, ...] = ()
    scope_locked_hit: bool = False
    params_from_model: bool = False
    note: dict[str, Any] = field(default_factory=dict)


class PlanChatService:
    def __init__(
        self,
        settings: Settings,
        *,
        repository: PlanChatRepository,
        ledger: UsageLedger,
        planning: PlanningRules,
        writer: PlanWriter,
        learning: LearningSummaryPort,
        provider: StructuredReplyProvider | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._repo = repository
        self._ledger = ledger
        self._planning = planning
        self._writer = writer
        self._learning = learning
        self._provider = provider
        self._clock = clock or (lambda: datetime.now(UTC))
        self._locks = _KeyedLocks()
        self._temp_ids: OrderedDict[UUID, UUID] = OrderedDict()
        self._temp_lock = threading.Lock()

    # ------------------------------------------------------------------ small helpers

    def _now(self) -> datetime:
        return self._clock().astimezone(UTC).replace(microsecond=0)

    def _model_enabled(self, ctx: SessionContext) -> bool:
        """The model may serve this account: a configured provider and, for real accounts,
        the ``QATRA_CHAT_MODEL_FOR_LEARNERS`` switch."""
        if self._provider is None or not self._provider.is_enabled():
            return False
        return ctx.is_demo or self._settings.QATRA_CHAT_MODEL_FOR_LEARNERS

    def _temp_id(self, chat_id: UUID) -> UUID:
        """A random id for the model, held in memory only and never equal to the chat id."""
        with self._temp_lock:
            existing = self._temp_ids.get(chat_id)
            if existing is not None:
                return existing
            value = uuid.uuid4()
            self._temp_ids[chat_id] = value
            while len(self._temp_ids) > _TEMP_ID_LIMIT:
                self._temp_ids.popitem(last=False)
            return value

    def _forget_temp_id(self, chat_id: UUID | None) -> None:
        if chat_id is not None:
            with self._temp_lock:
                self._temp_ids.pop(chat_id, None)

    def _edition(self, edition_id: UUID) -> CatalogEdition:
        try:
            return self._planning.catalog_edition(edition_id)
        except PlanningRuleError as exc:
            raise _fields((exc.field or "editionId", exc.rule)) from None

    def _estimate(
        self,
        ctx: SessionContext,
        params: PlanParameters,
        placement_id: UUID | None,
    ) -> EstimateResult:
        try:
            return self._planning.estimate(
                ctx.user_id,
                params.edition_id,
                params.target_scope,
                list(params.paths),
                params.session_minutes,
                params.preferred_date,
                placement_id,
                params.order,  # type: ignore[arg-type]
            )
        except PlanningRuleError as exc:
            raise _fields((exc.field or "targetScope", exc.rule)) from None
        except PlacementNotFound:
            raise AppError(ErrorCode.not_found) from None

    def _get_chat(self, ctx: SessionContext, chat_id: UUID) -> ChatRecord:
        chat = self._repo.get(ctx.user_id, chat_id)
        if chat is None:
            raise AppError(ErrorCode.not_found)
        return chat

    @staticmethod
    def _stored(chat: ChatRecord) -> StoredProposal | None:
        return StoredProposal.model_validate(chat.proposal) if chat.proposal else None

    @staticmethod
    def _params_of(proposal: PlanProposal) -> PlanParameters:
        return PlanParameters(
            edition_id=proposal.edition_id,
            target_scope=proposal.target_scope,
            paths=list(proposal.paths),
            order=proposal.order,
            session_minutes=proposal.session_minutes,
            preferred_date=proposal.preferred_date,
        )

    def _append(
        self,
        ctx: SessionContext,
        chat_id: UUID,
        *,
        role: str,
        kind: str,
        text: str,
        source: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self._repo.append_message(
            ctx.user_id,
            chat_id,
            role=role,
            kind=kind,
            text=text,
            source=source,
            payload=payload,
            now=self._now(),
        )

    # ------------------------------------------------------------------ proposals

    def _make_proposal(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        params: PlanParameters,
        edition: CatalogEdition,
        *,
        placement_id: UUID | None,
        plan_version: int | None,
    ) -> StoredProposal:
        result = self._estimate(ctx, params, placement_id)
        revision = chat.plan_id is not None
        sections: PlanSections = templates.build_sections(
            result.estimate,
            params,
            edition,
            chat.language,
            reason_code=result.reason_code,
            revision=revision,
        )
        return StoredProposal(
            proposal_version=chat.proposal_version + 1,
            edition_id=params.edition_id,
            target_scope=TargetScope(
                section_ordinals=sorted(set(params.target_scope.section_ordinals))
            ),
            paths=list(params.paths),  # type: ignore[arg-type]
            order=params.order,  # type: ignore[arg-type]
            session_minutes=params.session_minutes,  # type: ignore[arg-type]
            preferred_date=params.preferred_date,
            estimate=result.estimate,
            sections=sections,
            placement_session_id=placement_id,
            plan_version=plan_version,
            reason_code=result.reason_code,
        )

    def _save_proposal(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        proposal: StoredProposal,
        *,
        text: str,
        source: str,
        model: str | None = None,
        params_from_model: bool = False,
    ) -> StoredProposal:
        """Store the proposal and append the assistant ``proposal`` message."""
        dumped = proposal.model_dump(by_alias=True, mode="json")
        version = self._repo.save_proposal(ctx.user_id, chat.id, dumped, self._now())
        dumped["proposalVersion"] = version
        self._append(
            ctx,
            chat.id,
            role="assistant",
            kind="proposal",
            text=text,
            source=source,
            payload={
                "proposal": dumped,
                "model": model,
                "paramsFromModel": params_from_model,
            },
        )
        chat.proposal_version = version
        return proposal.model_copy(update={"proposal_version": version})

    # ------------------------------------------------------------------ model path

    def _cap_counts(self, ctx: SessionContext, chat: ChatRecord) -> policy.LedgerCounts:
        usage = self._ledger.counts(ctx.user_id, self._now())
        return policy.LedgerCounts(
            usage.global_day, usage.global_minute, usage.account_day, chat.model_turns
        )

    def _learning_record(self, ctx: SessionContext, chat: ChatRecord) -> LearningSummary | None:
        if chat.plan_id is None:
            return None
        try:
            summary = self._learning.summary_for(ctx.user_id, chat.plan_id, is_demo=ctx.is_demo)
        except Exception:
            return None
        return LearningSummary(
            passages=list(summary.passages),
            error_parts=list(summary.error_parts),
            daily_time=sorted(summary.daily_time, key=lambda item: item.date)[
                -MAX_DAILY_TIME_ITEMS:
            ],
            attempts=sorted(summary.attempts, key=lambda item: item.date)[-MAX_RECENT_ATTEMPTS:],
        )

    def _model_context(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        params: PlanParameters,
        edition: CatalogEdition,
        estimate: Estimate,
    ) -> ModelContext:
        ar = chat.language == "ar"
        history = chat.messages[-MODEL_CONTEXT_MESSAGES:]
        return ModelContext(
            conversation_id=str(self._temp_id(chat.id)),
            language=chat.language,  # type: ignore[arg-type]
            edition=EditionView(
                title=edition.title_ar if ar else edition.title_en,
                author=edition.author,
                content_format=edition.content_format,
                available_paths=list(edition.available_paths),
                sections=[
                    EditionSectionView(
                        ordinal=s.ordinal,
                        reference=s.reference,
                        title=s.title_ar if ar else s.title_en,
                        word_count=s.word_count,
                        passage_count=s.passage_count,
                    )
                    for s in edition.sections
                ],
            ),
            parameters=ParametersView(
                target_scope={"sectionOrdinals": list(params.target_scope.section_ordinals)},
                paths=list(params.paths),
                order=params.order,  # type: ignore[arg-type]
                session_minutes=params.session_minutes,
                preferred_date=params.preferred_date.isoformat() if params.preferred_date else None,
            ),
            estimate=estimate,
            placement=PlacementView(
                known_words=estimate.known_words, passage_count=estimate.passage_count
            ),
            messages=[MessageView(role=m.role, text=m.text) for m in history],  # type: ignore[arg-type]
            learning_record=self._learning_record(ctx, chat),
        )

    def _record_usage(
        self,
        ctx: SessionContext,
        *,
        model: str | None,
        status: str,
        reply: ModelReply | None = None,
        failure: ProviderUnavailable | None = None,
    ) -> None:
        tokens_in = reply.input_tokens if reply else (failure.input_tokens if failure else None)
        tokens_out = reply.output_tokens if reply else (failure.output_tokens if failure else None)
        self._ledger.record(
            UsageRecord(
                provider=getattr(self._provider, "name", "openrouter"),
                model=model or "unknown",
                prompt_version=PROMPT_VERSION,
                status=status,
                created_at=self._now(),
                input_tokens=tokens_in,
                output_tokens=tokens_out,
                cost_usd=reply.cost_usd if reply else None,
                quota_record={"reason": failure.reason} if failure else None,
            ),
            account=ctx.user_id,
        )

    def _model_turn(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        params: PlanParameters,
        edition: CatalogEdition,
        estimate: Estimate,
        today: date,
    ) -> _Turn:
        """One model request for the learner's latest message (already stored in ``chat``)."""
        fallback = _Turn("fallback", params)
        if not self._model_enabled(ctx) or self._provider is None:
            return fallback
        if not policy.caps_allow(self._cap_counts(ctx, chat), self._settings):
            return fallback
        context = self._model_context(ctx, chat, params, edition, estimate)
        payload = context.to_payload()
        if policy.find_disallowed_keys(payload):
            return fallback  # defence in depth for NFR-17: never send an unexpected field
        try:
            reply = self._provider.complete(
                payload,
                max_tokens=self._settings.QATRA_CHAT_MAX_TOKENS,
                timeout_sec=self._settings.QATRA_CHAT_MODEL_TIMEOUT_SEC,
            )
        except ProviderUnavailable as failure:
            if failure.reason != "disabled":
                self._record_usage(
                    ctx, model=failure.model, status=failure.usage_status, failure=failure
                )
            if failure.request_made:
                self._repo.add_model_turn(ctx.user_id, chat.id, self._now())
                chat.model_turns += 1
            return fallback
        self._record_usage(ctx, model=reply.model, status="succeeded", reply=reply)
        self._repo.add_model_turn(ctx.user_id, chat.id, self._now())
        chat.model_turns += 1

        output = reply.output
        if output.intent == "religious":
            return _Turn("fixed_religious", params, model=reply.model)
        if output.intent == "out_of_scope":
            return _Turn("fixed_out_of_scope", params, model=reply.model)
        if output.intent == "confirm":
            return _Turn("confirm", params, model=reply.model)

        patch = output.parameters.as_patch() if output.parameters else {}
        if output.intent == "set_parameters" and patch:
            merged = policy.merge_model_parameters(
                params, patch, edition, today, scope_locked=chat.plan_id is not None
            )
            scope_hit = chat.plan_id is not None and "targetScope" in merged.rejected
            kind = "applied" if merged.accepted else "rejected" if merged.rejected else "text"
            return _Turn(
                kind,
                merged.params,
                reply=output.reply,
                model=reply.model,
                accepted=merged.accepted,
                rejected=merged.rejected,
                scope_locked_hit=scope_hit,
                params_from_model=bool(merged.accepted),
            )
        return _Turn("text", params, reply=output.reply, model=reply.model)

    # ------------------------------------------------------------------ DTO assembly

    def _dto(
        self, ctx: SessionContext, chat: ChatRecord, *, replaced: UUID | None = None
    ) -> PlanChat:
        stored = self._stored(chat)
        quick: list[QuickReply] = []
        if chat.status == "open" and stored is not None:
            try:
                edition = self._planning.catalog_edition(stored.edition_id)
                codes = policy.available_quick_replies(
                    self._params_of(stored),
                    edition,
                    stored.reason_code,
                    scope_locked=chat.plan_id is not None,
                )
                quick = [templates.quick_reply(code) for code in codes]
            except PlanningRuleError:
                quick = [templates.quick_reply("confirm")]
        last_assistant = next((m for m in reversed(chat.messages) if m.role == "assistant"), None)
        assistant: dict[str, Any] = {"source": "rules"}
        if last_assistant is not None and last_assistant.source == "model":
            assistant = {
                "source": "model",
                "model": (last_assistant.payload or {}).get("model"),
            }
        cap = self._settings.QATRA_CHAT_MODEL_TURNS_PER_CHAT
        # Demo accounts send quick replies only, so no model turn is left for them.
        usable = self._model_enabled(ctx) and not ctx.is_demo
        left = max(0, cap - chat.model_turns) if usable else 0
        return PlanChat(
            chat_id=chat.id,
            status=chat.status,  # type: ignore[arg-type]
            plan_id=chat.plan_id,
            language=chat.language,  # type: ignore[arg-type]
            messages=[self._message_dto(m) for m in chat.messages],
            proposal=stored.public() if stored else None,
            quick_replies=quick,
            model_turns_left=left,
            assistant=assistant,  # type: ignore[arg-type]
            replaced_chat_id=replaced,
        )

    @staticmethod
    def _message_dto(record: MessageRecord) -> ChatMessage:
        return ChatMessage(
            message_id=record.id,
            ordinal=record.ordinal,
            role=record.role,  # type: ignore[arg-type]
            kind=record.kind,  # type: ignore[arg-type]
            text=record.text,
            source=record.source,  # type: ignore[arg-type]
            created_at=record.created_at,
        )

    # ------------------------------------------------------------------ E31

    def create_conversation(self, ctx: SessionContext, req: CreatePlanChatRequest) -> PlanChat:
        goal = req.goal_text.strip()
        if not goal or len(goal) > MAX_GOAL_CHARS:
            raise _fields(("goalText", "goal_text_length"))

        revision_plan: RevisablePlan | None = None
        if req.plan_id is not None:
            revision_plan = self._writer.load_plan(ctx.user_id, req.plan_id)
            if revision_plan is None:
                raise AppError(ErrorCode.not_found)
            if revision_plan.status == "completed":
                raise AppError(ErrorCode.version_conflict, details={"reason": "plan_not_active"})

        if revision_plan is not None:
            # A revision never changes the edition or the scope (E17; §2.9 item 1).
            edition_id = revision_plan.edition_id
            scope = list(revision_plan.target_scope.section_ordinals)
            order = revision_plan.order
            placement_id = revision_plan.placement_session_id
        else:
            edition_id = req.edition_id
            scope = list(req.target_scope.section_ordinals)
            order = "book"
            placement_id = req.placement_session_id

        edition = self._edition(edition_id)
        today = self._planning.learning_date(ctx.user_id)
        params = PlanParameters(
            edition_id=edition_id,
            target_scope=TargetScope(section_ordinals=sorted(set(scope))),
            paths=sorted(
                set(req.paths), key=lambda p: PATH_ORDER.index(p) if p in PATH_ORDER else 99
            ),
            order=order,
            session_minutes=req.session_minutes,
            preferred_date=req.preferred_date,
        )
        errors = policy.validate_parameters(params, edition, today)
        if errors:
            raise _fields(*[(e.field, e.rule) for e in errors])
        result = self._estimate(ctx, params, placement_id)  # may raise 404/422

        opened = self._repo.open_new(
            ctx.user_id,
            plan_id=revision_plan.plan_id if revision_plan else None,
            language=req.language,
            now=self._now(),
        )
        chat = opened.chat
        self._forget_temp_id(opened.replaced_chat_id)
        plan_version = revision_plan.current_version if revision_plan else None
        revision = revision_plan is not None

        self._append(ctx, chat.id, role="learner", kind="text", text=goal, source="learner")
        chat = self._get_chat(ctx, chat.id)

        composed = templates.goal_matches_composed(goal, edition, params, req.language)
        route = "rules"
        turn: _Turn | None = None
        guard_message: tuple[str, str] | None = None  # (kind, text)
        if ctx.is_demo or composed:
            pass  # rules-only first turn (a demo account's goal text never reaches the model)
        else:
            classification = policy.classify_request(goal, req.language)
            if classification == "religious":
                guard_message = ("refusal", templates.refusal_text(req.language))
                route = "guard"
            elif classification == "out_of_scope":
                guard_message = ("redirect", templates.redirect_text(req.language))
                route = "guard"
            else:
                turn = self._model_turn(ctx, chat, params, edition, result.estimate, today)
                route = "model" if turn.kind != "fallback" else "fallback"

        if guard_message is not None:
            self._append(
                ctx,
                chat.id,
                role="assistant",
                kind=guard_message[0],
                text=guard_message[1],
                source="fixed",
            )
        if turn is not None and turn.kind in ("fixed_religious", "fixed_out_of_scope"):
            religious = turn.kind == "fixed_religious"
            self._append(
                ctx,
                chat.id,
                role="assistant",
                kind="refusal" if religious else "redirect",
                text=templates.refusal_text(req.language)
                if religious
                else templates.redirect_text(req.language),
                source="fixed",
            )
        final_params = turn.params if turn is not None else params
        proposal = self._make_proposal(
            ctx, chat, final_params, edition, placement_id=placement_id, plan_version=plan_version
        )
        draft = proposal.public()
        text = templates.first_turn_message(draft, req.language, revision=revision)
        source = "rules"
        if turn is not None and turn.kind == "applied" and not turn.rejected and turn.reply:
            guarded = policy.guard_reply(turn.reply, draft, req.language)
            if guarded.ok:
                text, source = guarded.text, "model"
        self._save_proposal(
            ctx,
            chat,
            proposal,
            text=text,
            source=source,
            model=turn.model if turn and source == "model" else None,
            params_from_model=bool(turn and turn.params_from_model),
        )
        chat = self._get_chat(ctx, chat.id)
        if turn is not None:
            self._extra_first_turn_messages(ctx, chat, turn, proposal.public(), req.language)
        log_event(logger, "plan_chat_created", route=route, revision=revision)
        return self._dto(ctx, self._get_chat(ctx, chat.id), replaced=opened.replaced_chat_id)

    def _extra_first_turn_messages(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        turn: _Turn,
        proposal: PlanProposal,
        language: str,
    ) -> None:
        if turn.kind == "fallback":
            self._append_fallback(ctx, chat, proposal, language, include_summary=False)
        elif turn.kind in ("text", "rejected", "applied") and turn.rejected:
            self._append(
                ctx,
                chat.id,
                role="assistant",
                kind="text",
                text=templates.rejected_parameters_message(
                    proposal, language, scope_locked=turn.scope_locked_hit
                ),
                source="rules",
            )
        elif turn.kind == "text" and turn.reply:
            guarded = policy.guard_reply(turn.reply, proposal, language)
            if guarded.ok:
                self._append(
                    ctx,
                    chat.id,
                    role="assistant",
                    kind="text",
                    text=guarded.text,
                    source="model",
                    payload={"model": turn.model},
                )

    def _append_fallback(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        proposal: PlanProposal | None,
        language: str,
        *,
        include_summary: bool,
    ) -> None:
        shown_before = any(m.kind == "fallback" for m in chat.messages)
        text = templates.fallback_message(
            proposal, language, first_time=not shown_before, include_summary=include_summary
        )
        self._append(
            ctx,
            chat.id,
            role="assistant",
            kind="text" if shown_before else "fallback",
            text=text,
            source="rules",
        )

    # ------------------------------------------------------------------ E32

    def send_message(self, ctx: SessionContext, chat_id: UUID, req: SendMessageRequest) -> PlanChat:
        chat = self._get_chat(ctx, chat_id)
        has_text = req.text is not None
        has_quick = req.quick_reply is not None
        if has_text == has_quick:
            raise _fields(("body", "one_of_text_or_quick_reply"))
        if has_quick and req.quick_reply == "confirm":
            raise _fields(("quickReply", "quick_reply_confirm_use_e34"))
        if has_text:
            if ctx.is_demo:
                raise _fields(("text", "demo_quick_reply_only"))
            stripped = (req.text or "").strip()
            if not stripped or len(stripped) > MAX_TEXT_CHARS:
                raise _fields(("text", "text_length"))
        with self._locks.get(chat_id):
            chat = self._get_chat(ctx, chat_id)
            if chat.status != "open":
                raise AppError(ErrorCode.version_conflict, details={"reason": "chat_closed"})
            stored = self._stored(chat)
            if stored is None:  # cannot happen: E31 always stores a first proposal
                raise AppError(ErrorCode.internal)
            if has_quick:
                self._quick_reply_turn(ctx, chat, stored, str(req.quick_reply))
            else:
                self._text_turn(ctx, chat, stored, (req.text or "").strip())
            return self._dto(ctx, self._get_chat(ctx, chat_id))

    def _quick_reply_turn(
        self, ctx: SessionContext, chat: ChatRecord, stored: StoredProposal, code: str
    ) -> None:
        language = chat.language
        edition = self._edition(stored.edition_id)
        today = self._planning.learning_date(ctx.user_id)
        before = self._params_of(stored)
        self._append(
            ctx,
            chat.id,
            role="learner",
            kind="quick_reply",
            text=templates.quick_reply_label(code, language),
            source="learner",
            payload={"code": code},
        )
        outcome = policy.apply_quick_reply(
            code,
            before,
            edition,
            today=today,
            estimate_days=stored.estimate.days,
            scope_locked=chat.plan_id is not None,
        )
        if outcome.params == before:
            self._append(
                ctx,
                chat.id,
                role="assistant",
                kind="text",
                text=templates.unchanged_message(outcome.note, stored.public(), language),
                source="rules",
            )
            log_event(logger, "plan_chat_turn", route="quick_reply", changed=False)
            return
        proposal = self._make_proposal(
            ctx,
            chat,
            outcome.params,
            edition,
            placement_id=stored.placement_session_id,
            plan_version=stored.plan_version,
        )
        self._save_proposal(
            ctx,
            chat,
            proposal,
            text=templates.update_message(proposal.public(), language),
            source="rules",
        )
        log_event(logger, "plan_chat_turn", route="quick_reply", changed=True)

    def _text_turn(
        self, ctx: SessionContext, chat: ChatRecord, stored: StoredProposal, text: str
    ) -> None:
        language = chat.language
        self._append(ctx, chat.id, role="learner", kind="text", text=text, source="learner")
        chat = self._get_chat(ctx, chat.id)
        classification = policy.classify_request(text, language)
        if classification == "religious":
            self._append_fixed(ctx, chat, "refusal", templates.refusal_text(language))
            log_event(logger, "plan_chat_turn", route="guard", classification=classification)
            return
        if classification == "out_of_scope":
            self._append_fixed(ctx, chat, "redirect", templates.redirect_text(language))
            log_event(logger, "plan_chat_turn", route="guard", classification=classification)
            return

        edition = self._edition(stored.edition_id)
        today = self._planning.learning_date(ctx.user_id)
        params = self._params_of(stored)
        turn = self._model_turn(ctx, chat, params, edition, stored.estimate, today)
        current = stored.public()
        route = "fallback" if turn.kind == "fallback" else "model"
        log_event(logger, "plan_chat_turn", route=route, outcome=turn.kind)

        if turn.kind == "fallback":
            self._append_fallback(ctx, chat, current, language, include_summary=True)
        elif turn.kind == "fixed_religious":
            self._append_fixed(ctx, chat, "refusal", templates.refusal_text(language))
        elif turn.kind == "fixed_out_of_scope":
            self._append_fixed(ctx, chat, "redirect", templates.redirect_text(language))
        elif turn.kind == "confirm":
            self._append(
                ctx,
                chat.id,
                role="assistant",
                kind="text",
                text=templates.confirm_hint(language),
                source="rules",
            )
        elif turn.kind == "applied" and turn.params != params:
            proposal = self._make_proposal(
                ctx,
                chat,
                turn.params,
                edition,
                placement_id=stored.placement_session_id,
                plan_version=stored.plan_version,
            )
            draft = proposal.public()
            if turn.rejected:
                message, source = (
                    templates.rejected_parameters_message(
                        draft, language, scope_locked=turn.scope_locked_hit
                    ),
                    "rules",
                )
            else:
                message, source = self._shown_reply(turn, draft, language, templates.update_message)
            self._save_proposal(
                ctx,
                chat,
                proposal,
                text=message,
                source=source,
                model=turn.model if source == "model" else None,
                params_from_model=True,
            )
        elif turn.rejected:
            self._append(
                ctx,
                chat.id,
                role="assistant",
                kind="text",
                text=templates.rejected_parameters_message(
                    current, language, scope_locked=turn.scope_locked_hit
                ),
                source="rules",
            )
        else:
            message, source = self._shown_reply(turn, current, language, templates.templated_reply)
            self._append(
                ctx,
                chat.id,
                role="assistant",
                kind="text",
                text=message,
                source=source,
                payload={"model": turn.model} if source == "model" else None,
            )

    @staticmethod
    def _shown_reply(
        turn: _Turn,
        proposal: PlanProposal,
        language: str,
        template: Callable[[PlanProposal, str], str],
    ) -> tuple[str, str]:
        """The model's text when it passes the output guard, otherwise the templated text."""
        if turn.reply:
            guarded = policy.guard_reply(turn.reply, proposal, language)
            if guarded.ok:
                return guarded.text, "model"
        return template(proposal, language), "rules"

    def _append_fixed(self, ctx: SessionContext, chat: ChatRecord, kind: str, text: str) -> None:
        self._append(ctx, chat.id, role="assistant", kind=kind, text=text, source="fixed")

    # ------------------------------------------------------------------ E33

    def read_conversation(self, ctx: SessionContext, chat_id: UUID) -> PlanChat:
        return self._dto(ctx, self._get_chat(ctx, chat_id))

    # ------------------------------------------------------------------ E34

    def confirm_plan(
        self, ctx: SessionContext, chat_id: UUID, proposal_version: int
    ) -> tuple[Plan, bool]:
        """Save exactly the proposal the learner saw. Returns ``(plan, created)``."""
        with self._locks.get(chat_id):
            chat = self._get_chat(ctx, chat_id)
            if chat.status != "open":
                raise AppError(ErrorCode.version_conflict, details={"reason": "chat_closed"})
            if chat.proposal is None or chat.proposal_version != proposal_version:
                raise self._stale(chat)
            stored = StoredProposal.model_validate(chat.proposal)
            created = chat.plan_id is None

            def commit(record: ChatRecord) -> Plan:
                source, model = self._planner_of(record)
                if created:
                    return self._writer.create_plan(
                        ctx.user_id,
                        is_demo=ctx.is_demo,
                        edition_id=stored.edition_id,
                        target_scope=stored.target_scope,
                        paths=list(stored.paths),
                        order=stored.order,
                        session_minutes=stored.session_minutes,
                        preferred_date=stored.preferred_date,
                        placement_session_id=stored.placement_session_id,
                        confirmed_estimate=stored.estimate,
                        planner_source=source,
                        planner_model=model,
                    )
                assert record.plan_id is not None
                return self._writer.revise_plan(
                    ctx.user_id,
                    record.plan_id,
                    expected_version=stored.plan_version or 1,
                    target_scope=stored.target_scope,
                    paths=list(stored.paths),
                    order=stored.order,
                    session_minutes=stored.session_minutes,
                    preferred_date=stored.preferred_date,
                    confirmed_estimate=stored.estimate,
                )

            try:
                plan = self._repo.commit_and_close(
                    ctx.user_id, chat_id, proposal_version, commit, self._now()
                )
            except ChatClosedError:
                raise AppError(
                    ErrorCode.version_conflict, details={"reason": "chat_closed"}
                ) from None
            except ProposalStaleError:
                raise self._stale(self._get_chat(ctx, chat_id)) from None
            except EstimateChanged:
                raise self._refreshed_stale(ctx, chat_id, stored) from None
            except ActivePlanConflict:
                raise AppError(
                    ErrorCode.version_conflict, details={"reason": "active_plan_conflict"}
                ) from None
            except PlanVersionConflict as exc:
                raise AppError(
                    ErrorCode.version_conflict,
                    details={"reason": "plan_version", "currentVersion": exc.current_version},
                ) from None
            except PlanNotActive:
                raise AppError(
                    ErrorCode.version_conflict, details={"reason": "plan_not_active"}
                ) from None
            except PlanNotFound:
                raise AppError(ErrorCode.not_found) from None
            self._forget_temp_id(chat_id)
            log_event(logger, "plan_chat_confirmed", created=created)
            return plan, created

    @staticmethod
    def _planner_of(chat: ChatRecord) -> tuple[Any, str | None]:
        """``teaching_agent`` when a model turn supplied parameters (§2.9 item 6)."""
        for message in chat.messages:
            payload = message.payload or {}
            if payload.get("paramsFromModel"):
                return "teaching_agent", payload.get("model")
        return "rules", None

    @staticmethod
    def _stale(chat: ChatRecord) -> AppError:
        proposal = (
            StoredProposal.model_validate(chat.proposal)
            .public()
            .model_dump(by_alias=True, mode="json")
            if chat.proposal
            else None
        )
        return AppError(
            ErrorCode.version_conflict,
            "The proposal changed; confirm the current one.",
            details={"reason": "proposal_stale", "proposal": proposal},
        )

    def _refreshed_stale(
        self, ctx: SessionContext, chat_id: UUID, stored: StoredProposal
    ) -> AppError:
        """The E16/E17 recomputation differs (for example a new learning day): rebuild the
        proposal under a new version so the learner confirms the fresh numbers."""
        chat = self._get_chat(ctx, chat_id)
        edition = self._edition(stored.edition_id)
        fresh = self._make_proposal(
            ctx,
            chat,
            self._params_of(stored),
            edition,
            placement_id=stored.placement_session_id,
            plan_version=stored.plan_version,
        )
        self._save_proposal(
            ctx,
            chat,
            fresh,
            text=templates.update_message(fresh.public(), chat.language),
            source="rules",
        )
        return self._stale(self._get_chat(ctx, chat_id))


def build_plan_chat_service(
    settings: Settings,
    *,
    planning: PlanningRules,
    writer: PlanWriter,
    learning: LearningSummaryPort,
    repository: PlanChatRepository | None = None,
    ledger: UsageLedger | None = None,
    provider: Any = _UNSET,
    clock: Callable[[], datetime] | None = None,
) -> PlanChatService:
    """Wire the service. ``provider`` defaults to OpenRouter when a key and candidates are
    configured (otherwise ``None``: every turn is a rules turn); pass ``None`` to force that.
    B3/B4 call this once at startup and store the result on ``app.state.plan_chat_service``."""
    return PlanChatService(
        settings,
        repository=repository or InMemoryPlanChatRepository(),
        ledger=ledger or InMemoryUsageLedger(),
        planning=planning,
        writer=writer,
        learning=learning,
        provider=build_default_provider(settings) if provider is _UNSET else provider,
        clock=clock,
    )
