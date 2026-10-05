"""Model-assisted question words (D90): the request, the validation, the store, the builder, the
CLI step and the reusable free-only OpenRouter call.

Synthetic text only (``tests/data/synthetic_bundle.json``); no network (``httpx.MockTransport`` and
fake providers), no secrets. Nothing here asks a real model anything.
"""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.domain.normalization import is_arabic_script_word
from app.providers.llm import (
    PLAN_CHAT_SYSTEM_PROMPT,
    REPLY_JSON_SCHEMA,
    ProviderUnavailable,
)
from app.providers.openrouter import JsonReply, OpenRouterProvider, build_default_provider
from app.workflow import question_proposals as qp
from app.workflow.bundle import dumps_bundle, loads_bundle, structure_of, with_bank
from app.workflow.errors import ExitCode, InputError
from app.workflow.ids import stable_id
from app.workflow.lesson_question_builder import (
    STOPLIST,
    PartPick,
    _Builder,
    build_question_bank,
)
from app.workflow.question_proposals import ProposalStore, RawPick
from app.workflow.validation import validate_bank
from scripts.content_tools import CliRuntime, main
from tests.support import make_settings
from tests.workflow.wf_d83_support import LABELS, ORACLE, QURAN_RECORDS, rows
from tests.workflow.wf_support import (
    DATA,
    QURAN_ED,
    TickingClock,
    assert_no_source_text,
    quran_args,
    run_cli,
)

BUNDLE = structure_of(loads_bundle((DATA / "synthetic_bundle.json").read_text(encoding="utf-8")))
RULES = build_question_bank(BUNDLE)
MODEL = "vendor/free-model:free"
P1 = "quran:1:1"  # words 1:0 كلمه, 1:1 مثال, 1:2 تجريبي (rules: keyword 1:2, choice 1:0)
P2 = "quran:1:2"  # words 2:0 هذا (stoplist), 2:1 نص, 2:2 تجريبي
GOOD = PartPick("1:1", "1:2", ("1:0", "2:1", "3:0"))


@pytest.fixture
def builder() -> _Builder:
    return _Builder(BUNDLE)


def raw(ordinal: int, keyword: str, choice: str, *distractors: str) -> RawPick:
    return RawPick(ordinal, keyword, choice, tuple(distractors))


def part_id(key: str) -> str:
    path, passage, ordinal = key.split(":")
    entry = next(
        p for p in BUNDLE["passages"] if p["path"] == path and p["ordinal"] == int(passage)
    )
    return next(part["id"] for part in entry["parts"] if part["ordinal"] == int(ordinal))


def untouched(bank: Any) -> list[dict[str, Any]]:
    """The questions a pick can never change: orders, similar distinctions, next segments."""
    return [
        q
        for q in bank.questions
        if q["type"] in ("word_order", "similar_distinction") or q["variant"] == "segment"
    ]


def of_part(bank: Any, key: str, type_: str, variant: str | None) -> list[dict[str, Any]]:
    pid = part_id(key)
    return [
        q
        for q in bank.questions
        if q["type"] == type_ and q["variant"] == variant and q["coveredPartIds"] == [pid]
    ]


class FakeProvider:
    """Answers each request with ``responder(payload)``: a reply object, or an exception."""

    name = "fake"

    def __init__(self, responder: Callable[[dict[str, Any]], Any]) -> None:
        self.responder = responder
        self.requests: list[dict[str, Any]] = []
        self.calls: list[dict[str, Any]] = []

    def complete_json(
        self,
        payload: dict[str, Any],
        *,
        system_prompt: str,
        response_schema: dict[str, Any],
        schema_name: str = "x",
        max_tokens: int,
        timeout_sec: float,
    ) -> JsonReply:
        self.requests.append(payload)
        self.calls.append(
            {
                "system_prompt": system_prompt,
                "schema": response_schema,
                "schema_name": schema_name,
                "max_tokens": max_tokens,
                "timeout_sec": timeout_sec,
            }
        )
        result = self.responder(payload)
        if isinstance(result, Exception):
            raise result
        return JsonReply(data=result, model=MODEL, input_tokens=10, output_tokens=5)


def good_reply(payload: dict[str, Any]) -> dict[str, Any]:
    """A model-like answer: last word as the keyword, first as the choice, 3 other pool words."""
    parts = []
    for part in payload["parts"]:
        words = part["words"]
        choice = words[0]
        others = [w["ref"] for w in payload["pool"] if w["text"] != choice["text"]][:3]
        parts.append(
            {
                "partOrdinal": part["partOrdinal"],
                "keywordRef": words[-1]["ref"],
                "choiceRef": choice["ref"],
                "distractorRefs": others,
            }
        )
    return {"parts": parts}


def populated_store(path: Path | None = None) -> ProposalStore:
    store = ProposalStore(path)
    qp.propose_questions(BUNDLE, FakeProvider(good_reply), store)
    return store


