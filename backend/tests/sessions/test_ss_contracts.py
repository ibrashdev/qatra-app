"""DTOs of E18-E22 (contract §7, API-spec §4.6-§4.7): strict requests, camelCase responses."""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any
from uuid import UUID

import pytest
from pydantic import TypeAdapter

from app.contracts_sessions import (
    ActivityEvent,
    AnswerEvent,
    AnswerExpected,
    AnswerPassageState,
    AnswerResult,
    ChoiceOption,
    CompleteResponse,
    CompleteSummary,
    DailyProgress,
    DailySessionRequest,
    EventsRequest,
    EventsResponse,
    GameSessionRequest,
    LearnStep,
    OfflineEnvelope,
    OptionAnswer,
    OptionAnswerKey,
    OrderAnswer,
    OrderAnswerKey,
    PassageUnit,
    PassageView,
    PendingEvent,
    PlacementSessionRequest,
    Question,
    QuestionContext,
    QuestionPolicy,
    QuestionStep,
    RecallAnswerKey,
    RecallQuestion,
    RejectedEvent,
    RequestViolation,
    SessionSnapshot,
    SimilarQuestion,
    SourceRef,
    Step,
    TextAnswer,
    TokenView,
    WordChoiceQuestion,
    WordOrderQuestion,
    option_id_for_refs,
    parse_create_session_request,
    parse_events_request,
    refs_for_option_id,
)
from app.contracts_sessions import (
    Highlight as Highlight,
)

PLAN = "44444444-4444-4444-8444-000000000001"
EDITION = "11111111-1111-4111-8111-0000000000e1"
SESSION = "55555555-5555-4555-8555-000000000001"
PASSAGE = "66666666-6666-4666-8666-000000000003"
QUESTION = "77777777-7777-4777-8777-000000000001"
EVENT = "99999999-9999-4999-8999-000000000001"


def violations(raw: Any) -> list[tuple[str, str]]:
    with pytest.raises(RequestViolation) as raised:
        parse_create_session_request(raw)
    return list(raised.value.fields)


# --- E20 request ---------------------------------------------------------------------------------


def test_the_three_valid_bodies_parse() -> None:
    daily = parse_create_session_request(
        {"kind": "daily", "planId": PLAN, "expectedPlanVersion": 2}
    )
    assert isinstance(daily, DailySessionRequest)
    assert daily.plan_id == UUID(PLAN) and daily.expected_plan_version == 2
    game = parse_create_session_request(
        {
            "kind": "game",
            "planId": PLAN,
            "expectedPlanVersion": 1,
            "gameType": "word_recall",
            "passageIds": [PASSAGE],
        }
    )
    assert isinstance(game, GameSessionRequest)
    assert game.game_type == "word_recall" and game.passage_ids == [UUID(PASSAGE)]
    bare_game = parse_create_session_request(
        {"kind": "game", "planId": PLAN, "expectedPlanVersion": 1}
    )
    assert isinstance(bare_game, GameSessionRequest)
    assert bare_game.game_type is None and bare_game.passage_ids is None
    placement = parse_create_session_request(
        {
            "kind": "placement",
            "editionId": EDITION,
            "targetScope": {"sectionOrdinals": [3, 1, 2]},
            "selfRating": "some",
        }
    )
    assert isinstance(placement, PlacementSessionRequest)
    assert placement.target_scope.section_ordinals == [1, 2, 3]  # stored in ascending order
    assert placement.self_rating == "some"


@pytest.mark.parametrize(
    "raw",
    [
        {},
        {"planId": PLAN, "expectedPlanVersion": 1},
        {"kind": None},
        {"kind": "Daily"},
        {"kind": "weekly"},
        {"kind": 7},
        {"kind": ["daily"]},
        {"kind": ""},
    ],
)
def test_a_missing_or_unknown_kind_is_kind_invalid(raw: dict[str, Any]) -> None:
    assert violations(raw) == [("kind", "kind_invalid")]


@pytest.mark.parametrize("raw", [[], "daily", 5, None, [{"kind": "daily"}]])
def test_a_body_that_is_not_an_object_is_refused(raw: Any) -> None:
    assert violations(raw) == [("body", "object_required")]


