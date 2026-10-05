"""``Today.openPlanChatId`` (E18) names the account's open plan conversation (E31 to E34).

The field is the id of the caller's conversation in status ``open`` (at most one per account:
``plan_chats_user_id_open_key``), else ``null``. ``app/wiring.py`` binds it to the service that
``install_plan_chat`` leaves on ``app.state``, read when E18 is served. The scenarios run in memory
mode (a real registered session) and in supabase mode (a fake PostgREST project, no network, the
learner's token on every request); a database failure fails E18 like any other read of it.

The two repository reads (the in-memory store and the PostgREST store) are tested directly at the
end. Synthetic data only.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.errors import AppError, ErrorCode
from app.providers.postgrest import PostgrestClient
from app.repositories import ai_usage as ai_usage_module
from app.repositories.plan_chats import (
    InMemoryPlanChatRepository,
    NewMessage,
    PostgrestPlanChatRepository,
)
from app.wiring import install_plan_chat
from tests.integration.fake_project import OTHER_TOKEN
from tests.plan_chat.pc_e2e_support import Journey, build_journey
from tests.plan_chat.pc_postgrest import ChatProject
from tests.plan_chat.pc_supabase_support import (
    SupabaseJourney,
    UsageDatabase,
    build_supabase_journey,
)
from tests.plan_chat.pc_support import composed_body, login_as, make_app, make_env
from tests.sessions.ss_postgrest import ANON, TOKEN
from tests.sessions.ss_support import OTHER_USER, USER, ctx
from tests.support import FRONTEND_ORIGIN

NOW = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)
PROPOSAL: dict[str, Any] = {"proposalVersion": 1, "sessionMinutes": 5}


def open_chat_of(client: TestClient) -> str | None:
    """``Today.openPlanChatId`` as E18 answers it."""
    response = client.get("/api/today")
    assert response.status_code == 200, response.text
    value: str | None = response.json()["openPlanChatId"]
    assert value is None or isinstance(value, str)
    return value


def confirm(client: TestClient, chat: dict[str, Any], version: int = 1) -> dict[str, Any]:
    response = client.post(
        f"/api/plan-chats/{chat['chatId']}/confirm", json={"proposalVersion": version}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


@pytest.fixture
def usage_database(monkeypatch: pytest.MonkeyPatch) -> UsageDatabase:
    """The restricted database connection of the usage ledger, faked: no test opens a socket."""
    database = UsageDatabase()
    monkeypatch.setattr(ai_usage_module.psycopg, "connect", database.connect)
    return database


@pytest.fixture(params=["memory", "supabase"])
def chats(
    request: pytest.FixtureRequest, usage_database: UsageDatabase
) -> Journey | SupabaseJourney:
    """One signed-in learner of the application, in each backend."""
    if request.param == "memory":
        return build_journey()
    return build_supabase_journey(usage_database)


# -- E18 over both backends ------------------------------------------------------------------------


def test_today_names_no_conversation_until_one_is_started(chats: Journey | SupabaseJourney) -> None:
    assert open_chat_of(chats.client) is None


def test_today_names_the_open_conversation_until_it_is_confirmed(
    chats: Journey | SupabaseJourney,
) -> None:
    client = chats.client
    chat = chats.create_chat()
    assert open_chat_of(client) == chat["chatId"]
    plan = confirm(client, chat)
    assert open_chat_of(client) is None  # a confirmed conversation is closed
    today = client.get("/api/today").json()
    assert today["plan"]["planId"] == plan["planId"]  # the plan it made is the active one


def test_a_new_conversation_replaces_the_one_today_names(chats: Journey | SupabaseJourney) -> None:
    client = chats.client
    first = chats.create_chat()
    second = chats.create_chat()
    assert second["replacedChatId"] == first["chatId"]
    assert open_chat_of(client) == second["chatId"]  # never the abandoned one
    assert client.get(f"/api/plan-chats/{first['chatId']}").json()["status"] == "abandoned"
    confirm(client, second)
    assert open_chat_of(client) is None


def test_a_revision_conversation_is_named_like_any_other(chats: Journey | SupabaseJourney) -> None:
    client = chats.client
    plan = confirm(client, chats.create_chat())
    assert open_chat_of(client) is None
    revision = chats.create_chat(planId=plan["planId"], sessionMinutes=10)
    assert revision["planId"] == plan["planId"]
    assert open_chat_of(client) == revision["chatId"]
    assert client.get("/api/today").json()["plan"]["planId"] == plan["planId"]


# -- memory mode: accounts and the wiring ------------------------------------------------------


def test_each_account_is_named_its_own_conversation_in_memory_mode() -> None:
    journey = build_journey()
    mine = journey.create_chat()
    other = journey.other_browser("second_user")
    assert open_chat_of(other) is None  # my open conversation is not theirs
    theirs = journey.create_chat(other)
    assert open_chat_of(other) == theirs["chatId"]
    assert open_chat_of(journey.client) == mine["chatId"]  # and theirs does not replace mine


def test_the_lookup_follows_the_service_installed_when_e18_is_served() -> None:
    """``install_plan_chat`` runs after ``install_sessions`` and may be called again: E18 must ask
    the service that is installed now, not the one that was installed when E18 was wired."""
    journey = build_journey()
    first = journey.create_chat()
    assert open_chat_of(journey.client) == first["chatId"]

    install_plan_chat(
        journey.app,
        journey.settings,
        repository=InMemoryPlanChatRepository(),  # a new service over an empty store
        clock=journey.clock,
    )
    assert open_chat_of(journey.client) is None
    second = journey.create_chat()
    assert open_chat_of(journey.client) == second["chatId"]


def test_without_a_conversation_service_e18_names_none_and_still_answers() -> None:
    journey = build_journey()
    journey.create_chat()
    # install_plan_chat leaves None when there is no plan service (supabase mode, not configured)
    journey.app.state.plan_chat_service = None
    assert open_chat_of(journey.client) is None
    del journey.app.state.plan_chat_service  # no attribute at all
    assert open_chat_of(journey.client) is None


def test_a_plain_conversation_service_is_named_through_the_same_seam() -> None:
    """B13's route tests put a ``PlanChatService`` where the gateway stands; E18 reads it too."""
    app = make_app(make_env())
    login_as(app)
    with TestClient(app, headers={"Origin": FRONTEND_ORIGIN}) as client:
        assert open_chat_of(client) is None
        chat = client.post("/api/plan-chats", json=composed_body()).json()
        assert open_chat_of(client) == chat["chatId"]