# --- the request -----------------------------------------------------------------------------


def test_request_holds_the_parts_and_a_deduplicated_arabic_pool_of_the_section(
    builder: _Builder,
) -> None:
    request = qp.build_proposal_request(BUNDLE, 0)
    assert set(request) == {"passageKey", "parts", "pool"}
    assert request["passageKey"] == "quran:1"
    assert [p["partOrdinal"] for p in request["parts"]] == [1, 2, 3, 4]
    first = request["parts"][0]["words"]
    assert [w["ref"] for w in first] == ["1:0", "1:1", "1:2"]
    assert all(set(w) == {"ref", "text"} and w["text"] for w in first)
    pool_refs = [w["ref"] for w in request["pool"]]
    # one word per normalized form, the first in reading order, nothing from another section
    assert pool_refs == ["1:0", "1:1", "1:2", "2:0", "2:1", "3:0", "3:1"]
    norms = [builder._word_by_ref[r].n for r in pool_refs]
    assert len(set(norms)) == len(norms)
    assert not set(pool_refs) & {"5:0", "10:0"}
    json.dumps(request, ensure_ascii=False)  # plain JSON data


def test_pool_is_capped_and_never_holds_grade_or_non_arabic_words(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    hadith = structure_of(
        loads_bundle((DATA / "synthetic_bundle_hadith.json").read_text(encoding="utf-8"))
    )
    hb = _Builder(hadith)
    grade_words = {
        w.ref for i, p in enumerate(hadith["passages"]) if p["path"] == "grade" for w in hb.words[i]
    }
    for index in range(len(hadith["passages"])):
        pool = {w["ref"] for w in qp.build_proposal_request(hb, index)["pool"]}
        assert not pool & grade_words
    monkeypatch.setattr(qp, "POOL_CAP", 3)
    assert len(qp.build_proposal_request(BUNDLE, 0)["pool"]) == 3
    latin = copy.deepcopy(BUNDLE)
    latin["units"][1]["tokens"][1]["n"] = "latin"  # unit 2, token 1 (2:1)
    refs = {w["ref"] for w in qp.build_proposal_request(latin, 0)["pool"]}
    assert "2:1" not in refs


def test_prompt_and_schema_ask_for_references_only() -> None:
    prompt = qp.SYSTEM_PROMPT
    for needle in ("keywordRef", "choiceRef", "distractorRefs", "pool", "refs only", "JSON"):
        assert needle in prompt
    assert any("؀" <= ch <= "ۿ" for ch in prompt)  # Arabic as well as English
    parts = qp.RESPONSE_SCHEMA["properties"]["parts"]["items"]
    assert parts["required"] == ["partOrdinal", "keywordRef", "choiceRef", "distractorRefs"]
    assert parts["properties"]["distractorRefs"]["minItems"] == 3
    assert qp.RESPONSE_SCHEMA["additionalProperties"] is False


# --- validation ------------------------------------------------------------------------------


def verdict(proposal: RawPick, key: str = P1, passage: int = 0):
    accepted, rejections = qp.validate_proposal(BUNDLE, passage, [proposal])
    return accepted.get(key), {(r.component, r.reason) for r in rejections if r.part_key == key}


def test_a_valid_pick_is_accepted_whole() -> None:
    pick, rejected = verdict(raw(1, "1:1", "1:2", "1:0", "2:1", "3:0"))
    assert pick == GOOD
    assert rejected == set()


@pytest.mark.parametrize(
    ("proposal", "component", "reason"),
    [
        (raw(1, "2:1", "1:2", "1:0", "2:1", "3:0"), "keyword", "keyword_not_in_part"),
        (raw(1, "9:9", "1:2", "1:0", "2:1", "3:0"), "keyword", "keyword_unknown_ref"),
        (raw(1, "bad", "1:2", "1:0", "2:1", "3:0"), "keyword", "keyword_unknown_ref"),
        (raw(1, "1:1", "2:1", "1:0", "2:1", "3:0"), "choice", "choice_not_in_part"),
        (raw(1, "1:1", "9:9", "1:0", "2:1", "3:0"), "choice", "choice_unknown_ref"),
        (raw(1, "1:1", "1:1", "1:0", "2:1", "3:0"), "choice", "choice_same_as_keyword"),
        (raw(1, "1:1", "1:2", "1:0", "2:1"), "choice", "distractors_count"),
        (raw(1, "1:1", "1:2", "1:0", "2:1", "3:0", "3:1"), "choice", "distractors_count"),
        (raw(1, "1:1", "1:2", "1:0", "2:1", "5:0"), "choice", "distractor_not_in_pool"),
        (raw(1, "1:1", "1:2", "1:0", "2:1", "9:9"), "choice", "distractor_unknown_ref"),
        (raw(1, "1:1", "1:2", "1:0", "2:1", "2:1"), "choice", "distractor_duplicate"),
        (raw(1, "1:1", "1:2", "1:0", "2:1", "1:2"), "choice", "distractor_same_as_target"),
    ],
)
def test_a_bad_component_is_rejected_with_its_reason_and_the_other_survives(
    proposal: RawPick, component: str, reason: str
) -> None:
    pick, rejected = verdict(proposal)
    assert rejected == {(component, reason)}
    assert pick is not None
    if component == "keyword":
        assert pick.keyword_ref is None and pick.choice_ref == "1:2"
    else:
        assert pick.choice_ref is None and pick.distractor_refs == ()
        assert pick.keyword_ref == "1:1"


def test_the_continuation_word_of_a_later_part_is_not_a_choice_target() -> None:
    # quran:1:3 starts with 3:0, which the rules already test as the continuation point
    pick, rejected = verdict(raw(3, "3:2", "3:0", "1:0", "1:1", "2:1"), "quran:1:3")
    assert rejected == {("choice", "choice_is_continuation_word")}
    assert pick == PartPick("3:2", None, ())
    # the first part has no continuation point: its first word may be the choice
    assert verdict(raw(1, "1:1", "1:0", "1:2", "2:1", "3:0"))[1] == set()


def test_a_stoplist_target_is_rejected() -> None:
    assert "هذا" in STOPLIST
    pick, rejected = verdict(raw(2, "2:0", "2:0", "1:0", "2:1", "3:0"), P2)
    assert pick is None
    assert rejected == {("keyword", "keyword_stoplist"), ("choice", "choice_stoplist")}


def test_a_latin_or_foreign_distractor_is_rejected() -> None:
    latin = copy.deepcopy(BUNDLE)
    latin["units"][1]["tokens"][1]["n"] = "latin"  # 2:1
    accepted, rejections = qp.validate_proposal(
        latin, 0, [raw(1, "1:1", "1:2", "1:0", "2:1", "3:0")]
    )
    assert {(r.component, r.reason) for r in rejections if r.part_key == P1} == {
        ("choice", "distractor_not_arabic")
    }
    assert accepted[P1].choice_ref is None


def test_an_ambiguous_target_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_Builder, "_unambiguous", lambda self, w: w.ref != "1:1")
    pick, rejected = verdict(raw(1, "1:1", "1:2", "1:0", "2:1", "3:0"))
    assert rejected == {("keyword", "keyword_ambiguous")}
    assert pick == PartPick(None, "1:2", ("1:0", "2:1", "3:0"))


