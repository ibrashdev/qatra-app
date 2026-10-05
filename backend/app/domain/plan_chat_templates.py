"""Arabic and English templates of the plan conversation (pure; Plan-conversation.md §2.2-§2.6).

Every number that appears in a template comes from the rules engine's ``Estimate`` or from the
fixed review ladder (D66); no number comes from the model. Arabic strings marked "proposed" are
the coordinator's proposals awaiting the owner's wording review; English strings are proposed
renderings of the same lines. D26 is the owner's fixed Arabic text and is used verbatim for
both interface languages.

The composed sentence (``compose_goal_sentence``) is the text the start form pre-fills in the
«الهدف والموعد» box. The frontend MUST build the same sentence from the same template, because
the server recomputes it and skips the model when the learner's ``goalText`` equals it (R28).
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date

from app.contracts_plan_chat import (
    CatalogEdition,
    DailyNew,
    Estimate,
    PlanParameters,
    PlanProposal,
    PlanSections,
    QuickReply,
    QuickReplyCode,
)

Lang = str  # "ar" or "en"

# --- fixed texts ----------------------------------------------------------------------------------

D26_MESSAGE = (
    "نعتذر، التطبيق مخصص لحفظ الكتب كما هي ولا يقدم فتوى أو شرحًا. "
    "للفتوى أو الشرح يرجى مراجعة أهل العلم والاختصاص."
)

REDIRECT_LINES: dict[str, str] = {
    "ar": "يمكنني مساعدتك في خطة الحفظ فقط: المدة والوقت اليومي والنطاق والترتيب والمراجعات.",
    "en": (
        "I can only help with your memorization plan: duration, daily time, scope, order "
        "and reviews."
    ),
}

FALLBACK_LINES: dict[str, str] = {
    "ar": "المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.",
    "en": (
        "The assistant is not available right now; you can keep adjusting with the options below."
    ),
}

# §2.6, approved by the owner on 4 October 2026 («use best practice»); Arabic only.
TRANSPARENCY_LINE_AR = (
    "تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي يستقبل وصف هدفك وخيارات الخطة، "
    "وعند التعديل ملخص تعلمك وإجاباتك، تحت معرّف مؤقت لا يكشف حسابك؛ "
    "وتُحسب الأرقام بمحرك القواعد داخل التطبيق."
)

# Owner labels of the six sections, in display order (R24).
SECTION_LABELS: dict[str, dict[str, str]] = {
    "ar": {
        "goal": "الهدف الكلي",
        "totalTime": "الزمن الكلي",
        "dailyTime": "الزمن اليومي",
        "stages": "المراحل",
        "reviews": "المراجعات",
        "nextStep": "الخطوة التالية",
    },
    "en": {
        "goal": "Total goal",
        "totalTime": "Total time",
        "dailyTime": "Daily time",
        "stages": "Stages",
        "reviews": "Reviews",
        "nextStep": "Next step",
    },
}

QUICK_REPLY_LABELS: dict[str, tuple[str, str]] = {
    "fewer_minutes": ("وقت أقل يوميًا", "Less time per day"),
    "more_minutes": ("وقت أكثر يوميًا", "More time per day"),
    "smaller_scope": ("نطاق أصغر", "Smaller scope"),
    "later_date": ("موعد أبعد", "Later date"),
    "no_date": ("بدون موعد محدد", "No set date"),
    "order_book": ("ترتيب الكتاب", "Book order"),
    "order_reverse": ("الترتيب العكسي", "Reverse order"),
    "paths_matn_only": ("المتن فقط", "Matn only"),
    "paths_all": ("كل المسارات المتاحة", "All available paths"),
    "confirm": ("اعتماد الخطة", "Confirm the plan"),
}

# The review ladder of D66: intervals 1, 2 and 4 days (cumulative days 1, 3 and 7 on time).
REVIEW_LADDER_DAYS: tuple[int, ...] = (1, 2, 4)
REVIEW_LADDER_CUMULATIVE: tuple[int, ...] = (1, 3, 7)

_PATH_LABELS = {
    "ar": {"quran": "القرآن", "matn": "المتن", "sanad": "السند", "grade": "الدرجة"},
    "en": {"quran": "Quran", "matn": "matn", "sanad": "sanad", "grade": "grade"},
}


def quick_reply(code: QuickReplyCode) -> QuickReply:
    label_ar, label_en = QUICK_REPLY_LABELS[code]
    return QuickReply(code=code, label_ar=label_ar, label_en=label_en)


def quick_reply_label(code: str, language: Lang) -> str:
    label_ar, label_en = QUICK_REPLY_LABELS[code]
    return label_ar if language == "ar" else label_en


def refusal_text(language: Lang) -> str:
    """The fixed D26 message, verbatim, whatever the interface language."""
    del language
    return D26_MESSAGE


def redirect_text(language: Lang) -> str:
    return REDIRECT_LINES["ar" if language == "ar" else "en"]


# --- small renderers ------------------------------------------------------------------------------


def days_text(days: int, language: Lang) -> str:
    if language == "ar":
        if days <= 0:
            return "أقل من يوم"
        if days == 1:
            return "يوم واحد"
        if days == 2:
            return "يومان"
        if days <= 10:
            return f"{days} أيام"
        return f"{days} يومًا"
    if days <= 0:
        return "less than a day"
    return "1 day" if days == 1 else f"{days} days"


def _ar_every_days(days: int) -> str:
    if days == 1:
        return "كل يوم"
    if days == 2:
        return "كل يومين"
    return f"كل {days} أيام" if days <= 10 else f"كل {days} يومًا"


def _ar_new_units(unit: str, count: int) -> str:
    """Arabic number agreement of «N new ayat/hadith»: 1 and 2 take the singular and the dual with
    their adjective, 3 to 10 the plural, 11 and above the singular accusative (tamyiz)."""
    ayah = unit == "ayah"
    if count == 1:
        return "آية جديدة" if ayah else "حديث جديد"
    if count == 2:
        return "آيتان جديدتان" if ayah else "حديثان جديدان"
    if count <= 10:
        return f"{count} {'آيات' if ayah else 'أحاديث'} جديدة"
    return f"{count} {'آية جديدة' if ayah else 'حديثًا جديدًا'}"


def _daily_new_ar(daily: DailyNew) -> str:
    noun_one = "آية جديدة" if daily.unit == "ayah" else "حديث جديد"
    if daily.every_days is not None:
        return f"{noun_one} {_ar_every_days(daily.every_days)}"
    per_day = daily.per_day or 1
    if per_day == 1 and daily.unit == "hadith":
        return f"{noun_one} {_ar_every_days(1)}"
    if per_day <= 2:
        return f"{_ar_new_units(daily.unit, per_day)} في اليوم"
    return f"نحو {_ar_new_units(daily.unit, per_day)} في اليوم"


def _daily_new_en(daily: DailyNew) -> str:
    ayah = daily.unit == "ayah"
    if daily.every_days is not None:
        every = "every day" if daily.every_days == 1 else f"every {daily.every_days} days"
        return f"a new {'ayah' if ayah else 'hadith'} {every}"
    per_day = daily.per_day or 1
    if per_day == 1:
        return f"a new {'ayah' if ayah else 'hadith'} each day"
    noun = "ayat" if ayah else "hadiths"
    return f"{'about ' if per_day >= 3 else ''}{per_day} new {noun} each day"


def daily_new_text(estimate: Estimate, language: Lang) -> str | None:
    """The daily amount of new material in whole units (D90), as a clause that follows the daily
    time («نحو 3 آيات جديدة في اليوم», «a new hadith every 2 days»); ``None`` when the estimate
    carries no unit amount, and the caller then states the words figure."""
    daily = estimate.daily_new
    if daily is None:
        return None
    return _daily_new_ar(daily) if language == "ar" else _daily_new_en(daily)


def minutes_text(minutes: int, language: Lang) -> str:
    if language == "ar":
        return f"{minutes} دقائق" if minutes <= 10 else f"{minutes} دقيقة"
    return f"{minutes} minutes"


def _paths_text(paths: list[str], language: Lang) -> str:
    labels = _PATH_LABELS["ar" if language == "ar" else "en"]
    separator = "، " if language == "ar" else ", "
    return separator.join(labels.get(path, path) for path in paths)


def _ranges_text(ordinals: list[int], language: Lang) -> str:
    ordered = sorted(set(ordinals))
    if not ordered:
        return ""
    runs: list[tuple[int, int]] = []
    start = previous = ordered[0]
    for value in ordered[1:]:
        if value == previous + 1:
            previous = value
            continue
        runs.append((start, previous))
        start = previous = value
    runs.append((start, previous))
    separator = "، " if language == "ar" else ", "
    return separator.join(f"{a}–{b}" if a != b else str(a) for a, b in runs)


def covers_whole_edition(edition: CatalogEdition, ordinals: list[int]) -> bool:
    return set(ordinals) == {section.ordinal for section in edition.sections}


def scope_text(edition: CatalogEdition, ordinals: list[int], language: Lang) -> str:
    """The whole book, or ``surahs 78–85`` / ``الأحاديث 1–5`` (ordinals ascending, runs merged)."""
    if covers_whole_edition(edition, ordinals):
        return "كامل الكتاب" if language == "ar" else "the whole book"
    quran = edition.content_format == "quran"
    if language == "ar":
        noun = "السور" if quran else "الأحاديث"
    else:
        noun = "surahs" if quran else "hadiths"
    return f"{noun} {_ranges_text(ordinals, language)}"


def order_phrase(order: str, language: Lang) -> str:
    if language == "ar":
        return "بالترتيب العكسي (من آخر الكتاب إلى أوله)" if order == "reverse" else "بترتيب الكتاب"
    return (
        "in reverse order (from the end of the book to the start)"
        if order == "reverse"
        else ("in book order")
    )


def _title(edition: CatalogEdition, language: Lang) -> str:
    return edition.title_ar if language == "ar" else edition.title_en


# --- the composed goal sentence -------------------------------------------------------------------


def compose_goal_sentence(edition: CatalogEdition, params: PlanParameters, language: Lang) -> str:
    """The sentence the start form pre-fills (S-08). The frontend must produce the same text.

    Arabic: ``أريد حفظ «{titleAr}»{scope}{paths} بمعدل {minutes} يوميًا{date}.`` where ``minutes``
    is ``N دقائق`` (5, 10) or ``15 دقيقة``, ``scope`` is `` ({scope})`` and ``date`` is
    `` على أن أنهيه قبل YYYY-MM-DD``.

    English: ``I want to memorize "{titleEn}"{scope}{paths} at {N} minutes a day{date}.`` where
    ``date`` is ``, finishing by YYYY-MM-DD``.

    ``scope`` is omitted when every section is selected; otherwise ``السور``/``الأحاديث``
    (``surahs``/``hadiths``) followed by ascending ordinals with consecutive runs merged as
    ``a–b`` (an en dash), joined by ``، `` (``, ``). The paths clause (`` (المسارات: …)`` /
    `` (paths: …)``, labels joined the same way) appears for hadith editions only. Dates are ISO
    ``YYYY-MM-DD``; digits are ASCII.
    """
    ordinals = list(params.target_scope.section_ordinals)
    scope = ""
    if not covers_whole_edition(edition, ordinals):
        scope = f" ({scope_text(edition, ordinals, language)})"
    paths = ""
    if edition.content_format == "hadith_collection":
        label = "المسارات" if language == "ar" else "paths"
        paths = f" ({label}: {_paths_text(list(params.paths), language)})"
    iso = params.preferred_date.isoformat() if params.preferred_date else None
    if language == "ar":
        date_part = f" على أن أنهيه قبل {iso}" if iso else ""
        return (
            f"أريد حفظ «{_title(edition, language)}»{scope}{paths} "
            f"بمعدل {minutes_text(params.session_minutes, language)} يوميًا{date_part}."
        )
    date_part = f", finishing by {iso}" if iso else ""
    return (
        f'I want to memorize "{_title(edition, language)}"{scope}{paths} '
        f"at {params.session_minutes} minutes a day{date_part}."
    )


def normalize_sentence(text: str) -> str:
    """Comparison form: NFC, whitespace collapsed, ends trimmed."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip()


