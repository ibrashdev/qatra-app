"""Source-text hygiene: the publisher's framing never becomes source text.

Defect (5 October 2026, owner-approved fix): the live ``get_hadith`` answer puts an English
reminder line inside the ``[EXACT]`` block, before the Arabic narration, and opens with a banner
line (``──── RETRIEVED FROM <publisher> — published text ────``). The parser kept both, the
validators had no script check, and the question builder offered the English words as choices
for Arabic blanks. These tests cover the three layers (parser, validators, builder) on synthetic
text only: the Arabic is the placeholder narration of the committed synthetic fixtures.
"""

from __future__ import annotations

import copy
import json
from collections import defaultdict
from typing import Any

import pytest

from app.domain.normalization import (
    has_arabic_letter,
    has_latin_letter,
    is_arabic_script_word,
    tokenize,
)
from app.workflow import lesson_question_builder
from app.workflow.bundle import content_hash
from app.workflow.editions import hadith_url
from app.workflow.errors import McpParseError
from app.workflow.lesson_question_builder import _Builder, build_question_bank
from app.workflow.mcp_client import parse_hadith_response
from app.workflow.models import HadithRecord, sha256_hex
from app.workflow.validation import (
    non_arabic_source_text,
    validate_edition,
    validate_hadith_records,
)
from tests.workflow.wf_support import DATA, load_json

LIVE_FRAMING = DATA / "live_framing" / "synthetic_mcp_hadith_response_live_framing.txt"
LIVE_TEXT = LIVE_FRAMING.read_text(encoding="utf-8")
PLAIN_TEXT = (DATA / "synthetic_mcp_hadith_response.txt").read_text(encoding="utf-8")
EXPECTED = load_json(DATA / "synthetic_hadith_records_pass1.json")["records"][0]
BANNER = "─" * 8 + " RETRIEVED FROM HADEETHENC — published text " + "─" * 8
PREAMBLE = (
    "the narration itself — reproduce these words exactly, without changing any thing, "
    "EXACTLY reproduce these words"
)
SOURCE = "Source: https://hadeethenc.com/ar/browse/hadith/990001\n"
NARRATION = EXPECTED["narration"]


def framed(narration: str, attribution: str = "", *, banner: bool = True) -> str:
    """A live-shaped answer: banner, [EXACT] with the English reminder line, attribution."""
    head = f"{BANNER}\n" if banner else ""
    return f"{head}[EXACT]\n{PREAMBLE}\n{narration}\n[/EXACT]\n{attribution}{SOURCE}"


# --- parser: the framing is removed, nothing else changes ----------------------------------


def test_live_framing_fixture_reproduces_the_defect_layout() -> None:
    exact = LIVE_TEXT.split("[EXACT]")[1].split("[/EXACT]")[0]
    first, second = exact.strip().splitlines()[:2]
    assert not has_arabic_letter(first) and has_latin_letter(first)  # the English reminder line
    assert has_arabic_letter(second)
    assert LIVE_TEXT.startswith(BANNER)


def test_live_framing_is_removed_and_the_record_equals_the_plain_layout() -> None:
    record = parse_hadith_response(LIVE_TEXT, 990001, 1)
    assert record.narration.startswith("عَنْ")
    assert not has_latin_letter(record.narration)
    assert "reproduce" not in repr(record.model_dump())
    assert record.model_dump(by_alias=True) == EXPECTED
    assert record == parse_hadith_response(PLAIN_TEXT, 990001, 1)


def test_a_banner_line_is_never_the_title() -> None:
    record = parse_hadith_response(LIVE_TEXT, 990001, 1)
    assert record.title == EXPECTED["title"]
    assert "RETRIEVED" not in record.title
    assert not any("─" <= ch <= "╿" for ch in record.title)
    only_banner = parse_hadith_response(framed(NARRATION), 990001, 1)
    assert only_banner.title == ""  # no real title line: empty, never the banner


