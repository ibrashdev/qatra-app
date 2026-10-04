"""The turn pipeline in memory mode: E31-E34 through the service, with fake ports."""

from __future__ import annotations

from datetime import timedelta
from uuid import UUID, uuid4

import pytest

from app.contracts_plan_chat import CreatePlanChatRequest, PlanChat, SendMessageRequest
from app.domain import plan_chat_templates as templates
from app.domain.planning_port import (
    ActivePlanConflict,
    EstimateChanged,
    PlanNotActive,
    PlanVersionConflict,
)
from app.errors import AppError, ErrorCode
from app.providers.llm import ProviderUnavailable
from app.repositories.ai_usage import UsageRecord
from tests.plan_chat.pc_support import (
    OTHER_USER_ID,
    PLACEMENT_ID,
    TODAY,
    USER_ID,
    Env,
    composed_body,
    create_body,
    ctx,
    make_env,
    model_reply,
)
from tests.plan_chat.test_pc_policy import OUT_OF_SCOPE_PROMPTS, RELIGIOUS_PROMPTS


def create(env: Env, body: dict | None = None, **kwargs) -> PlanChat:
    request = CreatePlanChatRequest.model_validate(body or composed_body())
    return env.service.create_conversation(ctx(**kwargs), request)


def send(env: Env, chat: PlanChat, *, text: str | None = None, quick: str | None = None, **kwargs):
    payload = {k: v for k, v in (("text", text), ("quickReply", quick)) if v is not None}
    return env.service.send_message(
        ctx(**kwargs), chat.chat_id, SendMessageRequest.model_validate(payload)
    )


def rules(env: Env, body: dict) -> int:
    del env, body
    return 0


def fields(error: AppError) -> list[dict[str, str]]:
    return error.details["fields"]


def kinds(chat: PlanChat) -> list[str]:
    return [m.kind for m in chat.messages]


# --- E31: the first turn ---


def test_composed_goal_text_is_rules_only_and_makes_a_proposal() -> None:
    env = make_env()
    chat = create(env)
    assert env.provider.calls == []
    assert env.ledger.rows == []
    assert chat.status == "open" and chat.plan_id is None and chat.language == "en"
    assert [(m.ordinal, m.role, m.kind, m.source) for m in chat.messages] == [
        (1, "learner", "text", "learner"),
        (2, "assistant", "proposal", "rules"),
    ]
    proposal = chat.proposal
    assert proposal is not None and proposal.proposal_version == 1
    assert proposal.estimate.new_words_per_day == 25 and proposal.estimate.days == 8
    assert proposal.estimate.known_words == 0
    assert chat.assistant.source == "rules" and chat.assistant.model is None
    assert chat.model_turns_left == 6
    assert [q.code for q in chat.quick_replies][-1] == "confirm"
    assert chat.replaced_chat_id is None


def test_the_composed_sentence_must_match_the_form_selections() -> None:
    """An edited sentence is free text (one model turn); the unedited one is not."""
    env = make_env(model_reply("question", "Sure."))
    body = composed_body()
    body["goalText"] = body["goalText"] + "  "  # whitespace only: still the composed sentence
    create(env, body)
    assert env.provider.calls == []
    body["goalText"] = body["goalText"].strip() + " Please be gentle."
    create(env, body)
    assert len(env.provider.calls) == 1


def test_free_goal_text_uses_one_model_turn_and_rules_recompute_the_numbers() -> None:
    reply = model_reply("set_parameters", "I made it 15 minutes a day.", sessionMinutes=15)
    env = make_env(reply)
    chat = create(env, create_body(goalText="I have little time but want it quick, 15 min"))
    assert len(env.provider.calls) == 1
    proposal = chat.proposal
    assert proposal.session_minutes == 15
    assert proposal.estimate.new_words_per_day == 40  # recomputed by rules, never from the model
    assert proposal.estimate.days == 5
    assert [m.kind for m in chat.messages] == ["text", "proposal"]
    assert chat.messages[1].source == "model"
    assert chat.messages[1].text == "I made it 15 minutes a day."
    assert chat.assistant.source == "model" and chat.assistant.model == "free/model:free"
    assert chat.model_turns_left == 5
    (row,) = env.ledger.rows
    assert (row.prompt_version, row.status, row.provider) == ("plan-chat-v1", "succeeded", "fake")
    assert row.quota_record is None


