"""Pure policy of the plan conversation (Plan-conversation.md §2.4; no framework imports).

- ``classify_request``: the input guard (religious / out_of_scope / logistics), from a reviewed
  keyword and pattern list in Arabic and English. It runs before any model call and again,
  through ``guard_reply``, on the model's reply.
- ``apply_quick_reply``: rules-only parameter patches.
- ``validate_parameters`` and ``merge_model_parameters``: validation against the catalog.
- ``caps_allow``: the model-call caps of NFR-18.
- ``guard_reply`` / ``sanitize_reply``: the output guard (length, classifier, numbers).
- ``find_disallowed_keys``: the outbound payload allowlist of R27 / NFR-17.

The guard is deliberately conservative: a false positive costs the learner a fixed message and a
rephrase; a false negative could show generated religious content.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal, Protocol

from app.contracts_plan_chat import (
    PATH_ORDER,
    SESSION_MINUTES_OPTIONS,
    CatalogEdition,
    Estimate,
    PlanParameters,
    PlanProposal,
    QuickReplyCode,
    ReasonCode,
    TargetScope,
)
from app.domain import plan_chat_templates as templates

Classification = Literal["religious", "out_of_scope", "logistics"]

MAX_REPLY_CHARS = 600
MAX_SECTION_ORDINALS = 60  # A-12 configuration (API-spec amendment: raised from 40 to 60)
PROMPT_VERSION = "plan-chat-v2"

# --- text normalization ---

_AR_MARKS = re.compile("[ؐ-ًؚ-ٰٟۖ-ۭـ]")
_AR_MAP = str.maketrans(
    {
        "أ": "ا",
        "إ": "ا",
        "آ": "ا",
        "ٱ": "ا",
        "ى": "ي",
        "ئ": "ي",
        "ة": "ه",
        "ؤ": "و",
    }
)
_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_TOKEN = re.compile(r"[a-z0-9']+|[ء-ي]+")


def _words(text: str) -> frozenset[str]:
    return frozenset(text.split())


def normalize_for_matching(text: str) -> str:
    """NFKC, case-folded, Arabic marks and tatweel removed, letter variants merged, ASCII digits."""
    value = unicodedata.normalize("NFKC", text).casefold().translate(_DIGITS)
    value = _AR_MARKS.sub("", value)
    return value.translate(_AR_MAP)


def _arabic_candidates(token: str) -> set[str]:
    """The token and its forms without the common attached prefixes (و ف ب ك ل ال لل)."""
    results = {token}
    for first in ("", "و", "ف"):
        if first and not token.startswith(first):
            continue
        rest = token[len(first) :]
        results.add(rest)
        if rest.startswith("لل"):
            results.add(rest[2:])
        for prep in ("ب", "ك", "ل"):
            if rest.startswith(prep):
                results.add(rest[1:])
                if rest[1:].startswith("ال"):
                    results.add(rest[3:])
        if rest.startswith("ال"):
            results.add(rest[2:])
    return {item for item in results if len(item) >= 2}


# --- the reviewed word lists (normalized forms) ---

_RELIGIOUS_AR = _words(
    "اثم احكام استنباط استنبط اعراب اعرب افتني افتونا افتوني بدعه تاويل تجويد ترجم ترجمات "
    "ترجمه تفاسير تفسير تلاوتي جايز حرام حكم حلال شرعا شرعي شريعه عقيده فتاوي فتواه فتوي فسر "
    "فسره فسرها فقه فقهي محرم مكروه منسوخ ناسخ يجوز يحرم"
)
# Soft triggers: religious unless the text is clearly about the plan itself.
_SOFT_AR = _words("اشرح شرح شروح معاني معناه معناها معني")
_RELIGIOUS_EN = _words(
    "abrogated bidaah bidah exegesis fatawa fatwa fatwas fiqh forbidden halal haram "
    "impermissible interpret interpretation interpretations interprets makruh mustahab naskh "
    "permissible ruling rulings sharia shariah sinful tafseer tafsiir tafsir tajweed tajwid "
    "translate translated translation translations wajib"
)
_SOFT_EN = _words("explain explains explanation explanations meaning meanings")

_RELIGIOUS_PATTERNS = [
    re.compile(p)
    for p in (
        r"(?:ماذا|ما|وش|ايش)\s+(?:يعني|تعني|معني)",
        r"يعني\s+(?:ايش|ايه|وش)",
        r"ما\s+(?:المقصود|المراد)",
        r"سبب\s+نزول|اسباب\s+النزول",
        r"هل\s+(?:(?:هو|هذا|هذه)\s+)?(?:(?:الحديث|الاثر)\s+)?(?:صحيح|ضعيف|ثابت|حسن|موضوع)",
        r"هل\s+يصح",
        r"ما\s+الدليل",
        r"\bis (?:it|this|that)\b.*\b(?:allowed|permitted|lawful|a sin|prohibited|obligatory)\b",
        r"\bislamic (?:law|ruling|view|position)\b",
        r"\bwhat does (?:islam|the quran|the hadith|allah)\b.*\bsay\b",
        r"\b(?:reason|context|occasion) (?:for|of) (?:the )?revelation\b",
        r"\basbab\b|\bi'?rab\b|\bgrammatical analysis\b",
        r"\b(?:hadith|narration)\b.*\b(?:authentic|authenticity|sahih|daif|da'if|fabricated|mawdu)",
        r"\b(?:authentic|authenticity|sahih|daif|da'if|fabricated|mawdu)\w*\b.*\b(?:hadith|narration)\b",
        r"\btell me (?:more )?about (?:islam|allah|the prophet|the quran|the hadith)\b",
        r"\b(?:who|what) (?:is|was|were) (?:allah|the prophet|muhammad)\b",
        r"\b(?:verse|verses|ayah|ayat|quran|qur'an)\b.*\bmeans?\b",
    )
]
_SOFT_PATTERNS = [re.compile(r"\bwhat (?:does|do|is)\b.*\bmeans?\b")]

_PLAN_OBJECT_AR = _words("الاقتراح التقدير المراجعات جدول خطتك خطتي خطه مراجعات")
_PLAN_OBJECT_EN = _words("estimate plan plans proposal reviews rhythm schedule timeline")
_SOURCE_WORDS = _words("aya ayah ayat koran qur'an quran verse verses ايات ايه قران")

_INJECTION_PATTERNS = [
    re.compile(p)
    for p in (
        r"\b(?:ignore|disregard|forget)\b.*\b(?:previous|above|prior|earlier|all)\b.*"
        r"\b(?:instructions?|rules?|prompts?)\b",
        r"\b(?:system|developer|hidden) (?:prompt|message|instructions?)\b",
        r"\b(?:reveal|show|print|repeat) (?:your|the) (?:prompt|instructions?|rules)\b",
        r"\bjailbreak\b|\bdan mode\b|\bdeveloper mode\b",
        r"\b(?:you are now|act as|pretend to be|roleplay)\b",
        r"تجاهل\s+(?:كل\s+)?(?:التعليمات|ما\s+سبق|الاوامر|القواعد)",
        r"(?:اكشف|اظهر|اعرض)\s+(?:لي\s+)?(?:التعليمات|البرومبت)",
        r"انت\s+الان|تصرف\s+(?:ك|كانك)|تظاهر",
    )
]
_OFFTOPIC_PATTERNS = [
    re.compile(p)
    for p in (
        r"\b(?:write|compose|make) (?:me )?(?:a |an )?(?:poem|story|essay|song|joke|code|program|"
        r"script|email|letter)\b",
        r"\b(?:recipe|weather|football|soccer|stock|bitcoin|crypto|movie|politic\w*|election)\b",
        r"\b(?:python|javascript|sql|java)\b",
        r"اكتب\s+(?:لي\s+)?(?:قصيده|قصه|مقال|كود|برنامج|رساله|نكته)",
        r"\b(?:وصفه|طقس|كره\s+القدم|انتخابات|سياسه)\b",
    )
]

_LOGISTICS_AR = _words(
    "ابدء ابدأ ابدا ابطا اتعلم اجزاء احاديث احفظ احفظه اختبار اربعين اسابيع اسبوع اسبوعيا "
    "اسرع اشهر اطول اعتماد اعتمد اقسام اقصر اقل اكثر اكد اكمل السلام اليوم انتهاء انهاء انهي "
    "اهداف اهلا اوقات ايام بدل بكره تاريخ تاكيد تخريج ترتيب تعديل تعلم تقدم تكرار تمام جدول "
    "جزء حديث حسنا حفظ خطتك خطتي خطط خطه خفف درجه دقايق دقيقه راجع رمضان زود ساعات ساعه سلام "
    "سند سنه سنوات سور سوره شكرا شهر شهور طيب عدل عكس عكسي عم غدا غير قسم قلل كتاب كلمات كلمه "
    "كمل لا متن مراجعات مراجعه مراحل مرحبا مرحله معكوس مقاطع مقطع مواعيد موافق موعد ميعاد "
    "نسخه نطاق نعم نووي نوويه هدف وافق وسع وقت يوم يومي يوميا"
)
_LOGISTICS_EN = _words(
    "accept adjust all amma approve backward backwards begin bigger book change complete "
    "completion confirm daily date day days deadline earlier easier edit edition everything "
    "faster fewer fine finish first forty forward goal good grade great hadith hadiths half "
    "harder hello hey hi hour hours isnad juz juzz larger later learn less lighter longer "
    "matn memorisation memorise memorization memorize min mins minute minutes modify month "
    "months more nawawi next no ok okay only order pace part parts passage passages path "
    "paths plan plans please quicker quickly ramadan repeat reverse review reviews revise "
    "revision salam sanad save schedule scope section sections session sessions shorter "
    "slower slowly smaller sooner speed start sura surah surahs sure takhrij target thank "
    "thanks time today tomorrow update week weekly weeks word words year years yes"
)


def _tokens(normalized: str) -> list[str]:
    return _TOKEN.findall(normalized)


def _has(tokens: Iterable[str], vocabulary: set[str]) -> bool:
    for token in tokens:
        if token in vocabulary:
            return True
        if token[:1] and "ء" <= token[0] <= "ي":
            if _arabic_candidates(token) & vocabulary:
                return True
    return False


def _soft_religious(tokens: list[str], normalized: str) -> bool:
    """Explain/meaning words: religious unless they point straight at the plan itself.

    A token trigger is excused only when a plan word (plan, schedule, خطة ...) follows within
    three tokens; a ``what does ... mean`` pattern is excused when the text names the plan and
    no Quran source word.
    """
    plan_words = _PLAN_OBJECT_AR | _PLAN_OBJECT_EN
    for index, token in enumerate(tokens):
        if _has([token], _SOFT_AR | _SOFT_EN):
            if not _has(tokens[index + 1 : index + 4], plan_words):
                return True
    if any(p.search(normalized) for p in _SOFT_PATTERNS):
        return not _has(tokens, plan_words) or _has(tokens, _SOURCE_WORDS)
    return False


def classify_request(text: str, language: str) -> Classification:
    """Classify a learner message. Both languages' lists always apply (mixed text is common);
    ``language`` is accepted for the contract and does not narrow the lists.

    Order: religious (fatwa, ruling, explanation, meaning, translation, authenticity,
    recitation) > prompt injection or off-topic > no plan vocabulary at all (out of scope) >
    logistics.
    """
    del language
    normalized = normalize_for_matching(text)
    tokens = _tokens(normalized)
    hard = _has(tokens, _RELIGIOUS_AR | _RELIGIOUS_EN) or any(
        p.search(normalized) for p in _RELIGIOUS_PATTERNS
    )
    if hard:
        return "religious"
    if _soft_religious(tokens, normalized):
        return "religious"
    if any(p.search(normalized) for p in _INJECTION_PATTERNS) or any(
        p.search(normalized) for p in _OFFTOPIC_PATTERNS
    ):
        return "out_of_scope"
    if _has(tokens, _LOGISTICS_AR | _LOGISTICS_EN):
        return "logistics"
    return "out_of_scope"


# --- plan order, scope and dates ---


def in_plan_order(ordinals: Iterable[int], order: str) -> list[int]:
    """Ordinals in plan order: ascending for ``book``, descending for ``reverse``."""
    return sorted(set(ordinals), reverse=(order == "reverse"))


def halve_scope(ordinals: Iterable[int], order: str) -> list[int]:
    """The first ``ceil(n / 2)`` sections in plan order, returned ascending (stored order).

    A single section cannot be halved and is returned unchanged. B4's alternative (b) of the
    estimate must use this function so that the "smaller scope" quick reply matches it.
    """
    ordered = in_plan_order(ordinals, order)
    if len(ordered) < 2:
        return sorted(ordered)
    return sorted(ordered[: math.ceil(len(ordered) / 2)])


def derive_reason_code(end_date: date, preferred_date: date | None) -> ReasonCode:
    if preferred_date is None:
        return "no_preferred_date"
    return "fits_preferred_date" if end_date <= preferred_date else "exceeds_preferred_date"


def shift_preferred_date(today: date, preferred: date | None, estimate_days: int) -> date:
    """+25 % of the horizon, at least one day later. The horizon is the time to the preferred
    date, or the estimate's days when there is no date."""
    horizon = (preferred - today).days if preferred else estimate_days
    horizon = max(horizon, 1)
    added = max(math.ceil(horizon * 1.25), horizon + 1)
    return today + timedelta(days=added)