def test_a_recall_excluded_keyword_falls_back_to_the_rules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_Builder, "_recall_excluded", lambda self, w: w.ref == "1:1")
    pick, rejected = verdict(raw(1, "1:1", "1:2", "1:0", "2:1", "3:0"))
    assert rejected == {("keyword", "keyword_recall_excluded")}
    assert pick is not None and pick.keyword_ref is None and pick.choice_ref == "1:2"


def test_a_missing_part_and_an_unknown_part_are_reported() -> None:
    accepted, rejections = qp.validate_proposal(
        BUNDLE, 0, [raw(7, "1:1", "1:2", "1:0", "2:1", "3:0")]
    )
    assert accepted == {}
    reasons = {(r.part_key, r.component, r.reason) for r in rejections}
    assert (P1, "part", "missing_part") in reasons
    assert ("quran:1", "part", "unknown_part:7") in reasons


def test_only_the_first_entry_of_a_part_counts() -> None:
    accepted, _ = qp.validate_proposal(
        BUNDLE,
        0,
        [raw(1, "1:1", "1:2", "1:0", "2:1", "3:0"), raw(1, "1:0", "1:1", "2:1", "3:0", "3:1")],
    )
    assert accepted[P1] == GOOD


def test_parse_response_is_strict_about_shape() -> None:
    parsed = qp.parse_response(
        {
            "parts": [
                {"partOrdinal": "2", "keywordRef": " 2:1 ", "choiceRef": 5, "distractorRefs": "x"},
                {"partOrdinal": True},
                "junk",
            ]
        }
    )
    assert parsed == [RawPick(2, "2:1", "", ())]
    for bad in (None, [], {"parts": "x"}, {"parts": []}, {"parts": [{"partOrdinal": "a"}]}):
        with pytest.raises(qp.ProposalFormatError):
            qp.parse_response(bad)


# --- the builder -----------------------------------------------------------------------------


