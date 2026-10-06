"""The fastest plan the rules allow (prompt ``plan-chat-v2``): what the model is shown, what the
output guard lets it say, and that a failed limits estimate never breaks a turn."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.contracts_plan_chat import CreatePlanChatRequest, SendMessageRequest
from app.domain import plan_chat_policy as policy
from app.domain.planning_port import PlacementNotFound
from app.providers.llm import PLAN_CHAT_SYSTEM_PROMPT, PROMPT_VERSION
from tests.plan_chat.pc_support import (
    PLACEMENT_ID,
    QURAN_ID,
    TODAY,
    composed_body,
    create_body,
    ctx,
    make_env,
    model_reply,
)
from tests.plan_chat.test_pc_policy import proposal_fixture

# Scope 78-81 is 160 words: 10 minutes a day is 8 days, 15 minutes a day (the fastest) is 5 days.
FASTEST_DAYS = 5
FASTEST_END = TODAY + timedelta(days=FASTEST_DAYS)


def arabic_refusal(days: int = FASTEST_DAYS, end: str = FASTEST_END.isoformat()) -> str:
    return (
        "لا يمكن إنهاء الخطة غدًا بحسب قواعد التطبيق. "
        f"أنسب خطة: {days} أيام بمعدل 15 دقيقة يوميًا، وتنتهي في {end}."
    )


def first_turn(env, goal: str, **overrides):
    body = create_body(goalText=goal, **overrides)
    return env.service.create_conversation(ctx(), CreatePlanChatRequest.model_validate(body))


def send(env, chat, text: str):
    return env.service.send_message(
        ctx(), chat.chat_id, SendMessageRequest.model_validate({"text": text})
    )


def test_the_prompt_version_and_rule_six_are_in_force() -> None:
    assert PROMPT_VERSION == "plan-chat-v2"
    rule = PLAN_CHAT_SYSTEM_PROMPT.split("\n6. ", 1)[1].split("\n\nOutput:", 1)[0]
    assert "this plan is not possible" in rule
    assert "limits.fastest" in rule and "limits.sessionMinutesOptions" in rule
    assert "Never repeat the impossible number or date" in rule
    assert chr(0x2014) not in PLAN_CHAT_SYSTEM_PROMPT  # R-02: no em dash


# --- (a) the payload ---


def test_the_payload_shows_the_fastest_plan_of_the_same_scope_for_a_ten_minute_plan() -> None:
    env = make_env(model_reply("question", "Sure."))
    chat = first_turn(env, "can I finish by tomorrow, please")
    assert chat.proposal.session_minutes == 10 and chat.proposal.estimate.days == 8
    (payload,) = env.provider.calls
    fastest_estimate = env.planning.estimate(
        ctx().user_id, QURAN_ID, chat.proposal.target_scope, ["quran"], 15, None, None
    ).estimate
    assert payload["limits"] == {
        "sessionMinutesOptions": [5, 10, 15],
        "fastest": {
            "sessionMinutes": 15,
            "days": fastest_estimate.days,
            "endDate": fastest_estimate.end_date.isoformat(),
        },
    }
    assert fastest_estimate.days == FASTEST_DAYS
    assert policy.find_disallowed_keys(payload) == []


def test_the_limits_use_the_stored_placement_on_a_later_turn() -> None:
    env = make_env(model_reply("question", "Sure."))
    env.planning.known[PLACEMENT_ID] = 100  # 60 of the 160 words are left to learn
    body = composed_body(placementSessionId=str(PLACEMENT_ID))
    chat = env.service.create_conversation(ctx(), CreatePlanChatRequest.model_validate(body))
    send(env, chat, "can we make this plan faster?")
    (payload,) = env.provider.calls
    with_placement = env.planning.estimate(
        ctx().user_id, QURAN_ID, chat.proposal.target_scope, ["quran"], 15, None, PLACEMENT_ID
    ).estimate
    assert payload["limits"]["fastest"]["days"] == with_placement.days == 2
    assert payload["limits"]["fastest"]["endDate"] == with_placement.end_date.isoformat()


# --- (b) the guard ---


def test_guard_accepts_the_fastest_plan_numbers_only_when_limits_are_given() -> None:
    proposal = proposal_fixture()  # 10 minutes a day, 8 days
    limits = policy.PlanLimits(15, FASTEST_DAYS, FASTEST_END)
    reply = arabic_refusal()
    with_limits = policy.guard_reply(reply, proposal, "ar", limits)
    assert with_limits.ok and not with_limits.replaced_numbers and with_limits.text == reply
    without = policy.guard_reply(reply, proposal, "ar")
    assert not (without.ok and without.text == reply)
    assert policy.sanitize_reply(reply, proposal, "ar", limits) == reply
    assert policy.sanitize_reply(reply, proposal, "ar") != reply


def test_guard_with_limits_still_rejects_a_number_that_is_not_the_fastest_plans() -> None:
    proposal = proposal_fixture()
    limits = policy.PlanLimits(15, FASTEST_DAYS, FASTEST_END)
    stray = arabic_refusal(days=6, end="2026-10-11")
    guarded = policy.guard_reply(stray, proposal, "ar", limits)
    assert not (guarded.ok and guarded.text == stray)
    assert policy.allowed_numbers(proposal, limits) >= {5, 15, 2026, 10, 9}
    assert 9 not in policy.allowed_numbers(proposal)


def test_the_allowlist_names_the_limits_fields() -> None:
    assert {"limits", "fastest", "sessionMinutesOptions"} <= policy.ALLOWED_PAYLOAD_KEYS


# --- (c) the service ---


def test_an_impossible_request_gets_the_fastest_plan_stated_and_the_proposal_is_unchanged() -> None:
    env = make_env(model_reply("question", arabic_refusal()))
    chat = env.service.create_conversation(
        ctx(), CreatePlanChatRequest.model_validate(composed_body(language="ar"))
    )
    before = chat.proposal
    chat = send(env, chat, "ابغى انهي الخطة غدا")
    last = chat.messages[-1]
    assert (last.role, last.kind, last.source) == ("assistant", "text", "model")
    assert last.text == arabic_refusal()
    assert chat.proposal.proposal_version == before.proposal_version
    assert chat.proposal.session_minutes == 10 and chat.proposal.estimate.days == 8
    assert chat.assistant.source == "model"


def test_the_first_turn_may_also_state_the_fastest_plan() -> None:
    env = make_env(model_reply("question", arabic_refusal()))
    chat = first_turn(env, "ابغى انهي الخطة غدا", language="ar")
    assert [m.kind for m in chat.messages] == ["text", "proposal", "text"]
    extra = chat.messages[-1]
    assert extra.source == "model" and extra.text == arabic_refusal()
    assert chat.proposal.session_minutes == 10


def test_a_reply_that_states_other_numbers_is_still_replaced() -> None:
    wrong = arabic_refusal(days=6, end="2026-10-11")
    env = make_env(model_reply("question", wrong))
    chat = env.service.create_conversation(
        ctx(), CreatePlanChatRequest.model_validate(composed_body(language="ar"))
    )
    chat = send(env, chat, "ابغى انهي الخطة غدا")
    last = chat.messages[-1]
    assert last.text != wrong and last.source in ("model", "rules")
    assert "6 أيام" not in last.text and "2026-10-11" not in last.text


def test_limits_do_not_widen_the_guard_for_a_turn_that_changes_the_parameters() -> None:
    """The proposal after an applied change is not the one the model saw, so its reply may not
    name the fastest plan's days: the guard corrects them against the new estimate."""
    reply = model_reply(
        "set_parameters", "Done, that is 5 days at 5 minutes a day.", sessionMinutes=5
    )
    env = make_env(reply)
    chat = env.service.create_conversation(
        ctx(), CreatePlanChatRequest.model_validate(composed_body())
    )
    chat = send(env, chat, "make it lighter please")
    new_days = chat.proposal.estimate.days
    assert chat.proposal.session_minutes == 5 and new_days != FASTEST_DAYS
    last = chat.messages[-1]
    assert last.kind == "proposal"
    assert f"{new_days} days" in last.text and f"{FASTEST_DAYS} days" not in last.text