# --- validation ---


@dataclass(frozen=True, slots=True)
class FieldError:
    field: str
    rule: str


def validate_parameters(
    params: PlanParameters, edition: CatalogEdition, today: date
) -> list[FieldError]:
    """Check every parameter against the catalog and the rules (API-spec §4.5 rule names)."""
    errors: list[FieldError] = []
    ordinals = list(params.target_scope.section_ordinals)
    known = {section.ordinal for section in edition.sections}
    if (
        not ordinals
        or len(ordinals) > MAX_SECTION_ORDINALS
        or len(set(ordinals)) != len(ordinals)
        or not set(ordinals) <= known
    ):
        errors.append(FieldError("targetScope", "scope_invalid"))

    paths = list(params.paths)
    if (
        not paths
        or len(set(paths)) != len(paths)
        or not set(paths) <= set(PATH_ORDER)
        or not set(paths) <= set(edition.available_paths)
    ):
        # Plan-conversation §2.9 item 3: the E15-E17 rule name covers "not available" too.
        errors.append(FieldError("paths", "paths_invalid"))

    if params.order not in ("book", "reverse"):
        errors.append(FieldError("order", "order_invalid"))
    elif params.order == "reverse" and edition.content_format != "quran":
        errors.append(FieldError("order", "order_not_available"))

    if params.session_minutes not in SESSION_MINUTES_OPTIONS:
        errors.append(FieldError("sessionMinutes", "session_minutes_invalid"))

    if params.preferred_date is not None and params.preferred_date < today:
        errors.append(FieldError("preferredDate", "date_invalid"))
    return errors


