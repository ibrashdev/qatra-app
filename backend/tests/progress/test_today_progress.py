"""E18 ``Today`` and E19 ``ProgressResponse`` at the service (API-spec E18, E19, D40, D57, D66):
the rules of the day and of the overall progress over the memory repositories and over the PostgREST
adapters. Synthetic content only; titles are read from the bundle, never typed here."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from app.domain.learning_state import PassageMastery
from app.services.progress import ProgressService
from tests.sessions.ss_events_support import (
    FIRST_PASSAGE,
    GOAL_MS,
    MODES,
    SECOND_PASSAGE,
    World,
    activity_event,
    answer_event,
)
from tests.sessions.ss_support import (
    HADITH,
    PLAN_B_ID,
    PLAN_ID,
    QURAN,
    QURAN_PASSAGES,
    TODAY,
    USER,
    quran_plan,
)

DAY = timedelta(days=1)
THIRD_PASSAGE, FOURTH_PASSAGE = QURAN_PASSAGES[2], QURAN_PASSAGES[3]
STAMP = datetime(2026, 10, 1, 8, tzinfo=UTC)


@pytest.fixture(params=MODES)
def world(request: pytest.FixtureRequest) -> World:
    """The Quran plan is the only active plan (the hadith plan is paused)."""
    world = World(request.param)
    world.plans.update(PLAN_B_ID, status="paused")
    return world


def mastery_row(passage: uuid.UUID, status: str, *, plan_id: uuid.UUID = PLAN_ID, **more: Any):
    """A row that is consistent with its status."""
    values: dict[str, Any] = {"plan_id": plan_id, "passage_id": passage, "status": status}
    if status == "learning":
        values.update(consecutive_correct=1)
    elif status in ("reviewing", "confirmed", "needs_refresh"):
        values.update(
            consecutive_correct=3,
            initial_success_at=STAMP,
            initial_learning_date=date(2026, 10, 1),
            review_stage=3 if status == "confirmed" else 1,
            next_review_due=TODAY + DAY,
            last_review_date=date(2026, 10, 2),
        )
    if status == "confirmed":
        values.update(confirmed_at=STAMP, first_confirmed_at=STAMP, maintenance_stage=1)
    if status == "needs_refresh":
        values.update(first_confirmed_at=STAMP)
    values.update(more)
    return PassageMastery(**values)


def plan_progress(world: World, plan_id: uuid.UUID = PLAN_ID) -> dict[str, Any]:
    return next(p for p in world.progress_view()["plans"] if p["planId"] == str(plan_id))


# --- E18: the plan and the day ------------------------------------------------------------------


def test_a_new_account_with_a_plan_starts_the_day_at_zero(world: World) -> None:
    today = world.today()
    assert today["learningDate"] == "2026-10-05"
    assert (today["dailyActiveMs"], today["dailyGoalMs"], today["dailyPercent"]) == (0, GOAL_MS, 0)
    assert (today["dailyCompleted"], today["extraActiveMs"]) == (False, 0)
    assert today["plan"]["planId"] == str(PLAN_ID) and today["plan"]["status"] == "active"
    assert today["dueReviews"] == 0 and today["openSessionId"] is None
    assert today["streakDays"] == 0 and today["openPlanChatId"] is None


def test_next_new_passage_is_the_first_of_the_plan_in_book_order(world: World) -> None:
    section = QURAN["sections"][0]
    assert world.today()["nextNewPassage"] == {
        "reference": "112:1-4",
        "sectionTitleAr": section["titleAr"],
    }


def test_a_reverse_plan_starts_from_the_last_section(world: World) -> None:
    world.plans.update(PLAN_ID, order="reverse")
    nxt = world.today()["nextNewPassage"]
    assert (
        nxt["reference"] == "114:1-3" and nxt["sectionTitleAr"] == QURAN["sections"][2]["titleAr"]
    )


def test_a_passage_being_learned_comes_before_a_new_one(world: World) -> None:
    world.seed_mastery(mastery_row(SECOND_PASSAGE, "learning"))
    assert world.today()["nextNewPassage"]["reference"] == "113:1-5"


def test_a_passage_that_reached_its_initial_evidence_is_no_longer_new(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "reviewing"))
    assert world.today()["nextNewPassage"]["reference"] == "113:1-5"


def test_passages_known_from_the_placement_are_skipped(world: World) -> None:
    world.plans.update(PLAN_ID, known_passage_ids=frozenset({FIRST_PASSAGE}))
    assert world.today()["nextNewPassage"]["reference"] == "113:1-5"


def test_when_every_passage_has_started_there_is_nothing_new(world: World) -> None:
    for passage in QURAN_PASSAGES:
        world.seed_mastery(mastery_row(passage, "reviewing"))
    assert world.today()["nextNewPassage"] is None


def test_a_scope_of_one_section_limits_the_next_passage_and_the_total(world: World) -> None:
    world.plans.update(PLAN_ID, section_ordinals=(2,))
    assert world.today()["nextNewPassage"]["reference"] == "113:1-5"
    assert plan_progress(world)["totalWords"] == 23


def test_an_account_without_a_plan_has_an_empty_day(world: World) -> None:
    world.plans._plans.clear()  # type: ignore[attr-defined]
    today = world.today()
    assert today["plan"] is None and today["dueReviews"] == 0
    assert today["nextNewPassage"] is None and today["openSessionId"] is None
    assert (today["dailyGoalMs"], today["dailyPercent"], today["dailyCompleted"]) == (0, 0, False)
    assert world.progress_view()["plans"] == []


def test_only_the_active_plan_is_the_plan_of_today(world: World) -> None:
    world.plans.update(PLAN_B_ID, status="active")
    world.plans.update(PLAN_ID, status="paused")
    assert world.today()["plan"]["planId"] == str(PLAN_B_ID)
    world.plans.update(PLAN_B_ID, status="completed")
    assert world.today()["plan"] is None


def test_the_pending_session_minutes_are_shown_apart_from_the_minutes_in_force(
    world: World,
) -> None:
    world.directory.pending[PLAN_ID] = 15
    plan = world.today()["plan"]
    assert (plan["sessionMinutes"], plan["pendingSessionMinutes"]) == (10, 15)


def test_the_goal_follows_the_minutes_in_force(world: World) -> None:
    world.plans.update(PLAN_ID, session_minutes=15)
    assert world.today()["dailyGoalMs"] == 900_000


# --- E18: due reviews ----------------------------------------------------------------------------


def test_due_reviews_are_the_passages_due_on_or_before_today(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "reviewing", next_review_due=TODAY))
    world.seed_mastery(mastery_row(SECOND_PASSAGE, "reviewing", next_review_due=TODAY - 3 * DAY))
    world.seed_mastery(mastery_row(THIRD_PASSAGE, "reviewing", next_review_due=TODAY + DAY))
    world.seed_mastery(mastery_row(FOURTH_PASSAGE, "learning"))
    assert world.today()["dueReviews"] == 2


def test_confirmed_and_refresh_passages_are_due_by_the_same_rule(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "confirmed", next_review_due=TODAY))
    world.seed_mastery(mastery_row(SECOND_PASSAGE, "needs_refresh", next_review_due=TODAY))
    world.seed_mastery(mastery_row(THIRD_PASSAGE, "confirmed", next_review_due=TODAY + 30 * DAY))
    assert world.today()["dueReviews"] == 2


def test_passages_outside_the_scope_in_force_are_not_due_reviews(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "reviewing", next_review_due=TODAY))
    world.seed_mastery(mastery_row(THIRD_PASSAGE, "reviewing", next_review_due=TODAY))
    world.plans.update(PLAN_ID, section_ordinals=(1,))
    assert world.today()["dueReviews"] == 1


def test_the_due_reviews_of_another_plan_are_not_counted(world: World) -> None:
    world.seed_mastery(
        mastery_row(FIRST_PASSAGE, "reviewing", plan_id=PLAN_B_ID, next_review_due=TODAY)
    )
    assert world.today()["dueReviews"] == 0


# --- E18: the open session -----------------------------------------------------------------------


def test_the_open_daily_session_of_today_is_reported_until_it_is_completed(world: World) -> None:
    daily = world.open("daily")
    assert world.today()["openSessionId"] == str(daily.id)
    world.complete(daily)
    assert world.today()["openSessionId"] is None


def test_a_game_session_is_not_the_open_session_of_the_day(world: World) -> None:
    world.open("game")
    assert world.today()["openSessionId"] is None


def test_an_open_daily_session_of_a_plan_that_is_no_longer_active_is_not_reported(
    world: World,
) -> None:
    world.open("daily")
    world.plans.update(PLAN_ID, status="paused")
    world.plans.update(PLAN_B_ID, status="active")
    assert world.today()["openSessionId"] is None


def test_an_offline_prepared_daily_session_is_not_the_open_session(world: World) -> None:
    daily = world.open("daily")
    world.make_offline(daily)
    assert world.today()["openSessionId"] is None


# --- E18: the streak -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("offsets", "streak"),
    [
        ((), 0),
        ((0,), 1),
        ((0, 1, 2), 3),
        ((1, 2, 3), 3),  # today is not done yet: a streak that ends yesterday still counts
        ((2, 3, 4), 0),  # a gap of a whole day ends it
        ((0, 2, 3), 1),
        ((0, 1, 3, 4, 5), 2),
    ],
)
def test_the_streak_counts_consecutive_completed_days_ending_today_or_yesterday(
    world: World, offsets: tuple[int, ...], streak: int
) -> None:
    for offset in offsets:
        world.seed_completion(TODAY - offset * DAY)
    assert world.today()["streakDays"] == streak


def test_a_streak_longer_than_a_year_is_counted_to_its_start(world: World) -> None:
    for offset in range(0, 800):
        world.seed_completion(TODAY - offset * DAY)
    world.seed_completion(TODAY - 801 * DAY)  # one day of gap, then older days
    assert world.today()["streakDays"] == 800


def test_the_streak_follows_the_completion_a_session_writes(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(0, 600)])
    today = world.today()
    assert today["streakDays"] == 1 and today["dailyCompleted"] is True


# --- E18: the seam for the open plan conversation -----------------------------------------------


def test_the_open_plan_chat_comes_from_the_seam_and_is_null_without_it(world: World) -> None:
    chat = uuid.uuid4()
    seamed = ProgressService(
        bank=world.bank,
        learning=world.learning,
        plans=world.directory,
        calendar=world.calendar,
        open_chat_lookup=lambda ctx: chat,
    )
    assert seamed.read_today(world.ctx).open_plan_chat_id == chat
    assert world.today()["openPlanChatId"] is None
    none_seam = ProgressService(
        bank=world.bank,
        learning=world.learning,
        plans=world.directory,
        calendar=world.calendar,
        open_chat_lookup=lambda ctx: None,
    )
    assert none_seam.read_today(world.ctx).open_plan_chat_id is None


# --- the daily figure is the one E21 reports -----------------------------------------------------


def test_today_and_the_events_response_report_the_same_daily_figure(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    daily = world.post(game, [activity_event(5, 185), answer_event(game.questions[0])])["daily"]
    today = world.today()
    assert {k: today[k] for k in daily} == daily
    assert world.progress_view()["daily"] == daily


def test_the_daily_progress_is_time_and_not_answers(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [answer_event(q) for q in game.questions])
    assert world.today()["dailyActiveMs"] == 0 and world.today()["dailyPercent"] == 0


def test_surplus_time_is_shown_apart_with_no_second_completion(world: World) -> None:
    game = world.game(FIRST_PASSAGE)
    world.post(game, [activity_event(0, 650)])
    today = world.today()
    assert (today["dailyPercent"], today["extraActiveMs"], today["dailyCompleted"]) == (
        100,
        50_000,
        True,
    )


# --- E19: overall progress -----------------------------------------------------------------------


def test_a_fresh_plan_has_no_progress_and_every_passage_new(world: World) -> None:
    plan = plan_progress(world)
    assert (plan["overallPercent"], plan["confirmedWords"], plan["totalWords"]) == (0, 0, 100)
    assert (plan["confirmedSections"], plan["totalSections"]) == (0, 3)
    assert plan["counts"] == {
        "new": 4,
        "learning": 0,
        "reviewing": 0,
        "confirmed": 0,
        "needsRefresh": 0,
    }
    assert plan["nextReviewDate"] is None
    assert [s["status"] for s in plan["sections"]] == ["new", "new", "new"]


def test_overall_progress_is_the_floored_share_of_words_of_confirmed_passages(
    world: World,
) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "confirmed"))  # 12 words of 100
    assert plan_progress(world)["overallPercent"] == 12
    world.seed_mastery(mastery_row(SECOND_PASSAGE, "confirmed"))  # 35 of 100
    plan = plan_progress(world)
    assert (plan["overallPercent"], plan["confirmedWords"]) == (35, 35)
    world.seed_mastery(mastery_row(THIRD_PASSAGE, "confirmed"))  # 68 of 100
    assert plan_progress(world)["overallPercent"] == 68
    world.seed_mastery(mastery_row(FOURTH_PASSAGE, "confirmed"))
    done = plan_progress(world)
    assert (done["overallPercent"], done["confirmedSections"]) == (100, 3)


def test_only_confirmed_passages_are_in_the_numerator(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "reviewing"))
    world.seed_mastery(mastery_row(SECOND_PASSAGE, "needs_refresh"))
    world.seed_mastery(mastery_row(THIRD_PASSAGE, "learning"))
    plan = plan_progress(world)
    assert (plan["overallPercent"], plan["confirmedWords"]) == (0, 0)
    assert plan["counts"] == {
        "new": 1,
        "learning": 1,
        "reviewing": 1,
        "confirmed": 0,
        "needsRefresh": 1,
    }


def test_a_confirmed_passage_that_needs_a_refresh_leaves_the_numerator(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "confirmed"))
    assert plan_progress(world)["overallPercent"] == 12
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "needs_refresh"))
    assert plan_progress(world)["overallPercent"] == 0


def test_sections_report_their_own_percent_and_status(world: World) -> None:
    world.seed_mastery(mastery_row(THIRD_PASSAGE, "confirmed"))  # 33 of 65 words in section 3
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "reviewing"))
    sections = {s["ordinal"]: s for s in plan_progress(world)["sections"]}
    assert (sections[3]["percent"], sections[3]["status"]) == (50, "reviewing")
    assert (sections[1]["percent"], sections[1]["status"]) == (0, "reviewing")
    assert (sections[2]["percent"], sections[2]["status"]) == (0, "new")
    for meta in QURAN["sections"]:
        entry = sections[meta["ordinal"]]
        assert (entry["reference"], entry["titleAr"], entry["titleEn"]) == (
            meta["reference"],
            meta["titleAr"],
            meta["titleEn"],
        )


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        (("confirmed", "confirmed"), "confirmed"),
        (("confirmed", "needs_refresh"), "needs_refresh"),
        (("confirmed", "new"), "reviewing"),
        (("learning", "new"), "learning"),
        (("reviewing", "learning"), "reviewing"),
    ],
)
def test_the_status_of_a_section_rolls_up_from_its_passages(
    world: World, statuses: tuple[str, str], expected: str
) -> None:
    for passage, status in zip((THIRD_PASSAGE, FOURTH_PASSAGE), statuses, strict=True):
        if status != "new":
            world.seed_mastery(mastery_row(passage, status))
    sections = {s["ordinal"]: s for s in plan_progress(world)["sections"]}
    assert sections[3]["status"] == expected


def test_the_next_review_date_is_the_earliest_due_date_on_the_ladder(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "reviewing", next_review_due=TODAY + 5 * DAY))
    world.seed_mastery(mastery_row(SECOND_PASSAGE, "confirmed", next_review_due=TODAY + 2 * DAY))
    world.seed_mastery(mastery_row(THIRD_PASSAGE, "learning"))
    assert plan_progress(world)["nextReviewDate"] == (TODAY + 2 * DAY).isoformat()


def test_the_numbers_of_a_plan_are_those_of_its_own_state(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "confirmed"))
    other = plan_progress(world, PLAN_B_ID)  # the paused hadith plan
    assert other["overallPercent"] == 0 and other["totalWords"] > 0
    assert plan_progress(world)["overallPercent"] == 12


def test_the_plan_entry_carries_the_titles_status_and_version_of_the_plan(world: World) -> None:
    plan = plan_progress(world)
    assert plan["titleAr"] == "title-ar" and plan["titleEn"] == "title-en"
    assert (plan["status"], plan["currentVersion"]) == ("active", 2)


# --- E19: the scope in force and the paths -------------------------------------------------------


def hadith_passages(path: str) -> list[dict[str, Any]]:
    return [p for p in HADITH["passages"] if p["path"] == path]


def test_a_path_change_changes_the_scope_and_keeps_the_evidence_of_the_deselected_path(
    world: World,
) -> None:
    world.plans.update(PLAN_B_ID, status="active")
    world.plans.update(PLAN_ID, status="paused")
    sanad = uuid.UUID(hadith_passages("sanad")[0]["id"])
    world.seed_mastery(mastery_row(sanad, "confirmed", plan_id=PLAN_B_ID))
    full = plan_progress(world, PLAN_B_ID)
    assert full["confirmedWords"] == 6 and full["counts"]["confirmed"] == 1
    world.plans.update(PLAN_B_ID, paths=("matn",))
    narrowed = plan_progress(world, PLAN_B_ID)
    matn_words = sum(p["wordCount"] for p in hadith_passages("matn"))
    assert narrowed["totalWords"] == matn_words and narrowed["confirmedWords"] == 0
    assert narrowed["counts"]["confirmed"] == 0 and narrowed["overallPercent"] == 0
    world.plans.update(PLAN_B_ID, paths=("matn", "sanad", "grade"))
    assert plan_progress(world, PLAN_B_ID) == full  # reselecting the path brings its evidence back


def test_a_deselected_path_is_not_a_due_review_either(world: World) -> None:
    world.plans.update(PLAN_B_ID, status="active")
    world.plans.update(PLAN_ID, status="paused")
    sanad = uuid.UUID(hadith_passages("sanad")[0]["id"])
    world.seed_mastery(mastery_row(sanad, "reviewing", plan_id=PLAN_B_ID, next_review_due=TODAY))
    assert world.today()["dueReviews"] == 1
    world.plans.update(PLAN_B_ID, paths=("matn",))
    assert world.today()["dueReviews"] == 0


# --- E19: plans, history ------------------------------------------------------------------------


def test_every_plan_of_the_account_is_listed_active_first_then_the_others_newest_first(
    world: World,
) -> None:
    third = uuid.UUID("44444444-4444-4444-8444-0000000000c3")
    world.plans.add(quran_plan(plan_id=third, status="completed"), owner=USER)
    plans = world.progress_view()["plans"]
    assert [p["planId"] for p in plans] == [str(PLAN_ID), str(third), str(PLAN_B_ID)]
    assert [p["status"] for p in plans] == ["active", "completed", "paused"]


def test_a_paused_or_completed_plan_has_progress_too(world: World) -> None:
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "confirmed"))
    world.plans.update(PLAN_ID, status="completed")
    plan = plan_progress(world)
    assert plan["status"] == "completed" and plan["overallPercent"] == 12


def test_history_lists_the_last_thirty_days_before_today_oldest_first(world: World) -> None:
    for offset, active in ((31, 100), (30, 200), (5, 300), (1, 400), (0, 500)):
        world.seed_daily(TODAY - offset * DAY, active, goal_ms=GOAL_MS)
    world.seed_completion(TODAY - 5 * DAY)
    history = world.progress_view()["history"]
    assert [h["date"] for h in history] == [
        (TODAY - 30 * DAY).isoformat(),
        (TODAY - 5 * DAY).isoformat(),
        (TODAY - 1 * DAY).isoformat(),
    ]
    assert [(h["activeMs"], h["goalMs"], h["completed"]) for h in history] == [
        (200, GOAL_MS, False),
        (300, GOAL_MS, True),
        (400, GOAL_MS, False),
    ]


def test_a_day_without_a_row_is_not_in_the_history(world: World) -> None:
    world.seed_daily(TODAY - 3 * DAY, 60_000)
    assert [h["date"] for h in world.progress_view()["history"]] == [(TODAY - 3 * DAY).isoformat()]


def test_a_past_day_keeps_the_goal_it_was_created_with(world: World) -> None:
    world.seed_daily(TODAY - DAY, 400_000, goal_ms=300_000)
    world.plans.update(PLAN_ID, session_minutes=15)
    [day] = world.progress_view()["history"]
    assert (day["goalMs"], day["activeMs"]) == (300_000, 400_000)


def test_the_daily_part_of_progress_is_the_one_of_today(world: World) -> None:
    world.seed_daily(TODAY, 300_000)
    daily = world.progress_view()["daily"]
    assert (daily["dailyActiveMs"], daily["dailyPercent"]) == (300_000, 50)


# --- a GET never writes --------------------------------------------------------------------------


def test_reading_today_and_progress_changes_nothing(world: World) -> None:
    world.open("daily")
    world.seed_mastery(mastery_row(FIRST_PASSAGE, "reviewing", next_review_due=TODAY))
    if world.fake is not None:
        before = len(world.fake.requests)
        world.today()
        world.progress_view()
        sent = world.fake.requests[before:]
        assert sent and all(r.method == "GET" for r in sent)
        return
    assert world.store is not None

    def state() -> tuple[Any, ...]:
        store = world.store
        assert store is not None
        return (
            dict(store.sessions),
            list(store.attempts),
            list(store.intervals),
            dict(store.mastery),
            dict(store.evidence),
            dict(store.daily_progress),
            dict(store.completions),
        )

    before_state = state()
    world.today()
    world.progress_view()
    assert state() == before_state