@pytest.mark.parametrize(
    "extra",
    ["userId", "isDemo", "mode", "correct", "mastery", "dailyCompleted", "confirmedAt", "streak"],
)
def test_authority_flags_and_unknown_properties_are_forbidden_fields(extra: str) -> None:
    body = {"kind": "daily", "planId": PLAN, "expectedPlanVersion": 1, extra: True}
    assert violations(body) == [(extra, "forbidden_field")]


def test_properties_of_another_kind_are_forbidden_fields() -> None:
    assert violations(
        {"kind": "daily", "planId": PLAN, "expectedPlanVersion": 1, "gameType": "x"}
    ) == [("gameType", "forbidden_field")]
    assert violations(
        {
            "kind": "placement",
            "editionId": EDITION,
            "targetScope": {"sectionOrdinals": [1]},
            "planId": PLAN,
        }
    ) == [("planId", "forbidden_field")]
    assert violations(
        {
            "kind": "game",
            "planId": PLAN,
            "expectedPlanVersion": 1,
            "targetScope": {"sectionOrdinals": [1]},
        }
    ) == [("targetScope", "forbidden_field")]


def test_missing_required_fields_are_reported_with_their_names() -> None:
    assert sorted(violations({"kind": "daily"})) == [
        ("expectedPlanVersion", "required"),
        ("planId", "required"),
    ]
    assert sorted(violations({"kind": "placement"})) == [
        ("editionId", "required"),
        ("targetScope", "required"),
    ]


@pytest.mark.parametrize("bad", ["word_swap", "WORD_ORDER", "", 3, ["word_order"], True])
def test_an_unknown_game_type_is_game_type_invalid(bad: Any) -> None:
    body = {"kind": "game", "planId": PLAN, "expectedPlanVersion": 1, "gameType": bad}
    assert violations(body) == [("gameType", "game_type_invalid")]


@pytest.mark.parametrize(
    "kind", ["word_order", "word_choice", "word_recall", "similar_distinction"]
)
def test_every_game_type_is_accepted(kind: str) -> None:
    body = {"kind": "game", "planId": PLAN, "expectedPlanVersion": 1, "gameType": kind}
    assert parse_create_session_request(body).game_type == kind  # type: ignore[union-attr]


@pytest.mark.parametrize("bad", ["many", "NONE", "", 1, ["none"], False])
def test_an_unknown_self_rating_is_self_rating_invalid(bad: Any) -> None:
    body = {
        "kind": "placement",
        "editionId": EDITION,
        "targetScope": {"sectionOrdinals": [1]},
        "selfRating": bad,
    }
    assert violations(body) == [("selfRating", "self_rating_invalid")]


@pytest.mark.parametrize(
    "scope",
    [
        {"sectionOrdinals": []},
        {"sectionOrdinals": [1, 1]},
        {"sectionOrdinals": [0]},
        {"sectionOrdinals": [-3]},
        {"sectionOrdinals": list(range(1, 62))},
        {"sectionOrdinals": ["1"]},
        {"sectionOrdinals": [1.0]},
        {"sectionOrdinals": [True]},
        {"sectionOrdinals": "1,2"},
        {"sectionOrdinals": None},
        [1, 2],
        "all",
    ],
)
def test_a_malformed_scope_is_scope_invalid(scope: Any) -> None:
    body = {"kind": "placement", "editionId": EDITION, "targetScope": scope}
    assert [rule for _, rule in violations(body)] == ["scope_invalid"]


def test_a_scope_of_sixty_ordinals_is_accepted_and_an_unknown_scope_property_is_forbidden() -> None:
    ok = {
        "kind": "placement",
        "editionId": EDITION,
        "targetScope": {"sectionOrdinals": list(range(1, 61))},
    }
    assert len(parse_create_session_request(ok).target_scope.section_ordinals) == 60  # type: ignore[union-attr]
    extra = {
        "kind": "placement",
        "editionId": EDITION,
        "targetScope": {"sectionOrdinals": [1], "paths": ["quran"]},
    }
    assert violations(extra) == [("targetScope.paths", "forbidden_field")]