def goal_matches_composed(
    goal_text: str, edition: CatalogEdition, params: PlanParameters, language: Lang
) -> bool:
    """True when ``goal_text`` equals the composed sentence of the form's own selections."""
    composed = compose_goal_sentence(edition, params, language)
    return normalize_sentence(goal_text) == normalize_sentence(composed)


# --- the six sections -----------------------------------------------------------------------------


def _date_text(value: date) -> str:
    return value.isoformat()


def build_sections(
    estimate: Estimate,
    params: PlanParameters,
    edition: CatalogEdition,
    language: Lang,
    *,
    reason_code: str,
    revision: bool,
) -> PlanSections:
    """The six labelled sections as plain text, from the rules engine's numbers (R24)."""
    ar = language == "ar"
    ordinals = list(params.target_scope.section_ordinals)
    scope = scope_text(edition, ordinals, language)
    hadith = edition.content_format == "hadith_collection"
    days = days_text(estimate.days, language)
    minutes = minutes_text(estimate.session_minutes, language)
    end = _date_text(estimate.end_date)
    preferred = _date_text(params.preferred_date) if params.preferred_date else None

    # Goal.
    if ar:
        goal = f"الكتاب: «{edition.title_ar}». النطاق: {scope}."
        if hadith:
            goal += f" المسارات: {_paths_text(list(params.paths), language)}."
        goal += f" عدد الكلمات: {estimate.total_words}، وعدد المقاطع: {estimate.passage_count}."
        if estimate.known_words:
            goal += f" كلمات تعرفها من اختبار التحديد: {estimate.known_words}."
    else:
        goal = f'Book: "{edition.title_en}". Scope: {scope}.'
        if hadith:
            goal += f" Paths: {_paths_text(list(params.paths), language)}."
        goal += f" Words: {estimate.total_words}; passages: {estimate.passage_count}."
        if estimate.known_words:
            goal += f" Words you already know from the placement test: {estimate.known_words}."

    # Total time.
    if ar:
        total_time = f"نحو {days}؛ تاريخ الانتهاء المتوقع {end}."
        if reason_code == "fits_preferred_date" and preferred:
            total_time += f" هذا يناسب موعدك المفضل ({preferred})."
        elif reason_code == "exceeds_preferred_date" and preferred:
            total_time += (
                f" هذا بعد موعدك المفضل ({preferred}). يمكنك زيادة الوقت اليومي أو تصغير النطاق "
                "أو تأخير الموعد."
            )
    else:
        total_time = f"About {days}; expected end date {end}."
        if reason_code == "fits_preferred_date" and preferred:
            total_time += f" This fits your preferred date ({preferred})."
        elif reason_code == "exceeds_preferred_date" and preferred:
            total_time += (
                f" This is after your preferred date ({preferred}). You can add daily time, "
                "narrow the scope or move the date."
            )

    # Daily time: the amount in whole ayat or hadith (D90); the words figure only when the
    # estimate has no unit amount.
    amount = daily_new_text(estimate, language)
    if ar:
        if amount is not None:
            daily_time = f"{minutes} يوميًا، و{amount}، مع مراجعة المقاطع السابقة."
        else:
            daily_time = (
                f"{minutes} يوميًا، وتتعلم نحو {estimate.new_words_per_day} كلمة جديدة كل يوم "
                "مع مراجعة المقاطع السابقة."
            )
    else:
        if amount is not None:
            daily_time = f"{minutes} a day, {amount}, while reviewing earlier passages."
        else:
            daily_time = (
                f"{minutes} a day, learning about {estimate.new_words_per_day} new words each "
                "day while reviewing earlier passages."
            )

    # Stages.
    phrase = order_phrase(params.order, language)
    if ar:
        stages = (
            f"1) تعلّم المقاطع الجديدة {phrase}.\n"
            "2) اختبار قصير في نهاية كل جلسة.\n"
            "3) اعتماد المقطع بعد مراجعاته الناجحة وتغطية كل أجزائه."
        )
    else:
        stages = (
            f"1) Learn the new passages {phrase}.\n"
            "2) A short test at the end of each session.\n"
            "3) A passage is confirmed after its successful reviews and full coverage."
        )

    # Reviews (D66 ladder).
    a, b, c = REVIEW_LADDER_DAYS
    x, y, z = REVIEW_LADDER_CUMULATIVE
    if ar:
        reviews = (
            f"تُراجَع الفقرة بعد {days_text(a, language)}، ثم بعد {days_text(b, language)}، "
            f"ثم بعد {days_text(c, language)} (أي في اليوم {x} و{y} و{z} عند الالتزام)، "
            "ثم تأتي مراجعات الصيانة بعد اعتمادها."
        )
    else:
        reviews = (
            f"A passage is reviewed after {days_text(a, language)}, then {days_text(b, language)}, "
            f"then {days_text(c, language)} (days {x}, {y} and {z} when on time), "
            "then maintenance reviews once it is confirmed."
        )

    # Next step.
    if ar:
        next_step = (
            "اعتمد التعديل ليسري من يوم التعلم التالي، أو عدّل الخيارات أولًا."
            if revision
            else "اعتمد الخطة لتبدأ جلستك الأولى، أو عدّل الخيارات أولًا."
        )
    else:
        next_step = (
            "Confirm the change to take effect from the next learning day, or adjust the options "
            "first."
            if revision
            else "Confirm the plan to start your first session, or adjust the options first."
        )

    return PlanSections(
        goal=goal,
        total_time=total_time,
        daily_time=daily_time,
        stages=stages,
        reviews=reviews,
        next_step=next_step,
    )