# -- supabase mode: the read and its failures --------------------------------------------------


def test_in_supabase_mode_e18_makes_one_select_as_the_learner(
    usage_database: UsageDatabase,
) -> None:
    journey = build_supabase_journey(usage_database)
    chat = journey.create_chat()
    journey.project.requests.clear()
    assert open_chat_of(journey.client) == chat["chatId"]
    (select,) = [r for r in journey.project.requests if r.url.path.endswith("/plan_chats")]
    assert select.method == "GET"
    assert dict(select.url.params) == {
        "select": "id",
        "user_id": f"eq.{USER}",
        "status": "eq.open",
        "limit": "1",
    }
    assert select.headers["apikey"] == ANON  # the publishable key, never a privileged one
    assert select.headers["authorization"] == f"Bearer {TOKEN}"  # the learner, so RLS applies
    others = [
        r
        for r in journey.project.requests
        if "plan_chat_messages" in r.url.path or "/rpc/app_plan_chat" in r.url.path
    ]
    assert others == []  # only the id is read: no message, no function call


def test_a_failing_read_fails_e18_instead_of_answering_null(
    usage_database: UsageDatabase,
) -> None:
    journey = build_supabase_journey(usage_database)
    chat = journey.create_chat()
    journey.project.fail("plan_chats", httpx.ReadTimeout("slow"))
    outage = journey.client.get("/api/today")
    assert (outage.status_code, outage.json()["error"]["code"]) == (503, "unavailable")
    expired = httpx.Response(401, json={"code": "PGRST301", "message": "JWT expired"})
    journey.project.fail("plan_chats", expired)
    refused = journey.client.get("/api/today")
    assert (refused.status_code, refused.json()["error"]["code"]) == (401, "unauthenticated")
    assert open_chat_of(journey.client) == chat["chatId"]  # the faults were one-shot


