"""Lessons and the deterministic question bank (API-spec §5.3 ``build-bank``, contract §2.4,
D20, D22, D31, D64, D66). No model writes anything: every question is made of token references
of the same edition, and the same bundle always gives the same bank.

Templates per part of a passage (a part is the coverage unit; showing context is never
coverage, so ``coveredPartIds`` lists only the parts whose own words are tested):

- ``word_recall`` ``keyword``: blank = the longest normalized word outside a small stoplist
  (first position on a tie); ``continuation``: blank = the first word of a non-first part.
  Quran positions whose Uthmani spelling diverges from common spelling (U+0670, U+06E5, U+06E6,
  U+0653, U+06DF) are never recall targets; ``word_choice`` ``word`` is used there instead.
- ``word_choice`` ``word``: blank = the next keyword of the part; 4 options = the correct word
  and 3 distractors of the same section (different normalized form, length within 2 letters;
  fallback: the same edition). ``segment``: for a non-first part, the first 2-4 words of the
  part are the correct next segment, with 2 other same-length segments (no overlap, different
  normalized text, inside one unit) of the same section (fallback: the edition).
- ``word_order``: one question per part of 3-8 words; a part of fewer than 3 words may be merged
  with the next part when that one has fewer than 4 words (and the group has 3 or more words).
- ``similar_distinction`` (D31): another part of the same edition that shares a normalized
  3-gram or aligns on at least 60% of its words, and differs at one word next to at least two
  equal words; options = the word of this part and the word at the similar position.
- Grade passages: a ``word_choice`` among the distinct grade phrases present in the edition
  (needs at least two); they get no recall or keyword questions (a one-word phrase has no
  context).

A position is skipped when its shown context (up to 6 words on each side, inside the passage)
also occurs elsewhere in the edition with a different normalized answer (an ambiguous item).
Hints and shuffling happen at session time and are not stored. Lesson duration is a workflow
estimate: ``60 s + 8 s per word`` (not a policy value).
"""

from __future__ import annotations

import difflib
import hashlib
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from app.workflow.bundle_index import CONTEXT_WORDS, BundleIndex, Word, window_key
from app.workflow.ids import stable_id
from app.workflow.passages import Tok

LESSON_BASE_SEC: Final = 60
LESSON_PER_WORD_SEC: Final = 8
QURAN_RECALL_EXCLUDED: Final = ("ٰ", "ۥ", "ۦ", "ٓ", "۟")
STOPLIST: Final = frozenset(
    {
        "و",
        "ف",
        "ثم",
        "او",
        "ان",
        "ما",
        "لا",
        "لم",
        "لن",
        "من",
        "في",
        "عن",
        "الي",
        "علي",
        "بل",
        "قد",
        "هو",
        "هي",
        "هم",
        "انا",
        "انت",
        "كل",
        "هذا",
        "هذه",
        "ذلك",
        "تلك",
        "الذي",
        "التي",
        "الذين",
        "اذا",
        "اذ",
        "كان",
        "كانوا",
        "ليس",
    }
)
TEMPLATE_RANK: Final = {
    "word_order": 0,
    "word_choice": 1,
    "word_recall": 2,
    "similar_distinction": 3,
}


@dataclass(slots=True)
class BankResult:
    """The built bank plus what could not be built (ids only), for the report."""

    lessons: list[dict[str, Any]]
    questions: list[dict[str, Any]]
    skipped: list[dict[str, str]] = field(default_factory=list)


def build_lessons(bundle: Mapping[str, Any]) -> list[dict[str, Any]]:
    """One lesson per passage, in passage order (``lessons.passage_id``)."""
    key, bank = bundle["editionKey"], bundle["bankVersion"]
    return [
        {
            "id": stable_id(key, bank, "lesson", ordinal),
            "ordinal": ordinal,
            "passageId": passage["id"],
            "durationEstimateSec": LESSON_BASE_SEC + LESSON_PER_WORD_SEC * passage["wordCount"],
        }
        for ordinal, passage in enumerate(bundle["passages"], start=1)
    ]


def _digest(*parts: object) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()


def _alt_differs(a: Word, b: Word) -> bool:
    """Different after normalization, including the alternative (U+0670) forms."""
    if a.n == b.n:
        return False
    if a.a is not None and (a.a == b.n or a.a == b.a):
        return False
    return not (b.a is not None and b.a == a.n)


