"""D92: every question shows the whole passage around its blank, and the learner-facing reference is
the book plus a human reference (no provider name, no technical code). Synthetic bundles only."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from app.repositories.bank import BankPassage
from app.services.sessions import SessionService
from tests.sessions.ss_support import (
    HADITH,
    PLAN_B_ID,
    PLAN_ID,
    QURAN,
    Env,
    learn_json,
    questions_json,
    steps_json,
)

QURAN_UNITS = {u["ordinal"]: u for u in QURAN["units"]}
HADITH_UNITS = {u["ordinal"]: u for u in HADITH["units"]}
QURAN_PASSAGES = {p["id"]: p for p in QURAN["passages"]}
HADITH_PASSAGES = {p["id"]: p for p in HADITH["passages"]}
QURAN_QUESTIONS = {q["id"]: q for q in QURAN["questions"]}
HADITH_QUESTIONS = {q["id"]: q for q in HADITH["questions"]}


def key(ref: str) -> tuple[int, int]:
    unit, index = ref.split(":")
    return int(unit), int(index)


def surface(units: dict[int, dict[str, Any]], ref: str) -> str:
    unit, index = key(ref)
    token = units[unit]["tokens"][index]
    return units[unit]["canonicalText"][token["s"] : token["e"]]


def passage_refs(passage: dict[str, Any], units: dict[int, dict[str, Any]]) -> list[str]:
    """Every token reference of the passage in book order, over all the units it spans."""
    first, last = key(passage["startRef"]), key(passage["endRef"])
    refs = []
    for ordinal in range(first[0], last[0] + 1):
        low = first[1] if ordinal == first[0] else 0
        high = last[1] if ordinal == last[0] else len(units[ordinal]["tokens"]) - 1
        refs += [f"{ordinal}:{index}" for index in range(low, high + 1)]
    return refs


def quran_session_questions(minutes: int = 15) -> list[dict[str, Any]]:
    env = Env()
    env.plans.update(PLAN_ID, session_minutes=minutes)
    snapshot, _ = env.daily()
    return questions_json(snapshot)


# --- the whole passage around the blank -----------------------------------------------------------


def test_every_question_type_shows_the_whole_passage_around_the_blank() -> None:
    questions = quran_session_questions()
    assert {q["type"] for q in questions} >= {"word_order", "word_choice", "word_recall"}
    for question in questions:
        bank = QURAN_QUESTIONS[question["questionId"]]
        passage = QURAN_PASSAGES[bank["passageId"]]
        expected = passage_refs(passage, QURAN_UNITS)
        target = sorted(bank["tokenRefs"], key=key)
        # the blank covers the target span, including a mark token inside it (a waqf sign)
        span = [r for r in expected if key(target[0]) <= key(r) <= key(target[-1])]
        context = question["context"]
        before = [t["ref"] for t in context["before"]]
        after = [t["ref"] for t in context["after"]]
        # before + the blank + after is exactly the passage: nothing lost, nothing from outside it
        assert before + span + after == expected, question["type"]
        for token in context["before"] + context["after"]:
            assert token["text"] == surface(QURAN_UNITS, token["ref"])  # verbatim, never altered
        assert all(key(ref) < key(target[0]) for ref in before)
        assert all(key(ref) > key(target[-1]) for ref in after)


def test_a_passage_over_several_ayat_shows_all_of_them_in_every_question() -> None:
    questions = quran_session_questions()
    second = [
        q
        for q in questions
        if QURAN_QUESTIONS[q["questionId"]]["passageId"] == QURAN["passages"][1]["id"]
    ]
    assert second, "the 15 minute session teaches the second passage too"
    for question in second:
        bank = QURAN_QUESTIONS[question["questionId"]]
        shown = {
            key(t["ref"])[0] for t in question["context"]["before"] + question["context"]["after"]
        }
        shown |= {key(ref)[0] for ref in bank["tokenRefs"]}
        assert shown == {5, 6, 7, 8, 9}  # the five ayat of 113:1-5, not a window of six words
    assert len(second[0]["context"]["before"]) + len(second[0]["context"]["after"]) > 12  # > 6 + 6


def test_the_bank_context_window_is_ignored_for_display() -> None:
    questions = quran_session_questions()
    wider = 0
    for question in questions:
        bank = QURAN_QUESTIONS[question["questionId"]]
        shown = {t["ref"] for t in question["context"]["before"] + question["context"]["after"]}
        assert set(bank["contextRefs"]) <= shown  # the stored window stays inside the whole passage
        wider += len(shown) > len(bank["contextRefs"])
    assert wider > 0  # and the whole passage is more than the window for some questions


def test_word_order_shows_the_passage_with_the_ordered_part_as_the_gap() -> None:
    orders = [q for q in quran_session_questions() if q["type"] == "word_order"]
    assert orders
    for question in orders:
        bank = QURAN_QUESTIONS[question["questionId"]]
        passage = QURAN_PASSAGES[bank["passageId"]]
        context = question["context"]
        everything = passage_refs(passage, QURAN_UNITS)
        low, high = min(key(r) for r in bank["tokenRefs"]), max(key(r) for r in bank["tokenRefs"])
        gap = [r for r in everything if low <= key(r) <= high]
        before = [t["ref"] for t in context["before"]]
        after = [t["ref"] for t in context["after"]]
        assert before + gap + after == everything
        # the tiles are the words of the part, as before
        assert sorted(t["ref"] for t in question["tokens"]) == sorted(bank["tokenRefs"])
        assert question["answerKey"]["order"] == bank["tokenRefs"]


def test_ayah_ends_are_structured_data_between_ayat_never_inside_a_token() -> None:
    for question in quran_session_questions():
        bank = QURAN_QUESTIONS[question["questionId"]]
        passage = QURAN_PASSAGES[bank["passageId"]]
        first, last = key(passage["startRef"])[0], key(passage["endRef"])[0]
        low, high = min(key(r) for r in bank["tokenRefs"]), max(key(r) for r in bank["tokenRefs"])
        expected = []
        for ordinal in range(first, last):  # no end after the last ayah of the passage
            end = (ordinal, len(QURAN_UNITS[ordinal]["tokens"]) - 1)
            if end < low or end >= high:  # none inside the blank; the one that closes it stays
                number = int(QURAN_UNITS[ordinal]["reference"].split(":")[1])
                expected.append({"afterRef": f"{end[0]}:{end[1]}", "number": number})
        context = question["context"]
        assert context["ayahEnds"] == expected
        shown = {t["ref"] for t in context["before"] + context["after"]}
        for end in context["ayahEnds"]:
            # an end is after a shown token, or it is the one after the blank
            assert end["afterRef"] in shown or key(end["afterRef"]) == high
        for token in context["before"] + context["after"]:
            assert "﴿" not in token["text"] and "۝" not in token["text"]


def test_a_single_unit_passage_has_no_ayah_end_and_starts_inside_its_unit() -> None:
    unit = SimpleNamespace(
        ordinal=7,
        kind="ayah",
        reference="112:3",
        tokens=[1, 2, 3, 4],
        surface=lambda index: f"w{index}",
    )
    text = SessionService._passage_text(_passage("7:1", "7:2"), _units_of({7: unit}))  # type: ignore[arg-type]
    assert [view.ref for _, view in text.tokens] == ["7:1", "7:2"]
    assert text.ayah_ends == ()  # an end is drawn between two ayat of the passage only


def test_a_hadith_question_shows_its_whole_passage_and_no_ayah_end() -> None:
    env = Env()
    snapshot, _ = env.daily(PLAN_B_ID, 2)
    questions = questions_json(snapshot)
    assert questions
    for question in questions:
        bank = HADITH_QUESTIONS[question["questionId"]]
        passage = HADITH_PASSAGES[bank["passageId"]]
        expected = passage_refs(passage, HADITH_UNITS)
        if question["type"] == "word_choice" and passage["path"] == "grade":
            continue  # the grade phrase is the whole passage: the blank has no neighbours
        context = question["context"]
        target = sorted(bank["tokenRefs"], key=key)
        span = [r for r in expected if key(target[0]) <= key(r) <= key(target[-1])]
        assert [t["ref"] for t in context["before"]] + span + [
            t["ref"] for t in context["after"]
        ] == expected
        assert context["ayahEnds"] == []
        # a matn question never shows the sanad before it: the passage is the matn part only
        if passage["path"] == "matn":
            assert all(key(t["ref"]) >= key(passage["startRef"]) for t in context["before"])


# --- the clean reference --------------------------------------------------------------------------

BANNED = ("HadeethEnc", "hadeethenc", "nawawi40", "QuranEnc", "islamenc")


def test_the_learn_step_and_every_question_carry_a_clean_arabic_reference() -> None:
    env = Env()
    env.plans.update(PLAN_ID, session_minutes=15)
    snapshot, _ = env.daily()
    first_title = QURAN["sections"][0]["titleAr"]
    (view, *_) = learn_json(snapshot)
    assert view["referenceAr"] == f"{first_title}، الآيات ١–٤"  # Arabic-Indic digits, en dash
    assert view["source"]["referenceAr"] == view["referenceAr"]
    assert view["source"]["bookTitleAr"] == QURAN["book"]["titleAr"]
    for question in questions_json(snapshot):
        source = question["source"]
        title = next(
            s["titleAr"]
            for s in QURAN["sections"]
            if s["ordinal"] == QURAN_PASSAGES[question["passageId"]]["sectionOrdinal"]
        )
        assert source["referenceAr"].startswith(f"{title}، الآيات ")
        assert source["referenceAr"].isascii() is False
        assert source["url"].startswith("https://")  # the link stays: the owner keeps it


def test_a_hadith_reference_is_the_section_title() -> None:
    env = Env()
    snapshot, _ = env.daily(PLAN_B_ID, 2)
    titles = {s["ordinal"]: s["titleAr"] for s in HADITH["sections"]}
    for view in learn_json(snapshot):
        section = next(p for p in HADITH["passages"] if p["id"] == view["passageId"])[
            "sectionOrdinal"
        ]
        assert view["referenceAr"] == titles[section]
        assert view["source"]["referenceAr"] == titles[section]
    for question in questions_json(snapshot):
        section = HADITH_PASSAGES[question["passageId"]]["sectionOrdinal"]
        assert question["source"]["referenceAr"] == titles[section]
        assert not any(word in question["source"]["referenceAr"] for word in BANNED)


def _units(references: dict[int, str]) -> Any:
    return SimpleNamespace(unit=lambda ordinal: SimpleNamespace(reference=references[ordinal]))


def _units_of(units: dict[int, Any]) -> Any:
    return SimpleNamespace(unit=lambda ordinal: units[ordinal])


def _passage(start: str, end: str) -> BankPassage:
    return BankPassage(  # type: ignore[arg-type]
        id=None,
        section_ordinal=1,
        ordinal=1,
        path="quran",
        start_ref=start,
        end_ref=end,
        word_count=1,
        reference="",
        parts=(),
    )


@pytest.mark.parametrize(
    ("title", "start", "end", "references", "expected"),
    [
        ("سورة الإخلاص", "1:0", "1:3", {1: "112:1"}, "سورة الإخلاص، الآية ١"),
        ("سورة الإخلاص", "1:0", "4:2", {1: "112:1", 4: "112:4"}, "سورة الإخلاص، الآيات ١–٤"),
        ("الإخلاص", "3:0", "3:5", {3: "112:3"}, "سورة الإخلاص، الآية ٣"),
        ("الإخلاص", "2:4", "3:5", {2: "112:2", 3: "112:3"}, "سورة الإخلاص، الآيات ٢–٣"),
        ("سورة الإخلاص", "1:0", "1:3", {1: "x"}, "سورة الإخلاص"),
    ],
)
def test_a_quran_reference_is_the_surah_and_the_ayah_or_the_ayah_range(
    title: str, start: str, end: str, references: dict[int, str], expected: str
) -> None:
    section = SimpleNamespace(title_ar=title)
    edition = SimpleNamespace(content_format="quran")
    reference = SessionService._reference_ar(
        edition,
        section,
        _passage(start, end),
        _units(references),  # type: ignore[arg-type]
    )
    assert reference == expected


def test_no_provider_name_or_technical_code_is_needed_for_the_learner_reference() -> None:
    env = Env()
    snapshot, _ = env.daily(PLAN_B_ID, 2)
    for step in steps_json(snapshot):
        source = (
            step["passage"]["source"] if step["type"] == "learn" else step["question"]["source"]
        )
        # compatibility fields stay in the contract, the readable reference does not use them
        assert not any(word in source["referenceAr"] for word in BANNED)
        assert source["referenceAr"] != source["reference"]