def test_a_religious_or_out_of_scope_goal_text_gets_the_fixed_message_then_the_rules_proposal() -> (
    None
):
    env = make_env()
    religious = create(env, create_body(goalText="What is the ruling on skipping days?"))
    assert [(m.role, m.kind, m.source) for m in religious.messages] == [
        ("learner", "text", "learner"),
        ("assistant", "refusal", "fixed"),
        ("assistant", "proposal", "rules"),
    ]
    assert religious.messages[1].text == templates.D26_MESSAGE
    off_topic = create(env, create_body(goalText="Write me a poem about the sea"))
    assert [m.kind for m in off_topic.messages] == ["text", "redirect", "proposal"]
    assert off_topic.messages[1].text == templates.redirect_text("en")
    assert env.provider.calls == []
    assert off_topic.replaced_chat_id == religious.chat_id
    assert off_topic.proposal.session_minutes == 10  # from the structured selections


def test_demo_goal_text_never_reaches_the_model() -> None:
    env = make_env()
    chat = create(env, create_body(goalText="free text from a demo user"), demo=True)
    assert env.provider.calls == [] and chat.proposal is not None
    assert chat.assistant.source == "rules" and chat.model_turns_left == 0


def test_model_failure_on_the_first_turn_falls_back_with_one_calm_notice() -> None:
    env = make_env(ProviderUnavailable("timeout", model="free/a:free"))
    chat = create(env, create_body(goalText="please make it light and short"))
    assert kinds(chat) == ["text", "proposal", "fallback"]
    assert chat.messages[2].text == templates.FALLBACK_LINES["en"]
    assert chat.messages[1].source == "rules"
    (row,) = env.ledger.rows
    assert row.status == "timed_out" and row.quota_record == {"reason": "timeout"}
    assert chat.model_turns_left == 5  # the attempt consumed one turn


@pytest.mark.parametrize(
    ("override", "field", "rule"),
    [
        ({"goalText": "   "}, "goalText", "goal_text_length"),
        ({"goalText": "x" * 501}, "goalText", "goal_text_length"),
        ({"paths": ["matn"]}, "paths", "paths_invalid"),
        ({"paths": []}, "paths", "paths_invalid"),
        ({"targetScope": {"sectionOrdinals": [1]}}, "targetScope", "scope_invalid"),
        ({"targetScope": {"sectionOrdinals": []}}, "targetScope", "scope_invalid"),
        ({"sessionMinutes": 7}, "sessionMinutes", "session_minutes_invalid"),
        ({"preferredDate": "2026-10-03"}, "preferredDate", "date_invalid"),
        (
            {"editionId": "11111111-1111-4111-8111-0000000000ff"},
            "editionId",
            "edition_not_available",
        ),
    ],
)
def test_e31_validation_rules(override: dict, field: str, rule: str) -> None:
    env = make_env()
    body = composed_body()
    body.update(override)
    with pytest.raises(AppError) as caught:
        create(env, body)
    assert caught.value.code is ErrorCode.validation_error
    assert {"field": field, "rule": rule} in fields(caught.value)
    assert env.repo._chats == {}  # nothing was created, so no open chat was abandoned


def test_goal_text_of_exactly_500_characters_is_accepted() -> None:
    env = make_env(model_reply("question", "ok"))
    chat = create(env, create_body(goalText="plan " * 99 + "plan!"))
    assert chat.proposal is not None


def test_unknown_placement_session_is_404() -> None:
    env = make_env()
    body = composed_body(placementSessionId=str(uuid4()))
    with pytest.raises(AppError) as caught:
        create(env, body)
    assert caught.value.code is ErrorCode.not_found


def test_placement_known_words_reach_the_estimate() -> None:
    env = make_env()
    chat = create(env, composed_body(placementSessionId=str(PLACEMENT_ID)))
    assert chat.proposal.estimate.known_words == 20


def test_a_new_conversation_abandons_the_open_one() -> None:
    env = make_env()
    first = create(env)
    second = create(env)
    assert second.replaced_chat_id == first.chat_id
    assert env.service.read_conversation(ctx(), first.chat_id).status == "abandoned"
    assert env.service.read_conversation(ctx(), second.chat_id).status == "open"
    with pytest.raises(AppError) as caught:
        send(env, first, quick="more_minutes")
    assert caught.value.details == {"reason": "chat_closed"}


