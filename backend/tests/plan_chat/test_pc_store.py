"""The conversation stores: the in-memory one (memory mode) and the PostgREST one (supabase mode).

The PostgREST repository is exercised against ``ChatProject``, a fake of migration 0006; a contract
test ties the fake's function signatures to the migration text, so the fake cannot drift from it.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest

from app.domain.planning_port import ActivePlanConflict, PlanNotActive, PlanNotFound
from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories.plan_chats import (
    ChatClosedError,
    ChatNotFoundError,
    InMemoryPlanChatRepository,
    NewMessage,
    PlanVersionMoved,
    PostgrestPlanChatRepository,
    ProposalStaleError,
)
from tests.plan_chat.pc_postgrest import FUNCTIONS, ChatProject
from tests.plans.fake_postgrest import ACTIVE_KEY_MESSAGE, db_error
from tests.sessions.ss_postgrest import ANON, TOKEN
from tests.sessions.ss_support import OTHER_USER, USER, ctx

NOW = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)
PROPOSAL: dict[str, Any] = {"proposalVersion": 1, "sessionMinutes": 5}
MIGRATION = Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "0006_plan_chats.sql"


def first_turn(*kinds: str) -> list[NewMessage]:
    return [NewMessage("assistant", kind, f"{kind} text", "rules", {"k": kind}) for kind in kinds]


# --- the in-memory store -----------------------------------------------------------------------


def memory_open(repo: InMemoryPlanChatRepository, user: UUID = USER, **overrides: Any) -> Any:
    values: dict[str, Any] = {
        "plan_id": None,
        "language": "en",
        "learner_text": "goal",
        "assistant": first_turn("proposal"),
        "proposal": PROPOSAL,
        "model_turns": 0,
        "now": NOW,
    }
    values.update(overrides)
    return repo.open_chat(user, **values)


def test_the_memory_store_opens_a_conversation_with_its_whole_first_turn() -> None:
    repo = InMemoryPlanChatRepository()
    opened = memory_open(repo, assistant=first_turn("refusal", "proposal", "text"), model_turns=1)
    chat = opened.chat
    assert opened.replaced_chat_id is None and chat.status == "open"
    assert [(m.ordinal, m.role, m.kind) for m in chat.messages] == [
        (1, "learner", "text"),
        (2, "assistant", "refusal"),
        (3, "assistant", "proposal"),
        (4, "assistant", "text"),
    ]
    assert chat.messages[0].text == "goal" and chat.messages[0].source == "learner"
    assert (chat.proposal, chat.proposal_version, chat.model_turns) == (PROPOSAL, 1, 1)
    assert repo.get(USER, chat.id) == chat and repo.get(OTHER_USER, chat.id) is None


def test_a_second_first_turn_abandons_the_open_conversation() -> None:
    repo = InMemoryPlanChatRepository()
    first = memory_open(repo).chat
    second = memory_open(repo)
    assert second.replaced_chat_id == first.id
    old = repo.get(USER, first.id)
    assert old is not None and old.status == "abandoned" and old.closed_at == NOW
    other = memory_open(repo, OTHER_USER)
    assert other.replaced_chat_id is None  # one open conversation per account


def test_the_first_turn_needs_assistant_messages_and_respects_the_text_limit() -> None:
    repo = InMemoryPlanChatRepository()
    with pytest.raises(ValueError):
        memory_open(repo, assistant=[])
    with pytest.raises(ValueError):
        memory_open(repo, assistant=[NewMessage("learner", "text", "x", "learner")])
    with pytest.raises(ValueError):
        memory_open(repo, assistant=[NewMessage("assistant", "text", "x" * 2001, "rules")])
    assert repo.get(USER, uuid4()) is None


def test_the_memory_store_appends_in_order_and_refuses_a_closed_conversation() -> None:
    repo = InMemoryPlanChatRepository()
    chat = memory_open(repo).chat
    repo.append_message(
        USER, chat.id, role="learner", kind="quick_reply", text="t", source="learner",
        payload={"code": "x"}, now=NOW,
    )  # fmt: skip
    assert repo.save_proposal(USER, chat.id, {"proposalVersion": 2}, NOW) == 2
    repo.add_model_turn(USER, chat.id, NOW)
    stored = repo.get(USER, chat.id)
    assert stored is not None
    assert [m.ordinal for m in stored.messages] == [1, 2, 3]
    assert (stored.proposal_version, stored.model_turns) == (2, 1)
    repo.close(USER, chat.id, "abandoned", NOW)
    with pytest.raises(ChatClosedError):
        repo.append_message(
            USER, chat.id, role="learner", kind="text", text="t", source="learner",
            payload=None, now=NOW,
        )  # fmt: skip
    with pytest.raises(ChatNotFoundError):
        repo.add_model_turn(OTHER_USER, chat.id, NOW)


def test_commit_and_close_runs_the_commit_and_closes_only_on_success() -> None:
    repo = InMemoryPlanChatRepository()
    chat = memory_open(repo).chat

    def boom(_: Any) -> None:
        raise RuntimeError("the plan write failed")

    with pytest.raises(RuntimeError):
        repo.commit_and_close(USER, chat.id, 1, boom, NOW)
    still = repo.get(USER, chat.id)
    assert still is not None and still.status == "open"
    with pytest.raises(ProposalStaleError):
        repo.commit_and_close(USER, chat.id, 7, lambda c: "x", NOW)
    assert repo.commit_and_close(USER, chat.id, 1, lambda c: c.id, NOW) == chat.id
    with pytest.raises(ChatClosedError):
        repo.commit_and_close(USER, chat.id, 1, lambda c: "x", NOW)


# --- the PostgREST store -----------------------------------------------------------------------


def store(
    project: ChatProject, user: UUID = USER, token: str | None = TOKEN
) -> PostgrestPlanChatRepository:
    client = PostgrestClient("https://project.example", ANON, transport=project.transport())
    return PostgrestPlanChatRepository(client, ctx(user, token=token))


def pg_open(repo: PostgrestPlanChatRepository, user: UUID = USER, **overrides: Any) -> Any:
    values: dict[str, Any] = {
        "plan_id": None,
        "language": "en",
        "learner_text": "goal",
        "assistant": first_turn("proposal"),
        "proposal": PROPOSAL,
        "model_turns": 0,
        "now": NOW,
    }
    values.update(overrides)
    return repo.open_chat(user, **values)


def test_the_database_store_opens_reads_and_orders_a_conversation() -> None:
    project = ChatProject()
    repo = store(project)
    opened = pg_open(repo, assistant=first_turn("refusal", "proposal"), model_turns=1)
    chat = opened.chat
    assert [(m.ordinal, m.role, m.kind) for m in chat.messages] == [
        (1, "learner", "text"),
        (2, "assistant", "refusal"),
        (3, "assistant", "proposal"),
    ]
    assert chat.messages[2].payload == {"k": "proposal"}
    assert (chat.proposal, chat.proposal_version, chat.model_turns) == (PROPOSAL, 1, 1)
    assert chat.user_id == USER and chat.created_at.microsecond == 0  # whole seconds, UTC
    # the model turn is counted by a second call, the open function has no argument for it
    (open_call,) = project.rpc_calls("app_plan_chat_open")
    assert open_call["p_first_assistant"][0]["kind"] == "refusal"
    assert "p_plan" not in open_call
    (append_call,) = project.rpc_calls("app_plan_chat_append")
    assert append_call["p_model_turns_increment"] == 1 and append_call["p_messages"] == []


def test_the_database_store_appends_one_function_call_per_write() -> None:
    project = ChatProject()
    repo = store(project)
    chat = pg_open(repo).chat
    repo.append_message(
        USER, chat.id, role="learner", kind="quick_reply", text="t", source="learner",
        payload={"code": "more_minutes"}, now=NOW,
    )  # fmt: skip
    assert repo.save_proposal(USER, chat.id, {"proposalVersion": 2}, NOW) == 2
    repo.add_model_turn(USER, chat.id, NOW)
    stored = repo.get(USER, chat.id)
    assert stored is not None
    assert [m.kind for m in stored.messages] == ["text", "proposal", "quick_reply"]
    assert stored.messages[2].payload == {"code": "more_minutes"}
    assert (stored.proposal, stored.proposal_version, stored.model_turns) == (
        {"proposalVersion": 2},
        2,
        1,
    )


def test_the_database_store_only_returns_the_callers_rows() -> None:
    project = ChatProject()
    chat = pg_open(store(project)).chat
    assert store(project).get(USER, chat.id) is not None
    assert (
        store(project, OTHER_USER, "other-learner-access-token-0002").get(OTHER_USER, chat.id)
        is None
    )
    assert store(project).get(USER, uuid4()) is None


def test_the_database_store_refuses_a_user_that_is_not_the_session() -> None:
    project = ChatProject()
    repo = store(project)
    for call in (
        lambda: repo.get(OTHER_USER, uuid4()),
        lambda: pg_open(repo, OTHER_USER),
        lambda: repo.add_model_turn(OTHER_USER, uuid4(), NOW),
        lambda: repo.confirm(OTHER_USER, uuid4(), 1, {}, NOW),
    ):
        with pytest.raises(AppError) as caught:
            call()
        assert caught.value.code is ErrorCode.internal
    assert project.chat_calls == []  # nothing was sent


def test_without_the_learner_token_nothing_is_sent() -> None:
    project = ChatProject()
    repo = store(project, token=None)
    with pytest.raises(AppError) as caught:
        repo.get(USER, uuid4())
    assert caught.value.code is ErrorCode.unauthenticated and project.chat_calls == []


def test_an_append_to_an_unknown_or_closed_conversation() -> None:
    project = ChatProject()
    repo = store(project)
    with pytest.raises(ChatNotFoundError):
        repo.add_model_turn(USER, uuid4(), NOW)
    chat = pg_open(repo).chat
    project.chats[str(chat.id)]["status"] = "confirmed"
    with pytest.raises(ChatClosedError):
        repo.save_proposal(USER, chat.id, {"proposalVersion": 2}, NOW)


def test_opening_maps_the_database_signals() -> None:
    project = ChatProject()
    repo = store(project)
    project.fail("rpc/app_plan_chat_open", db_error(400, "QT003", "plan_not_active"))
    with pytest.raises(PlanNotActive):
        pg_open(repo)
    project.fail("rpc/app_plan_chat_open", db_error(409, "23503"))
    with pytest.raises(PlanNotFound):
        pg_open(repo)
    project.fail("rpc/app_plan_chat_open", db_error(400, "23514"))
    with pytest.raises(AppError) as caught:
        pg_open(repo)
    assert caught.value.code is ErrorCode.internal
    assert project.chats == {}  # a refused call stored nothing


def test_a_damaged_answer_is_an_internal_error_without_database_text(
    log_lines: list[str],
) -> None:
    project = ChatProject()
    repo = store(project)
    chat = pg_open(repo).chat
    for name, answer in [
        ("plan_chats", httpx.Response(200, json=[{"id": str(chat.id)}])),
        ("rpc/app_plan_chat_open", httpx.Response(200, json=[{"nothing": 1}])),
        ("rpc/app_plan_chat_append", httpx.Response(200, json="not a number")),
        ("rpc/app_plan_chat_confirm", httpx.Response(200, json="not a uuid")),
    ]:
        project.fail(name, answer)
    with pytest.raises(AppError) as damaged_row:
        repo.get(USER, chat.id)
    with pytest.raises(AppError) as damaged_open:
        pg_open(repo)
    with pytest.raises(AppError) as damaged_append:
        repo.save_proposal(USER, chat.id, {"proposalVersion": 2}, NOW)
    with pytest.raises(AppError) as damaged_confirm:
        repo.confirm(USER, chat.id, 1, {"phases": []}, NOW)
    for caught in (damaged_row, damaged_open, damaged_append, damaged_confirm):
        assert caught.value.code is ErrorCode.internal
    assert "plan_chat_row_invalid" in "\n".join(log_lines)


CONFIRM_ARGS: dict[str, Any] = {
    "reason_code": "plan_created",
    "policy_json": {},
    "effective_learning_date": "2026-10-05",
    "phases": [],
}


def test_confirm_tells_the_causes_of_one_sqlstate_apart() -> None:
    project = ChatProject()
    repo = store(project)
    chat = pg_open(repo).chat
    raw = project.chats[str(chat.id)]

    def fails_with(sqlstate: str, http: int, **state: Any) -> None:
        def answer() -> httpx.Response:
            raw.update(state)
            return db_error(http, sqlstate)

        project.fail("rpc/app_plan_chat_confirm", answer)

    fails_with("QT002", 400, proposal_version=2)
    with pytest.raises(ProposalStaleError):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    fails_with("QT002", 400, proposal_version=1)
    with pytest.raises(PlanVersionMoved):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    fails_with("QT003", 400, proposal=None)
    with pytest.raises(ProposalStaleError):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    fails_with("QT003", 400, proposal=PROPOSAL)
    with pytest.raises(PlanNotActive):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    fails_with("P0002", 500)
    with pytest.raises(PlanNotFound):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    fails_with("QT003", 400, status="abandoned")
    with pytest.raises(ChatClosedError):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    project.fail("rpc/app_plan_chat_confirm", db_error(409, "23505", ACTIVE_KEY_MESSAGE))
    with pytest.raises(ActivePlanConflict):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    project.fail("rpc/app_plan_chat_confirm", db_error(400, "23514"))
    with pytest.raises(AppError) as caught:
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    assert caught.value.code is ErrorCode.internal
    raw["status"] = "open"
    project.fail("rpc/app_plan_chat_confirm", db_error(500, "P0002"))
    project.chats.clear()
    with pytest.raises(ChatNotFoundError):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)


# --- the fake of the migration follows the migration -------------------------------------------


def declared_parameters(function: str) -> tuple[set[str], set[str]]:
    sql = MIGRATION.read_text(encoding="utf-8")
    found = re.search(rf"create function public\.{function}\((.*?)\)\s*returns", sql, re.S)
    assert found is not None, function
    required, optional = set(), set()
    for part in found.group(1).split(","):
        words = part.split()
        (optional if "default" in words else required).add(words[0])
    return required, optional


@pytest.mark.parametrize(
    "function", ["app_plan_chat_open", "app_plan_chat_append", "app_plan_chat_confirm"]
)
def test_the_fake_uses_the_parameter_names_of_migration_0006(function: str) -> None:
    assert FUNCTIONS[f"rpc/{function}"] == declared_parameters(function)


def test_the_repository_sends_only_declared_parameters() -> None:
    project = ChatProject()
    repo = store(project)
    chat = pg_open(repo, model_turns=1).chat
    project.fail("rpc/app_plan_chat_confirm", db_error(400, "23514"))
    with pytest.raises(AppError):
        repo.confirm(USER, chat.id, 1, CONFIRM_ARGS, NOW)
    for function in ("app_plan_chat_open", "app_plan_chat_append", "app_plan_chat_confirm"):
        required, optional = declared_parameters(function)
        (call,) = project.rpc_calls(function)
        assert required <= set(call) <= required | optional