_PATCH_FIELDS = {
    "targetScope": "target_scope",
    "paths": "paths",
    "order": "order",
    "sessionMinutes": "session_minutes",
    "preferredDate": "preferred_date",
}


@dataclass(frozen=True, slots=True)
class MergeResult:
    params: PlanParameters
    accepted: tuple[str, ...]
    rejected: tuple[str, ...]


def merge_model_parameters(
    current: PlanParameters,
    patch: dict[str, Any],
    edition: CatalogEdition,
    today: date,
    *,
    scope_locked: bool = False,
) -> MergeResult:
    """Apply a model patch field by field. A field that fails validation (or targets a locked
    scope) is ignored and reported in ``rejected``; valid fields are applied. Only the five
    known fields are read; anything else is dropped silently."""
    params = current
    accepted: list[str] = []
    rejected: list[str] = []
    for name, attribute in _PATCH_FIELDS.items():
        if patch.get(name) is None:  # absent or null: unchanged
            continue
        value = patch[name]
        if name == "targetScope":
            if scope_locked:
                rejected.append(name)
                continue
            if isinstance(value, dict):
                value = TargetScope(section_ordinals=_clean_ints(value.get("sectionOrdinals")))
            else:
                rejected.append(name)
                continue
            value = TargetScope(section_ordinals=sorted(set(value.section_ordinals)))
        elif name == "paths":
            value = _ordered_paths(value)
        elif name == "sessionMinutes":
            value = value if isinstance(value, int) and not isinstance(value, bool) else -1
        elif name == "preferredDate":
            if isinstance(value, str) and value.strip().lower() == "none":
                value = None  # the model's way to remove the date
            else:
                try:
                    value = value if isinstance(value, date) else date.fromisoformat(str(value))
                except ValueError:
                    rejected.append(name)
                    continue
        elif name == "order":
            value = str(value)
        candidate = params.model_copy(update={attribute: value})
        if any(error.field == name for error in validate_parameters(candidate, edition, today)):
            rejected.append(name)
            continue
        if candidate != params:
            accepted.append(name)
        params = candidate
    return MergeResult(params, tuple(accepted), tuple(rejected))