# --- revision conversations ---


def revision_body(env: Env, **overrides) -> dict:
    plan = env.writer.add_plan(USER_ID)
    body = composed_body(sessionMinutes=10, planId=str(plan.plan_id), **overrides)
    return body


def test_revision_starts_from_the_plan_and_keeps_edition_and_scope() -> None:
    env = make_env()
    plan = env.writer.add_plan(USER_ID)
    body = composed_body(planId=str(plan.plan_id), targetScope={"sectionOrdinals": [78, 79]})
    chat = create(env, body)
    assert chat.plan_id == plan.plan_id
    assert chat.proposal.target_scope.section_ordinals == [78, 79, 80, 81]  # the plan's scope
    assert chat.proposal.estimate.known_words == 20  # the plan's own placement session
    assert "smaller_scope" not in [q.code for q in chat.quick_replies]
    assert "Confirm the change" in chat.proposal.sections.next_step


def test_revision_of_a_completed_or_foreign_plan_is_refused() -> None:
    env = make_env()
    done = env.writer.add_plan(USER_ID, status="completed")
    with pytest.raises(AppError) as caught:
        create(env, composed_body(planId=str(done.plan_id)))
    assert caught.value.code is ErrorCode.version_conflict
    assert caught.value.details == {"reason": "plan_not_active"}
    foreign = env.writer.add_plan(OTHER_USER_ID)
    for plan_id in (foreign.plan_id, uuid4()):
        with pytest.raises(AppError) as caught:
            create(env, composed_body(planId=str(plan_id)))
        assert caught.value.code is ErrorCode.not_found


def test_paused_plans_may_be_revised() -> None:
    env = make_env()
    paused = env.writer.add_plan(USER_ID, status="paused")
    assert create(env, composed_body(planId=str(paused.plan_id))).plan_id == paused.plan_id


def test_scope_cannot_change_in_a_revision() -> None:
    reply = model_reply(
        "set_parameters", "Narrowed it.", targetScope={"sectionOrdinals": [78]}, sessionMinutes=5
    )
    env = make_env(reply)
    chat = create(env, revision_body(env))
    result = send(env, chat, text="only surah 78 and 5 minutes please")
    proposal = result.proposal
    assert proposal.target_scope.section_ordinals == [78, 79, 80, 81]
    assert proposal.session_minutes == 5  # the valid field is applied
    last = result.messages[-1]
    assert last.source == "rules" and "does not change" in last.text
    quick = send(env, result, quick="smaller_scope")
    assert quick.messages[-1].kind == "text"
    assert "new scope needs a new plan" in quick.messages[-1].text
    assert quick.proposal.proposal_version == result.proposal.proposal_version


def test_scope_only_model_change_is_ignored_with_a_templated_reply() -> None:
    reply = model_reply("set_parameters", "Done!", targetScope={"sectionOrdinals": [78]})
    env = make_env(reply)
    chat = create(env, revision_body(env))
    result = send(env, chat, text="narrow it to surah 78")
    assert result.proposal.proposal_version == 1
    assert (
        result.messages[-1].kind == "text"
        and "new scope needs a new plan" in result.messages[-1].text
    )


# --- E32: quick replies ---


@pytest.mark.parametrize(
    ("code", "check"),
    [
        ("more_minutes", lambda p: p.session_minutes == 15 and p.estimate.new_words_per_day == 40),
        ("fewer_minutes", lambda p: p.session_minutes == 5 and p.estimate.new_words_per_day == 12),
        (
            "smaller_scope",
            lambda p: p.target_scope.section_ordinals == [78, 79] and p.estimate.total_words == 80,
        ),
        ("order_reverse", lambda p: p.order == "reverse"),
    ],
)
def test_quick_replies_patch_the_proposal_by_rules(code: str, check) -> None:
    env = make_env()
    chat = create(env)
    result = send(env, chat, quick=code)
    assert check(result.proposal)
    assert result.proposal.proposal_version == 2
    learner, assistant = result.messages[-2:]
    assert (learner.role, learner.kind, learner.source) == ("learner", "quick_reply", "learner")
    assert learner.text == templates.quick_reply_label(code, "en")
    assert (assistant.kind, assistant.source) == ("proposal", "rules")
    assert env.provider.calls == [] and env.ledger.rows == []
    assert result.model_turns_left == 6


