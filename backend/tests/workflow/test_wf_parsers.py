"""Islamic Content MCP response parsers, on synthetic text in the observed layout."""

from __future__ import annotations

import pytest

from app.workflow.errors import McpParseError
from app.workflow.mcp_client import parse_hadith_response, parse_quran_response
from tests.workflow.wf_support import DATA, load_json

QURAN_TEXT = (DATA / "synthetic_mcp_quran_response.txt").read_text(encoding="utf-8")
HADITH_TEXT = (DATA / "synthetic_mcp_hadith_response.txt").read_text(encoding="utf-8")
SOURCE_112 = "Source: https://islamenc.com/ar/quran/112\n"
QURAN_RECORDS = load_json(DATA / "synthetic_quran_records.json")["records"]
HADITH_RECORDS = load_json(DATA / "synthetic_hadith_records_pass1.json")["records"]


def test_quran_parser_keeps_only_the_verse_line_and_drops_the_tafsir_line() -> None:
    records = parse_quran_response(QURAN_TEXT)
    assert [r.ayah for r in records] == [1, 2, 3, 4]
    assert all(r.surah == 112 for r in records)
    assert [r.text for r in records] == [item["text"] for item in QURAN_RECORDS]
    assert all("تَفْسِيرٌ" not in r.text for r in records)
    assert all(r.url == "https://islamenc.com/ar/quran/112" for r in records)
    assert [r.model_dump() for r in records] == QURAN_RECORDS


def test_quran_parser_is_tolerant_of_layout_noise() -> None:
    noisy = (
        "RETRIEVED from the publisher\n" + QURAN_TEXT.replace("\n", "\r\n") + "\nCITE: something\n"
    )
    assert [r.text for r in parse_quran_response(noisy)] == [i["text"] for i in QURAN_RECORDS]


def test_quran_parser_without_a_tafsir_line_or_blank_lines() -> None:
    text = (
        '[Surah 112, translation "x"]\n[EXACT]\n[112:1]\nآية\n[112:2]\nآية ثانية\n[/EXACT]\n'
        + SOURCE_112
    )
    records = parse_quran_response(text)
    assert [(r.ayah, r.text) for r in records] == [(1, "آية"), (2, "آية ثانية")]


def test_quran_parser_keeps_nbsp_and_zero_width_characters_of_the_verse() -> None:
    verse = "كلمة مثال‌"
    text = f"[EXACT]\n[112:1]\n{verse}\nشرح\n[/EXACT]\n{SOURCE_112}"
    assert parse_quran_response(text)[0].text == verse


@pytest.mark.parametrize(
    "text",
    [
        "no blocks at all\nSource: https://islamenc.com/ar/quran/112\n",
        "[EXACT]\n[112:1]\nآية\n[/EXACT]\n",  # no Source line
        "[EXACT]\n[112:1]\nآية\n[/EXACT]\nSource: https://example.invalid/ar/quran/112\n",
        "[EXACT]\nonly text, no markers\n[/EXACT]\n" + SOURCE_112,
        "[EXACT]\n[112:1]\n[/EXACT]\n" + SOURCE_112,  # marker, no verse
        "[EXACT]\n[113:1]\nآية\n[/EXACT]\n" + SOURCE_112,
        "[EXACT]\n[112:1]\nآية\n[112:1]\nأخرى\n[/EXACT]\n" + SOURCE_112,
        '[Surah 113, translation "x"]\n[EXACT]\n[112:1]\nآية\n[/EXACT]\nSource: https://islamenc.com/ar/quran/112\n',
    ],
)
def test_quran_parser_refuses_unexpected_layouts(text: str) -> None:
    with pytest.raises(McpParseError):
        parse_quran_response(text)


def test_hadith_parser_captures_every_stored_field_and_drops_the_commentary() -> None:
    record = parse_hadith_response(HADITH_TEXT, 990001, 1)
    expected = HADITH_RECORDS[0]
    assert record.model_dump(by_alias=True) == expected
    dumped = repr(record.model_dump())
    assert "شَرْحٌ" not in dumped
    assert "example.invalid" not in dumped
    assert record.narrator == "رواه الراوي المثال"
    assert record.grade == "تجريبي"
    assert record.url == "https://hadeethenc.com/ar/browse/hadith/990001"
    assert record.languages == ["ar", "en", "fr"]


def test_hadith_parser_without_grade_or_attribution() -> None:
    body = (
        "عنوان\n[EXACT]\nنص الرواية\n[/EXACT]\nSource: https://hadeethenc.com/ar/browse/hadith/5\n"
    )
    record = parse_hadith_response(body, 5, 2)
    assert (record.narrator, record.grade, record.languages) == ("", "", [])
    assert record.title == "عنوان" and record.narration == "نص الرواية"
    empty_grade = body.replace(
        "[EXACT]", "[ATTRIBUTION]\nNarrator: رواه\nGrade:\n[/ATTRIBUTION]\n[EXACT]"
    )
    assert parse_hadith_response(empty_grade, 5, 2).grade == ""


def test_hadith_parser_refuses_unexpected_layouts() -> None:
    with pytest.raises(McpParseError):
        parse_hadith_response("title\nSource: https://hadeethenc.com/ar/browse/hadith/5\n", 5, 1)
    with pytest.raises(McpParseError):  # empty narration
        parse_hadith_response(
            "t\n[EXACT]\n \n[/EXACT]\nSource: https://hadeethenc.com/ar/browse/hadith/5\n", 5, 1
        )
    with pytest.raises(McpParseError):  # URL id differs from the requested id
        parse_hadith_response(HADITH_TEXT, 990002, 1)
    with pytest.raises(McpParseError):  # no Source line outside the blocks
        parse_hadith_response(
            "t\n[EXACT]\nنص\n[/EXACT]\n[COMMENTARY]\nSource: https://hadeethenc.com/ar/browse/hadith/5\n[/COMMENTARY]\n",
            5,
            1,
        )


def test_hadith_forty_number_is_validated_by_the_record_model() -> None:
    with pytest.raises(ValueError):
        parse_hadith_response(HADITH_TEXT, 990001, 43)