def _clean_ints(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, int) and not isinstance(item, bool)]


def _ordered_paths(value: Any) -> list[str]:
    if not isinstance(value, list):
        return ["?"]
    names = [str(item) for item in value]
    return sorted(names, key=lambda n: PATH_ORDER.index(n) if n in PATH_ORDER else 99)


# --- quick replies ---


@dataclass(frozen=True, slots=True)
class QuickReplyResult:
    """The patched parameters and, when nothing changed, a note code for the templated reply."""

    params: PlanParameters
    note: str | None = None

    def changed_from(self, before: PlanParameters) -> bool:
        return self.params != before


def apply_quick_reply(
    code: str,
    params: PlanParameters,
    edition: CatalogEdition,
    *,
    today: date,
    estimate_days: int | None = None,
    scope_locked: bool = False,
) -> QuickReplyResult:
    """Rules-only parameter patch for each ``QuickReplyCode`` except ``confirm`` (which only
    returns the parameters unchanged: the client calls E34)."""
    if code == "fewer_minutes":
        lower = [m for m in SESSION_MINUTES_OPTIONS if m < params.session_minutes]
        if not lower:
            return QuickReplyResult(params, "minutes_min")
        return QuickReplyResult(params.model_copy(update={"session_minutes": lower[-1]}))
    if code == "more_minutes":
        higher = [m for m in SESSION_MINUTES_OPTIONS if m > params.session_minutes]
        if not higher:
            return QuickReplyResult(params, "minutes_max")
        return QuickReplyResult(params.model_copy(update={"session_minutes": higher[0]}))
    if code == "smaller_scope":
        if scope_locked:
            return QuickReplyResult(params, "scope_locked")
        ordinals = params.target_scope.section_ordinals
        smaller = halve_scope(ordinals, params.order)
        if len(smaller) == len(set(ordinals)):
            return QuickReplyResult(params, "scope_min")
        return QuickReplyResult(
            params.model_copy(update={"target_scope": TargetScope(section_ordinals=smaller)})
        )
    if code == "later_date":
        horizon = estimate_days if estimate_days is not None else 1
        moved = shift_preferred_date(today, params.preferred_date, horizon)
        return QuickReplyResult(params.model_copy(update={"preferred_date": moved}))
    if code == "no_date":
        if params.preferred_date is None:
            return QuickReplyResult(params, "already_set")
        return QuickReplyResult(params.model_copy(update={"preferred_date": None}))
    if code in ("order_book", "order_reverse"):
        target = "book" if code == "order_book" else "reverse"
        if target == "reverse" and edition.content_format != "quran":
            return QuickReplyResult(params, "order_not_available")
        if params.order == target:
            return QuickReplyResult(params, "already_set")
        return QuickReplyResult(params.model_copy(update={"order": target}))
    if code == "paths_matn_only":
        if "matn" not in edition.available_paths:
            return QuickReplyResult(params, "paths_not_available")
        if list(params.paths) == ["matn"]:
            return QuickReplyResult(params, "already_set")
        return QuickReplyResult(params.model_copy(update={"paths": ["matn"]}))
    if code == "paths_all":
        everything = [p for p in PATH_ORDER if p in edition.available_paths]
        if edition.content_format != "hadith_collection":
            return QuickReplyResult(params, "paths_not_available")
        if list(params.paths) == everything:
            return QuickReplyResult(params, "already_set")
        return QuickReplyResult(params.model_copy(update={"paths": everything}))
    return QuickReplyResult(params)  # confirm