def test_the_builder_uses_an_accepted_pick_with_the_same_item_shapes() -> None:
    bank = build_question_bank(BUNDLE, {P1: GOOD})
    (keyword,) = of_part(bank, P1, "word_recall", "keyword")
    assert keyword["tokenRefs"] == ["1:1"] and keyword["correctRef"] == ["1:1"]
    assert keyword["id"] == stable_id(
        BUNDLE["editionKey"], BUNDLE["bankVersion"], "question", "word_recall|keyword|1:1"
    )
    (choice,) = of_part(bank, P1, "word_choice", "word")
    assert choice["tokenRefs"] == ["1:2"] and choice["correctRef"] == ["1:2"]
    assert choice["optionRefs"] == [["1:0"], ["1:2"], ["2:1"], ["3:0"]]  # sorted as today
    assert choice["id"] == stable_id(
        BUNDLE["editionKey"], BUNDLE["bankVersion"], "question", "word_choice|word|1:2"
    )
    rules_keyword = of_part(RULES, P1, "word_recall", "keyword")[0]
    assert set(keyword) == set(rules_keyword)  # no new key on a question item
    assert len(bank.questions) == len(RULES.questions)
    changed = {q["id"] for q in bank.questions} ^ {q["id"] for q in RULES.questions}
    assert len(changed) == 4  # the two questions of the part, swapped; nothing else moved
    assert bank.usage == {P1: {"keyword": "ai", "choice": "ai"}}


def test_the_builder_without_a_usable_pick_equals_the_rules_bank() -> None:
    assert build_question_bank(BUNDLE, None).questions == RULES.questions
    assert build_question_bank(BUNDLE, {}).questions == RULES.questions
    junk = PartPick("99:9", "98:8", ("1:0", "2:1", "3:0"))
    wrong_part = PartPick("1:1", "1:2", ("1:0", "2:1"))  # words of another part, 2 distractors
    bank = build_question_bank(BUNDLE, {P1: junk, P2: wrong_part})
    assert bank.questions == RULES.questions and bank.lessons == RULES.lessons
    assert bank.usage[P1] == {"keyword": "rules", "choice": "rules"}


def test_a_keyword_only_pick_keeps_the_rules_choice() -> None:
    bank = build_question_bank(BUNDLE, {P1: PartPick(keyword_ref="1:1")})
    assert of_part(bank, P1, "word_recall", "keyword")[0]["tokenRefs"] == ["1:1"]
    assert of_part(bank, P1, "word_choice", "word")[0]["tokenRefs"] == ["1:2"]  # rules, next word
    assert bank.usage[P1] == {"keyword": "ai", "choice": "rules"}


def test_a_choice_only_pick_keeps_the_rules_keyword_off_the_models_word() -> None:
    pick = PartPick(choice_ref="1:2", distractor_refs=("1:0", "2:1", "3:0"))
    bank = build_question_bank(BUNDLE, {P1: pick})
    assert of_part(bank, P1, "word_recall", "keyword")[0]["tokenRefs"] == ["1:0"]  # not 1:2
    assert of_part(bank, P1, "word_choice", "word")[0]["tokenRefs"] == ["1:2"]
    assert bank.usage[P1] == {"keyword": "rules", "choice": "ai"}


def test_other_question_types_are_not_touched_by_a_pick() -> None:
    bank = build_question_bank(BUNDLE, {P1: GOOD, P2: PartPick(keyword_ref="2:1")})
    assert untouched(bank) == untouched(RULES)


@pytest.mark.parametrize("name", ["synthetic_bundle.json", "synthetic_bundle_hadith.json"])
def test_a_bank_built_with_picks_passes_the_bank_validation(name: str) -> None:
    structure = structure_of(loads_bundle((DATA / name).read_text(encoding="utf-8")))
    store = ProposalStore()
    result = qp.propose_questions(structure, FakeProvider(good_reply), store)
    assert result.proposed == result.passages and result.passages > 0
    review = qp.review_store(structure, store)
    assert review.picks
    bank = build_question_bank(structure, review.picks)
    assert bank.usage and any("ai" in u.values() for u in bank.usage.values())
    report = validate_bank(with_bank(structure, bank.lessons, bank.questions))
    assert [(i.code, i.ref) for i in report.issues] == []
    words = _Builder(structure)._word_by_ref
    for question in bank.questions:  # every option stays an Arabic-script word of the edition
        for option in question["optionRefs"] or []:
            assert all(ref in words and is_arabic_script_word(words[ref].n) for ref in option)


def test_the_same_store_gives_the_same_bank() -> None:
    store = populated_store()
    first = qp.review_store(BUNDLE, store)
    second = qp.review_store(BUNDLE, ProposalStore.loads(store.dumps()))
    assert first.picks == second.picks and first.picks
    one = build_question_bank(BUNDLE, first.picks)
    two = build_question_bank(BUNDLE, second.picks)
    assert one.questions == two.questions and one.usage == two.usage
    full = lambda r: dumps_bundle(with_bank(BUNDLE, r.lessons, r.questions))  # noqa: E731
    assert full(one) == full(two)
    assert one.questions != RULES.questions  # the picks changed something


# --- the run ---------------------------------------------------------------------------------