class _Builder:
    def __init__(self, bundle: Mapping[str, Any]) -> None:
        self.bundle = bundle
        self.edition = bundle["editionKey"]
        self.bank = bundle["bankVersion"]
        self.index = BundleIndex(bundle)
        self.words: list[list[Word]] = list(self.index.all_passage_words())
        self.tokens: list[list[Tok]] = [
            self.index.passage_tokens(i) for i in range(len(self.index.passages))
        ]
        self._tok_pos: list[dict[tuple[int, int], int]] = [
            {tok.ref: i for i, tok in enumerate(toks)} for toks in self.tokens
        ]
        self.part_words: list[list[Word]] = [[] for _ in self.index.parts]
        for words in self.words:
            for word in words:
                self.part_words[word.part].append(word)
        self.section_of_passage = [p["sectionOrdinal"] for p in self.index.passages]
        self.section_words: dict[int, list[Word]] = defaultdict(list)
        for p_index, words in enumerate(self.words):
            if self.index.passages[p_index]["path"] != "grade":
                self.section_words[self.section_of_passage[p_index]].extend(words)
        self.edition_words: list[Word] = [w for ws in self.section_words.values() for w in ws]
        self.is_quran = any(u["kind"] == "ayah" for u in bundle["units"])
        self.questions: dict[str, dict[str, Any]] = {}
        self.skipped: list[dict[str, str]] = []
        self._single_targets: dict[tuple[tuple[str, ...], tuple[str, ...]], set[str]] = defaultdict(
            set
        )
        for p_index, words in enumerate(self.words):
            # Grade prompts compare whole phrases, so grade words do not compete for blank contexts.
            if self.index.passages[p_index]["path"] == "grade":
                continue
            for word in words:
                self._single_targets[self._single_key(word)].add(word.n)
        self._segment_targets: dict[int, dict[Any, set[tuple[str, ...]]]] = {}
        self._windows: dict[tuple[int | None, int], list[tuple[Word, ...]]] = {}

    # --- naming -------------------------------------------------------------------------

    def part_key(self, part: int) -> str:
        passage = self.index.passages[self.index.part_passage[part]]
        ordinal = self.index.parts[part]["ordinal"]
        return f"{passage['path']}:{passage['ordinal']}:{ordinal}"

    def _reference(self, refs: Sequence[str]) -> str:
        first = self.index.units[int(refs[0].split(":")[0])]["reference"]
        last = self.index.units[int(refs[-1].split(":")[0])]["reference"]
        if first == last:
            return str(first)
        prefix, _, tail = str(last).rpartition(":")
        if prefix and str(first).startswith(prefix + ":"):
            return f"{first}-{tail}"
        return f"{first}-{last}"

    def _add(
        self,
        *,
        type_: str,
        variant: str | None,
        parts: Sequence[int],
        token_refs: Sequence[str],
        options: Sequence[Sequence[str]] | None,
        correct: Sequence[str],
        context: Sequence[str],
        natural_key: str,
    ) -> bool:
        if natural_key in self.questions:
            return False
        passage = self.index.passages[self.index.part_passage[parts[0]]]
        self.questions[natural_key] = {
            "id": stable_id(self.edition, self.bank, "question", natural_key),
            "type": type_,
            "variant": variant,
            "passageId": passage["id"],
            "coveredPartIds": [self.index.parts[p]["id"] for p in parts],
            "tokenRefs": list(token_refs),
            "optionRefs": None if options is None else [list(o) for o in options],
            "correctRef": list(correct),
            "contextRefs": list(context),
            "reference": self._reference(token_refs),
            "_sort": (parts[0], TEMPLATE_RANK[type_], natural_key),
        }
        return True

    # --- context and ambiguity ----------------------------------------------------------

    def _single_key(self, word: Word) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return window_key(self.words[word.passage], word.pos)

    def _unambiguous(self, word: Word) -> bool:
        return len(self._single_targets[self._single_key(word)]) == 1

    def _context(self, passage: int, first: Word, last: Word) -> list[str]:
        """Refs of the tokens shown around ``first..last`` (up to 6 words each side)."""
        words, toks, pos = self.words[passage], self.tokens[passage], self._tok_pos[passage]
        start = pos[(first.unit, first.index)]
        end = pos[(last.unit, last.index)]
        before_words = words[max(0, first.pos - CONTEXT_WORDS) : first.pos]
        after_words = words[last.pos + 1 : last.pos + 1 + CONTEXT_WORDS]
        low = pos[(before_words[0].unit, before_words[0].index)] if before_words else start
        if after_words:
            nxt = last.pos + 1 + CONTEXT_WORDS
            high = (
                pos[(words[nxt].unit, words[nxt].index)] - 1 if nxt < len(words) else len(toks) - 1
            )
        else:
            high = end
        refs = [f"{t.ref[0]}:{t.ref[1]}" for t in toks[low:start]]
        refs += [f"{t.ref[0]}:{t.ref[1]}" for t in toks[end + 1 : high + 1]]
        return refs

    # --- distractors --------------------------------------------------------------------

    def _distractor_words(self, target: Word) -> list[Word]:
        chosen: list[Word] = []
        seen = {target.n}
        for pool in (
            self.section_words[self.section_of_passage[target.passage]],
            self.edition_words,
        ):
            candidates = sorted(
                (
                    w
                    for w in pool
                    if w.ref != target.ref
                    and abs(len(w.n) - len(target.n)) <= 2
                    and _alt_differs(target, w)
                ),
                key=lambda w: (abs(len(w.n) - len(target.n)), _digest(target.ref, w.ref)),
            )
            for word in candidates:
                if word.n in seen or any(not _alt_differs(word, c) for c in chosen):
                    continue
                chosen.append(word)
                seen.add(word.n)
                if len(chosen) == 3:
                    return chosen
        return chosen

    def _windows_of(self, section: int | None, length: int) -> list[tuple[Word, ...]]:
        key = (section, length)
        if key not in self._windows:
            found: list[tuple[Word, ...]] = []
            for p_index, words in enumerate(self.words):
                if self.index.passages[p_index]["path"] == "grade":
                    continue
                if section is not None and self.section_of_passage[p_index] != section:
                    continue
                for start in range(len(words) - length + 1):
                    window = tuple(words[start : start + length])
                    if len({w.unit for w in window}) == 1:
                        found.append(window)
            self._windows[key] = found
        return self._windows[key]

    def _segment_index(self, length: int) -> dict[Any, set[tuple[str, ...]]]:
        if length not in self._segment_targets:
            table: dict[Any, set[tuple[str, ...]]] = defaultdict(set)
            for words in self.words:
                for start in range(len(words) - length + 1):
                    key = window_key(words, start, length)
                    table[key].add(tuple(w.n for w in words[start : start + length]))
            self._segment_targets[length] = table
        return self._segment_targets[length]

    # --- templates ----------------------------------------------------------------------

    def _recall_excluded(self, word: Word) -> bool:
        return self.is_quran and any(ch in word.surface for ch in QURAN_RECALL_EXCLUDED)

    def _choice_word(self, part: int, word: Word) -> bool:
        distractors = self._distractor_words(word)
        if len(distractors) < 3:
            self.skipped.append({"kind": "choice_word_few_distractors", "ref": word.ref})
            return False
        options = sorted([[word.ref], *[[d.ref] for d in distractors]], key=_ref_sort)
        return self._add(
            type_="word_choice",
            variant="word",
            parts=[part],
            token_refs=[word.ref],
            options=options,
            correct=[word.ref],
            context=self._context(word.passage, word, word),
            natural_key=f"word_choice|word|{word.ref}",
        )

    def _recall(self, part: int, word: Word, variant: str) -> bool:
        if self._recall_excluded(word):
            return self._choice_word(part, word)
        return self._add(
            type_="word_recall",
            variant=variant,
            parts=[part],
            token_refs=[word.ref],
            options=None,
            correct=[word.ref],
            context=self._context(word.passage, word, word),
            natural_key=f"word_recall|{variant}|{word.ref}",
        )

    def _segment(self, part: int, words: list[Word]) -> None:
        length = min(4, len(words))
        if length < 2:
            return
        correct = tuple(words[:length])
        first, last = correct[0], correct[-1]
        key = window_key(self.words[first.passage], first.pos, length)
        correct_n = tuple(w.n for w in correct)
        if len(self._segment_index(length)[key]) != 1:
            self.skipped.append({"kind": "segment_ambiguous", "ref": first.ref})
            return
        correct_refs = {w.ref for w in correct}
        picked: list[tuple[Word, ...]] = []
        seen = {correct_n}
        section = self.section_of_passage[first.passage]
        for pool in (self._windows_of(section, length), self._windows_of(None, length)):
            candidates = sorted(
                (
                    window
                    for window in pool
                    if not correct_refs & {w.ref for w in window}
                    and tuple(w.n for w in window) not in seen
                ),
                key=lambda window: _digest(first.ref, window[0].ref),
            )
            for window in candidates:
                n_tuple = tuple(w.n for w in window)
                if n_tuple in seen:
                    continue
                picked.append(window)
                seen.add(n_tuple)
                if len(picked) == 2:
                    break
            if len(picked) == 2:
                break
        if len(picked) < 2:
            self.skipped.append({"kind": "segment_few_distractors", "ref": first.ref})
            return
        options = sorted(
            [[w.ref for w in correct], *[[w.ref for w in window] for window in picked]],
            key=_ref_sort,
        )
        self._add(
            type_="word_choice",
            variant="segment",
            parts=[part],
            token_refs=[w.ref for w in correct],
            options=options,
            correct=[w.ref for w in correct],
            context=self._context(first.passage, first, last),
            natural_key=f"word_choice|segment|{first.ref}",
        )

    def _part_questions(self, part: int, first_of_passage: bool) -> None:
        words = self.part_words[part]
        if not words:
            return
        ranked = sorted(
            (w for w in words if w.n not in STOPLIST and len(w.n) >= 2),
            key=lambda w: (-len(w.n), w.pos),
        ) or sorted(words, key=lambda w: (-len(w.n), w.pos))
        used: set[str] = set()
        for word in ranked:  # recall, keyword
            if self._unambiguous(word):
                self._recall(part, word, "keyword")
                used.add(word.ref)
                break
        if not first_of_passage and words[0].ref not in used and self._unambiguous(words[0]):
            self._recall(part, words[0], "continuation")  # may become a choice (exclusions)
            used.add(words[0].ref)
        for word in ranked:  # choice, next keyword
            if word.ref not in used and self._unambiguous(word):
                if self._choice_word(part, word):
                    used.add(word.ref)
                    break
        if not first_of_passage:
            self._segment(part, words)

    def _order_questions(self, part_ids: Sequence[int]) -> None:
        i = 0
        while i < len(part_ids):
            part = part_ids[i]
            count = len(self.part_words[part])
            group = [part]
            if count < 3:
                if i + 1 < len(part_ids) and len(self.part_words[part_ids[i + 1]]) < 4:
                    group.append(part_ids[i + 1])
                i += len(group)
                if sum(len(self.part_words[p]) for p in group) < 3:
                    continue
            else:
                i += 1
            words = [w for p in group for w in self.part_words[p]]
            refs = [w.ref for w in words]
            self._add(
                type_="word_order",
                variant=None,
                parts=group,
                token_refs=refs,
                options=None,
                correct=refs,
                context=[],
                natural_key="word_order|" + "+".join(self.part_key(p) for p in group),
            )

    def _grade_phrases(self) -> dict[tuple[str, ...], list[Word]]:
        phrases: dict[tuple[str, ...], list[Word]] = {}
        for p_index, passage in enumerate(self.index.passages):
            if passage["path"] == "grade":
                words = self.words[p_index]
                phrases.setdefault(tuple(w.n for w in words), words)
        return phrases

    def _grade_question(self, p_index: int, part_ids: Sequence[int]) -> None:
        words = self.words[p_index]
        phrases = self._grade_phrases()
        key = tuple(w.n for w in words)
        others = [phrase for k, phrase in phrases.items() if k != key]
        if not others:
            self.skipped.append(
                {"kind": "grade_needs_two_phrases", "ref": self.index.passages[p_index]["id"]}
            )
            return
        others.sort(key=lambda phrase: _digest(self.index.passages[p_index]["id"], phrase[0].ref))
        options = sorted(
            [[w.ref for w in words], *[[w.ref for w in phrase] for phrase in others[:3]]],
            key=_ref_sort,
        )
        variant = "word" if all(len(option) == 1 for option in options) else "segment"
        self._add(
            type_="word_choice",
            variant=variant,
            parts=list(part_ids),
            token_refs=[w.ref for w in words],
            options=options,
            correct=[w.ref for w in words],
            context=[],
            natural_key=f"word_choice|{variant}|grade:{self.index.passages[p_index]['ordinal']}",
        )

    def _similar_questions(self) -> None:
        eligible = [
            part
            for part, words in enumerate(self.part_words)
            if len(words) >= 3
            and self.index.passages[self.index.part_passage[part]]["path"] != "grade"
        ]
        seqs = {part: tuple(w.n for w in self.part_words[part]) for part in eligible}
        trigram_parts: dict[tuple[str, ...], set[int]] = defaultdict(set)
        word_parts: dict[str, set[int]] = defaultdict(set)
        for part, seq in seqs.items():
            for start in range(len(seq) - 2):
                trigram_parts[seq[start : start + 3]].add(part)
            for n in set(seq):
                word_parts[n].add(part)
        for part in eligible:
            seq = seqs[part]
            counts = Counter(seq)
            shared_trigram: set[int] = set()
            for start in range(len(seq) - 2):
                shared_trigram |= trigram_parts[seq[start : start + 3]]
            overlap: Counter[int] = Counter()
            for n, count in counts.items():
                for other in word_parts[n]:
                    if other != part:
                        overlap[other] += min(count, seqs[other].count(n))
            candidates = {o for o in shared_trigram if o != part} | {
                o for o, shared in overlap.items() if shared * 10 >= 6 * max(len(seq), len(seqs[o]))
            }
            ranked: list[tuple[float, int, difflib.SequenceMatcher[str]]] = []
            for other in candidates:
                if seqs[other] == seq:
                    continue
                matcher = difflib.SequenceMatcher(None, seq, seqs[other], autojunk=False)
                matched = sum(block.size for block in matcher.get_matching_blocks())
                ratio = matched / max(len(seq), len(seqs[other]))
                if other in shared_trigram or ratio >= 0.6:
                    ranked.append((-ratio, other, matcher))
            ranked.sort(key=lambda item: (item[0], item[1]))
            for _ratio, other, matcher in ranked:
                if self._similar_for(part, other, matcher):
                    break

    def _similar_for(self, part: int, other: int, matcher: difflib.SequenceMatcher[str]) -> bool:
        ops = matcher.get_opcodes()
        for k, (tag, i1, i2, j1, j2) in enumerate(ops):
            if tag != "replace" or i2 - i1 != 1 or j2 - j1 != 1:
                continue
            neighbours = [ops[k - 1]] if k > 0 else []
            neighbours += [ops[k + 1]] if k + 1 < len(ops) else []
            if not any(t == "equal" and a2 - a1 >= 2 for t, a1, a2, _b1, _b2 in neighbours):
                continue
            mine, theirs = self.part_words[part][i1], self.part_words[other][j1]
            if not _alt_differs(mine, theirs):
                continue
            return self._add(
                type_="similar_distinction",
                variant=None,
                parts=[part],
                token_refs=[mine.ref],
                options=sorted([[mine.ref], [theirs.ref]], key=_ref_sort),
                correct=[mine.ref],
                context=self._context(mine.passage, mine, mine),
                natural_key=f"similar_distinction|{mine.ref}|{theirs.ref}",
            )
        return False

    # --- driver -------------------------------------------------------------------------

    def build(self) -> BankResult:
        for p_index, passage in enumerate(self.index.passages):
            part_ids = [self.index.part_by_id[p["id"]] for p in passage["parts"]]
            if passage["path"] == "grade":
                self._grade_question(p_index, part_ids)
            else:
                for position, part in enumerate(part_ids):
                    self._part_questions(part, position == 0)
            self._order_questions(part_ids)
        self._similar_questions()
        ordered = sorted(self.questions.values(), key=lambda q: q["_sort"])
        questions = [{k: v for k, v in q.items() if k != "_sort"} for q in ordered]
        return BankResult(build_lessons(self.bundle), questions, self.skipped)


def _ref_sort(refs: Sequence[str]) -> tuple[int, int]:
    unit, _, index = refs[0].partition(":")
    return int(unit), int(index)


def build_question_bank(bundle: Mapping[str, Any]) -> BankResult:
    """Build the lessons and the question bank of a segmented bundle (deterministic)."""
    return _Builder(bundle).build()
