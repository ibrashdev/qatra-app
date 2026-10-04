"""Guard rails for the committed synthetic fixtures: placeholder words only, no source text."""

from __future__ import annotations

import json
import re
import unicodedata

from app.domain.normalization import normalize
from app.workflow.content_management import load_oracle, strip_trailing_ayah_number
from tests.workflow.wf_support import DATA, load_json

# Normalized placeholder vocabulary of the fixtures (neutral words only). Adding a fixture word
# means adding it here on purpose: a real verse or hadith would fail this test.
ALLOWED_WORDS = {
    "اخري",
    "التجريبيه",
    "الراوي",
    "الكلمه",
    "المثال",
    "المعلم",
    "اول",
    "تجريبي",
    "تجريبيه",
    "تفسير",
    "ثالث",
    "ثان",
    "حديث",
    "راو",
    "رواه",
    "شرح",
    "عن",
    "قال",
    "كلمه",
    "لا",
    "مثال",
    "نص",
    "هذا",
    "وكلمه",
    "يحفظ",
    # neutral structural labels used by the synthetic bundle (titles, kinds, prompts):
    # generic words, no source text
    "اختبار",
    "اختيار",
    "باب",
    "بناء",
    "بيان",
    "ترتيب",
    "تمرين",
    "جزء",
    "جواب",
    "حرف",
    "حفظ",
    "درس",
    "رقم",
    "سطر",
    "سوال",
    "سوره",
    "طبعه",
    "عباره",
    "عنوان",
    "فصل",
    "فقره",
    "فيه",
    "قسم",
    "كتاب",
    "لفظ",
    "مراجعه",
    "معني",
    "مقطع",
    "موضع",
    "مولف",
    "نموذج",
    "هاذا",
    "ثم",
    "رابع",
    "وصف",
}
TEXT_FIELDS = ("text", "title", "narration", "narrator", "grade")


def _string_values(node: object) -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        return [text for value in node.values() for text in _string_values(value)]
    if isinstance(node, list):
        return [text for value in node for text in _string_values(value)]
    return []


def fixture_words(name: str) -> set[str]:
    raw = (DATA / name).read_text(encoding="utf-8")
    if name.endswith(".json"):
        # every string value of the file (records files and the B8 bundles alike), never the keys
        raw = " ".join(_string_values(json.loads(raw)))
    arabic_only = re.sub(r"[A-Za-z0-9:\[\]/_\-.|#,]+", " ", raw)
    return set(normalize(arabic_only).split())


def test_fixture_files_exist_and_the_synthetic_bundle_is_committed() -> None:
    names = {p.name for p in DATA.iterdir()}
    assert {
        "README.md",
        "synthetic_mcp_quran_response.txt",
        "synthetic_mcp_hadith_response.txt",
        "synthetic_quran_records.json",
        "synthetic_hadith_records_pass1.json",
        "synthetic_hadith_records_pass2.json",
        "synthetic_oracle.txt",
    } <= names
    assert "synthetic_bundle.json" in names  # produced by the B8 pipeline (contract §2.6)


def test_fixtures_contain_only_placeholder_words() -> None:
    for path in DATA.iterdir():
        if path.suffix in {".json", ".txt"}:
            unexpected = fixture_words(path.name) - ALLOWED_WORDS
            assert not unexpected, f"{path.name} has non-placeholder words: {sorted(unexpected)}"


def test_readme_declares_the_data_synthetic() -> None:
    text = (DATA / "README.md").read_text(encoding="utf-8")
    assert "synthetic" in text.lower() and "no religious text" in text.lower()


def test_fixture_texts_are_nfc_and_consistent_across_files() -> None:
    quran = load_json(DATA / "synthetic_quran_records.json")["records"]
    oracle = load_oracle(DATA / "synthetic_oracle.txt")
    response = (DATA / "synthetic_mcp_quran_response.txt").read_text(encoding="utf-8")
    for record in quran:
        assert unicodedata.is_normalized("NFC", record["text"])
        assert (
            strip_trailing_ayah_number(oracle[(record["surah"], record["ayah"])]) == record["text"]
        )
        assert record["text"] in response
    pass1 = load_json(DATA / "synthetic_hadith_records_pass1.json")["records"]
    pass2 = load_json(DATA / "synthetic_hadith_records_pass2.json")["records"]
    assert pass1 == pass2  # identical texts; only the retrieval time differs
    assert (
        load_json(DATA / "synthetic_hadith_records_pass1.json")["retrievedAt"]
        != load_json(DATA / "synthetic_hadith_records_pass2.json")["retrievedAt"]
    )
    for record in pass1:
        for key in ("title", "narration", "narrator", "grade"):
            assert unicodedata.is_normalized("NFC", record[key])
        assert record["url"].endswith(str(record["hadeethencId"]))
    assert pass1[2]["grade"] == ""  # a missing grade is covered on purpose


def test_oracle_strips_trailing_ayah_numbers_only_when_present() -> None:
    assert strip_trailing_ayah_number("نص ۝١") == "نص"
    assert strip_trailing_ayah_number("نص ۝١٢٣") == "نص"
    assert strip_trailing_ayah_number("نص ٣") == "نص"
    assert strip_trailing_ayah_number("نص ﴿٣﴾") == "نص"
    assert strip_trailing_ayah_number("نص") == "نص"
    assert strip_trailing_ayah_number("نص‌") == "نص‌"  # zero-width characters are kept