def test_one_request_per_passage_with_the_published_text_only() -> None:
    provider = FakeProvider(good_reply)
    store = ProposalStore()
    result = qp.propose_questions(BUNDLE, provider, store, timeout_sec=12, max_requests=10)
    assert (result.passages, result.requests, result.proposed) == (4, 4, 4)
    assert (result.reused, result.failed, result.deferred, result.stopped) == (0, 0, 0, None)
    assert [r["passageKey"] for r in provider.requests] == [f"quran:{i}" for i in (1, 2, 3, 4)]
    first = provider.calls[0]
    assert first["system_prompt"] == qp.SYSTEM_PROMPT
    assert first["schema"] == qp.RESPONSE_SCHEMA and first["schema_name"] == qp.SCHEMA_NAME
    assert first["timeout_sec"] == 12 and 0 < first["max_tokens"] <= 4000
    assert result.models == {MODEL} and len(store) == 4


def test_a_current_entry_is_reused_and_refresh_asks_again(tmp_path: Path) -> None:
    path = tmp_path / "question-proposals.json"
    store = ProposalStore(path)
    qp.propose_questions(BUNDLE, FakeProvider(good_reply), store)
    again = FakeProvider(good_reply)
    result = qp.propose_questions(BUNDLE, again, ProposalStore.load(path))
    assert (result.reused, result.requests, again.requests) == (4, 0, [])
    refreshed = qp.propose_questions(BUNDLE, again, ProposalStore.load(path), refresh=True)
    assert refreshed.requests == 4


def test_the_request_cap_and_the_daily_limit_bound_the_run() -> None:
    provider = FakeProvider(good_reply)
    result = qp.propose_questions(BUNDLE, provider, ProposalStore(), max_requests=2)
    assert (result.requests, result.deferred) == (2, 2)
    limited = qp.propose_questions(
        BUNDLE, provider, ProposalStore(), max_requests=10, daily_limit=1
    )
    assert (limited.requests, limited.deferred) == (1, 3)
    none = qp.propose_questions(BUNDLE, provider, ProposalStore(), max_requests=0)
    assert (none.requests, none.deferred) == (0, 4)


def test_the_run_is_paced_between_requests() -> None:
    pauses: list[float] = []
    qp.propose_questions(
        BUNDLE, FakeProvider(good_reply), ProposalStore(), pause_sec=3.5, sleep=pauses.append
    )
    assert pauses == [3.5, 3.5, 3.5]  # between 4 requests, never before the first


def test_a_dry_run_sends_nothing() -> None:
    provider = FakeProvider(good_reply)
    store = ProposalStore()
    result = qp.propose_questions(BUNDLE, None, store, dry_run=True, max_requests=3)
    assert (result.planned, result.requests, result.deferred, len(store)) == (3, 0, 1, 0)
    assert provider.requests == []
    with pytest.raises(ProviderUnavailable):
        qp.propose_questions(BUNDLE, None, store)


def test_failures_leave_the_passage_to_the_rules_and_are_recorded() -> None:
    outcomes = iter([ProviderUnavailable("timeout", model=MODEL), {"nope": 1}, "good", "good"])

    def responder(payload: dict[str, Any]) -> Any:
        outcome = next(outcomes)
        return good_reply(payload) if outcome == "good" else outcome

    provider = FakeProvider(responder)
    store = ProposalStore()
    result = qp.propose_questions(BUNDLE, provider, store)
    assert result.failures == [("quran:1", "timeout"), ("quran:2", "invalid_output")]
    assert (result.requests, result.proposed, result.failed, result.stopped) == (4, 2, 2, None)
    assert len(store) == 2
    assert qp.review_store(BUNDLE, store).without == ["quran:1", "quran:2"]


def test_three_failures_in_a_row_stop_the_run() -> None:
    provider = FakeProvider(lambda p: ProviderUnavailable("error", model=MODEL))
    result = qp.propose_questions(BUNDLE, provider, ProposalStore())
    assert (result.requests, result.failed, result.deferred) == (3, 3, 1)
    assert result.stopped == "provider_failing"


def test_no_free_model_stops_at_once_and_the_bank_equals_the_rules_bank() -> None:
    provider = FakeProvider(lambda p: ProviderUnavailable("ineligible", model=MODEL))
    store = ProposalStore()
    result = qp.propose_questions(BUNDLE, provider, store)
    assert (result.requests, result.failed, result.deferred) == (0, 1, 3)
    assert result.stopped == "ineligible" and len(store) == 0
    review = qp.review_store(BUNDLE, store)
    assert review.picks == {}
    assert build_question_bank(BUNDLE, review.picks).questions == RULES.questions


# --- the store -------------------------------------------------------------------------------


