"""Behaviour that B13 added to the service: the switched-off model, the first turn stored as one
unit, planner provenance, and the confirmation errors that used to be unhandled."""

from __future__ import annotations

import threading
import time

import pytest

from app.contracts_plan_chat import CreatePlanChatRequest, PlanChat, SendMessageRequest
from app.domain import plan_chat_templates as templates
from app.domain.planning_port import PlacementNotFound, PlanningRuleError
from app.errors import AppError, ErrorCode
from app.repositories.plan_chats import (
    ChatClosedError,
    ChatNotFoundError,
    InMemoryPlanChatRepository,
)
from app.services.plan_chat import ChatRuntime, build_plan_chat_service
from tests.plan_chat.pc_support import (
    USER_ID,
    Env,
    FakeProvider,
    composed_body,
    create_body,
    ctx,
    make_env,
    model_reply,
)

FREE_GOAL = "a free text goal about the schedule"


def create(env: Env, body: dict | None = None, **kwargs) -> PlanChat:
    request = CreatePlanChatRequest.model_validate(body or composed_body())
    return env.service.create_conversation(ctx(**kwargs), request)


def send(env: Env, chat: PlanChat, *, text: str | None = None, quick: str | None = None):
    payload = {k: v for k, v in (("text", text), ("quickReply", quick)) if v is not None}
    return env.service.send_message(ctx(), chat.chat_id, SendMessageRequest.model_validate(payload))


def kinds(chat: PlanChat) -> list[str]:
    return [m.kind for m in chat.messages]


# --- the model switched off by configuration (D76) ------------------------------------------------


def test_the_code_default_keeps_learner_text_away_from_the_model() -> None:
    env = make_env(model_reply("question", "never shown"), learner_model=None)
    assert env.settings.QATRA_CHAT_MODEL_FOR_LEARNERS is False  # the default of the code
    chat = create(env, create_body(goalText=FREE_GOAL))
    chat = send(env, chat, text="please make the days shorter")
    chat = send(env, chat, text="and a little easier")
    assert env.provider.calls == [] and env.ledger.rows == []
    assert chat.model_turns_left == 0 and chat.assistant.source == "rules"


def test_a_switched_off_model_gives_rules_replies_without_the_unavailable_notice() -> None:
    env = make_env(learner_model=False)
    first = create(env, create_body(goalText=FREE_GOAL))
    assert kinds(first) == ["text", "proposal"]  # rules only from the first turn, no notice
    turn = send(env, first, text="make the days shorter please")
    reply = turn.messages[-1]
    assert (reply.kind, reply.source) == ("text", "rules")
    assert templates.FALLBACK_LINES["en"] not in reply.text
    assert reply.text.startswith("Current plan:") and "Use the options below." in reply.text
    assert turn.proposal.proposal_version == 1  # free text only reaches what the rules understand
    again = send(env, turn, text="and one more thing about the plan")
    assert kinds(again).count("fallback") == 0


def test_a_switched_off_model_still_runs_the_guard_and_the_quick_replies() -> None:
    env = make_env(learner_model=False)
    chat = create(env)
    refused = send(env, chat, text="what is the ruling on this?")
    assert refused.messages[-1].kind == "refusal"
    redirected = send(env, refused, text="what is the weather in the city today?")
    assert redirected.messages[-1].kind == "redirect"
    quick = send(env, redirected, quick="more_minutes")
    assert quick.proposal.session_minutes == 15 and quick.proposal.proposal_version == 2
    plan, created = env.service.confirm_plan(ctx(), chat.chat_id, 2)
    assert created and plan.planner.source == "rules"


def test_an_unconfigured_provider_with_the_model_switched_on_keeps_the_calm_notice() -> None:
    env = make_env(provider=False, learner_model=True)
    chat = create(env, create_body(goalText=FREE_GOAL))
    assert kinds(chat) == ["text", "proposal", "fallback"]  # a real outage, not a setting


def test_a_demo_account_is_unaffected_by_the_switch() -> None:
    env = make_env(learner_model=None)
    chat = create(env, create_body(goalText=FREE_GOAL), demo=True)
    assert kinds(chat) == ["text", "proposal"] and env.provider.calls == []
    quick = env.service.send_message(
        ctx(demo=True),
        chat.chat_id,
        SendMessageRequest.model_validate({"quickReply": "more_minutes"}),
    )
    assert quick.proposal.session_minutes == 15


