"""The plan conversation service: E31-E34 and the rules-first turn pipeline (D75, B13).

Pipeline per learner turn (Plan-conversation.md §2.4, API-spec §4.10.2):
guard (pure) -> quick reply (rules) -> model turn (only when caps, flag and eligibility allow)
-> fallback (rules) -> record. The rules engine computes every number; the model only
interprets free text into validated parameters and phrases a short reply that passes the output
guard. Nothing is saved as a plan before ``confirm_plan``.

Integration happens through ports (``domain/planning_port.py``) that B3/B4 implement; this
module never reads the session cookie: identity arrives as a ``SessionContext``.

Wiring (B13): the ports of B4 and the learner's access token are bound per request, so the
application installs a ``PlanChatGateway`` (``app.state.plan_chat_service``) that builds one
``PlanChatService`` per call from ``PlanService.ports_for(ctx)``, a repository and a learning
adapter. What must outlive a request (per-conversation locks, temporary model ids) lives in the
shared ``ChatRuntime``. E31 builds the whole first turn in memory and stores it with one
repository call; E34 writes the plan and closes the conversation through a ``PlanConfirmer``:
under one lock in memory mode, in one database function (``app_plan_chat_confirm``) in
supabase mode.

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
from typing import TYPE_CHECKING, Any, Protocol
from uuid import UUID

from app.config import Settings
from app.contracts_plan_chat import (
    MAX_DAILY_TIME_ITEMS,
    MAX_RECENT_ATTEMPTS,
    PATH_ORDER,
    SESSION_MINUTES_OPTIONS,
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
from app.domain.plan_policy import EstimateMismatch, PlanInputError
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
    FastestPlanView,
    LimitsView,
    MessageView,
    ModelContext,
    ModelReply,
    ParametersView,
    PlacementView,
    ProviderUnavailable,
    StructuredReplyProvider,
)
from app.providers.openrouter import build_default_provider
from app.repositories.ai_usage import (
    InMemoryUsageLedger,
    PostgresUsageLedger,
    UsageLedger,
    UsageRecord,
)
from app.repositories.plan_chats import (
    ChatClosedError,
    ChatNotFoundError,
    ChatRecord,
    InMemoryPlanChatRepository,
    LocalPlanChatRepository,
    MessageRecord,
    NewMessage,
    PlanChatRepository,
    PlanVersionMoved,
    PostgrestPlanChatRepository,
    ProposalStaleError,
)
from app.services.plan_chat_learning import EmptyLearningSummary, PlanChatLearningSummary
from app.services.plans import PlanService, plan_dto

if TYPE_CHECKING:
    from app.providers.postgrest import PostgrestClient
    from app.repositories.bank import BankRepository
    from app.repositories.learning import LearningRepository

logger = logging.getLogger("qatra.plan_chat")

MAX_GOAL_CHARS = 500
MAX_TEXT_CHARS = 500
MODEL_CONTEXT_MESSAGES = 10
_TEMP_ID_LIMIT = 1000

_UNSET: Any = object()

# The route label of a model-path outcome in the log (names only).
_TURN_ROUTES = {"fallback": "fallback", "rules_only": "rules"}


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


class ChatRuntime:
    """State that must outlive one request and is shared by every request-scoped service: the
    per-conversation locks and the temporary model ids (held in memory only, never stored or
    logged)."""

    def __init__(self) -> None:
        self.locks = _KeyedLocks()
        self._temp_ids: OrderedDict[UUID, UUID] = OrderedDict()
        self._temp_lock = threading.Lock()

    def temp_id(self, chat_id: UUID) -> UUID:
        """A random id for the model, never equal to the chat id, stable for one conversation."""
        with self._temp_lock:
            existing = self._temp_ids.get(chat_id)
            if existing is not None:
                return existing
            value = uuid.uuid4()
            self._temp_ids[chat_id] = value
            while len(self._temp_ids) > _TEMP_ID_LIMIT:
                self._temp_ids.popitem(last=False)
            return value

    def forget_temp_id(self, chat_id: UUID | None) -> None:
        if chat_id is not None:
            with self._temp_lock:
                self._temp_ids.pop(chat_id, None)

    def rekey_temp_id(self, old: UUID, new: UUID) -> None:
        """The first turn runs before the conversation has its stored id: keep its temporary id."""
        with self._temp_lock:
            value = self._temp_ids.pop(old, None)
            if value is not None:
                self._temp_ids[new] = value


@dataclass
class _Turn:
    """The outcome of the model path for one learner message."""

    kind: (
        str  # fixed_religious | fixed_out_of_scope | confirm | text | applied | rejected | fallback
        # | rules_only (the model is switched off by configuration)
    )
    params: PlanParameters
    reply: str | None = None  # model text that passed the output guard
    model: str | None = None
    accepted: tuple[str, ...] = ()
    rejected: tuple[str, ...] = ()
    scope_locked_hit: bool = False
    params_from_model: bool = False
    note: dict[str, Any] = field(default_factory=dict)
    limits: policy.PlanLimits | None = None  # the fastest plan the model was shown, if any


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
        runtime: ChatRuntime | None = None,
        confirmer: PlanConfirmer | None = None,
    ) -> None:
        self._settings = settings
        self._repo = repository
        self._ledger = ledger
        self._planning = planning
        self._writer = writer
        self._learning = learning
        self._provider = provider
        self._clock = clock or (lambda: datetime.now(UTC))
        self._runtime = runtime or ChatRuntime()
        if confirmer is None:
            if not hasattr(repository, "commit_and_close"):
                raise TypeError("a repository without commit_and_close needs a confirmer")
            confirmer = LocalPlanConfirmer(repository, writer)  # type: ignore[arg-type]
        self._confirmer = confirmer

    # ------------------------------------------------------------------ small helpers

    def _now(self) -> datetime:
        return self._clock().astimezone(UTC).replace(microsecond=0)

    def _model_enabled(self, ctx: SessionContext) -> bool:
        """The model may serve this account: a configured provider and, for real accounts,
        the ``QATRA_CHAT_MODEL_FOR_LEARNERS`` switch."""
        if self._provider is None or not self._provider.is_enabled():
            return False
        return ctx.is_demo or self._settings.QATRA_CHAT_MODEL_FOR_LEARNERS

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

    def _plan_limits(
        self, ctx: SessionContext, params: PlanParameters, placement_id: UUID | None
    ) -> policy.PlanLimits | None:
        """The fastest plan the rules allow for the same edition, scope and paths: the largest
        daily minutes and no preferred date. A failure here never breaks the turn."""
        try:
            result = self._planning.estimate(
                ctx.user_id,
                params.edition_id,
                params.target_scope,
                list(params.paths),
                max(SESSION_MINUTES_OPTIONS),
                None,
                placement_id,
                params.order,  # type: ignore[arg-type]
            )
        except Exception:
            return None
        return policy.PlanLimits(
            max(SESSION_MINUTES_OPTIONS), result.estimate.days, result.estimate.end_date
        )

    def _model_context(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        params: PlanParameters,
        edition: CatalogEdition,
        estimate: Estimate,
        limits: policy.PlanLimits | None = None,
    ) -> ModelContext:
        ar = chat.language == "ar"
        history = chat.messages[-MODEL_CONTEXT_MESSAGES:]
        return ModelContext(
            conversation_id=str(self._runtime.temp_id(chat.id)),
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
            messages=[
                MessageView(role=m.role, text=policy.redact_contact_details(m.text))  # type: ignore[arg-type]
                for m in history
            ],
            learning_record=self._learning_record(ctx, chat),
            limits=LimitsView(
                session_minutes_options=list(SESSION_MINUTES_OPTIONS),
                fastest=FastestPlanView(
                    session_minutes=limits.session_minutes,
                    days=limits.days,
                    end_date=limits.end_date.isoformat(),
                ),
            )
            if limits is not None
            else None,
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
        *,
        persist: bool = True,
        placement_id: UUID | None = None,
    ) -> _Turn:
        """One model request for the learner's latest message (already in ``chat.messages``).

        ``persist`` is false for the first turn of E31, whose conversation is not stored yet:
        the model turns it used are counted on ``chat`` and stored with the first turn."""
        fallback = _Turn("fallback", params)
        if not ctx.is_demo and not self._settings.QATRA_CHAT_MODEL_FOR_LEARNERS:
            # Switched off by configuration (D76): a rules-only conversation without the
            # "assistant unavailable" notice (UI-screens, S-34 state "Model switched off").
            return _Turn("rules_only", params)
        if not self._model_enabled(ctx) or self._provider is None:
            return fallback
        if not policy.caps_allow(self._cap_counts(ctx, chat), self._settings):
            return fallback
        limits = self._plan_limits(ctx, params, placement_id)
        context = self._model_context(ctx, chat, params, edition, estimate, limits)
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
                if persist:
                    self._repo.add_model_turn(ctx.user_id, chat.id, self._now())
                chat.model_turns += 1
            return fallback
        self._record_usage(ctx, model=reply.model, status="succeeded", reply=reply)
        if persist:
            self._repo.add_model_turn(ctx.user_id, chat.id, self._now())
        chat.model_turns += 1

        output = reply.output
        if output.intent == "religious":
            return _Turn("fixed_religious", params, model=reply.model, limits=limits)
        if output.intent == "out_of_scope":
            return _Turn("fixed_out_of_scope", params, model=reply.model, limits=limits)
        if output.intent == "confirm":
            return _Turn("confirm", params, model=reply.model, limits=limits)

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
                limits=limits,
            )
        return _Turn("text", params, reply=output.reply, model=reply.model, limits=limits)

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
        # One first turn per account at a time: a second simultaneous call waits, then replaces
        # the first conversation. The lock key is the account id; no conversation id equals it.
        with self._runtime.locks.get(ctx.user_id):
            return self._create_conversation(ctx, req)

    def _create_conversation(self, ctx: SessionContext, req: CreatePlanChatRequest) -> PlanChat:
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

        plan_version = revision_plan.current_version if revision_plan else None
        revision = revision_plan is not None
        now = self._now()
        # The conversation is stored once, after the first turn is complete (migration 0006:
        # ``app_plan_chat_open``), so the model and the guard work on this unsaved draft.
        chat = self._draft_chat(ctx, req.language, revision_plan, goal, now)

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
                turn = self._model_turn(
                    ctx,
                    chat,
                    params,
                    edition,
                    result.estimate,
                    today,
                    persist=False,
                    placement_id=placement_id,
                )
                route = _TURN_ROUTES.get(turn.kind, "model")

        assistant: list[NewMessage] = []
        if guard_message is not None:
            assistant.append(NewMessage("assistant", guard_message[0], guard_message[1], "fixed"))
        if turn is not None and turn.kind in ("fixed_religious", "fixed_out_of_scope"):
            religious = turn.kind == "fixed_religious"
            assistant.append(
                NewMessage(
                    "assistant",
                    "refusal" if religious else "redirect",
                    templates.refusal_text(req.language)
                    if religious
                    else templates.redirect_text(req.language),
                    "fixed",
                )
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
        dumped = proposal.model_dump(by_alias=True, mode="json")
        assistant.append(
            NewMessage(
                "assistant",
                "proposal",
                text,
                source,
                payload={
                    "proposal": dumped,
                    # The model id is kept whenever the model supplied the parameters, also
                    # when its text was replaced by the template: it becomes ``planner.model``.
                    "model": turn.model
                    if turn and (source == "model" or turn.params_from_model)
                    else None,
                    "paramsFromModel": bool(turn and turn.params_from_model),
                },
            )
        )
        if turn is not None:
            assistant.extend(self._first_turn_extras(turn, draft, req.language))

        try:
            opened = self._repo.open_chat(
                ctx.user_id,
                plan_id=chat.plan_id,
                language=req.language,
                learner_text=goal,
                assistant=assistant,
                proposal=dumped,
                model_turns=chat.model_turns,
                now=now,
            )
        except PlanNotActive:
            raise AppError(
                ErrorCode.version_conflict, details={"reason": "plan_not_active"}
            ) from None
        except PlanNotFound:
            raise AppError(ErrorCode.not_found) from None
        self._runtime.rekey_temp_id(chat.id, opened.chat.id)
        self._runtime.forget_temp_id(opened.replaced_chat_id)
        log_event(logger, "plan_chat_created", route=route, revision=revision)
        return self._dto(ctx, opened.chat, replaced=opened.replaced_chat_id)

    @staticmethod
    def _draft_chat(
        ctx: SessionContext,
        language: str,
        revision_plan: RevisablePlan | None,
        goal: str,
        now: datetime,
    ) -> ChatRecord:
        """The first turn's conversation before it is stored: a random provisional id, the
        learner's goal text as the only message, no proposal and no model turn yet."""
        chat_id = uuid.uuid4()
        goal_message = MessageRecord(
            id=uuid.uuid4(),
            chat_id=chat_id,
            user_id=ctx.user_id,
            ordinal=1,
            role="learner",
            kind="text",
            text=goal,
            source="learner",
            payload=None,
            created_at=now,
        )
        return ChatRecord(
            id=chat_id,
            user_id=ctx.user_id,
            plan_id=revision_plan.plan_id if revision_plan else None,
            status="open",
            language=language,
            proposal=None,
            proposal_version=0,
            model_turns=0,
            created_at=now,
            updated_at=now,
            messages=[goal_message],
        )

    def _first_turn_extras(
        self, turn: _Turn, proposal: PlanProposal, language: str
    ) -> list[NewMessage]:
        """Assistant messages that follow the first proposal message."""
        if turn.kind == "fallback":
            return [self._fallback_message(proposal, language, first_time=True, summary=False)]
        if turn.kind in ("text", "rejected", "applied") and turn.rejected:
            return [
                NewMessage(
                    "assistant",
                    "text",
                    templates.rejected_parameters_message(
                        proposal, language, scope_locked=turn.scope_locked_hit
                    ),
                    "rules",
                )
            ]
        if turn.kind == "text" and turn.reply:
            guarded = policy.guard_reply(turn.reply, proposal, language, turn.limits)
            if guarded.ok:
                return [
                    NewMessage("assistant", "text", guarded.text, "model", {"model": turn.model})
                ]
        return []

    @staticmethod
    def _fallback_message(
        proposal: PlanProposal | None, language: str, *, first_time: bool, summary: bool
    ) -> NewMessage:
        """The calm rules notice; ``kind`` is ``fallback`` the first time, ``text`` afterwards."""
        text = templates.fallback_message(
            proposal, language, first_time=first_time, include_summary=summary
        )
        return NewMessage("assistant", "fallback" if first_time else "text", text, "rules")

    def _append_fallback(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        proposal: PlanProposal | None,
        language: str,
    ) -> None:
        shown_before = any(m.kind == "fallback" for m in chat.messages)
        self._append_message(
            ctx,
            chat.id,
            self._fallback_message(proposal, language, first_time=not shown_before, summary=True),
        )

    def _append_rules_reply(
        self,
        ctx: SessionContext,
        chat: ChatRecord,
        proposal: PlanProposal | None,
        language: str,
    ) -> None:
        """The reply of a conversation whose model is switched off: the plan restated, with the
        quick replies, and no notice."""
        self._append_message(
            ctx,
            chat.id,
            self._fallback_message(proposal, language, first_time=False, summary=True),
        )

    def _append_message(self, ctx: SessionContext, chat_id: UUID, message: NewMessage) -> None:
        self._append(
            ctx,
            chat_id,
            role=message.role,
            kind=message.kind,
            text=message.text,
            source=message.source,
            payload=message.payload,
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
        with self._runtime.locks.get(chat_id):
            chat = self._get_chat(ctx, chat_id)
            if chat.status != "open":
                raise AppError(ErrorCode.version_conflict, details={"reason": "chat_closed"})
            stored = self._stored(chat)
            if stored is None:  # cannot happen: E31 always stores a first proposal
                raise AppError(ErrorCode.internal)
            try:
                if has_quick:
                    self._quick_reply_turn(ctx, chat, stored, str(req.quick_reply))
                else:
                    self._text_turn(ctx, chat, stored, (req.text or "").strip())
            except ChatClosedError:  # another process closed it after the check above
                raise AppError(
                    ErrorCode.version_conflict, details={"reason": "chat_closed"}
                ) from None
            except ChatNotFoundError:
                raise AppError(ErrorCode.not_found) from None
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
        turn = self._model_turn(
            ctx,
            chat,
            params,
            edition,
            stored.estimate,
            today,
            placement_id=stored.placement_session_id,
        )
        current = stored.public()
        route = _TURN_ROUTES.get(turn.kind, "model")
        log_event(logger, "plan_chat_turn", route=route, outcome=turn.kind)

        if turn.kind == "fallback":
            self._append_fallback(ctx, chat, current, language)
        elif turn.kind == "rules_only":
            self._append_rules_reply(ctx, chat, current, language)
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
                model=turn.model,
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
            message, source = self._shown_reply(
                turn, current, language, templates.templated_reply, limits=turn.limits
            )
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
        *,
        limits: policy.PlanLimits | None = None,
    ) -> tuple[str, str]:
        """The model's text when it passes the output guard, otherwise the templated text."""
        if turn.reply:
            guarded = policy.guard_reply(turn.reply, proposal, language, limits)
            if guarded.ok:
                return guarded.text, "model"
        return template(proposal, language), "rules"

    def _append_fixed(self, ctx: SessionContext, chat: ChatRecord, kind: str, text: str) -> None:
        self._append(ctx, chat.id, role="assistant", kind=kind, text=text, source="fixed")

    # ------------------------------------------------------------------ E33

    def read_conversation(self, ctx: SessionContext, chat_id: UUID) -> PlanChat:
        return self._dto(ctx, self._get_chat(ctx, chat_id))

    def open_chat_id(self, ctx: SessionContext) -> UUID | None:
        """The id of the caller's open conversation, for ``Today.openPlanChatId`` (E18)."""
        return self._repo.open_chat_id(ctx.user_id)

    # ------------------------------------------------------------------ E34

    def confirm_plan(
        self, ctx: SessionContext, chat_id: UUID, proposal_version: int
    ) -> tuple[Plan, bool]:
        """Save exactly the proposal the learner saw. Returns ``(plan, created)``."""
        with self._runtime.locks.get(chat_id):
            chat = self._get_chat(ctx, chat_id)
            if chat.status != "open":
                raise AppError(ErrorCode.version_conflict, details={"reason": "chat_closed"})
            if chat.proposal is None or chat.proposal_version != proposal_version:
                raise self._stale(chat)
            stored = StoredProposal.model_validate(chat.proposal)
            created = chat.plan_id is None
            try:
                plan = self._confirmer.confirm(
                    ctx, Confirmation(chat, stored, proposal_version, created), self._now()
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
            except (PlanNotFound, PlacementNotFound, ChatNotFoundError):
                raise AppError(ErrorCode.not_found) from None
            except PlanningRuleError as exc:
                # A rule that held when the proposal was made no longer holds (for example a
                # preferred date that has passed): the learner changes it and confirms again.
                raise _fields((exc.field or "proposal", exc.rule)) from None
            self._runtime.forget_temp_id(chat_id)
            log_event(logger, "plan_chat_confirmed", created=created)
            return plan, created

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


# --- the confirmation of E34 (plan write and closing of the conversation as one unit) -------------


def planner_of(chat: ChatRecord) -> tuple[Any, str | None]:
    """``teaching_agent`` when a model turn supplied parameters (Plan-conversation §2.9 item 6)."""
    for message in chat.messages:
        payload = message.payload or {}
        if payload.get("paramsFromModel"):
            return "teaching_agent", payload.get("model")
    return "rules", None


@dataclass(frozen=True, slots=True)
class Confirmation:
    """What E34 confirms: the conversation as read under its lock and the proposal the learner
    saw. ``created`` is true for a new plan and false for the revision of ``chat.plan_id``."""

    chat: ChatRecord
    stored: StoredProposal
    proposal_version: int
    created: bool


class PlanConfirmer(Protocol):
    def confirm(self, ctx: SessionContext, confirmation: Confirmation, now: datetime) -> Plan:
        """Write the plan and mark the conversation ``confirmed`` as one unit: when the plan write
        fails nothing is closed. Raises ``ChatClosedError``, ``ProposalStaleError``,
        ``EstimateChanged``, ``ActivePlanConflict``, ``PlanVersionConflict``, ``PlanNotActive``,
        ``PlanNotFound``, ``PlanningRuleError`` or ``ChatNotFoundError``."""


class LocalPlanConfirmer:
    """Memory mode: the plan functions of the ports run inside the repository's lock, in the
    same unit of work as the closing of the conversation."""

    def __init__(self, repository: LocalPlanChatRepository, writer: PlanWriter) -> None:
        self._repo = repository
        self._writer = writer

    def confirm(self, ctx: SessionContext, confirmation: Confirmation, now: datetime) -> Plan:
        stored = confirmation.stored

        def commit(record: ChatRecord) -> Plan:
            source, model = planner_of(record)
            if confirmation.created:
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

        return self._repo.commit_and_close(
            ctx.user_id, confirmation.chat.id, confirmation.proposal_version, commit, now
        )


class AtomicPlanConfirmer:
    """Supabase mode: ``app_plan_chat_confirm`` writes the plan and closes the conversation in
    one transaction. B4's ``prepare_creation`` / ``prepare_revision`` run the E16 / E17 checks and
    build the same commit (phases, policy snapshot) that those endpoints write; nothing is
    written before the database function runs, and the plan is read back afterwards."""

    def __init__(self, plans: PlanService, repository: PostgrestPlanChatRepository) -> None:
        self._plans = plans
        self._repo = repository

    def confirm(self, ctx: SessionContext, confirmation: Confirmation, now: datetime) -> Plan:
        chat, stored = confirmation.chat, confirmation.stored
        try:
            if confirmation.created:
                source, model = planner_of(chat)
                commit = self._plans.prepare_creation(
                    ctx,
                    edition_id=stored.edition_id,
                    ordinals=stored.target_scope.section_ordinals,
                    paths=list(stored.paths),
                    order=stored.order,
                    session_minutes=stored.session_minutes,
                    preferred_date=stored.preferred_date,
                    placement_session_id=stored.placement_session_id,
                    confirmed=stored.estimate,
                    planner_source=source,
                    planner_model=model,
                )
                plan_args = commit.plan_args()
            else:
                assert chat.plan_id is not None
                expected = stored.plan_version or 1
                commit = self._plans.prepare_revision(
                    ctx,
                    chat.plan_id,
                    expected_version=expected,
                    scope=stored.target_scope.section_ordinals,
                    paths=list(stored.paths),
                    order=stored.order,
                    session_minutes=stored.session_minutes,
                    preferred_date=stored.preferred_date,
                    confirmed=stored.estimate,
                )
                plan_args = {**commit.plan_args(), "expected_version": expected}
        except PlanInputError as exc:
            first = exc.errors[0]
            raise PlanningRuleError(first.rule, first.field) from None
        except EstimateMismatch:
            raise EstimateChanged from None
        try:
            plan_id = self._repo.confirm(
                ctx.user_id, chat.id, confirmation.proposal_version, plan_args, now
            )
        except PlanVersionMoved:
            current = self._plans.read_plan(ctx, chat.plan_id) if chat.plan_id is not None else None
            if current is None:
                raise PlanNotFound from None
            raise PlanVersionConflict(current.current_version) from None
        written = self._plans.read_plan(ctx, plan_id)
        if written is None:
            log_event(logger, "plan_missing_after_confirm", level=logging.ERROR)
            raise AppError(ErrorCode.internal)
        return plan_dto(written)


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
    runtime: ChatRuntime | None = None,
    confirmer: PlanConfirmer | None = None,
) -> PlanChatService:
    """Wire one service over fixed ports (tests, and anything that needs no per-request binding).
    ``provider`` defaults to OpenRouter when a key and candidates are configured (otherwise
    ``None``: every turn is a rules turn); pass ``None`` to force that. The application uses
    ``build_plan_chat_gateway`` instead, which binds the ports of each request."""
    if settings.APP_ENV == "production" and (repository is None or ledger is None):
        # Never fall back to process memory in production: conversations and quota counters
        # would silently disappear on restart (pre-merge audit, 4 October 2026).
        raise RuntimeError(
            "the plan-chat repository and usage ledger must be provided in production"
        )
    return PlanChatService(
        settings,
        repository=repository or InMemoryPlanChatRepository(),
        ledger=ledger or InMemoryUsageLedger(),
        planning=planning,
        writer=writer,
        learning=learning,
        provider=build_default_provider(settings) if provider is _UNSET else provider,
        clock=clock,
        runtime=runtime,
        confirmer=confirmer,
    )