def test_the_store_is_deterministic_text_without_source_words(tmp_path: Path) -> None:
    path = tmp_path / "question-proposals.json"
    store = populated_store(path)
    first = path.read_bytes()
    store.save()
    assert path.read_bytes() == first
    text = first.decode("utf-8")
    document = json.loads(text)
    assert document["formatVersion"] == 1
    entry = document["entries"][f"{QURAN_ED}|quran:1"]
    assert set(entry) == {"edition", "passageKey", "textSha256", "model", "parts"}
    assert entry["model"] == MODEL and len(entry["textSha256"]) == 64
    assert_no_source_text(text)  # references and the model id only


def test_a_stale_entry_is_ignored() -> None:
    store = populated_store()
    changed = copy.deepcopy(BUNDLE)
    changed["units"][0]["canonicalText"] = changed["units"][0]["canonicalText"].replace(
        "ك", "ل", 1
    )  # same length, other letter: passage 1 changes, the others do not
    review = qp.review_store(changed, store)
    assert review.stale == ["quran:1"] and "quran:1" not in review.models
    assert set(review.models) == {"quran:2", "quran:3", "quran:4"}
    assert not any(key.startswith("quran:1:") for key in review.picks)
    again = FakeProvider(good_reply)
    result = qp.propose_questions(changed, again, store)
    assert (result.reused, result.requests) == (3, 1)


def test_a_malformed_store_file_is_an_input_error(tmp_path: Path) -> None:
    path = tmp_path / "question-proposals.json"
    assert len(ProposalStore.load(path)) == 0  # absent: empty
    for text in ("not json", "[]", json.dumps({"formatVersion": 9, "entries": {}})):
        path.write_text(text, encoding="utf-8")
        with pytest.raises(InputError):
            ProposalStore.load(path)
    path.write_text(
        json.dumps({"formatVersion": 1, "entries": {"x|y": {"model": 1}, "z": 3}}),
        encoding="utf-8",
    )
    assert len(ProposalStore.load(path)) == 0  # malformed entries are dropped


# --- the reusable free-only OpenRouter call --------------------------------------------------

ZERO = {"prompt": "0", "completion": "0"}
PAID = {"prompt": "0.000001", "completion": "0.000002"}


def router(
    *, models: list[dict[str, Any]] | None = None, content: Any = None, key: str | None = "dummy"
) -> tuple[OpenRouterProvider, list[dict[str, Any]]]:
    catalog = (
        models
        if models is not None
        else [{"id": "free/a:free", "pricing": ZERO, "supported_parameters": ["response_format"]}]
    )
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": catalog})
        sent.append(json.loads(request.content))
        body = {
            "choices": [{"message": {"content": content if content is not None else '{"ok": 1}'}}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 4},
        }
        return httpx.Response(200, json=body)

    settings = make_settings(OPENROUTER_API_KEY=key, OPENROUTER_MODELS="free/a:free,paid/b")
    return OpenRouterProvider(settings, httpx.MockTransport(handler)), sent


def test_complete_json_sends_the_custom_prompt_and_schema_to_a_free_model() -> None:
    provider, sent = router()
    schema = {"type": "object", "properties": {"ok": {"type": "integer"}}}
    reply = provider.complete_json(
        {"x": "نص"},
        system_prompt="custom prompt",
        response_schema=schema,
        schema_name="my_schema",
        max_tokens=77,
        timeout_sec=5,
    )
    assert reply.data == {"ok": 1} and reply.model == "free/a:free"
    assert (reply.input_tokens, reply.output_tokens, reply.cost_usd) == (11, 4, None)
    (body,) = sent
    assert body["messages"][0] == {"role": "system", "content": "custom prompt"}
    assert json.loads(body["messages"][1]["content"]) == {"x": "نص"}
    assert body["max_tokens"] == 77 and body["model"] == "free/a:free"
    assert body["response_format"]["json_schema"] == {
        "name": "my_schema",
        "strict": False,
        "schema": schema,
    }
    assert body["provider"] == {"require_parameters": True}


def test_complete_json_never_calls_a_paid_model_or_one_without_a_key() -> None:
    provider, sent = router(models=[{"id": "free/a:free", "pricing": PAID}])
    with pytest.raises(ProviderUnavailable) as excinfo:
        provider.complete_json(
            {}, system_prompt="p", response_schema={}, max_tokens=10, timeout_sec=5
        )
    assert excinfo.value.reason == "ineligible" and sent == []
    keyless, sent = router(key=None)
    with pytest.raises(ProviderUnavailable) as excinfo:
        keyless.complete_json(
            {}, system_prompt="p", response_schema={}, max_tokens=10, timeout_sec=5
        )
    assert excinfo.value.reason == "disabled" and sent == []


def test_complete_json_without_structured_output_support_and_with_fenced_json() -> None:
    provider, sent = router(
        models=[{"id": "free/a:free", "pricing": ZERO, "supported_parameters": []}],
        content='```json\n{"ok": 2}\n```',
    )
    reply = provider.complete_json(
        {}, system_prompt="p", response_schema={}, max_tokens=10, timeout_sec=5
    )
    assert reply.data == {"ok": 2}
    assert "response_format" not in sent[0] and "provider" not in sent[0]