def test_removal_changes_no_arabic_character_or_invisible_mark() -> None:
    # harakat, zero-width characters (kept on purpose, D03), NBSP and punctuation stay as sent
    narration = "عَنْ‌ رَاوٍ​ أَوَّلَ ‍ قَالَ: «كَلِمَةٌ، مِثَالٌ؟»."
    record = parse_hadith_response(framed(narration), 990001, 1)
    assert record.narration == narration
    crlf = parse_hadith_response(framed(narration).replace("\n", "\r\n"), 990001, 1)
    assert crlf.narration == narration


def test_a_multi_line_narration_is_kept_whole_after_the_framing() -> None:
    two_lines = "عَنْ رَاوٍ أَوَّلَ\nقَالَ الْمُعَلِّمُ"
    record = parse_hadith_response(framed(two_lines), 990001, 1)
    assert record.narration == two_lines
    assert parse_hadith_response(framed(two_lines, banner=False), 990001, 1).narration == two_lines


def test_a_narration_without_framing_is_unchanged() -> None:
    assert parse_hadith_response(PLAIN_TEXT, 990001, 1).narration == NARRATION


# --- parser: fail closed on anything that is still not Arabic ------------------------------


@pytest.mark.parametrize(
    "narration",
    [
        NARRATION + "\nEnglish note after the narration",
        "عَنْ word رَاوٍ",  # a Latin word inside an Arabic line
        "عَنْ رَاوٍ ـ note",
        "ī عَنْ رَاوٍ",  # an accented Latin letter
    ],
)
def test_latin_still_inside_the_narration_raises(narration: str) -> None:
    with pytest.raises(McpParseError) as raised:
        parse_hadith_response(framed(narration), 990001, 1)
    assert "Latin" in str(raised.value)
    assert "note" not in str(raised.value) and "reproduce" not in str(raised.value)


def test_a_block_with_no_arabic_line_raises() -> None:
    body = f"{BANNER}\n[EXACT]\n{PREAMBLE}\n[/EXACT]\n{SOURCE}"
    with pytest.raises(McpParseError):
        parse_hadith_response(body, 990001, 1)
    digits_only = body.replace(PREAMBLE, "١٢٣")
    with pytest.raises(McpParseError):
        parse_hadith_response(digits_only, 990001, 1)


@pytest.mark.parametrize(
    "attribution",
    [
        "[ATTRIBUTION]\nNarrator: Reported by someone\nGrade: صحيح\n[/ATTRIBUTION]\n",
        "[ATTRIBUTION]\nNarrator: رواه الراوي\nGrade: Sahih\n[/ATTRIBUTION]\n",
    ],
)
def test_latin_in_the_narrator_or_grade_raises(attribution: str) -> None:
    with pytest.raises(McpParseError):
        parse_hadith_response(framed(NARRATION, attribution), 990001, 1)


def test_an_arabic_narrator_and_grade_pass() -> None:
    attribution = "[ATTRIBUTION]\nNarrator: رواه الراوي\nGrade: تجريبي\n[/ATTRIBUTION]\n"
    record = parse_hadith_response(framed(NARRATION, attribution), 990001, 1)
    assert (record.narrator, record.grade) == ("رواه الراوي", "تجريبي")


# --- script helpers ------------------------------------------------------------------------


def test_script_helpers() -> None:
    assert has_arabic_letter("the xع") and not has_arabic_letter("the narration — ١٢")
    assert not has_arabic_letter("") and not has_arabic_letter("َْ")  # marks only
    assert has_latin_letter("عَنْ a") and has_latin_letter("ī") and has_latin_letter("Ａ")
    assert not has_latin_letter("عَنْ رَاوٍ ١٢ 12 «»") and not has_latin_letter("")
    assert is_arabic_script_word("كلمه") and is_arabic_script_word("﴾".join(["ا", "ب"]))
    assert not is_arabic_script_word("") and not is_arabic_script_word("كلمهx")
    assert not is_arabic_script_word("كلمه1") and not is_arabic_script_word("1")


# --- validators: record level --------------------------------------------------------------


def hadith(number: int = 1, **overrides: object) -> HadithRecord:
    values: dict[str, object] = {
        "hadeethenc_id": 990000 + number,
        "forty_number": number,
        "title": "t",
        "narration": "نص",
        "narrator": "رواه",
        "grade": "درجة",
        "url": hadith_url(990000 + number),
        "languages": ["ar"],
    }
    values.update(overrides)
    return HadithRecord(**values)  # type: ignore[arg-type]