# --- the first turn is stored as one unit ------------------------------------------------------


def test_a_failure_while_building_the_first_turn_stores_nothing_and_keeps_the_open_chat() -> None:
    env = make_env()
    first = create(env)
    calls = env.planning.estimate_calls

    original = env.planning.estimate

    def fail_on_the_proposal(*args, **kwargs):
        if env.planning.estimate_calls >= calls + 1:  # the first estimate checks the input
            raise PlacementNotFound
        return original(*args, **kwargs)

    env.planning.estimate = fail_on_the_proposal  # type: ignore[method-assign]
    with pytest.raises(AppError) as caught:
        create(env, create_body(goalText=FREE_GOAL))
    assert caught.value.code is ErrorCode.not_found
    env.planning.estimate = original  # type: ignore[method-assign]
    kept = env.service.read_conversation(ctx(), first.chat_id)
    assert kept.status == "open" and kept.replaced_chat_id is None


def test_the_first_turn_stores_the_goal_the_guard_message_and_the_proposal_in_order() -> None:
    env = make_env()
    chat = create(env, create_body(goalText="what is the ruling on skipping days?"))
    assert kinds(chat) == ["text", "refusal", "proposal"]
    assert [m.ordinal for m in chat.messages] == [1, 2, 3]
    assert [m.source for m in chat.messages] == ["learner", "fixed", "rules"]
    stored = env.repo.get(USER_ID, chat.chat_id)
    assert stored is not None and stored.proposal_version == 1 and stored.model_turns == 0


def test_a_model_call_of_the_first_turn_is_counted_on_the_stored_conversation() -> None:
    env = make_env(model_reply("question", "Fine."))
    chat = create(env, create_body(goalText=FREE_GOAL))
    stored = env.repo.get(USER_ID, chat.chat_id)
    assert stored is not None and stored.model_turns == 1 and chat.model_turns_left == 5
    assert [m.kind for m in stored.messages] == ["text", "proposal", "text"]  # the model's text


def test_the_temporary_model_id_survives_from_the_first_turn_to_the_next() -> None:
    env = make_env(model_reply("question", "ok"), model_reply("question", "ok"))
    chat = create(env, create_body(goalText=FREE_GOAL))
    send(env, chat, text="a question about the schedule")
    first, second = (call["conversationId"] for call in env.provider.calls)
    assert first == second and first != str(chat.chat_id)


def test_two_simultaneous_first_turns_of_one_account_run_one_after_another() -> None:
    entered, gate = threading.Event(), threading.Event()
    started: list[int] = []

    class Slow(FakeProvider):
        def complete(self, payload, *, max_tokens, timeout_sec):  # type: ignore[no-untyped-def]
            started.append(1)
            entered.set()
            assert gate.wait(5)
            return super().complete(payload, max_tokens=max_tokens, timeout_sec=timeout_sec)

    base = make_env(provider=False)
    provider = Slow(model_reply("question", "ok"), model_reply("question", "ok"))
    service = build_plan_chat_service(
        base.settings,
        planning=base.planning,
        writer=base.writer,
        learning=base.learning,
        repository=base.repo,
        ledger=base.ledger,
        provider=provider,
        clock=base.clock,
    )
    request = CreatePlanChatRequest.model_validate(create_body(goalText=FREE_GOAL))
    results: list[PlanChat] = []
    first = threading.Thread(
        target=lambda: results.append(service.create_conversation(ctx(), request))
    )
    second = threading.Thread(
        target=lambda: results.append(service.create_conversation(ctx(), request))
    )
    first.start()
    assert entered.wait(5)  # the first call is inside the model, holding the account's turn
    second.start()
    time.sleep(0.2)
    assert len(started) == 1  # the second call waits for the first
    gate.set()
    first.join(5)
    second.join(5)
    assert len(results) == 2
    older, newer = results
    assert newer.replaced_chat_id == older.chat_id and older.replaced_chat_id is None
    statuses = {
        chat_id: base.repo.get(USER_ID, chat_id).status
        for chat_id in (older.chat_id, newer.chat_id)
    }  # type: ignore[union-attr]
    assert sorted(statuses.values()) == ["abandoned", "open"]