# --- assistant messages ---------------------------------------------------------------------------


def _headline(proposal: PlanProposal, language: Lang) -> str:
    days = days_text(proposal.estimate.days, language)
    minutes = minutes_text(proposal.session_minutes, language)
    if language == "ar":
        return f"{days} بمعدل {minutes} يوميًا"
    return f"{days} at {minutes} a day"


def first_turn_message(proposal: PlanProposal, language: Lang, *, revision: bool) -> str:
    head = _headline(proposal, language)
    if language == "ar":
        if revision:
            return (
                f"هذا اقتراح لتعديل خطتك: {head}. تسري التعديلات من يوم التعلم التالي. "
                "راجع الأقسام أدناه ثم اعتمد التعديل عندما يناسبك."
            )
        return (
            f"هذه خطتك المقترحة: {head}. راجع الأقسام أدناه، ثم عدّل ما تريد بالخيارات "
            "الجاهزة أو بالكتابة، واعتمد الخطة عندما تناسبك."
        )
    if revision:
        return (
            f"Here is a proposed change to your plan: {head}. Changes take effect from the next "
            "learning day. Review the sections below, then confirm the change when it suits you."
        )
    return (
        f"Here is your proposed plan: {head}. Review the sections below, then adjust what you "
        "like with the quick options or by typing, and confirm the plan when it suits you."
    )