def test_complete_json_reports_a_non_json_reply_as_invalid_output_with_its_usage() -> None:
    provider, _ = router(content="sorry, I cannot")
    with pytest.raises(ProviderUnavailable) as excinfo:
        provider.complete_json(
            {}, system_prompt="p", response_schema={}, max_tokens=10, timeout_sec=5
        )
    assert excinfo.value.reason == "invalid_output"
    assert (excinfo.value.input_tokens, excinfo.value.output_tokens) == (11, 4)


def test_the_plan_chat_call_is_unchanged() -> None:
    reply_content = json.dumps({"intent": "question", "reply": "ok"})
    provider, sent = router(content=reply_content)
    reply = provider.complete({"conversationId": "t"}, max_tokens=400, timeout_sec=8)
    assert reply.output.intent == "question"
    (body,) = sent
    assert body["messages"][0] == {"role": "system", "content": PLAN_CHAT_SYSTEM_PROMPT}
    assert body["response_format"]["json_schema"] == {
        "name": "plan_chat_reply",
        "strict": False,
        "schema": REPLY_JSON_SCHEMA,
    }
    assert body["temperature"] == 0.2 and body["max_tokens"] == 400
    bad, _ = router(content=json.dumps({"intent": "nonsense", "reply": ""}))
    with pytest.raises(ProviderUnavailable) as excinfo:
        bad.complete({}, max_tokens=400, timeout_sec=8)
    assert excinfo.value.reason == "invalid_output"
    assert excinfo.value.input_tokens == 11


def test_build_default_provider_takes_an_optional_transport() -> None:
    settings = make_settings(OPENROUTER_API_KEY="dummy", OPENROUTER_MODELS="free/a:free")
    assert build_default_provider(settings, httpx.MockTransport(lambda r: httpx.Response(500)))
    assert build_default_provider(make_settings()) is None


# --- the CLI step ----------------------------------------------------------------------------


def segmented(build: Path) -> None:
    for argv in (
        quran_args("acquire", "--records", str(QURAN_RECORDS), "--surahs", "112"),
        quran_args("verify", "--oracle", str(ORACLE)),
        quran_args("segment", "--labels", str(LABELS)),
    ):
        assert run_cli(argv, build) == 0