@pytest.mark.parametrize(
    ("version", "rule"),
    [
        ("2", "int_type"),
        (2.0, "int_type"),
        (True, "int_type"),
        (0, "greater_than_equal"),
        (-1, "greater_than_equal"),
        (None, "int_type"),
    ],
)
def test_the_expected_plan_version_must_be_a_positive_integer(version: Any, rule: str) -> None:
    body = {"kind": "daily", "planId": PLAN, "expectedPlanVersion": version}
    assert violations(body) == [("expectedPlanVersion", rule)]


def test_ids_must_be_uuids_and_at_most_sixty_passage_ids_are_accepted() -> None:
    assert violations({"kind": "daily", "planId": "not-a-uuid", "expectedPlanVersion": 1}) == [
        ("planId", "uuid_parsing")
    ]
    ids = [f"66666666-6666-4666-8666-{n:012d}" for n in range(61)]
    body = {"kind": "game", "planId": PLAN, "expectedPlanVersion": 1, "passageIds": ids}
    assert violations(body) == [("passageIds", "too_long")]
    body["passageIds"] = ids[:60]
    assert len(parse_create_session_request(body).passage_ids) == 60  # type: ignore[union-attr]
    body["passageIds"] = [ids[0], "x"]
    assert violations(body) == [("passageIds[1]", "uuid_parsing")]


def test_violations_never_echo_submitted_values() -> None:
    body = {"kind": "game", "planId": PLAN, "expectedPlanVersion": 1, "gameType": "SECRET-value"}
    with pytest.raises(RequestViolation) as raised:
        parse_create_session_request(body)
    assert "SECRET-value" not in str(raised.value) and "SECRET-value" not in repr(
        raised.value.fields
    )


# --- option ids ----------------------------------------------------------------------------------


def test_option_ids_encode_their_token_references() -> None:
    assert option_id_for_refs(["2:0"]) == "2:0"
    assert option_id_for_refs(["2:0", "2:1", "2:2"]) == "2:0,2:1,2:2"
    assert refs_for_option_id("2:0,2:1,2:2") == ["2:0", "2:1", "2:2"]
    assert refs_for_option_id(option_id_for_refs(["10:3", "10:4"])) == ["10:3", "10:4"]
    for bad in ([], ["x"], ["1:"], ["1:2", ""]):
        with pytest.raises(ValueError):
            option_id_for_refs(bad)
    for bad_id in ("", "opt-a", "1:2;3:4", "1:2,"):
        with pytest.raises(ValueError):
            refs_for_option_id(bad_id)


# --- responses: camelCase shapes of the contract --------------------------------------------------

SOURCE = SourceRef(
    publisher="QuranEnc",
    edition_label="طبعة تجريبية",
    book_title_ar="كتاب تجريبي",
    reference="112:1",
    url="https://example.invalid/ref/112",
)


def context() -> QuestionContext:
    return QuestionContext(
        before=[TokenView(ref="1:0", text="كلمة")], after=[TokenView(ref="1:2", text="نص")]
    )


def base(**extra: Any) -> dict[str, Any]:
    values: dict[str, Any] = {
        "question_id": UUID(QUESTION),
        "passage_id": UUID(PASSAGE),
        "role": "training",
        "review_round_id": None,
        "context": context(),
        "policy": QuestionPolicy(),
        "source": SOURCE,
    }
    values.update(extra)
    return values


def all_questions() -> list[Any]:
    return [
        WordChoiceQuestion(
            **base(),
            type="word_choice",
            variant="word",
            options=[
                ChoiceOption(option_id="1:0", text="أ"),
                ChoiceOption(option_id="2:0", text="ب"),
            ],
            answer_key=OptionAnswerKey(option_id="1:0"),
        ),
        SimilarQuestion(
            **base(),
            type="similar_distinction",
            options=[
                ChoiceOption(option_id="1:0", text="أ"),
                ChoiceOption(option_id="2:0", text="ب"),
            ],
            answer_key=OptionAnswerKey(option_id="2:0"),
        ),
        RecallQuestion(
            **base(),
            type="word_recall",
            hint_first_letter="ك",
            answer_key=RecallAnswerKey(accepted_norms=["كلمه"]),
        ),
        WordOrderQuestion(
            **base(),
            type="word_order",
            tokens=[TokenView(ref="1:1", text="ب"), TokenView(ref="1:0", text="أ")],
            answer_key=OrderAnswerKey(order=["1:0", "1:1"]),
        ),
    ]


