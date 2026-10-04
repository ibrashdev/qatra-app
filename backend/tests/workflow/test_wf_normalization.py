"""Policy ``arabic-norm-v1`` (contract §2.5) and the tokenizer (§2.2): every rule with explicit
code points."""

from __future__ import annotations

import unicodedata

import pytest

from app.domain.normalization import (
    POLICY_VERSION,
    UnsupportedPolicyError,
    alternative_form,
    classify_token,
    is_single_word,
    letter_skeleton,
    normalize,
    tokenize,
)

BA, ALEF, LAM, YEH, MEEM = "ب", "ا", "ل", "ي", "م"


def test_policy_version_constant() -> None:
    assert POLICY_VERSION == "arabic-norm-v1"


def test_nfc_is_applied_before_mapping() -> None:
    # alef + combining madda above composes to U+0622 under NFC, which then maps to plain alef
    assert normalize("آ") == ALEF
    # hamza forms written decomposed also reach the same result
    assert normalize("أ") == ALEF  # alef + hamza above -> U+0623 -> alef
    assert normalize("ئ") == YEH  # yeh + hamza above -> U+0626 -> yeh
    assert normalize("ؤ") == "و"  # waw + hamza above -> U+0624 -> waw


@pytest.mark.parametrize("codepoint", [*range(0x200B, 0x2010), 0xFEFF])
def test_zero_width_characters_are_removed(codepoint: int) -> None:
    assert normalize(f"{BA}{chr(codepoint)}{ALEF}") == BA + ALEF


def test_zero_width_range_and_neighbours_are_exact() -> None:
    # U+200A (hair space) is whitespace, U+2010 (hyphen) is punctuation: neither is zero-width,
    # and both end up removed/collapsed through their own rules, never as a zero-width char.
    assert normalize(f"{BA} {ALEF}") == f"{BA} {ALEF}"
    assert normalize(f"{BA}‐{ALEF}") == BA + ALEF


def test_tatweel_is_removed() -> None:
    assert normalize(f"{BA}ــ{ALEF}") == BA + ALEF


@pytest.mark.parametrize("codepoint", range(0x064B, 0x0660))
def test_harakat_tanwin_shadda_sukun_range_is_removed(codepoint: int) -> None:
    assert normalize(f"{BA}{chr(codepoint)}{ALEF}") == BA + ALEF


def test_superscript_alef_is_removed() -> None:
    assert normalize(f"{LAM}{BA}ٰ{ALEF}") == LAM + BA + ALEF


@pytest.mark.parametrize("codepoint", range(0x06D6, 0x06EE))
def test_quranic_marks_range_is_removed(codepoint: int) -> None:
    assert normalize(f"{BA}{chr(codepoint)}{ALEF}") == BA + ALEF


def test_characters_just_outside_the_removed_ranges_stay() -> None:
    for outside in ("٠" if False else "ء", "ۮ", "ۯ"):  # hamza, U+06EE/F
        assert outside in normalize(f"{BA}{outside}{ALEF}")
    assert normalize("٠") == ""  # digit, removed by the digit rule instead
    assert "ە" in normalize("ە")  # ae is a letter below the Quranic mark block


def test_arabic_indic_digits_removed_for_words_but_kept_on_request() -> None:
    digits = "".join(chr(c) for c in range(0x0660, 0x066A))
    assert normalize(f"{BA}{digits}") == BA
    assert normalize(digits, keep_digits=True) == digits
    assert normalize("12") == "12"  # ASCII digits are not Arabic-Indic digits
    assert normalize("۱") == "۱"  # extended digits are outside the stated range


@pytest.mark.parametrize(
    "mark",
    ["«", "»", "،", "؛", "؟", ".", ":", "!", "-", "(", ")", '"', "۔"],
)
def test_punctuation_and_guillemets_are_removed(mark: str) -> None:
    assert normalize(f"{BA}{mark}{ALEF}") == BA + ALEF


def test_only_the_listed_characters_are_removed() -> None:
    # bidi and Arabic letter marks outside U+200B-U+200F are not in the policy and stay
    for kept in ("\u061c", "\u202a", "\u202e", "\u2066"):
        assert normalize(f"{BA}{kept}{ALEF}") == BA + kept + ALEF


def test_symbols_are_not_punctuation() -> None:
    assert normalize("a$b") == "a$b"  # category Sc stays: the policy says punctuation only


@pytest.mark.parametrize(
    ("source", "target"),
    [
        ("أ", ALEF),
        ("إ", ALEF),
        ("آ", ALEF),
        ("ٱ", ALEF),
        ("ٲ", ALEF),
        ("ٳ", ALEF),
        ("ى", YEH),
        ("ة", "ه"),
        ("ؤ", "و"),
        ("ئ", YEH),
    ],
)
def test_letter_mapping(source: str, target: str) -> None:
    assert normalize(source) == target


def test_whitespace_is_collapsed_and_trimmed() -> None:
    assert normalize(f"  {BA}  {ALEF}\t\n{LAM}  ") == f"{BA} {ALEF} {LAM}"


def test_latin_is_lowercased_and_arabic_is_untouched() -> None:
    assert normalize("AbC É") == "abc é"
    assert normalize(BA) == BA


def test_contract_example_ayah_word() -> None:
    word = "ٱلۡعَٰلَمِينَ"
    assert normalize(word) == "العلمين"
    assert alternative_form(word) == "العالمين"


def test_alternative_form_is_none_without_superscript_alef() -> None:
    assert alternative_form(f"{BA}{ALEF}") is None
    assert alternative_form(f"{BA}َ{ALEF}") is None