def run_with(
    argv: list[str],
    build: Path,
    *,
    provider: FakeProvider | None = None,
    environ: dict[str, str] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> int:
    runtime = CliRuntime(
        environ=environ if environ is not None else {},
        stdin_isatty=lambda: False,
        clock=TickingClock(),
        transport=transport,
        proposal_provider=provider,
    )
    return main([*argv, "--build-dir", str(build)], runtime=runtime)


def edition_dir(build: Path) -> Path:
    return build / QURAN_ED


def bank_of(build: Path) -> list[dict[str, Any]]:
    text = (edition_dir(build) / "bundle.json").read_text(encoding="utf-8")
    return loads_bundle(text)["questions"]


def test_without_a_free_model_the_step_prints_the_fallback_and_writes_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    segmented(build)
    capsys.readouterr()
    before = sorted(p.name for p in edition_dir(build).iterdir())
    assert run_with(quran_args("propose-questions"), build) == ExitCode.OK
    assert capsys.readouterr().out.strip() == "rules fallback: no free model configured"
    assert sorted(p.name for p in edition_dir(build).iterdir()) == before
    # a key without a candidate model is still "not configured"
    assert (
        run_with(quran_args("propose-questions"), build, environ={"OPENROUTER_API_KEY": "k"}) == 0
    )
    assert "rules fallback" in capsys.readouterr().out


def test_the_step_writes_the_store_and_the_review_sheet_then_build_bank_uses_them(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    segmented(build)
    assert run_cli(quran_args("build-bank"), build) == 0
    rules_bank = bank_of(build)
    capsys.readouterr()

    provider = FakeProvider(good_reply)
    assert run_with(quran_args("propose-questions", "--pause", "0"), build, provider=provider) == 0
    out = capsys.readouterr().out
    assert "propose-questions" in out and "status=proposed" in out
    assert "passages=1 requests=1 proposed=1" in out and f"models={MODEL}" in out
    assert "parts_ai=" in out and "question-proposals.md" in out
    store_path = edition_dir(build) / "question-proposals.json"
    sheet = (edition_dir(build) / "question-proposals.md").read_text(encoding="utf-8")
    assert_no_source_text(store_path.read_text(encoding="utf-8"), out)
    assert "# Question proposals" in sheet and f"(model: {MODEL})" in sheet
    assert "### Part 1" in sheet and "Text: كَلِمَةٌ مِثَالٌ تَجْرِيبِيٌّ" in sheet
    assert "| Keyword (recall) |" in sheet and "accepted" in sheet
    assert "rules (keyword_stoplist)" in sheet or "rules (choice_stoplist)" in sheet  # part 2

    assert run_cli(quran_args("build-bank"), build) == 0
    out = capsys.readouterr().out
    assert "parts_ai=" in out and "parts_rules=" in out
    structure = structure_of(
        loads_bundle((edition_dir(build) / "bundle.json").read_text(encoding="utf-8"))
    )
    review = qp.review_store(structure, ProposalStore.load(store_path))
    assert review.picks
    expected = build_question_bank(structure, review.picks)
    assert bank_of(build) == expected.questions and bank_of(build) != rules_bank
    summary = rows(build, QURAN_ED)["bank_built"].validation_summary
    by = summary["proposals"]["proposedBy"]
    assert by["ai"] + by["partial"] >= 1 and by["ai"] + by["partial"] + by["rules"] == 4
    assert summary["proposals"]["models"] == [MODEL]
    report = (edition_dir(build) / "report.md").read_text(encoding="utf-8")
    assert "## Question proposals (D90)" in report and "proposedBy ai" in report
    assert_no_source_text(report)
    # the bank stays valid and the same store gives the same bank (nothing changes)
    assert run_cli(quran_args("validate"), build) == 0
    assert "## Question proposals (D90)" in (edition_dir(build) / "report.md").read_text("utf-8")
    capsys.readouterr()
    assert run_cli(quran_args("build-bank"), build) == 0
    assert "changed=no" in capsys.readouterr().out


def test_a_provider_with_no_free_model_leaves_the_bank_identical_to_the_rules(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    segmented(build)
    assert run_cli(quran_args("build-bank"), build) == 0
    rules_bank = bank_of(build)
    capsys.readouterr()
    provider = FakeProvider(lambda p: ProviderUnavailable("ineligible", model=MODEL))
    assert run_with(quran_args("propose-questions"), build, provider=provider) == 0
    assert "stopped=ineligible" in capsys.readouterr().out
    assert not (edition_dir(build) / "question-proposals.json").exists()
    assert not (edition_dir(build) / "question-proposals.md").exists()
    assert run_cli(quran_args("build-bank"), build) == 0
    assert "changed=no" in capsys.readouterr().out
    assert bank_of(build) == rules_bank


def test_dry_run_and_max_requests_zero_send_nothing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    segmented(build)
    capsys.readouterr()
    provider = FakeProvider(good_reply)
    assert run_with(quran_args("propose-questions", "--dry-run"), build) == 0  # no key needed
    out = capsys.readouterr().out
    assert "status=dry_run" in out and "planned=1" in out and "nothing was sent" in out
    assert (
        run_with(quran_args("propose-questions", "--max-requests", "0"), build, provider=provider)
        == 0
    )
    assert "requests=0" in capsys.readouterr().out and provider.requests == []
    assert not (edition_dir(build) / "question-proposals.json").exists()


def test_the_step_needs_segment_and_refuses_a_corrupt_store(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    provider = FakeProvider(good_reply)
    assert (
        run_with(quran_args("propose-questions"), build, provider=provider) == ExitCode.PRECONDITION
    )
    assert provider.requests == []
    segmented(build)
    (edition_dir(build) / "question-proposals.json").write_text("{broken", encoding="utf-8")
    assert run_with(quran_args("propose-questions"), build, provider=provider) == ExitCode.USAGE
    assert run_cli(quran_args("build-bank"), build) == ExitCode.USAGE
    assert "cannot be read" in capsys.readouterr().err
    assert provider.requests == []


def test_the_default_provider_path_goes_through_the_free_only_openrouter_client(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    build = tmp_path / "build"
    segmented(build)
    capsys.readouterr()
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "openrouter.ai"
        if request.url.path.endswith("/models"):
            data = [
                {"id": "free/a:free", "pricing": ZERO, "supported_parameters": ["response_format"]}
            ]
            return httpx.Response(200, json={"data": data})
        body = json.loads(request.content)
        sent.append(body)
        payload = json.loads(body["messages"][1]["content"])
        content = json.dumps(good_reply(payload), ensure_ascii=False)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    environ = {"OPENROUTER_API_KEY": "dummy-key", "OPENROUTER_MODELS": "free/a:free"}
    argv = quran_args("propose-questions", "--pause", "0")
    assert run_with(argv, build, environ=environ, transport=httpx.MockTransport(handler)) == 0
    out = capsys.readouterr().out
    assert "requests=1 proposed=1" in out and "models=free/a:free" in out
    (body,) = sent
    assert body["messages"][0]["content"] == qp.SYSTEM_PROMPT
    assert body["response_format"]["json_schema"]["name"] == qp.SCHEMA_NAME
    assert "dummy-key" not in out
    assert (edition_dir(build) / "question-proposals.json").is_file()