# --- the application's request-scoped service -----------------------------------------------------


class PlanChatApi(Protocol):
    """What the router calls (E31 to E34) and what E18 reads (``open_chat_id``): a
    ``PlanChatService`` or a ``PlanChatGateway``."""

    def create_conversation(self, ctx: SessionContext, req: CreatePlanChatRequest) -> PlanChat: ...

    def send_message(
        self, ctx: SessionContext, chat_id: UUID, req: SendMessageRequest
    ) -> PlanChat: ...

    def read_conversation(self, ctx: SessionContext, chat_id: UUID) -> PlanChat: ...

    def confirm_plan(
        self, ctx: SessionContext, chat_id: UUID, proposal_version: int
    ) -> tuple[Plan, bool]: ...

    def open_chat_id(self, ctx: SessionContext) -> UUID | None: ...


@dataclass(frozen=True, slots=True)
class Binding:
    """The storage of one request: the repository and how E34 confirms (``None``: locally)."""

    repository: PlanChatRepository
    confirmer: PlanConfirmer | None = None


class PlanChatGateway:
    """Installed on ``app.state.plan_chat_service``. The ports of B4 and the learner's access
    token are bound per request (``PlanService.ports_for``), so each call builds a
    ``PlanChatService`` for its session context; the provider, the usage ledger and the shared
    ``ChatRuntime`` are the same for every call."""

    def __init__(
        self,
        settings: Settings,
        *,
        plans: PlanService,
        bind: Callable[[SessionContext], Binding],
        learning_for: Callable[[SessionContext], LearningSummaryPort],
        ledger: UsageLedger,
        provider: StructuredReplyProvider | None,
        clock: Callable[[], datetime] | None = None,
        runtime: ChatRuntime | None = None,
    ) -> None:
        self._settings = settings
        self._plans = plans
        self._bind = bind
        self._learning_for = learning_for
        self._clock = clock
        self.ledger = ledger
        self.provider = provider
        self.runtime = runtime or ChatRuntime()

    def binding(self, ctx: SessionContext) -> Binding:
        """The storage of one request: its repository and its confirmer."""
        return self._bind(ctx)

    def _service(self, ctx: SessionContext) -> PlanChatService:
        ports = self._plans.ports_for(ctx)
        binding = self.binding(ctx)
        return PlanChatService(
            self._settings,
            repository=binding.repository,
            ledger=self.ledger,
            planning=ports,
            writer=ports,
            learning=self._learning_for(ctx),
            provider=self.provider,
            clock=self._clock,
            runtime=self.runtime,
            confirmer=binding.confirmer,
        )

    def create_conversation(self, ctx: SessionContext, req: CreatePlanChatRequest) -> PlanChat:
        return self._service(ctx).create_conversation(ctx, req)

    def send_message(self, ctx: SessionContext, chat_id: UUID, req: SendMessageRequest) -> PlanChat:
        return self._service(ctx).send_message(ctx, chat_id, req)

    def read_conversation(self, ctx: SessionContext, chat_id: UUID) -> PlanChat:
        return self._service(ctx).read_conversation(ctx, chat_id)

    def confirm_plan(
        self, ctx: SessionContext, chat_id: UUID, proposal_version: int
    ) -> tuple[Plan, bool]:
        return self._service(ctx).confirm_plan(ctx, chat_id, proposal_version)

    def open_chat_id(self, ctx: SessionContext) -> UUID | None:
        """The caller's open conversation for E18. One read through the repository of the request;
        no service is built for it."""
        return self.binding(ctx).repository.open_chat_id(ctx.user_id)