def passage_view() -> PassageView:
    return PassageView(
        passage_id=UUID(PASSAGE),
        path="quran",
        reference="112:1-4",
        section_title_ar="سورة تجريبية",
        units=[PassageUnit(unit_ref=1, kind="ayah", reference="112:1", text="كلمة مثال")],
        highlight=Highlight(start_ref="1:0", end_ref="1:1"),
        takhrij=None,
        grade=None,
        show_d50_notice=False,
        source=SOURCE,
    )


def test_a_snapshot_dumps_in_the_camel_case_shape_of_the_contract() -> None:
    steps = [LearnStep(type="learn", passage=passage_view())] + [
        QuestionStep(type="question", question=q) for q in all_questions()
    ]
    snapshot = SessionSnapshot(
        session_id=UUID(SESSION),
        kind="daily",
        plan_id=UUID(PLAN),
        plan_version=2,
        edition_id=UUID(EDITION),
        bank_version=1,
        learning_date=date(2026, 10, 5),
        status="open",
        steps=steps,
        created_at=datetime.fromisoformat("2026-10-05T07:00:00+00:00"),
    )
    data = json.loads(snapshot.model_dump_json(by_alias=True))
    assert set(data) == {
        "sessionId",
        "kind",
        "planId",
        "planVersion",
        "editionId",
        "bankVersion",
        "learningDate",
        "status",
        "steps",
        "createdAt",
    }
    assert data["learningDate"] == "2026-10-05" and data["createdAt"].endswith("Z")
    learn = data["steps"][0]
    assert learn["type"] == "learn"
    assert set(learn["passage"]) == {
        "passageId",
        "path",
        "reference",
        "sectionTitleAr",
        "units",
        "highlight",
        "takhrij",
        "grade",
        "showD50Notice",
        "source",
    }
    assert learn["passage"]["units"][0] == {
        "unitRef": 1,
        "kind": "ayah",
        "reference": "112:1",
        "text": "كلمة مثال",
    }
    assert learn["passage"]["takhrij"] is None and learn["passage"]["grade"] is None
    choice, similar, recall, order = (step["question"] for step in data["steps"][1:])
    common = {
        "questionId",
        "type",
        "passageId",
        "role",
        "reviewRoundId",
        "context",
        "policy",
        "source",
    }
    assert set(choice) == common | {"variant", "options", "answerKey"}
    assert set(similar) == common | {"options", "answerKey"}  # no variant on a similar question
    assert set(recall) == common | {"hintFirstLetter", "answerKey"}
    assert set(order) == common | {"tokens", "answerKey"}
    assert choice["policy"] == {
        "normalizationPolicyVersion": "arabic-norm-v1",
        "scoringPolicyVersion": "v1",
    }
    assert choice["answerKey"] == {"optionId": "1:0"}
    assert recall["answerKey"] == {"acceptedNorms": ["كلمه"]}
    assert order["answerKey"] == {"order": ["1:0", "1:1"]}
    assert choice["context"]["before"] == [{"ref": "1:0", "text": "كلمة"}]
    assert choice["source"]["pages"] == []
    assert choice["reviewRoundId"] is None


def test_a_dumped_snapshot_validates_back_into_the_same_steps() -> None:
    steps = [LearnStep(type="learn", passage=passage_view())] + [
        QuestionStep(type="question", question=q) for q in all_questions()
    ]
    adapter = TypeAdapter(list[Step])
    dumped = adapter.dump_python(steps, mode="json", by_alias=True)
    assert adapter.validate_python(dumped) == steps
    assert isinstance(adapter.validate_python(dumped)[1].question, WordChoiceQuestion)  # type: ignore[union-attr]
    question_adapter = TypeAdapter(Question)
    for question in all_questions():
        assert (
            question_adapter.validate_python(question.model_dump(mode="json", by_alias=True))
            == question
        )