def codes(report: Any) -> set[str]:
    return {issue.code for issue in report.issues}


@pytest.mark.parametrize(
    "value",
    [
        PREAMBLE + "\n" + NARRATION,  # the stored defect: the reminder line kept with the text
        "نص [EXACT] نص",
        "نص [/EXACT]",
        "RETRIEVED",
        "─" * 8,  # a decoration line has no Latin letter and is still not source text
        "نص ī",
    ],
)
@pytest.mark.parametrize("field", ["narration", "narrator", "grade"])
def test_hadith_records_with_foreign_text_are_blocked(field: str, value: str) -> None:
    report = validate_hadith_records([hadith(1, **{field: value})], [1])
    assert codes(report) == {"non_arabic_source_text"}
    assert [(issue.ref) for issue in report.issues] == ["forty:1"]
    assert not report.ok


def test_clean_hadith_records_are_not_flagged() -> None:
    record = parse_hadith_response(LIVE_TEXT, 990001, 1)
    assert validate_hadith_records([record], [1]).ok
    assert "non_arabic_source_text" not in codes(validate_hadith_records([hadith(1)], [1]))
    assert not non_arabic_source_text(NARRATION) and not non_arabic_source_text("عَنْ ١٢ «»")


def test_the_issue_never_carries_the_text() -> None:
    report = validate_hadith_records([hadith(1, narration=PREAMBLE + "\n" + NARRATION)], [1])
    shown = report.summary() + "".join(issue.message for issue in report.issues)
    assert "reproduce" not in shown and "عَنْ" not in shown


# --- validators: edition (unit) level ------------------------------------------------------

QURAN_BUNDLE = load_json(DATA / "synthetic_bundle.json")
HADITH_BUNDLE = load_json(DATA / "synthetic_bundle_hadith.json")


def corrupt_unit(bundle: dict[str, Any], kind: str, replacement: str) -> tuple[dict[str, Any], str]:
    """Copy of ``bundle`` whose first ``kind`` unit has its last word replaced, with hash, tokens
    and content hash recomputed so that only the new check can object."""
    data = copy.deepcopy(bundle)
    unit = next(u for u in data["units"] if u["kind"] == kind)
    words = unit["canonicalText"].split(" ")
    words[-1] = replacement
    unit["canonicalText"] = " ".join(words)
    unit["textHash"] = sha256_hex(unit["canonicalText"].encode("utf-8"))
    unit["tokens"] = [token.to_dict() for token in tokenize(unit["canonicalText"])]
    data["edition"]["contentHash"] = content_hash(data["units"])
    return data, f"unit:{unit['ordinal']}"


def test_the_untouched_synthetic_bundles_pass_the_new_check() -> None:
    for bundle in (QURAN_BUNDLE, HADITH_BUNDLE):
        assert "non_arabic_source_text" not in codes(validate_edition(bundle))
        assert validate_edition(bundle).ok


@pytest.mark.parametrize(
    ("bundle", "kind"),
    [
        (QURAN_BUNDLE, "ayah"),
        (HADITH_BUNDLE, "hadith_narration"),
        (HADITH_BUNDLE, "hadith_takhrij"),
        (HADITH_BUNDLE, "hadith_grade"),
    ],
)
def test_a_unit_with_a_latin_word_is_blocked_and_nothing_else_is_reported(
    bundle: dict[str, Any], kind: str
) -> None:
    corrupted, ref = corrupt_unit(bundle, kind, "English")
    report = validate_edition(corrupted)
    assert [(issue.code, issue.ref) for issue in report.issues] == [("non_arabic_source_text", ref)]
    assert not report.ok


@pytest.mark.parametrize("marker", ["[EXACT]", "[/EXACT]", "RETRIEVED", "───"])
def test_a_unit_with_an_envelope_marker_is_blocked(marker: str) -> None:
    corrupted, ref = corrupt_unit(HADITH_BUNDLE, "hadith_narration", marker)
    assert ("non_arabic_source_text", ref) in {
        (issue.code, issue.ref) for issue in validate_edition(corrupted).issues
    }