def test_date_quick_replies() -> None:
    env = make_env()
    chat = create(env, composed_body(preferredDate="2026-10-08"))  # 4 days; the plan needs 8
    assert "later_date" in [q.code for q in chat.quick_replies]
    later = send(env, chat, quick="later_date")
    assert later.proposal.preferred_date == TODAY + timedelta(days=5)
    cleared = send(env, later, quick="no_date")
    assert cleared.proposal.preferred_date is None
    assert "no_date" not in [q.code for q in cleared.quick_replies]


def test_a_quick_reply_that_changes_nothing_says_so_without_a_new_version() -> None:
    env = make_env()
    chat = create(env, composed_body(sessionMinutes=15))
    result = send(env, chat, quick="more_minutes")
    assert result.proposal.proposal_version == 1
    assert result.messages[-1].kind == "text"
    assert "highest option" in result.messages[-1].text


def test_hadith_quick_replies_and_reverse_note() -> None:
    env = make_env()
    body = composed_body(
        editionId="11111111-1111-4111-8111-0000000000e2",
        targetScope={"sectionOrdinals": [1, 2, 3]},
        paths=["matn"],
    )
    chat = create(env, body)
    assert "order_reverse" not in [q.code for q in chat.quick_replies]
    result = send(env, chat, quick="paths_all")
    assert result.proposal.paths == ["matn", "sanad", "grade"]
    assert result.proposal.estimate.total_words == 270
    back = send(env, result, quick="paths_matn_only")
    assert back.proposal.paths == ["matn"]
    refused = send(env, back, quick="order_reverse")
    assert refused.proposal.order == "book" and "Quran only" in refused.messages[-1].text


def test_confirm_quick_reply_is_refused_in_favour_of_e34() -> None:
    env = make_env()
    chat = create(env)
    with pytest.raises(AppError) as caught:
        send(env, chat, quick="confirm")
    assert {"field": "quickReply", "rule": "quick_reply_confirm_use_e34"} in fields(caught.value)


def test_exactly_one_of_text_or_quick_reply() -> None:
    env = make_env()
    chat = create(env)
    for payload in ({}, {"text": "hi", "quickReply": "more_minutes"}):
        with pytest.raises(AppError) as caught:
            env.service.send_message(
                ctx(), chat.chat_id, SendMessageRequest.model_validate(payload)
            )
        assert {"field": "body", "rule": "one_of_text_or_quick_reply"} in fields(caught.value)


@pytest.mark.parametrize("text", ["", "   ", "x" * 501])
def test_text_length_rule(text: str) -> None:
    env = make_env()
    chat = create(env)
    with pytest.raises(AppError) as caught:
        send(env, chat, text=text)
    assert {"field": "text", "rule": "text_length"} in fields(caught.value)


def test_demo_accounts_use_quick_replies_only() -> None:
    env = make_env()
    chat = create(env, demo=True)
    with pytest.raises(AppError) as caught:
        send(env, chat, text="make it shorter", demo=True)
    assert fields(caught.value) == [{"field": "text", "rule": "demo_quick_reply_only"}]
    assert send(env, chat, quick="more_minutes", demo=True).proposal.session_minutes == 15
    assert env.provider.calls == []


def test_other_accounts_cannot_see_or_use_a_conversation() -> None:
    env = make_env()
    chat = create(env)
    with pytest.raises(AppError) as caught:
        env.service.read_conversation(ctx(OTHER_USER_ID), chat.chat_id)
    assert caught.value.code is ErrorCode.not_found
    with pytest.raises(AppError) as caught:
        send(env, chat, quick="more_minutes", user_id=OTHER_USER_ID)
    assert caught.value.code is ErrorCode.not_found
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(OTHER_USER_ID), chat.chat_id, 1)
    assert caught.value.code is ErrorCode.not_found


# --- E32: the guard ---


