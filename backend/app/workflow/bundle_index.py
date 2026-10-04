"""Read-only index over a bundle (a plain dictionary): tokens by reference, passage and part
token sequences, words. Shared by the question builder and the validators, which treat the
bundle as data and trust nothing about how it was built."""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from app.workflow.passages import Tok

CONTEXT_WORDS: Final = 6  # words shown on each side of a blank, inside the passage


def parse_ref(ref: str) -> tuple[int, int] | None:
    """``"<unit ordinal>:<token index>"`` -> ``(unit, index)``, or ``None`` when malformed."""
    unit, sep, index = ref.partition(":")
    if not sep or not unit.isdecimal() or not index.isdecimal():
        return None
    return int(unit), int(index)


@dataclass(frozen=True, slots=True)
class Word:
    """A word token of a passage (position inside the passage's word list)."""

    ref: str
    unit: int
    index: int
    n: str
    a: str | None
    surface: str
    passage: int  # index of the passage in bundle["passages"]
    pos: int  # position among the passage's words
    part: int  # global index of the part


class BundleIndex:
    """Lookups over ``bundle`` (sections, units, passages, parts)."""

    def __init__(self, bundle: Mapping[str, Any]) -> None:
        self.bundle = bundle
        self.units: dict[int, Mapping[str, Any]] = {u["ordinal"]: u for u in bundle["units"]}
        self.passages: list[Mapping[str, Any]] = list(bundle["passages"])
        self.parts: list[Mapping[str, Any]] = []
        self.part_passage: list[int] = []
        self.part_by_id: dict[str, int] = {}
        for p_index, passage in enumerate(self.passages):
            for part in passage["parts"]:
                self.part_by_id[part["id"]] = len(self.parts)
                self.parts.append(part)
                self.part_passage.append(p_index)

    # tokens ---------------------------------------------------------------------------------

    def token(self, ref: str) -> Mapping[str, Any] | None:
        parsed = parse_ref(ref)
        if parsed is None:
            return None
        unit = self.units.get(parsed[0])
        if unit is None or parsed[1] >= len(unit["tokens"]):
            return None
        token = unit["tokens"][parsed[1]]
        return token if token["i"] == parsed[1] else None

    def surface(self, ref: str) -> str:
        parsed = parse_ref(ref)
        assert parsed is not None
        unit = self.units[parsed[0]]
        token = unit["tokens"][parsed[1]]
        return unit["canonicalText"][token["s"] : token["e"]]

    def range_tokens(self, start: str, end: str) -> list[Tok] | None:
        """Flat tokens from ``start`` to ``end`` inclusive across consecutive units, or ``None``
        when the range is not valid."""
        first, last = parse_ref(start), parse_ref(end)
        if first is None or last is None or self.token(start) is None or self.token(end) is None:
            return None
        if (first[0], first[1]) > (last[0], last[1]):
            return None
        result: list[Tok] = []
        for unit_ordinal in range(first[0], last[0] + 1):
            unit = self.units.get(unit_ordinal)
            if unit is None:
                return None
            low = first[1] if unit_ordinal == first[0] else 0
            high = last[1] if unit_ordinal == last[0] else len(unit["tokens"]) - 1
            text = unit["canonicalText"]
            for token in unit["tokens"][low : high + 1]:
                result.append(
                    Tok(
                        (unit_ordinal, token["i"]),
                        token["k"],
                        text[token["s"] : token["e"]],
                        token["n"],
                    )
                )
        return result

    def passage_tokens(self, passage_index: int) -> list[Tok]:
        passage = self.passages[passage_index]
        tokens = self.range_tokens(passage["startRef"], passage["endRef"])
        assert tokens is not None
        return tokens

    def token_alt(self, ref: str) -> str | None:
        token = self.token(ref)
        return None if token is None else token.get("a")

    # words ----------------------------------------------------------------------------------

    def passage_words(self, passage_index: int) -> list[Word]:
        """The word tokens of a passage, with the part each belongs to."""
        part_of: dict[tuple[int, int], int] = {}
        passage = self.passages[passage_index]
        for part in passage["parts"]:
            tokens = self.range_tokens(part["startRef"], part["endRef"]) or []
            for tok in tokens:
                part_of[tok.ref] = self.part_by_id[part["id"]]
        words: list[Word] = []
        for tok in self.passage_tokens(passage_index):
            if tok.kind != "word":
                continue
            unit_ordinal, index = tok.ref
            words.append(
                Word(
                    ref=f"{unit_ordinal}:{index}",
                    unit=unit_ordinal,
                    index=index,
                    n=tok.n,
                    a=self.units[unit_ordinal]["tokens"][index].get("a"),
                    surface=tok.surface,
                    passage=passage_index,
                    pos=len(words),
                    part=part_of.get(tok.ref, -1),
                )
            )
        return words

    def all_passage_words(self) -> Iterator[list[Word]]:
        for p_index in range(len(self.passages)):
            yield self.passage_words(p_index)


def window_key(
    words: Sequence[Word], start: int, length: int = 1
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """The normalized context a learner sees around the window ``words[start:start+length]``:
    up to 6 words before and after, inside the passage."""
    before = tuple(w.n for w in words[max(0, start - CONTEXT_WORDS) : start])
    after = tuple(w.n for w in words[start + length : start + length + CONTEXT_WORDS])
    return before, after
