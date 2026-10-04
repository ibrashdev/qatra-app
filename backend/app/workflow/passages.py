"""Passage and part algorithms (contract §2.3, D66): pure functions over flat token lists.

Everything here is deterministic. A *flat sequence* is a list of ``Tok`` (one per token of a
unit or of a run of consecutive units). Cuts are always expressed as a number of words
(``c`` = "the left group holds the first ``c`` words"); non-word tokens (marks, punctuation)
that follow a word stay with the word on their left, so groups tile the sequence exactly.

Choices made where the contract leaves room:

- **Balancing** (Quran passages): the specified greedy rule, exactly: for each multiple
  ``i * words / k`` take the ayah boundary with the smallest distance (ties: the earlier
  boundary), keeping every group non-empty. ``k`` never exceeds the number of ayat.
- **Balancing** (cuts inside an ayah or a long matn): the cut set that minimizes, in this order,
  the number of non-preferred cuts, then the sum of squared deviations from the ideal size
  (integer arithmetic), then the cut positions themselves (deterministic tie-break). It is an
  exact dynamic program, not a heuristic.
- **Pause marks** (Quran): a cut is *after a pause mark* when the word token, or a non-word
  token immediately following it, contains a character of U+06D6-U+06DC (the Quranic waqf
  signs).
- **Sentence punctuation** (matn): strong ``. ؟ ! ؛`` (U+061F, U+061B), then weak ``،``
  (U+060C). Clause punctuation (parts) is ``، ؛ : . ؟ !``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

MAX_PASSAGE_WORDS: Final = 60
AYAT_PER_PASSAGE: Final = 5
QURAN_PART_MIN: Final = 4
PART_MAX: Final = 8
HADITH_CLAUSE_MIN: Final = 3

PAUSE_MARKS: Final = frozenset(chr(cp) for cp in range(0x06D6, 0x06DD))
STRONG_SENTENCE: Final = frozenset(".؟!؛")
WEAK_SENTENCE: Final = frozenset("،")
CLAUSE_PUNCT: Final = frozenset("،؛:.؟!")


@dataclass(frozen=True, slots=True)
class Tok:
    """A token of a flat sequence: ``ref`` is ``(unit ordinal, token index)``."""

    ref: tuple[int, int]
    kind: str
    surface: str
    n: str = ""


def ref_str(ref: tuple[int, int]) -> str:
    return f"{ref[0]}:{ref[1]}"


def word_positions(tokens: Sequence[Tok]) -> list[int]:
    """Indexes (into ``tokens``) of the word tokens."""
    return [i for i, tok in enumerate(tokens) if tok.kind == "word"]


def _trailing_chars(tokens: Sequence[Tok], words: Sequence[int], c: int) -> str:
    """Surface of the ``c``-th word (1-based) plus the non-word tokens right after it."""
    start = words[c - 1]
    end = words[c] if c < len(words) else len(tokens)
    return "".join(tok.surface for tok in tokens[start:end])


def has_pause_after(tokens: Sequence[Tok], words: Sequence[int], c: int) -> bool:
    return any(ch in PAUSE_MARKS for ch in _trailing_chars(tokens, words, c))


def word_cut_ranges(tokens: Sequence[Tok], cuts: Sequence[int]) -> list[tuple[int, int]]:
    """Token index ranges (inclusive) of the groups made by ``cuts`` (word counts, ascending);
    the ranges tile ``tokens``."""
    words = word_positions(tokens)
    bounds = [0, *[words[c] for c in cuts], len(tokens)]
    return [(bounds[i], bounds[i + 1] - 1) for i in range(len(bounds) - 1)]


# --- exact balanced cut selection ----------------------------------------------------------


def best_cuts(
    n: int, k: int, candidates: Mapping[int, int], min_size: int, max_size: int
) -> tuple[int, ...] | None:
    """Choose ``k - 1`` cut positions (word counts in ``1..n-1``) from ``candidates`` so that the
    ``k`` groups have sizes within ``[min_size, max_size]``.

    ``candidates`` maps a position to its penalty (0 = preferred). Minimizes, lexicographically,
    (sum of penalties, sum of ``(k * size - n) ** 2``, the cut tuple). Returns ``None`` when no
    such selection exists.
    """
    if k < 1:
        raise ValueError("k must be at least 1")
    if k == 1:
        return () if min_size <= n <= max_size else None
    positions = sorted(candidates)
    # state: (cuts used, last cut) -> (penalty, cost, cuts)
    states: dict[tuple[int, int], tuple[int, int, tuple[int, ...]]] = {(0, 0): (0, 0, ())}
    for used in range(1, k):
        for cut in positions:
            best: tuple[int, int, tuple[int, ...]] | None = None
            for (done, last), (pen, cost, cuts) in states.items():
                if done != used - 1 or not min_size <= cut - last <= max_size:
                    continue
                candidate = (
                    pen + candidates[cut],
                    cost + (k * (cut - last) - n) ** 2,
                    (*cuts, cut),
                )
                if best is None or candidate < best:
                    best = candidate
            if best is not None:
                states[(used, cut)] = best
    result: tuple[int, int, tuple[int, ...]] | None = None
    for (done, last), (pen, cost, cuts) in states.items():
        if done != k - 1 or not min_size <= n - last <= max_size:
            continue
        candidate = (pen, cost + (k * (n - last) - n) ** 2, cuts)
        if result is None or candidate < result:
            result = candidate
    return None if result is None else result[2]


def nearest_cuts(n: int, k: int) -> tuple[int, ...]:
    """Hard fallback: ``k - 1`` distinct cuts at the positions nearest to ``i * n / k``."""
    cuts: list[int] = []
    previous = 0
    for i in range(1, k):
        low, high = previous + 1, n - (k - i)
        target_times_k = i * n
        best = min(range(low, high + 1), key=lambda c: (abs(c * k - target_times_k), c))
        cuts.append(best)
        previous = best
    return tuple(cuts)


# --- Quran ---------------------------------------------------------------------------------


def quran_passage_groups(ayah_word_counts: Sequence[int]) -> tuple[list[tuple[int, int]], bool]:
    """Group the ayat of one surah into passages (D66).

    Returns the groups as inclusive ``(first, last)`` indexes into the ayat and a flag that is
    true when ``k`` had to be capped at the number of ayat. A surah of at most 60 words is one
    passage; otherwise ``k = max(ceil(ayat / 5), ceil(words / 60))`` consecutive groups are cut
    at the ayah boundary nearest to each multiple of ``words / k``.
    """
    ayat = len(ayah_word_counts)
    if ayat == 0:
        raise ValueError("a surah has at least one ayah")
    words = sum(ayah_word_counts)
    if words <= MAX_PASSAGE_WORDS:
        return [(0, ayat - 1)], False
    wanted = max(-(-ayat // AYAT_PER_PASSAGE), -(-words // MAX_PASSAGE_WORDS))
    k = min(wanted, ayat)
    cumulative: list[int] = []
    total = 0
    for count in ayah_word_counts:
        total += count
        cumulative.append(total)  # words up to and including ayah j (0-based)
    cuts: list[int] = []  # last ayah index of each group but the last
    previous = -1
    for i in range(1, k):
        low, high = previous + 1, ayat - 1 - (k - i)
        best = min(range(low, high + 1), key=lambda j: (abs(cumulative[j] * k - i * words), j))
        cuts.append(best)
        previous = best
    firsts = [0, *[c + 1 for c in cuts]]
    lasts = [*cuts, ayat - 1]
    return list(zip(firsts, lasts, strict=True)), k < wanted


def quran_ayah_parts(tokens: Sequence[Tok]) -> list[tuple[int, int]]:
    """Parts of one ayah: one part when it has at most 8 words, otherwise
    ``ceil(words / 8)`` balanced chunks of 4-8 words, preferring cuts after a pause mark."""
    words = word_positions(tokens)
    count = len(words)
    if count <= PART_MAX:
        return [(0, len(tokens) - 1)]
    chunks = -(-count // PART_MAX)
    candidates = {c: 0 if has_pause_after(tokens, words, c) else 1 for c in range(1, count)}
    cuts = best_cuts(count, chunks, candidates, QURAN_PART_MIN, PART_MAX)
    if cuts is None:  # cannot happen for count > 8 (4 * chunks <= count <= 8 * chunks)
        raise AssertionError("no admissible part cuts")
    return word_cut_ranges(tokens, cuts)


# --- hadith --------------------------------------------------------------------------------


def clause_ends(tokens: Sequence[Tok]) -> list[int]:
    """Word counts after which a clause ends (clause punctuation on the word or right after)."""
    words = word_positions(tokens)
    return [
        c
        for c in range(1, len(words) + 1)
        if any(ch in CLAUSE_PUNCT for ch in _trailing_chars(tokens, words, c))
    ]


def hadith_parts(tokens: Sequence[Tok]) -> list[tuple[int, int]]:
    """Parts of a hadith passage: clauses split at ``، ؛ : . ؟ !``; a clause of fewer than 3
    words merges with the next one (a short last clause merges with the previous one); a clause
    of more than 8 words is split into ``ceil(words / 8)`` balanced chunks of at most 8."""
    words = word_positions(tokens)
    total = len(words)
    ends = clause_ends(tokens)
    if not ends or ends[-1] != total:
        ends = [*ends, total]
    clauses: list[int] = []  # sizes in words
    previous = 0
    for end in ends:
        clauses.append(end - previous)
        previous = end
    merged: list[int] = []
    pending = 0
    for size in clauses:
        pending += size
        if pending >= HADITH_CLAUSE_MIN:
            merged.append(pending)
            pending = 0
    if pending:
        if merged:
            merged[-1] += pending
        else:
            merged.append(pending)
    cuts: list[int] = []
    position = 0
    for size in merged:
        pieces = -(-size // PART_MAX)
        base, extra = divmod(size, pieces)
        for piece in range(pieces):
            position += base + (1 if piece < extra else 0)
            if position < total:
                cuts.append(position)
    return word_cut_ranges(tokens, cuts)


def matn_groups(tokens: Sequence[Tok]) -> tuple[list[tuple[int, int]], bool]:
    """Split a matn into passages of at most 60 words (``ceil(words / 60)`` balanced groups) at
    sentence punctuation (``. ؟ ! ؛`` first, then ``،``).

    Returns token ranges (inclusive) and a flag that is true when no punctuation-only selection
    exists and hard cuts at word boundaries had to be used (reported for review).
    """
    words = word_positions(tokens)
    count = len(words)
    if count <= MAX_PASSAGE_WORDS:
        return [(0, len(tokens) - 1)], False
    k = -(-count // MAX_PASSAGE_WORDS)
    candidates: dict[int, int] = {}
    for c in range(1, count):
        trailing = _trailing_chars(tokens, words, c)
        if any(ch in STRONG_SENTENCE for ch in trailing):
            candidates[c] = 0
        elif any(ch in WEAK_SENTENCE for ch in trailing):
            candidates[c] = 1
    cuts = best_cuts(count, k, candidates, 1, MAX_PASSAGE_WORDS)
    hard = cuts is None
    if cuts is None:
        cuts = nearest_cuts(count, k)
    return word_cut_ranges(tokens, cuts), hard


def find_matn_bounds(tokens: Sequence[Tok]) -> tuple[tuple[int, int] | None, str | None]:
    """The matn token range (inclusive) from the opening ``«`` to the closing ``»``.

    Returns ``(range, None)`` when there is exactly one opening and one closing mark in order,
    otherwise ``(None, doubt)`` with doubt ``absent``, ``multiple`` or ``unbalanced``.
    """
    opens = [i for i, tok in enumerate(tokens) if "«" in tok.surface]
    closes = [i for i, tok in enumerate(tokens) if "»" in tok.surface]
    if not opens or not closes:
        return None, "absent"
    if len(opens) > 1 or len(closes) > 1:
        return None, "multiple"
    if opens[0] > closes[0]:
        return None, "unbalanced"
    return (opens[0], closes[0]), None