@pytest.mark.parametrize("text", RELIGIOUS_PROMPTS)
def test_religious_prompts_never_reach_the_provider(text: str) -> None:
    env = make_env()
    chat = create(env)
    result = send(env, chat, text=text)
    assert env.provider.calls == [] and env.ledger.rows == []
    assistant = result.messages[-1]
    assert (assistant.kind, assistant.source, assistant.text) == (
        "refusal",
        "fixed",
        templates.D26_MESSAGE,
    )
    assert result.proposal.proposal_version == 1  # the conversation stays usable
    assert result.model_turns_left == 6


@pytest.mark.parametrize("text", OUT_OF_SCOPE_PROMPTS)
def test_out_of_scope_prompts_never_reach_the_provider(text: str) -> None:
    env = make_env()
    chat = create(env)
    result = send(env, chat, text=text)
    assert env.provider.calls == [] and env.ledger.rows == []
    assistant = result.messages[-1]
    assert (assistant.kind, assistant.source, assistant.text) == (
        "redirect",
        "fixed",
        templates.redirect_text("en"),
    )


def test_arabic_conversations_get_arabic_fixed_lines() -> None:
    env = make_env()
    chat = create(env, composed_body(language="ar"))
    result = send(env, chat, text="اكتب لي قصة")
    assert result.messages[-1].text == templates.REDIRECT_LINES["ar"]
    assert templates.SECTION_LABELS["ar"]["goal"] == "الهدف الكلي"
    assert "المراجعات" not in chat.proposal.sections.goal  # sections hold bodies, not labels
    assert chat.proposal.sections.reviews.startswith("تُراجَع")


def test_model_intents_religious_and_out_of_scope_give_the_fixed_messages() -> None:
    env = make_env(model_reply("religious", "Here is the ruling: ..."), model_reply("out_of_scope"))
    chat = create(env)
    first = send(env, chat, text="please look at the sanad of the plan")
    assert first.messages[-1].text == templates.D26_MESSAGE
    second = send(env, first, text="please look at the sanad of the plan again")
    assert second.messages[-1].text == templates.redirect_text("en")


# --- E32: the model turn ---


def test_model_set_parameters_applies_valid_values_and_shows_a_clean_reply() -> None:
    env = make_env(
        model_reply(
            "set_parameters", "Lighter days now.", sessionMinutes=5, preferredDate="2026-12-01"
        )
    )
    chat = create(env)
    result = send(env, chat, text="lighter please and finish by December first")
    proposal = result.proposal
    assert proposal.session_minutes == 5 and str(proposal.preferred_date) == "2026-12-01"
    assert proposal.proposal_version == 2
    assert result.messages[-1].source == "model" and result.messages[-1].kind == "proposal"
    assert result.messages[-1].text == "Lighter days now."
    assert result.assistant.model == "free/model:free" and result.model_turns_left == 5


def test_invalid_model_parameters_are_ignored_and_the_reply_is_templated() -> None:
    env = make_env(
        model_reply(
            "set_parameters", "Sure, grade path added!", paths=["grade"], preferredDate="2020-01-01"
        )
    )
    chat = create(env)
    result = send(env, chat, text="add the grade path and a date in the past")
    assert result.proposal.proposal_version == 1 and result.proposal.paths == ["quran"]
    last = result.messages[-1]
    assert last.source == "rules" and "could not apply" in last.text
    assert "grade path added" not in last.text


def test_partly_valid_parameters_apply_but_the_reply_is_templated() -> None:
    env = make_env(model_reply("set_parameters", "All done!", sessionMinutes=15, paths=["grade"]))
    chat = create(env)
    result = send(env, chat, text="15 minutes and the grade path")
    assert result.proposal.session_minutes == 15
    assert result.messages[-1].source == "rules" and result.messages[-1].kind == "proposal"
    assert "All done!" not in result.messages[-1].text


def test_output_guard_replaces_religious_numeric_and_linked_replies() -> None:
    bad_replies = [
        "The ruling here is that it is permissible.",
        "You will learn 777 passages.",
        "Read more at https://example.com/plan",
    ]
    env = make_env(*[model_reply("question", text) for text in bad_replies])
    chat = create(env)
    for text in bad_replies:
        before = len(chat.messages)
        chat = send(env, chat, text="how long will the schedule take overall?")
        message = chat.messages[-1]
        assert len(chat.messages) == before + 2
        assert message.source == "rules" and message.text.startswith("Current plan:")
        assert text not in message.text


