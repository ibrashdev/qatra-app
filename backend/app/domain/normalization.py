"""Arabic normalization policy ``arabic-norm-v1`` and the tokenizer (contract §2.2, §2.5).

Pure module: standard library only (no FastAPI, no database client). It is owned by the content
package and imported by the backend (contract §10).

Policy ``arabic-norm-v1`` (contract §2.5), in this order for every character of the NFC text:

1. NFC; 2. remove zero-width characters U+200B-U+200F and U+FEFF, tatweel U+0640, harakat /
tanwin / shadda / sukun U+064B-U+065F, superscript alef U+0670, Quranic marks U+06D6-U+06ED;
3. remove Arabic-Indic digits U+0660-U+0669 (only when grading words, i.e. unless
``keep_digits=True``); 4. remove punctuation (Unicode category ``P*``, which includes the Arabic
comma, semicolon, question mark, full stop and the guillemets); 5. map أ إ آ ٱ ٲ ٳ to ا, ى to ي,
ة to ه, ؤ to و, ئ to ي; 6. lower-case Latin letters; 7. collapse whitespace.

Nothing else is removed or mapped (for example bidi controls such as U+061C and U+202A-U+202E
stay). An unsupported or missing policy version raises ``UnsupportedPolicyError``: grading is
unavailable and the policy is never guessed.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Final, Literal

POLICY_VERSION: Final = "arabic-norm-v1"

TokenKind = Literal["word", "number", "mark", "punct"]

SUPERSCRIPT_ALEF: Final = "ٰ"
_ALEF: Final = "ا"

# Letter mapping of contract §2.5 (code points written out so the table cannot be mis-edited).
_LETTER_MAP: Final = str.maketrans(
    {
        "أ": _ALEF,  # alef with hamza above
        "إ": _ALEF,  # alef with hamza below
        "آ": _ALEF,  # alef with madda above
        "ٱ": _ALEF,  # alef wasla
        "ٲ": _ALEF,  # alef with wavy hamza above
        "ٳ": _ALEF,  # alef with wavy hamza below
        "ى": "ي",  # alef maksura -> yeh
        "ة": "ه",  # teh marbuta -> heh
        "ؤ": "و",  # waw with hamza above -> waw
        "ئ": "ي",  # yeh with hamza above -> yeh
    }
)

_TOKEN_RE: Final = re.compile(r"\S+")


class UnsupportedPolicyError(ValueError):
    """The requested normalization policy is missing or not ``arabic-norm-v1``."""


def require_policy(policy: str | None) -> None:
    """Raise ``UnsupportedPolicyError`` unless ``policy`` is exactly ``arabic-norm-v1``."""
    if policy != POLICY_VERSION:
        shown = "<missing>" if not policy else policy[:40]
        raise UnsupportedPolicyError(
            f"unsupported normalization policy {shown!r}; only {POLICY_VERSION!r} is implemented"
        )


def _is_removed(cp: int) -> bool:
    """Zero-width characters, tatweel, harakat, superscript alef and Quranic marks."""
    return (
        0x200B <= cp <= 0x200F
        or cp == 0xFEFF
        or cp == 0x0640
        or 0x064B <= cp <= 0x065F
        or cp == 0x0670
        or 0x06D6 <= cp <= 0x06ED
    )


def _is_arabic_indic_digit(cp: int) -> bool:
    return 0x0660 <= cp <= 0x0669


def _is_digit(ch: str) -> bool:
    """ASCII or Arabic-Indic digit (the digits a ``number`` token may contain)."""
    return "0" <= ch <= "9" or _is_arabic_indic_digit(ord(ch))


def _is_punctuation(ch: str) -> bool:
    return unicodedata.category(ch).startswith("P")


def _is_letter(ch: str) -> bool:
    """A real letter: category ``L*`` outside tatweel and the Quranic mark block U+06D6-U+06ED
    (U+06E5 and U+06E6 are category Lm but are marks, not letters)."""
    cp = ord(ch)
    if cp == 0x0640 or 0x06D6 <= cp <= 0x06ED:
        return False
    return unicodedata.category(ch).startswith("L")


# Script checks (source-text hygiene). They read characters only and never change them.
_ARABIC_SCRIPT_RANGES: Final = (
    (0x0600, 0x06FF),  # Arabic
    (0x0750, 0x077F),  # Arabic Supplement
    (0x08A0, 0x08FF),  # Arabic Extended-A
    (0xFB50, 0xFDFF),  # Arabic Presentation Forms-A
    (0xFE70, 0xFEFF),  # Arabic Presentation Forms-B
)
_LATIN_LETTER_RANGES: Final = (
    (0x0000, 0x024F),  # Basic Latin, Latin-1 Supplement, Latin Extended-A/B (letters only)
    (0x1E00, 0x1EFF),  # Latin Extended Additional
    (0x2C60, 0x2C7F),  # Latin Extended-C
    (0xA720, 0xA7FF),  # Latin Extended-D
    (0xFB00, 0xFB06),  # Latin ligatures
    (0xFF21, 0xFF5A),  # Fullwidth Latin letters
)


def is_arabic_script_char(ch: str) -> bool:
    """True when ``ch`` lies in one of the Arabic-script blocks (letters, marks, digits)."""
    cp = ord(ch)
    return any(low <= cp <= high for low, high in _ARABIC_SCRIPT_RANGES)


def has_arabic_letter(text: str) -> bool:
    """True when ``text`` has at least one Arabic-script *letter* (Unicode category ``L*``)."""
    return any(
        is_arabic_script_char(ch) and unicodedata.category(ch).startswith("L") for ch in text
    )


def is_latin_letter(ch: str) -> bool:
    """A Latin-script letter (ASCII, accented or fullwidth); digits and punctuation are not."""
    if not ch.isalpha():
        return False
    cp = ord(ch)
    return any(low <= cp <= high for low, high in _LATIN_LETTER_RANGES)


def has_latin_letter(text: str) -> bool:
    """True when ``text`` contains any Latin-script letter."""
    return any(is_latin_letter(ch) for ch in text)


def is_arabic_script_word(normalized: str) -> bool:
    """True when ``normalized`` is non-empty and every character lies in an Arabic-script block
    (so it has no Latin letter, ASCII digit or other foreign script)."""
    return bool(normalized) and all(is_arabic_script_char(ch) for ch in normalized)


def _normalize(text: str, *, keep_digits: bool, superscript_alef_as_alef: bool) -> str:
    out: list[str] = []
    for ch in unicodedata.normalize("NFC", text):
        cp = ord(ch)
        if superscript_alef_as_alef and cp == 0x0670:
            out.append(_ALEF)
            continue
        if _is_removed(cp):
            continue
        if not keep_digits and _is_arabic_indic_digit(cp):
            continue
        if _is_punctuation(ch):
            continue
        mapped = ch.translate(_LETTER_MAP)
        if cp < 0x0250 and mapped.isalpha():  # Latin (Basic, Latin-1, Extended-A/B)
            mapped = mapped.lower()
        out.append(mapped)
    return " ".join("".join(out).split())


def normalize(text: str, *, policy: str | None = POLICY_VERSION, keep_digits: bool = False) -> str:
    """Normalize ``text`` with ``arabic-norm-v1``.

    ``keep_digits=True`` keeps Arabic-Indic digits (used only for ``number`` tokens); the
    default removes them, as when grading words.
    """
    require_policy(policy)
    return _normalize(text, keep_digits=keep_digits, superscript_alef_as_alef=False)


def alternative_form(text: str, *, policy: str | None = POLICY_VERSION) -> str | None:
    """Alternative normalized form: superscript alef U+0670 mapped to ا instead of removed.

    Returns ``None`` when the word contains no U+0670 (there is then nothing to alternate).
    Example: the word with a dagger alef over the lam normalizes to ``العلمين`` and has the
    alternative form ``العالمين``.
    """
    require_policy(policy)
    if SUPERSCRIPT_ALEF not in text:
        return None
    return _normalize(text, keep_digits=False, superscript_alef_as_alef=True)


def letter_skeleton(text: str, *, policy: str | None = POLICY_VERSION) -> str:
    """Letters only of the normalized text (no spaces, digits or symbols).

    Used to compare two wordings of the same text for omissions or additions; a review aid,
    never a verbatim check.
    """
    return "".join(ch for ch in normalize(text, policy=policy) if _is_letter(ch))


@dataclass(frozen=True, slots=True)
class Token:
    """One token of a unit (contract §2.2): ``s``/``e`` are character offsets into the NFC
    ``canonical_text`` (``e`` is exclusive), so ``canonical_text[s:e]`` is the surface form."""

    i: int
    s: int
    e: int
    k: TokenKind
    n: str
    a: str | None = None

    def to_dict(self) -> dict[str, int | str]:
        """Bundle form ``{i, s, e, k, n, a?}``; ``a`` appears only when it exists."""
        data: dict[str, int | str] = {
            "i": self.i,
            "s": self.s,
            "e": self.e,
            "k": self.k,
            "n": self.n,
        }
        if self.a is not None:
            data["a"] = self.a
        return data


def classify_token(surface: str) -> TokenKind:
    """Token kind of a non-empty, whitespace-free ``surface``.

    ``number``: only ASCII or Arabic-Indic digits. ``punct``: punctuation only. ``mark``: no
    letter at all (for example ۞ ۩ or a standalone pause mark; a token such as ``(1)`` is a
    mark too). Everything else is a ``word`` (its surface keeps attached marks/punctuation).
    """
    if not surface:
        raise ValueError("a token surface cannot be empty")
    if all(_is_digit(ch) for ch in surface):
        return "number"
    if all(_is_punctuation(ch) for ch in surface):
        return "punct"
    if not any(_is_letter(ch) for ch in surface):
        return "mark"
    return "word"


def tokenize(canonical_text: str, *, policy: str | None = POLICY_VERSION) -> list[Token]:
    """Split NFC ``canonical_text`` on whitespace (space, NBSP and any other Unicode space).

    Raises ``ValueError`` if the text is not NFC (offsets would then not match the stored
    text) and ``UnsupportedPolicyError`` for an unsupported policy.
    """
    require_policy(policy)
    if not unicodedata.is_normalized("NFC", canonical_text):
        raise ValueError("canonical_text must be NFC")
    tokens: list[Token] = []
    for index, match in enumerate(_TOKEN_RE.finditer(canonical_text)):
        surface = match.group()
        kind = classify_token(surface)
        tokens.append(
            Token(
                i=index,
                s=match.start(),
                e=match.end(),
                k=kind,
                n=_normalize(
                    surface, keep_digits=(kind == "number"), superscript_alef_as_alef=False
                ),
                a=alternative_form(surface) if kind == "word" else None,
            )
        )
    return tokens


def is_single_word(answer: str, *, policy: str | None = POLICY_VERSION) -> bool:
    """A recall answer must be exactly one word after trimming (contract §2.5).

    True when the trimmed answer is non-empty, has no inner whitespace and is a single
    ``word`` token (digits-only or punctuation-only answers are not words).
    """
    require_policy(policy)
    trimmed = answer.strip()
    if not trimmed or any(ch.isspace() for ch in trimmed):
        return False
    return classify_token(trimmed) == "word"