def test_another_learners_token_is_named_no_conversation_of_mine(
    usage_database: UsageDatabase,
) -> None:
    """The select is the learner's own (``user_id`` and row-level security): the fake answers a row
    to the token of its owner only."""
    journey = build_supabase_journey(usage_database)
    chat = journey.create_chat()
    assert open_chat_of(journey.client) == chat["chatId"]
    mine = store(journey.project).open_chat_id(USER)
    assert mine is not None and str(mine) == chat["chatId"]
    assert store(journey.project, OTHER_USER, OTHER_TOKEN).open_chat_id(OTHER_USER) is None


# -- the repository read -----------------------------------------------------------------------


def first_turn() -> list[NewMessage]:
    return [NewMessage("assistant", "proposal", "proposal text", "rules", {"k": "proposal"})]


def open_values(**overrides: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "plan_id": None,
        "language": "en",
        "learner_text": "goal",
        "assistant": first_turn(),
        "proposal": PROPOSAL,
        "model_turns": 0,
        "now": NOW,
    }
    values.update(overrides)
    return values


def test_the_memory_store_names_only_the_open_conversation_of_the_caller() -> None:
    repo = InMemoryPlanChatRepository()
    assert repo.open_chat_id(USER) is None
    first = repo.open_chat(USER, **open_values()).chat
    assert repo.open_chat_id(USER) == first.id
    assert repo.open_chat_id(OTHER_USER) is None
    second = repo.open_chat(USER, **open_values()).chat  # replaces the first
    assert repo.open_chat_id(USER) == second.id
    repo.close(USER, second.id, "abandoned", NOW)
    assert repo.open_chat_id(USER) is None
    third = repo.open_chat(USER, **open_values()).chat
    assert repo.commit_and_close(USER, third.id, 1, lambda chat: chat.id, NOW) == third.id
    assert repo.open_chat_id(USER) is None  # confirmed


def store(
    project: ChatProject, user: Any = USER, token: str | None = TOKEN
) -> PostgrestPlanChatRepository:
    client = PostgrestClient("https://project.example", ANON, transport=project.transport())
    return PostgrestPlanChatRepository(client, ctx(user, token=token))


def test_the_database_store_selects_the_open_row_of_the_caller() -> None:
    project = ChatProject()
    repo = store(project)
    assert repo.open_chat_id(USER) is None
    first = repo.open_chat(USER, **open_values()).chat
    assert repo.open_chat_id(USER) == first.id
    project.chats[str(first.id)].update(status="confirmed", closed_at="2026-10-05T07:00:00+00:00")
    assert repo.open_chat_id(USER) is None  # a closed row is not an open conversation
    second = repo.open_chat(USER, **open_values()).chat
    assert repo.open_chat_id(USER) == second.id
    assert store(project, OTHER_USER, OTHER_TOKEN).open_chat_id(OTHER_USER) is None


def test_the_database_store_refuses_a_foreign_user_and_a_missing_token() -> None:
    project = ChatProject()
    with pytest.raises(AppError) as caught:
        store(project).open_chat_id(OTHER_USER)  # not the user of the session
    assert caught.value.code is ErrorCode.internal
    with pytest.raises(AppError) as caught:
        store(project, token=None).open_chat_id(USER)
    assert caught.value.code is ErrorCode.unauthenticated
    assert project.chat_calls == []  # nothing was sent


def test_the_database_store_does_not_hide_a_bad_row_or_an_outage() -> None:
    project = ChatProject()
    repo = store(project)
    for answer in (
        httpx.Response(200, json=[{"id": "not-a-uuid"}]),
        httpx.Response(200, json=[{}]),
    ):
        project.fail("plan_chats", answer)
        with pytest.raises(AppError) as caught:
            repo.open_chat_id(USER)
        assert caught.value.code is ErrorCode.internal
    project.fail("plan_chats", httpx.ReadTimeout("slow"))
    with pytest.raises(AppError) as caught:
        repo.open_chat_id(USER)
    assert caught.value.code is ErrorCode.unavailable