def test_output_guard_corrects_a_wrong_number_of_days() -> None:
    env = make_env(model_reply("question", "This takes about 40 days in total."))
    chat = create(env)
    result = send(env, chat, text="how long will the schedule take?")
    assert result.messages[-1].source == "model"
    assert "8 days" in result.messages[-1].text and "40 days" not in result.messages[-1].text


def test_model_confirm_intent_points_to_the_confirm_action() -> None:
    env = make_env(model_reply("confirm", "Great, confirming!"))
    chat = create(env)
    result = send(env, chat, text="yes, that plan is fine, save it")
    assert result.messages[-1].text == templates.confirm_hint("en")
    assert result.proposal.proposal_version == 1


def test_temporary_conversation_id_is_random_stable_per_chat_and_not_the_chat_id() -> None:
    env = make_env(model_reply("question", "ok"), model_reply("question", "ok"))
    chat = create(env)
    send(env, chat, text="a question about the schedule")
    send(env, chat, text="another question about the schedule")
    first, second = (call["conversationId"] for call in env.provider.calls)
    assert first == second
    assert first != str(chat.chat_id) and UUID(first)
    other = create(env)
    env.provider.script.append(model_reply("question", "ok"))
    send(env, other, text="a question about the schedule")
    assert env.provider.calls[-1]["conversationId"] != first


# --- caps and the model switch ---


def counted_rows(env: Env, n: int, account: UUID | None = None, seconds_ago: int = 0) -> None:
    for _ in range(n):
        env.ledger.record(
            UsageRecord(
                "fake",
                "m",
                "plan-chat-v1",
                "succeeded",
                env.clock.now - timedelta(seconds=seconds_ago),
            ),
            account=account,
        )


def assert_one_fallback_then_text(env: Env) -> None:
    chat = create(env)
    first = send(env, chat, text="make the schedule easier please")
    assert first.messages[-1].kind == "fallback"
    assert first.messages[-1].text.startswith(templates.FALLBACK_LINES["en"])
    assert first.messages[-1].source == "rules"
    second = send(env, first, text="and a little shorter please")
    assert second.messages[-1].kind == "text"  # the notice is shown once per conversation
    assert templates.FALLBACK_LINES["en"] not in second.messages[-1].text
    assert env.provider.calls == []


def test_global_daily_cap_gives_the_fallback() -> None:
    env = make_env()
    counted_rows(env, 50, seconds_ago=3600)
    assert_one_fallback_then_text(env)


def test_global_minute_cap_gives_the_fallback() -> None:
    env = make_env()
    counted_rows(env, 20, seconds_ago=10)
    assert_one_fallback_then_text(env)


def test_per_account_daily_cap_gives_the_fallback() -> None:
    env = make_env()
    counted_rows(env, 10, account=USER_ID, seconds_ago=3600)
    assert_one_fallback_then_text(env)


def test_caps_of_another_account_do_not_apply() -> None:
    env = make_env(model_reply("question", "Fine."))
    counted_rows(env, 10, account=OTHER_USER_ID, seconds_ago=3600)
    chat = create(env)
    assert send(env, chat, text="how is the schedule?").messages[-1].source == "model"


def test_per_conversation_cap_gives_the_fallback_after_the_last_turn() -> None:
    env = make_env(
        model_reply("question", "One."),
        model_reply("question", "Two."),
        QATRA_CHAT_MODEL_TURNS_PER_CHAT=2,
    )
    chat = create(env)
    chat = send(env, chat, text="how is the schedule?")
    chat = send(env, chat, text="how is the schedule now?")
    assert chat.model_turns_left == 0 and chat.messages[-1].source == "model"
    third = send(env, chat, text="and the schedule again?")
    assert third.messages[-1].kind == "fallback" and len(env.provider.calls) == 2


def test_caps_count_every_attempt_and_the_ledger_resets_on_a_new_day() -> None:
    env = make_env(
        ProviderUnavailable("error", model="m"),
        model_reply("question", "ok"),
        QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY=1,
    )
    chat = create(env)
    chat = send(env, chat, text="how is the schedule?")
    assert chat.messages[-1].kind == "fallback"
    assert chat.model_turns_left == 5
    blocked = send(env, chat, text="how is the schedule again?")
    assert len(env.provider.calls) == 1  # the failed attempt used the account's only call
    assert blocked.messages[-1].kind == "text"
    env.clock.now += timedelta(days=1)
    again = send(env, blocked, text="how is the schedule today?")
    assert again.messages[-1].source == "model"