def test_the_question_union_is_decided_by_type_and_refuses_a_foreign_shape() -> None:
    data = all_questions()[2].model_dump(mode="json", by_alias=True)
    data["type"] = "word_order"
    with pytest.raises(ValueError):
        TypeAdapter(Question).validate_python(data)


def test_today_progress_and_completion_shapes() -> None:
    daily = DailyProgress(
        learning_date=date(2026, 10, 5),
        daily_active_ms=420000,
        daily_goal_ms=600000,
        daily_percent=70,
        daily_completed=False,
        extra_active_ms=0,
    )
    dumped = json.loads(daily.model_dump_json(by_alias=True))
    assert dumped == {
        "learningDate": "2026-10-05",
        "dailyActiveMs": 420000,
        "dailyGoalMs": 600000,
        "dailyPercent": 70,
        "dailyCompleted": False,
        "extraActiveMs": 0,
    }
    done = CompleteResponse(
        summary=CompleteSummary(
            answered=12,
            correct=10,
            new_passages=1,
            reviews_passed=1,
            reviews_failed=0,
            active_ms=540000,
        ),
        daily=daily,
    )
    assert json.loads(done.model_dump_json(by_alias=True))["summary"] == {
        "answered": 12,
        "correct": 10,
        "newPassages": 1,
        "reviewsPassed": 1,
        "reviewsFailed": 0,
        "activeMs": 540000,
    }


def test_today_and_progress_models_accept_the_documented_fields() -> None:
    from app.contracts_sessions import (
        HistoryDay,
        NextNewPassage,
        PlanProgress,
        ProgressResponse,
        SectionProgress,
        StatusCounts,
        Today,
    )

    daily = DailyProgress(
        learning_date=date(2026, 10, 5),
        daily_active_ms=0,
        daily_goal_ms=600000,
        daily_percent=0,
        daily_completed=False,
        extra_active_ms=0,
    )
    today = Today(
        **daily.model_dump(),
        plan=None,
        due_reviews=2,
        next_new_passage=NextNewPassage(reference="79:1-5", section_title_ar="سورة"),
        open_session_id=None,
        streak_days=3,
    )
    data = json.loads(today.model_dump_json(by_alias=True))
    assert data["dueReviews"] == 2 and data["nextNewPassage"]["sectionTitleAr"] == "سورة"
    assert data["openSessionId"] is None and data["plan"] is None and data["openPlanChatId"] is None
    progress = ProgressResponse(
        daily=daily,
        history=[
            HistoryDay(date=date(2026, 10, 4), active_ms=660000, goal_ms=300000, completed=True)
        ],
        plans=[
            PlanProgress(
                plan_id=UUID(PLAN),
                title_ar="عنوان",
                title_en="Title",
                status="completed",
                current_version=2,
                overall_percent=100,
                confirmed_words=180,
                total_words=180,
                confirmed_sections=2,
                total_sections=2,
                counts=StatusCounts(new=0, learning=0, reviewing=0, confirmed=4, needs_refresh=0),
                next_review_date=None,
                sections=[
                    SectionProgress(
                        ordinal=1,
                        reference="78",
                        title_ar="س",
                        title_en="Surah 78",
                        percent=100,
                        status="confirmed",
                    )
                ],
            )
        ],
    )
    plan = json.loads(progress.model_dump_json(by_alias=True))["plans"][0]
    assert plan["currentVersion"] == 2 and plan["counts"]["needsRefresh"] == 0
    assert plan["nextReviewDate"] is None and plan["sections"][0]["status"] == "confirmed"