def test_alternative_form_maps_superscript_alef_to_alef() -> None:
    word = f"{LAM}{BA}ٰ{MEEM}"
    assert normalize(word) == LAM + BA + MEEM
    assert alternative_form(word) == LAM + BA + ALEF + MEEM


@pytest.mark.parametrize("policy", [None, "", "arabic-norm-v2", "arabic-norm-v0", "ARABIC-NORM-V1"])
def test_unsupported_policy_raises_everywhere(policy: str | None) -> None:
    with pytest.raises(UnsupportedPolicyError):
        normalize(BA, policy=policy)
    with pytest.raises(UnsupportedPolicyError):
        alternative_form(BA, policy=policy)
    with pytest.raises(UnsupportedPolicyError):
        tokenize(BA, policy=policy)
    with pytest.raises(UnsupportedPolicyError):
        is_single_word(BA, policy=policy)
    with pytest.raises(UnsupportedPolicyError):
        letter_skeleton(BA, policy=policy)


def test_explicit_supported_policy_is_accepted() -> None:
    assert normalize("أ", policy="arabic-norm-v1") == ALEF


# --- tokenizer -----------------------------------------------------------------------------


def test_tokenize_kinds_offsets_and_normalized_forms() -> None:
    text = "«قَالَ» ۞ ١ ، ٱلۡعَٰلَمِينَ"
    tokens = tokenize(text)
    assert [t.k for t in tokens] == ["word", "mark", "number", "punct", "word"]
    assert [t.i for t in tokens] == [0, 1, 2, 3, 4]
    for token in tokens:
        assert text[token.s : token.e] == text[token.s : token.e].strip()
        assert " " not in text[token.s : token.e]
    assert tokens[0].n == "قال"  # guillemets and harakat removed
    assert tokens[1].n == ""  # U+06DE is a Quranic mark
    assert tokens[2].n == "١"  # number tokens keep their digits
    assert tokens[3].n == ""
    assert tokens[4].n == "العلمين"
    assert tokens[4].a == "العالمين"
    assert all(t.a is None for t in tokens[:4])


def test_tokenize_offsets_round_trip_over_a_longer_text() -> None:
    surfaces = ["كَلِمَةٌ", "هَٰذَا", "«مِثَالٌ»"]
    text = "  ".join(surfaces[:2]) + " " + surfaces[2]
    tokens = tokenize(text)
    assert [text[t.s : t.e] for t in tokens] == surfaces
    assert [t.i for t in tokens] == [0, 1, 2]


def test_tokenize_splits_on_space_and_nbsp() -> None:
    tokens = tokenize(f"{BA} {ALEF} {LAM}")
    assert [t.n for t in tokens] == [BA, ALEF, LAM]
    assert tokens[1].s == 2 and tokens[2].s == 4


def test_zero_width_characters_stay_in_the_surface_and_leave_the_normalized_form() -> None:
    text = f"{BA}‌{ALEF} {LAM}"
    tokens = tokenize(text)
    assert text[tokens[0].s : tokens[0].e] == f"{BA}‌{ALEF}"
    assert tokens[0].n == BA + ALEF


def test_tokenize_empty_and_blank_text() -> None:
    assert tokenize("") == []
    assert tokenize("    ") == []


def test_tokenize_requires_nfc_text() -> None:
    with pytest.raises(ValueError, match="NFC"):
        tokenize("آ")  # decomposed alef + madda


def test_token_dict_has_a_only_when_present() -> None:
    plain, dagger = tokenize(f"{BA} {LAM}ٰ{MEEM}")
    assert plain.to_dict() == {"i": 0, "s": 0, "e": 1, "k": "word", "n": BA}
    assert dagger.to_dict() == {
        "i": 1,
        "s": 2,
        "e": 5,
        "k": "word",
        "n": LAM + MEEM,
        "a": LAM + ALEF + MEEM,
    }


@pytest.mark.parametrize(
    ("surface", "kind"),
    [
        ("123", "number"),
        ("١٢", "number"),
        ("1٢", "number"),
        ("،", "punct"),
        ("«»", "punct"),
        (".", "punct"),
        ("۞", "mark"),
        ("۩", "mark"),
        ("ۖ", "mark"),
        ("ۥ", "mark"),  # Lm but inside the Quranic mark block: not a letter
        ("ـ", "mark"),  # tatweel alone is not a letter
        ("(1)", "mark"),
        ("‌", "mark"),
        ("كَلِمَة", "word"),
        ("«قال،", "word"),  # attached punctuation stays in a word
        ("abc", "word"),
    ],
)
def test_classify_token(surface: str, kind: str) -> None:
    assert classify_token(surface) == kind


def test_classify_token_rejects_empty() -> None:
    with pytest.raises(ValueError):
        classify_token("")


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ("كلمة", True),
        ("  كلمة  ", True),
        ("كَلِمَة", True),
        ("كلمة،", True),
        ("كلمة مثال", False),
        ("كلمة مثال", False),
        ("", False),
        ("   ", False),
        ("123", False),
        ("،", False),
        ("۞", False),
    ],
)
def test_is_single_word(answer: str, expected: bool) -> None:
    assert is_single_word(answer) is expected


def test_letter_skeleton_keeps_letters_only() -> None:
    assert letter_skeleton(f"«{BA}َ {ALEF}١، {LAM}ٰ") == BA + ALEF + LAM


def test_nfc_inputs_are_stable_under_normalize_twice() -> None:
    sample = unicodedata.normalize("NFC", "أَلْكِتَابُ 1")
    once = normalize(sample)
    assert normalize(once) == once