def available_quick_replies(
    params: PlanParameters,
    edition: CatalogEdition,
    reason_code: str,
    *,
    scope_locked: bool = False,
) -> list[QuickReplyCode]:
    """The quick replies that would change something, in fixed order; ``confirm`` is last."""
    codes: list[QuickReplyCode] = []
    if params.session_minutes > SESSION_MINUTES_OPTIONS[0]:
        codes.append("fewer_minutes")
    if params.session_minutes < SESSION_MINUTES_OPTIONS[-1]:
        codes.append("more_minutes")
    if not scope_locked and len(set(params.target_scope.section_ordinals)) > 1:
        codes.append("smaller_scope")
    if params.preferred_date is not None:
        if reason_code == "exceeds_preferred_date":
            codes.append("later_date")
        codes.append("no_date")
    if edition.content_format == "quran":
        codes.append("order_book" if params.order == "reverse" else "order_reverse")
    else:
        everything = [p for p in PATH_ORDER if p in edition.available_paths]
        if "matn" in everything and list(params.paths) != ["matn"]:
            codes.append("paths_matn_only")
        if list(params.paths) != everything and len(everything) > 1:
            codes.append("paths_all")
    codes.append("confirm")
    return codes


# --- caps ---


class ChatCapSettings(Protocol):
    QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY: int
    QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE: int
    QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY: int
    QATRA_CHAT_MODEL_TURNS_PER_CHAT: int