def templated_reply(proposal: PlanProposal, language: Lang) -> str:
    """The restated current plan: the safe reply used whenever the model's text is not shown."""
    end = _date_text(proposal.estimate.end_date)
    head = _headline(proposal, language)
    if language == "ar":
        return f"الخطة الحالية: {head}، وتنتهي في {end}."
    return f"Current plan: {head}, ending on {end}."


def update_message(proposal: PlanProposal, language: Lang) -> str:
    end = _date_text(proposal.estimate.end_date)
    head = _headline(proposal, language)
    if language == "ar":
        return f"تم تحديث الخطة: {head}، وتنتهي في {end}. راجع الأقسام أدناه."
    return f"The plan is updated: {head}, ending on {end}. Review the sections below."


_NOTES_AR = {
    "minutes_min": "الوقت اليومي عند أقل خيار متاح.",
    "minutes_max": "الوقت اليومي عند أعلى خيار متاح.",
    "scope_min": "لا يمكن تصغير النطاق الحالي أكثر.",
    "scope_locked": "لا يتغير نطاق خطة قائمة؛ النطاق الجديد يحتاج خطة جديدة.",
    "order_not_available": "الترتيب العكسي متاح للقرآن الكريم فقط؛ بقيت الخطة بترتيب الكتاب.",
    "paths_not_available": "مسارات المتن والسند والدرجة متاحة لكتب الحديث فقط.",
    "already_set": "هذا الخيار مطبّق على الخطة الحالية.",
}
_NOTES_EN = {
    "minutes_min": "Daily time is already at the lowest option.",
    "minutes_max": "Daily time is already at the highest option.",
    "scope_min": "The current scope cannot be reduced any further.",
    "scope_locked": "The scope of an existing plan does not change; a new scope needs a new plan.",
    "order_not_available": "Reverse order is available for the Quran only; the plan stays in book "
    "order.",
    "paths_not_available": "The matn, sanad and grade paths are for hadith books only.",
    "already_set": "That option is already applied to the current plan.",
}


