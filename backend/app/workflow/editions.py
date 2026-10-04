"""Edition constants of the MVP (contract §2.1, D68) and scope parsing.

Numbers here are structural facts (ayah counts per surah, hadith numbers), not source text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final, Literal

from app.workflow.errors import InputError

EDITION_QURAN: Final = "quran-hafs-quranenc"
EDITION_HADITH: Final = "nawawi40-hadeethenc"
EDITION_KEYS: Final = (EDITION_QURAN, EDITION_HADITH)

MCP_SOURCE_URL: Final = "https://mcp.islamiccontent.org/"
MCP_ENDPOINT: Final = "https://mcp.islamiccontent.org/mcp"
MCP_HOST: Final = "mcp.islamiccontent.org"
PROVIDER: Final = "Association for Multilingual Islamic Content (Islamic Content MCP)"

TOOL_QURAN: Final = "get_quran_verses"
TOOL_HADITH: Final = "get_hadith"

QURAN_FIRST_SURAH: Final = 78
QURAN_LAST_SURAH: Final = 114
FORTY_COUNT: Final = 42

# Ayat per surah of Juz' Amma (Hafs numbering): 37 surahs, 564 ayat (contract §2.1).
QURAN_AYAH_COUNTS: Final[dict[int, int]] = {
    78: 40, 79: 46, 80: 42, 81: 29, 82: 19, 83: 36, 84: 25, 85: 22, 86: 17, 87: 19,
    88: 26, 89: 30, 90: 20, 91: 15, 92: 21, 93: 11, 94: 8, 95: 8, 96: 19, 97: 5,
    98: 8, 99: 8, 100: 11, 101: 11, 102: 8, 103: 3, 104: 9, 105: 5, 106: 4, 107: 7,
    108: 3, 109: 6, 110: 3, 111: 5, 112: 4, 113: 5, 114: 6,
}  # fmt: skip

_QURAN_URL_RE: Final = re.compile(r"^https://islamenc\.com/ar/quran/(\d{1,3})$")
_HADITH_URL_RE: Final = re.compile(r"^https://hadeethenc\.com/ar/browse/hadith/(\d{1,12})$")


def quran_url(surah: int) -> str:
    return f"https://islamenc.com/ar/quran/{surah}"


def hadith_url(hadeethenc_id: int) -> str:
    return f"https://hadeethenc.com/ar/browse/hadith/{hadeethenc_id}"


def quran_url_surah(url: str) -> int | None:
    """Surah number of a canonical QuranEnc URL, or ``None`` if the shape is wrong."""
    match = _QURAN_URL_RE.match(url)
    return int(match.group(1)) if match else None


def hadith_url_id(url: str) -> int | None:
    """HadeethEnc id of a canonical hadith URL, or ``None`` if the shape is wrong."""
    match = _HADITH_URL_RE.match(url)
    return int(match.group(1)) if match else None


@dataclass(frozen=True, slots=True)
class EditionSpec:
    key: str
    kind: Literal["quran", "hadith"]
    tool_name: str
    title: str


EDITIONS: Final[dict[str, EditionSpec]] = {
    EDITION_QURAN: EditionSpec(EDITION_QURAN, "quran", TOOL_QURAN, "QuranEnc"),
    EDITION_HADITH: EditionSpec(EDITION_HADITH, "hadith", TOOL_HADITH, "HadeethEnc"),
}


def edition_spec(edition_key: str) -> EditionSpec:
    try:
        return EDITIONS[edition_key]
    except KeyError:
        raise InputError(
            f"unknown edition key (expected one of {', '.join(EDITION_KEYS)})"
        ) from None


@dataclass(frozen=True, slots=True)
class EditionScope:
    """What a build covers. Full scope by default; a narrower scope makes a sample build."""

    surahs: tuple[int, ...] = ()
    forty_numbers: tuple[int, ...] = ()

    def to_dict(self) -> dict[str, list[int]]:
        return {"surahs": list(self.surahs), "fortyNumbers": list(self.forty_numbers)}

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> EditionScope:
        surahs = data.get("surahs", [])
        forty = data.get("fortyNumbers", [])
        if not isinstance(surahs, list) or not isinstance(forty, list):
            raise InputError("recorded scope is malformed")
        return cls(tuple(int(x) for x in surahs), tuple(int(x) for x in forty))

    def ayah_total(self) -> int:
        return sum(QURAN_AYAH_COUNTS[s] for s in self.surahs)


def default_scope(edition_key: str) -> EditionScope:
    spec = edition_spec(edition_key)
    if spec.kind == "quran":
        return EditionScope(surahs=tuple(range(QURAN_FIRST_SURAH, QURAN_LAST_SURAH + 1)))
    return EditionScope(forty_numbers=tuple(range(1, FORTY_COUNT + 1)))


def parse_number_spec(spec: str, *, low: int, high: int, label: str) -> tuple[int, ...]:
    """Parse ``"112"``, ``"78-114"`` or ``"1,3,5-7"`` into a sorted tuple within ``[low, high]``."""
    values: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            raise InputError(f"{label}: empty item in {spec!r}")
        if re.fullmatch(r"\d+", part):
            values.add(int(part))
        elif match := re.fullmatch(r"(\d+)-(\d+)", part):
            start, end = int(match.group(1)), int(match.group(2))
            if start > end:
                raise InputError(f"{label}: descending range {part!r}")
            values.update(range(start, end + 1))
        else:
            raise InputError(f"{label}: cannot parse {part!r}")
    if not values:
        raise InputError(f"{label}: no values")
    outside = sorted(v for v in values if not low <= v <= high)
    if outside:
        raise InputError(f"{label}: values outside {low}-{high}: {outside}")
    return tuple(sorted(values))