@pytest.mark.parametrize(
    ("failure", "status"),
    [
        (ProviderUnavailable("timeout", model="m"), "timed_out"),
        (ProviderUnavailable("invalid_output", model="m", input_tokens=5), "failed"),
        (ProviderUnavailable("error", model="m"), "failed"),
        (ProviderUnavailable("ineligible", model="m"), "rules_fallback"),
    ],
)
def test_provider_failures_fall_back_and_are_recorded_without_text(failure, status) -> None:
    env = make_env(failure)
    chat = create(env)
    result = send(env, chat, text="make the schedule easier please")
    assert result.messages[-1].kind == "fallback" and result.proposal.proposal_version == 1
    (row,) = env.ledger.rows
    assert (row.status, row.prompt_version, row.cost_usd) == (status, "plan-chat-v1", None)
    consumed = 0 if status == "rules_fallback" else 1
    assert result.model_turns_left == 6 - consumed
    assert env.ledger.counts(USER_ID, env.clock.now).global_day == consumed


def test_the_fallback_conversation_completes_the_whole_journey_without_the_model() -> None:
    env = make_env(provider=False)
    chat = create(env, create_body(goalText="free text, but no provider exists"))
    assert kinds(chat) == ["text", "proposal", "fallback"]
    chat = send(env, chat, quick="more_minutes")
    chat = send(env, chat, quick="smaller_scope")
    plan, created = env.service.confirm_plan(ctx(), chat.chat_id, chat.proposal.proposal_version)
    assert created and plan.agreed_estimate == chat.proposal.estimate


@pytest.mark.parametrize("flag", [True, False])
def test_the_learner_model_switch(flag: bool) -> None:
    env = make_env(model_reply("question", "Fine."), QATRA_CHAT_MODEL_FOR_LEARNERS=flag)
    chat = create(env, create_body(goalText="a free text goal about the schedule"))
    chat = send(env, chat, text="how is the schedule?")
    if flag:
        assert len(env.provider.calls) == 2 and chat.assistant.source == "model"
        assert chat.model_turns_left == 4
    else:
        assert env.provider.calls == [] and env.ledger.rows == []
        assert chat.assistant.source == "rules" and chat.model_turns_left == 0
        assert chat.messages[-1].kind in ("text", "fallback")
        assert chat.proposal is not None  # the rules journey still works
        assert send(env, chat, quick="more_minutes").proposal.session_minutes == 15


# --- E33 / E34 ---


def test_read_returns_the_same_chat() -> None:
    env = make_env()
    chat = create(env)
    assert env.service.read_conversation(ctx(), chat.chat_id) == chat


def test_confirm_creates_the_plan_with_exactly_the_proposal() -> None:
    env = make_env()
    chat = send(env, create(env), quick="more_minutes")
    plan, created = env.service.confirm_plan(ctx(), chat.chat_id, 2)
    assert created is True
    (call,) = env.writer.created
    proposal = chat.proposal
    assert call["confirmed_estimate"] == proposal.estimate
    assert call["session_minutes"] == 15 and call["order"] == "book"
    assert call["target_scope"] == proposal.target_scope and call["paths"] == ["quran"]
    assert call["is_demo"] is False and call["user_id"] == USER_ID
    assert (call["planner_source"], call["planner_model"]) == ("rules", None)
    assert plan.agreed_estimate == proposal.estimate and plan.planner.source == "rules"
    closed = env.service.read_conversation(ctx(), chat.chat_id)
    assert closed.status == "confirmed" and closed.quick_replies == []
    assert env.repo.get(USER_ID, chat.chat_id).closed_at is not None


def test_a_model_derived_plan_reports_the_teaching_agent_and_the_model() -> None:
    env = make_env(model_reply("set_parameters", "Shorter.", sessionMinutes=5))
    chat = send(env, create(env), text="shorter days please for the schedule")
    plan, _ = env.service.confirm_plan(ctx(), chat.chat_id, chat.proposal.proposal_version)
    assert (plan.planner.source, plan.planner.model) == ("teaching_agent", "free/model:free")
    assert env.writer.created[0]["planner_source"] == "teaching_agent"