def test_events_response_drops_unset_expected_members_and_keeps_the_o21_codes() -> None:
    daily = DailyProgress(
        learning_date=date(2026, 10, 5),
        daily_active_ms=180000,
        daily_goal_ms=600000,
        daily_percent=30,
        daily_completed=False,
        extra_active_ms=0,
    )
    response = EventsResponse(
        acknowledged=[UUID(EVENT)],
        duplicate=[],
        pending=[PendingEvent(client_event_id=UUID(EVENT), reason_code="policy_unsupported")],
        rejected=[RejectedEvent(client_event_id=UUID(EVENT), code="invalid_answer_shape")],
        results=[
            AnswerResult(
                client_event_id=UUID(EVENT),
                question_id=UUID(QUESTION),
                correct=True,
                assisted=False,
                expected=AnswerExpected(option_id="1:0"),
                passage=AnswerPassageState(
                    passage_id=UUID(PASSAGE),
                    status="learning",
                    covered_parts=1,
                    total_parts=3,
                    consecutive_correct=1,
                ),
            )
        ],
        daily=daily,
    )
    data = json.loads(response.model_dump_json(by_alias=True))
    assert data["results"][0]["expected"] == {"optionId": "1:0"}
    assert data["results"][0]["passage"]["coveredParts"] == 1
    assert data["pending"] == [{"clientEventId": EVENT, "reasonCode": "policy_unsupported"}]
    assert data["rejected"] == [{"clientEventId": EVENT, "code": "invalid_answer_shape"}]
    assert json.loads(AnswerExpected(order=["1:0"], word=None).model_dump_json(by_alias=True)) == {
        "order": ["1:0"]
    }
    with pytest.raises(ValueError):
        RejectedEvent(client_event_id=UUID(EVENT), code="not_an_o21_code")  # type: ignore[arg-type]


# --- E21 request ---------------------------------------------------------------------------------


def answer_event(**overrides: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "clientEventId": EVENT,
        "type": "answer",
        "questionId": QUESTION,
        "answer": {"optionId": "opt-a"},
        "hintUsed": False,
        "occurredAt": "2026-10-05T07:03:10Z",
        "durationMs": 8200,
    }
    event.update(overrides)
    return event


def activity_event(**overrides: Any) -> dict[str, Any]:
    event: dict[str, Any] = {
        "clientEventId": "99999999-9999-4999-8999-000000000002",
        "type": "activity",
        "startedAt": "2026-10-05T07:00:05Z",
        "endedAt": "2026-10-05T07:03:05Z",
        "activeMs": 180000,
    }
    event.update(overrides)
    return event


ENVELOPE: dict[str, Any] = {
    "clientRunId": "88888888-8888-4888-8888-000000000001",
    "snapshotId": "88888888-8888-4888-8888-000000000002",
    "protocolVersion": 1,
    "planVersion": 2,
    "editionId": EDITION,
    "bankVersion": 1,
    "normalizationPolicyVersion": "arabic-norm-v1",
    "scoringPolicyVersion": "v1",
    "localSequence": 4,
}


def event_violations(raw: Any) -> list[tuple[str, str]]:
    with pytest.raises(RequestViolation) as raised:
        parse_events_request(raw)
    return list(raised.value.fields)


def test_valid_online_and_offline_events_parse() -> None:
    parsed = parse_events_request(
        {
            "events": [
                answer_event(),
                answer_event(answer={"order": ["1:0", "1:1"]}),
                answer_event(answer={"text": "كلمة"}),
                activity_event(),
                answer_event(**ENVELOPE),
            ]
        }
    )
    types = [type(event) for event in parsed.events]
    assert types == [AnswerEvent, AnswerEvent, AnswerEvent, ActivityEvent, AnswerEvent]
    assert isinstance(parsed.events[0].answer, OptionAnswer)  # type: ignore[union-attr]
    assert isinstance(parsed.events[1].answer, OrderAnswer)  # type: ignore[union-attr]
    assert isinstance(parsed.events[2].answer, TextAnswer)  # type: ignore[union-attr]
    assert not parsed.events[0].has_envelope and parsed.events[4].has_envelope
    assert (
        EventsRequest.model_validate({"events": [activity_event()]}).events[0].active_ms == 180000
    )  # type: ignore[union-attr]


def test_a_forbidden_property_inside_an_event_reads_events_index_property() -> None:
    events = [activity_event(), activity_event(), activity_event(), answer_event(correct=True)]
    assert event_violations({"events": events}) == [("events[3].correct", "forbidden_field")]
    for name in ("userId", "mode", "isDemo", "mastery"):
        assert event_violations({"events": [answer_event(**{name: 1})]}) == [
            (f"events[0].{name}", "forbidden_field")
        ]
    assert event_violations({"events": [activity_event(correct=True)]}) == [
        ("events[0].correct", "forbidden_field")
    ]