# --- builder: distractors are Arabic script only -------------------------------------------


def decoys_for(target: Any, count: int = 6) -> list[Any]:
    """Latin and digit look-alikes of the target's length: the best-ranked candidates."""
    shapes = ["abcdefghij", "klmnopqrst", "u1234567890", "xy99999999", "tiktok2026", "zzzzzzzzzz"]
    return [
        type(target)(
            ref=f"99:{i}",
            unit=99,
            index=i,
            n=shape[: len(target.n)] if i % 2 == 0 else shape[: len(target.n) - 1] + "7",
            a=None,
            surface=shape,
            passage=target.passage,
            pos=1000 + i,
            part=target.part,
        )
        for i, shape in enumerate(shapes[:count])
    ]


def test_latin_and_digit_words_are_never_distractors(monkeypatch: pytest.MonkeyPatch) -> None:
    builder = _Builder(QURAN_BUNDLE)
    target = next(w for words in builder.words for w in words if len(w.n) >= 4)
    baseline = builder._distractor_words(target)
    assert len(baseline) == 3 and all(is_arabic_script_word(w.n) for w in baseline)

    decoys = decoys_for(target)
    assert not any(is_arabic_script_word(d.n) for d in decoys)
    section = builder.section_of_passage[target.passage]
    pools = {key: list(words) for key, words in builder.section_words.items()}
    pools[section] = [*decoys, *pools[section]]
    builder.section_words = defaultdict(list, pools)
    builder.edition_words = [*decoys, *builder.edition_words]

    chosen = builder._distractor_words(target)
    assert chosen == baseline  # the decoys change nothing: same words, same order
    assert not any(has_latin_letter(w.n) or any(c.isdigit() for c in w.n) for w in chosen)

    # control: without the script filter the same decoys would be offered
    monkeypatch.setattr(lesson_question_builder, "_arabic_choice", lambda _n: True)
    unfiltered = builder._distractor_words(target)
    assert any(w.ref.startswith("99:") for w in unfiltered)


def latin_injected_bundle() -> dict[str, Any]:
    """The synthetic Quran bundle with every word of unit 1 turned into a Latin string of the
    same length (the defect: English words among the words of a section)."""
    bundle = copy.deepcopy(QURAN_BUNDLE)
    for i, token in enumerate(bundle["units"][0]["tokens"]):
        if token["k"] == "word":
            token["n"] = (chr(97 + i) * 12)[: len(token["n"])]
    return bundle


def foreign_options(bundle: dict[str, Any], questions: list[dict[str, Any]]) -> list[str]:
    """Normalized forms of every wrong option of a choice question that is not Arabic script."""
    n_of = {f"{u['ordinal']}:{t['i']}": t["n"] for u in bundle["units"] for t in u["tokens"]}
    found: list[str] = []
    for question in questions:
        if question["type"] != "word_choice":
            continue
        for option in question["optionRefs"]:
            if option != question["correctRef"]:
                found += [n_of[ref] for ref in option if not is_arabic_script_word(n_of[ref])]
    return found


def test_a_built_bank_offers_no_latin_distractor(monkeypatch: pytest.MonkeyPatch) -> None:
    bundle = latin_injected_bundle()
    assert foreign_options(bundle, build_question_bank(bundle).questions) == []
    # control: the same injected bundle does leak Latin choices when the filter is disabled
    monkeypatch.setattr(lesson_question_builder, "_arabic_choice", lambda _n: True)
    assert foreign_options(bundle, build_question_bank(bundle).questions) != []


def test_the_clean_bundle_is_built_identically() -> None:
    """The script filter changes nothing for Arabic-only text (determinism, D22)."""
    rebuilt = build_question_bank(QURAN_BUNDLE)
    assert json.dumps(rebuilt.questions, ensure_ascii=False, sort_keys=True) == json.dumps(
        QURAN_BUNDLE["questions"], ensure_ascii=False, sort_keys=True
    )