@dataclass(frozen=True, slots=True)
class LedgerCounts:
    """Model requests counted so far: today and this minute for the whole deployment, today for
    the account, and the conversation's own ``model_turns``."""

    global_day: int = 0
    global_minute: int = 0
    account_day: int = 0
    chat_turns: int = 0


def cap_reason(counts: LedgerCounts, settings: ChatCapSettings) -> str | None:
    if counts.global_day >= settings.QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY:
        return "global_day"
    if counts.global_minute >= settings.QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE:
        return "global_minute"
    if counts.account_day >= settings.QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY:
        return "account_day"
    if counts.chat_turns >= settings.QATRA_CHAT_MODEL_TURNS_PER_CHAT:
        return "conversation"
    return None


def caps_allow(counts: LedgerCounts, settings: ChatCapSettings) -> bool:
    """True when one more model request fits under every cap (NFR-18)."""
    return cap_reason(counts, settings) is None


# --- the output guard ---


@dataclass(frozen=True, slots=True)
class GuardedReply:
    text: str
    ok: bool  # False: the model's text was replaced by the templated reply
    reason: str | None = None
    replaced_numbers: bool = field(default=False)


_NUMBER = re.compile(r"(?<![\w.])(\d+)(?![\w])")
_URL = re.compile(r"https?://|www\.|<[a-zA-Z/][^>]*>|```|\]\(")
_PRIVACY = re.compile(
    r"\b(?:password|passcode|username|e-?mail|phone number|address|device id|ip address)\b"
    r"|كلمه المرور|كلمة المرور|اسم المستخدم|البريد الالكتروني|رقم الهاتف|رقم الجوال"
)
# --- contact-detail redaction (D89): applied only to the outgoing model payload ---

REDACTION_TOKEN = "[redacted]"
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_LINK = re.compile(
    r"https?://\S+|www\.\S+"
    r"|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|io|app|me|ae|sa|info|co|dev|ly|gl|edu|gov)\b(?:/\S*)?",
    re.IGNORECASE,
)
_HANDLE = re.compile(r"(?<![\w@])@[A-Za-z0-9_.]{2,}")
# Digits with at most two separator characters between them (so ") " passes but " - " splits a
# date range); a candidate is a phone number only with 9+ digits (str.isdigit: Arabic-Indic too).
# Separators: whitespace, brackets, dots, ASCII hyphen, Unicode dashes U+2010-U+2015 (hyphen, en and
# em dash ...) and U+2212 (minus). "/" is deliberately absent so that dates stay readable.
_PHONE_CANDIDATE = re.compile(r"\+?\(?\d(?:[\s().\-\u2010-\u2015\u2212]{0,2}\d){6,}")
_MIN_PHONE_DIGITS = 9


def _redact_phone(match: re.Match[str]) -> str:
    candidate = match.group(0)
    if sum(1 for ch in candidate if ch.isdigit()) < _MIN_PHONE_DIGITS:
        return candidate
    return REDACTION_TOKEN