def test_event_counts_empty_and_too_many() -> None:
    assert event_violations({"events": []}) == [("events", "events_empty")]
    assert event_violations({"events": [activity_event()] * 101 + [{"bogus": 1}]}) == [
        ("events", "events_too_many")
    ]
    assert len(parse_events_request({"events": [activity_event()] * 100}).events) == 100


def test_a_partial_offline_envelope_is_envelope_incomplete() -> None:
    partial = {name: ENVELOPE[name] for name in list(ENVELOPE)[:4]}
    assert event_violations({"events": [answer_event(**partial)]}) == [
        ("events[0]", "envelope_incomplete")
    ]
    assert event_violations({"events": [activity_event(clientRunId=ENVELOPE["clientRunId"])]}) == [
        ("events[0]", "envelope_incomplete")
    ]
    complete = parse_events_request({"events": [activity_event(**ENVELOPE)]}).events[0]
    assert complete.has_envelope  # type: ignore[union-attr]


def test_a_complete_envelope_is_read_as_one_value_and_an_online_event_has_none() -> None:
    online, offline = parse_events_request(
        {"events": [answer_event(), answer_event(**ENVELOPE)]}
    ).events
    assert online.envelope() is None
    envelope = offline.envelope()
    assert isinstance(envelope, OfflineEnvelope)
    assert envelope.client_run_id == UUID(ENVELOPE["clientRunId"])
    assert envelope.snapshot_id == UUID(ENVELOPE["snapshotId"])
    assert envelope.edition_id == UUID(EDITION)
    assert (envelope.protocol_version, envelope.plan_version, envelope.bank_version) == (1, 2, 1)
    assert envelope.normalization_policy_version == "arabic-norm-v1"
    assert envelope.scoring_policy_version == "v1" and envelope.local_sequence == 4
    assert envelope.model_dump(by_alias=True, mode="json") == ENVELOPE


def test_envelope_values_of_another_version_are_accepted_for_the_per_event_decision() -> None:
    odd = dict(
        ENVELOPE,
        protocolVersion=2,
        normalizationPolicyVersion="arabic-norm-v2",
        scoringPolicyVersion="v9",
    )
    event = parse_events_request({"events": [answer_event(**odd)]}).events[0]
    assert (
        event.protocol_version == 2
    )  # B6 answers envelope_mismatch / policy_unsupported per event
    assert event.normalization_policy_version == "arabic-norm-v2"


@pytest.mark.parametrize(
    ("override", "field", "rule"),
    [
        ({"hintUsed": "false"}, "events[0].hintUsed", "bool_type"),
        ({"durationMs": -1}, "events[0].durationMs", "greater_than_equal"),
        ({"durationMs": "5"}, "events[0].durationMs", "int_type"),
        ({"occurredAt": "2026-10-05T07:03:10"}, "events[0].occurredAt", "timezone_aware"),
        ({"clientEventId": "x"}, "events[0].clientEventId", "uuid_parsing"),
        ({"questionId": None}, "events[0].questionId", "uuid_type"),
    ],
)
def test_malformed_event_fields_are_reported_by_path(
    override: dict[str, Any], field: str, rule: str
) -> None:
    assert event_violations({"events": [answer_event(**override)]}) == [(field, rule)]


def test_unknown_event_types_and_a_non_object_body_are_refused() -> None:
    assert event_violations({"events": [{"type": "bogus"}]}) == [("events[0]", "union_tag_invalid")]
    assert event_violations({"events": [{}]}) == [("events[0]", "union_tag_not_found")]
    assert event_violations([]) == [("body", "object_required")]
    assert event_violations({"events": "x"}) == [("events", "list_type")]


def test_an_answer_that_fits_no_shape_is_refused_by_field() -> None:
    found = event_violations({"events": [answer_event(answer={"foo": 1})]})
    assert {field for field, _ in found} >= {
        "events[0].answer.order",
        "events[0].answer.optionId",
        "events[0].answer.text",
    }
    assert all(field.startswith("events[0].answer") for field, _ in found)  # no class names leak
    assert {rule for _, rule in found} == {"required", "forbidden_field"}