def test_the_temporary_id_of_a_replaced_conversation_is_forgotten() -> None:
    runtime = ChatRuntime()
    env = make_env(model_reply("question", "ok"), model_reply("question", "ok"))
    service = build_plan_chat_service(
        env.settings,
        planning=env.planning,
        writer=env.writer,
        learning=env.learning,
        repository=env.repo,
        ledger=env.ledger,
        provider=env.provider,
        clock=env.clock,
        runtime=runtime,
    )
    request = CreatePlanChatRequest.model_validate(create_body(goalText=FREE_GOAL))
    first = service.create_conversation(ctx(), request)
    assert len(runtime._temp_ids) == 1
    second = service.create_conversation(ctx(), request)
    assert second.replaced_chat_id == first.chat_id
    assert set(runtime._temp_ids) == {second.chat_id}  # the replaced chat's id is gone


# --- planner provenance ------------------------------------------------------------------------


def test_the_model_id_is_kept_when_its_parameters_were_used_but_its_text_was_not() -> None:
    env = make_env(model_reply("set_parameters", "You will learn 777 passages.", sessionMinutes=5))
    chat = create(env, composed_body(sessionMinutes=10))
    chat = send(env, chat, text="shorter days please for the schedule")
    assert chat.proposal.session_minutes == 5
    assert chat.messages[-1].source == "rules"  # the guard replaced the model's text
    plan, _ = env.service.confirm_plan(ctx(), chat.chat_id, chat.proposal.proposal_version)
    assert (plan.planner.source, plan.planner.model) == ("teaching_agent", "free/model:free")
    assert chat.assistant.source == "rules"


# --- confirmation errors -----------------------------------------------------------------------


def test_a_rule_that_no_longer_holds_at_confirmation_is_a_validation_error() -> None:
    env = make_env()
    chat = create(env)
    env.writer.fail_create = PlanningRuleError("date_invalid", "preferredDate")
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(), chat.chat_id, 1)
    assert caught.value.code is ErrorCode.validation_error
    assert caught.value.details == {"fields": [{"field": "preferredDate", "rule": "date_invalid"}]}
    env.writer.fail_create = None
    assert env.service.confirm_plan(ctx(), chat.chat_id, 1)[1] is True  # the chat stayed open


def test_a_rule_without_a_field_names_the_proposal() -> None:
    env = make_env()
    chat = create(env)
    env.writer.fail_create = PlanningRuleError("scope_invalid")
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(), chat.chat_id, 1)
    assert caught.value.details["fields"] == [{"field": "proposal", "rule": "scope_invalid"}]


def test_a_placement_session_that_vanished_at_confirmation_is_404() -> None:
    env = make_env()
    chat = create(env)
    env.writer.fail_create = PlacementNotFound()
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(), chat.chat_id, 1)
    assert caught.value.code is ErrorCode.not_found


class ClosingRepository(InMemoryPlanChatRepository):
    """The conversation is closed by another process after the service checked it."""

    def __init__(self) -> None:
        super().__init__()
        self.refuse: Exception | None = None

    def append_message(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        if self.refuse is not None:
            raise self.refuse
        return super().append_message(*args, **kwargs)


@pytest.mark.parametrize(
    ("error", "status", "details"),
    [
        (ChatClosedError(), 409, {"reason": "chat_closed"}),
        (ChatNotFoundError("gone"), 404, {}),
    ],
)
def test_a_conversation_that_changes_during_a_turn_is_answered_not_crashed(
    error: Exception, status: int, details: dict
) -> None:
    base = make_env()
    repo = ClosingRepository()
    service = build_plan_chat_service(
        base.settings,
        planning=base.planning,
        writer=base.writer,
        learning=base.learning,
        repository=repo,
        ledger=base.ledger,
        provider=base.provider,
        clock=base.clock,
    )
    chat = service.create_conversation(ctx(), CreatePlanChatRequest.model_validate(composed_body()))
    repo.refuse = error
    with pytest.raises(AppError) as caught:
        service.send_message(
            ctx(), chat.chat_id, SendMessageRequest.model_validate({"quickReply": "more_minutes"})
        )
    assert caught.value.code.status == status and caught.value.details == details


def test_a_repository_that_cannot_confirm_needs_a_confirmer() -> None:
    base = make_env()

    class ReadOnly:
        def __getattr__(self, name: str):  # type: ignore[no-untyped-def]
            raise AttributeError(name)

    with pytest.raises(TypeError, match="needs a confirmer"):
        build_plan_chat_service(
            base.settings,
            planning=base.planning,
            writer=base.writer,
            learning=base.learning,
            repository=ReadOnly(),  # type: ignore[arg-type]
            ledger=base.ledger,
            provider=None,
        )