def redact_contact_details(text: str) -> str:
    """Replace emails, links, @handles and phone numbers (9+ digits) with ``REDACTION_TOKEN``.

    Pure. Text with nothing to redact is returned unchanged (D89). Dates such as 2026-10-20 and
    20/10/2026 have 8 digits and survive, as do plan numbers.
    """
    out = _EMAIL.sub(REDACTION_TOKEN, text)
    out = _LINK.sub(REDACTION_TOKEN, out)
    out = _HANDLE.sub(REDACTION_TOKEN, out)
    out = _PHONE_CANDIDATE.sub(_redact_phone, out)
    return text if out == text else out


_DAY_UNIT = re.compile(r"^\s*[-–]?\s*(?:days?\b|يوم|ايام|أيام|يوما|يومًا)")
_MINUTE_UNIT = re.compile(r"^\s*[-–]?\s*(?:minutes?\b|mins?\b|دقيق|دقائق|دقايق)")
_WORD_UNIT = re.compile(r"^\s*[-–]?\s*(?:words?\b|كلمة|كلمات)")
# D92: the daily amount in whole ayat or hadith. "حديث" also begins the dual and accusative forms
# the Arabic text may use (حديثان, حديثين, حديثًا); "أحاديث" is the plural.
_AYAH_UNIT = re.compile(r"^\s*[-–]?\s*(?:ayahs?\b|ayat\b|verses?\b|[آأا]ي[ةه]|[آأا]يات)")
_HADITH_UNIT = re.compile(r"^\s*[-–]?\s*(?:hadiths?\b|ahadith\b|حديث|[أا]حاديث)")


def _daily_new_numbers(estimate: Estimate) -> set[int]:
    """The number of the whole-unit daily amount (D92): ``perDay`` or ``everyDays``."""
    daily = estimate.daily_new
    if daily is None:
        return set()
    return {value for value in (daily.per_day, daily.every_days) if value is not None}


def _every_days(estimate: Estimate) -> set[int]:
    daily = estimate.daily_new
    return {daily.every_days} if daily is not None and daily.every_days is not None else set()


def _unit_count_matches(value: int, after: str, estimate: Estimate) -> bool:
    """Does ``value``, followed by ayat or hadith (``after``), match the daily amount (D92)? Only
    the proposal's own number for its own unit; "1 hadith" is also right when the amount is one
    hadith every N days."""
    daily = estimate.daily_new
    if daily is None or (_AYAH_UNIT.match(after) is not None) != (daily.unit == "ayah"):
        return False
    return value == (daily.per_day if daily.per_day is not None else 1)


@dataclass(frozen=True, slots=True)
class PlanLimits:
    """The fastest plan the rules allow (largest daily minutes), which the model may name."""

    session_minutes: int
    days: int
    end_date: date


def allowed_numbers(proposal: PlanProposal, limits: PlanLimits | None = None) -> set[int]:
    """Numbers the reply may mention: the proposal's own, the fixed options and the ladder, and
    the fastest plan's numbers when ``limits`` is given."""
    estimate = proposal.estimate
    numbers = {
        0,
        estimate.days,
        estimate.new_words_per_day,
        *_daily_new_numbers(estimate),
        estimate.total_words,
        estimate.known_words,
        estimate.passage_count,
        proposal.session_minutes,
        len(proposal.target_scope.section_ordinals),
        proposal.proposal_version,
        *SESSION_MINUTES_OPTIONS,
        12,
        25,
        40,
        *templates.REVIEW_LADDER_DAYS,
        *templates.REVIEW_LADDER_CUMULATIVE,
        *proposal.target_scope.section_ordinals,
    }
    dates = [estimate.end_date, proposal.preferred_date]
    if limits is not None:
        numbers.update({limits.days, limits.session_minutes})
        dates.append(limits.end_date)
    for value in dates:
        if value is not None:
            numbers.update({value.year, value.month, value.day})
    return numbers


def _truncate(text: str) -> str:
    if len(text) <= MAX_REPLY_CHARS:
        return text
    cut = text[:MAX_REPLY_CHARS]
    ends = [cut.rfind(mark) for mark in (".", "؟", "?", "!", "。", "؛")]
    best = max(ends)
    return cut[: best + 1] if best >= 120 else ""