def unchanged_message(note: str | None, proposal: PlanProposal, language: Lang) -> str:
    notes = _NOTES_AR if language == "ar" else _NOTES_EN
    text = notes.get(note or "already_set", notes["already_set"])
    return f"{text} {templated_reply(proposal, language)}"


def rejected_parameters_message(
    proposal: PlanProposal, language: Lang, *, scope_locked: bool = False
) -> str:
    """Templated reply when a model patch was (partly) ignored. ``scope_locked`` explains that a
    revision never changes the scope: a new scope needs a new plan (§2.9 item 1)."""
    notes = _NOTES_AR if language == "ar" else _NOTES_EN
    if scope_locked:
        prefix = notes["scope_locked"]
    elif language == "ar":
        prefix = "لم أتمكن من تطبيق بعض التغييرات لأنها غير متاحة لهذا الكتاب أو غير صالحة."
    else:
        prefix = "I could not apply some changes because they are not available for this book."
    return f"{prefix} {templated_reply(proposal, language)}"


def confirm_hint(language: Lang) -> str:
    if language == "ar":
        return "للاعتماد اضغط «اعتماد الخطة» بعد مراجعة الأقسام أعلاه."
    return "To confirm, press «Confirm the plan» after reviewing the sections above."


def fallback_message(
    proposal: PlanProposal | None, language: Lang, *, first_time: bool, include_summary: bool
) -> str:
    """A rules reply that restates the plan. ``first_time`` adds the calm unavailable notice
    (shown once per conversation, kind ``fallback``)."""
    parts: list[str] = []
    if first_time:
        parts.append(FALLBACK_LINES["ar" if language == "ar" else "en"])
    if include_summary and proposal is not None:
        parts.append(templated_reply(proposal, language))
    if not first_time:
        parts.append(
            "يمكنك المتابعة بالخيارات أدناه." if language == "ar" else "Use the options below."
        )
    return " ".join(parts)