def build_plan_chat_gateway(
    settings: Settings,
    *,
    plans: PlanService,
    learning: LearningRepository | None = None,
    bank: BankRepository | None = None,
    client: PostgrestClient | None = None,
    provider: Any = _UNSET,
    ledger: UsageLedger | None = None,
    repository: PlanChatRepository | None = None,
    clock: Callable[[], datetime] | None = None,
) -> PlanChatGateway:
    """The conversation of the configured backend.

    Memory mode shares one repository and one ledger for the process (``repository`` and
    ``ledger`` replace them in tests). Supabase mode (needs ``client``) reads and writes the
    conversations through PostgREST under each learner's token and records usage through the
    restricted database role ``QATRA_SERVER_DB``; in production a missing role is a startup
    failure, never a fallback to process memory. ``learning`` and ``bank`` feed the anonymized
    learning record of revision conversations; without them that record is empty."""
    production = settings.APP_ENV == "production"
    binder: Callable[[SessionContext], Binding]
    if settings.QATRA_DATA_BACKEND == "memory":
        if production:
            raise RuntimeError("the memory backend is refused in production")
        shared = repository or InMemoryPlanChatRepository()
        ledger = ledger or InMemoryUsageLedger()

        def binder(ctx: SessionContext) -> Binding:
            return Binding(shared)

    else:
        if client is None:
            raise ValueError("the supabase plan conversation needs the PostgREST client")
        if ledger is None:
            if not settings.is_missing("QATRA_SERVER_DB"):
                assert settings.QATRA_SERVER_DB is not None
                ledger = PostgresUsageLedger(settings.QATRA_SERVER_DB.get_secret_value())
            elif production:
                raise RuntimeError(
                    "the plan-chat repository and usage ledger must be provided in production"
                )
            else:
                ledger = InMemoryUsageLedger()  # development and test without the restricted role
        postgrest = client

        def binder(ctx: SessionContext) -> Binding:
            store = PostgrestPlanChatRepository(postgrest, ctx)
            return Binding(store, AtomicPlanConfirmer(plans, store))

    def learning_for(ctx: SessionContext) -> LearningSummaryPort:
        if learning is None or bank is None:
            return EmptyLearningSummary()
        return PlanChatLearningSummary(ctx, plans=plans, learning=learning, bank=bank)

    return PlanChatGateway(
        settings,
        plans=plans,
        bind=binder,
        learning_for=learning_for,
        ledger=ledger,
        provider=build_default_provider(settings) if provider is _UNSET else provider,
        clock=clock,
    )