def test_demo_creation_is_flagged_for_synthetic_demo_mode() -> None:
    env = make_env()
    chat = create(env, demo=True)
    env.service.confirm_plan(ctx(demo=True), chat.chat_id, 1)
    assert env.writer.created[0]["is_demo"] is True


def test_stale_proposal_returns_the_current_one_and_saves_nothing() -> None:
    env = make_env()
    chat = send(env, create(env), quick="more_minutes")  # version 2
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(), chat.chat_id, 1)
    error = caught.value
    assert error.code is ErrorCode.version_conflict and error.details["reason"] == "proposal_stale"
    assert error.details["proposal"]["proposalVersion"] == 2
    assert error.details["proposal"]["sessionMinutes"] == 15
    assert env.writer.created == []
    assert env.service.read_conversation(ctx(), chat.chat_id).status == "open"


def test_confirm_twice_is_chat_closed() -> None:
    env = make_env()
    chat = create(env)
    env.service.confirm_plan(ctx(), chat.chat_id, 1)
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(), chat.chat_id, 1)
    assert caught.value.details == {"reason": "chat_closed"}
    with pytest.raises(AppError) as caught:
        send(env, chat, quick="more_minutes")
    assert caught.value.details == {"reason": "chat_closed"}
    assert len(env.writer.created) == 1


def test_revision_confirmation_calls_the_revise_function_with_the_plan_snapshot() -> None:
    env = make_env()
    plan = env.writer.add_plan(USER_ID, current_version=3)
    chat = create(env, composed_body(planId=str(plan.plan_id)))
    chat = send(env, chat, quick="more_minutes")
    result, created = env.service.confirm_plan(ctx(), chat.chat_id, chat.proposal.proposal_version)
    assert created is False and result.current_version == 4
    (call,) = env.writer.revised
    assert call["plan_id"] == plan.plan_id and call["expected_version"] == 3
    assert call["session_minutes"] == 15 and call["confirmed_estimate"] == chat.proposal.estimate
    assert env.writer.created == []


@pytest.mark.parametrize(
    ("error", "details"),
    [
        (ActivePlanConflict(), {"reason": "active_plan_conflict"}),
        (PlanNotActive(), {"reason": "plan_not_active"}),
    ],
)
def test_creation_conflicts_leave_the_chat_open(error, details) -> None:
    env = make_env()
    chat = create(env)
    env.writer.fail_create = error
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(), chat.chat_id, 1)
    assert caught.value.code is ErrorCode.version_conflict and caught.value.details == details
    assert env.service.read_conversation(ctx(), chat.chat_id).status == "open"


def test_plan_version_conflict_reports_the_current_version() -> None:
    env = make_env()
    plan = env.writer.add_plan(USER_ID)
    chat = create(env, composed_body(planId=str(plan.plan_id)))
    env.writer.fail_revise = PlanVersionConflict(7)
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(), chat.chat_id, 1)
    assert caught.value.details == {"reason": "plan_version", "currentVersion": 7}
    assert env.service.read_conversation(ctx(), chat.chat_id).status == "open"


def test_estimate_changed_rebuilds_the_proposal_and_reports_it_stale() -> None:
    env = make_env()
    chat = create(env)
    env.writer.fail_create = EstimateChanged()
    env.planning.today = TODAY + timedelta(days=1)  # the learning day moved on
    with pytest.raises(AppError) as caught:
        env.service.confirm_plan(ctx(), chat.chat_id, 1)
    details = caught.value.details
    assert details["reason"] == "proposal_stale" and details["proposal"]["proposalVersion"] == 2
    assert details["proposal"]["estimate"]["endDate"] == "2026-10-13"
    env.writer.fail_create = None
    plan, _ = env.service.confirm_plan(ctx(), chat.chat_id, 2)
    assert plan.agreed_estimate.end_date == TODAY + timedelta(days=9)


def test_messages_are_stored_with_increasing_ordinals_and_no_model_raw_output() -> None:
    env = make_env(model_reply("question", "Fine."))
    chat = send(env, create(env), text="how is the schedule?")
    assert [m.ordinal for m in chat.messages] == [1, 2, 3, 4]
    for record in env.repo.get(USER_ID, chat.chat_id).messages:
        assert "intent" not in str(record.payload)