# --- (d) a failed limits estimate never breaks the turn ---


@pytest.mark.parametrize("failure", [RuntimeError("boom"), PlacementNotFound()])
def test_a_failing_limits_estimate_leaves_the_turn_working_without_limits(failure) -> None:
    env = make_env(model_reply("question", "Sure, that stays as it is."))
    chat = env.service.create_conversation(
        ctx(), CreatePlanChatRequest.model_validate(composed_body())
    )
    original = env.planning.estimate

    def flaky(user_id, edition_id, scope, paths, minutes, *rest, **kwargs):
        if minutes == 15:  # only the limits estimate asks for the largest option
            raise failure
        return original(user_id, edition_id, scope, paths, minutes, *rest, **kwargs)

    env.planning.estimate = flaky
    chat = send(env, chat, "is the schedule fine?")
    (payload,) = env.provider.calls
    assert "limits" not in payload
    assert policy.find_disallowed_keys(payload) == []
    last = chat.messages[-1]
    assert (last.kind, last.source, last.text) == ("text", "model", "Sure, that stays as it is.")


def test_no_limits_estimate_is_made_when_the_model_is_not_called() -> None:
    env = make_env(model_reply("question", "never used"), provider=False)
    chat = env.service.create_conversation(
        ctx(), CreatePlanChatRequest.model_validate(composed_body())
    )
    calls = env.planning.estimate_calls
    send(env, chat, "is the schedule fine?")
    assert env.planning.estimate_calls == calls