def guard_reply(
    text: str, proposal: PlanProposal, language: str, limits: PlanLimits | None = None
) -> GuardedReply:
    """Output guard: the model's reply is shown only when it passes. Otherwise the templated
    reply (a restatement of the proposal) is returned with ``ok=False``. ``limits`` lets the
    reply name the fastest plan the rules allow (days, date, minutes)."""
    fallback = templates.templated_reply(proposal, language)
    cleaned = "".join(ch for ch in text if ch == "\n" or unicodedata.category(ch)[0] != "C").strip()
    cleaned = _truncate(cleaned)
    if not cleaned:
        return GuardedReply(fallback, False, "empty_or_too_long")
    if _URL.search(cleaned):
        return GuardedReply(fallback, False, "link_or_markup")
    if _PRIVACY.search(normalize_for_matching(cleaned)) or _PRIVACY.search(cleaned.casefold()):
        return GuardedReply(fallback, False, "personal_data")
    if classify_request(cleaned, language) == "religious":
        return GuardedReply(fallback, False, "religious")
    normalized = normalize_for_matching(cleaned)
    if any(p.search(normalized) for p in _INJECTION_PATTERNS + _OFFTOPIC_PATTERNS):
        return GuardedReply(fallback, False, "out_of_scope")

    digits_only = cleaned.translate(_DIGITS)
    allowed = allowed_numbers(proposal, limits)
    estimate = proposal.estimate
    allowed_days = {
        estimate.days,
        *templates.REVIEW_LADDER_DAYS,
        *templates.REVIEW_LADDER_CUMULATIVE,
        *_every_days(estimate),  # "a new hadith every 3 days" is a pace, not the length
    }
    if limits is not None:
        allowed_days.add(limits.days)
    pieces: list[str] = []
    last = 0
    replaced = False
    for match in _NUMBER.finditer(digits_only):
        value = int(match.group(1))
        after = digits_only[match.end() :]
        replacement: int | None = None
        if _DAY_UNIT.match(after):
            if value not in allowed_days:
                replacement = estimate.days
        elif _MINUTE_UNIT.match(after):
            if value not in SESSION_MINUTES_OPTIONS:
                replacement = proposal.session_minutes
        elif _WORD_UNIT.match(after):
            if value not in {
                estimate.new_words_per_day,
                estimate.total_words,
                estimate.known_words,
                12,
                25,
                40,
            }:
                return GuardedReply(fallback, False, "number_mismatch")
        elif _AYAH_UNIT.match(after) or _HADITH_UNIT.match(after):
            if not _unit_count_matches(value, after, estimate):
                return GuardedReply(fallback, False, "number_mismatch")
        elif value not in allowed:
            return GuardedReply(fallback, False, "number_mismatch")
        if replacement is not None:
            pieces.append(digits_only[last : match.start()])
            pieces.append(str(replacement))
            last = match.end()
            replaced = True
    pieces.append(digits_only[last:])
    result = "".join(pieces) if replaced else cleaned
    if replaced:
        # Re-check after substitution: every remaining number must now be allowed.
        for match in _NUMBER.finditer(result):
            if int(match.group(1)) not in allowed:
                return GuardedReply(fallback, False, "number_mismatch")
    return GuardedReply(result, True, None, replaced)


def sanitize_reply(
    text: str, proposal: PlanProposal, language: str, limits: PlanLimits | None = None
) -> str:
    """The text to show: the (possibly number-corrected) reply or the templated reply."""
    return guard_reply(text, proposal, language, limits).text


# --- outbound payload allowlist (R27, NFR-17) ---

ALLOWED_PAYLOAD_KEYS: frozenset[str] = _words(
    "activeMinutes assisted attempts author availablePaths contentFormat conversationId "
    "correct dailyTime date days edition endDate errorCount errorKind errorParts estimate "
    "knownWords language learningRecord messages newWordsPerDay order ordinal parameters "
    "passageCount passages passed paths placement preferredDate questionType reference "
    "reviewOutcomes role scope sectionOrdinals sections sessionMinutes state targetScope text "
    "title totalWords wordCount dailyNew everyDays perDay unit limits fastest sessionMinutesOptions"
)


def find_disallowed_keys(payload: Any, allowed: frozenset[str] = ALLOWED_PAYLOAD_KEYS) -> list[str]:
    """Every dictionary key anywhere in ``payload`` that is not on the allowlist (empty = ok)."""
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key not in allowed:
                    found.append(str(key))
                walk(value)
        elif isinstance(node, list | tuple):
            for item in node:
                walk(item)

    walk(payload)
    return found
