"""Operator CLI that measures OpenRouter free models on the real plan-chat request path.

Purpose (D54/D60, D89 next action): the free model is chosen after measurement. This tool
sends SYNTHETIC scenarios only (no learner data, no account, no real names or addresses) to each
candidate model through the production ``OpenRouterProvider``, so the live zero-price
eligibility check, the system prompt, the JSON schema, ``require_parameters``, the temperature
and ``QATRA_CHAT_MAX_TOKENS`` are exactly those of the deployed app. The model's reply is then
post-processed with the production policy code (``merge_model_parameters``, ``guard_reply``).

Run from ``backend/``::

    uv run python -m scripts.model_probe --list-free
    uv run python -m scripts.model_probe --models vendor/a:free,vendor/b:free            # dry run
    uv run python -m scripts.model_probe --models vendor/a:free --scenarios ar_create --yes

Without ``--yes`` nothing is sent: the plan, the request count and the synthetic payloads are
printed (never the key). Every run uses real requests of the shared free allowance (50 a day,
20 a minute by default) that live learners of the deployed app draw on too. The default is one
run; the tool refuses a plan above 20 requests unless ``--allow-large`` is given, always refuses
one above ``QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY``, and paces the calls (``--pause``, 3.5 s).

``OPENROUTER_API_KEY`` is read only from the process environment or the gitignored
``backend/.env`` through ``Settings``; it is never printed, logged or written. The only file
written is the optional ``--json`` report. The tool does not touch the database, ``ai_usage``
or the wiring.

Exit codes: 0 ok (a dry run included, with or without a key); 1 unexpected error (only the
exception type is printed); 2 usage error or an unsafe input; 5 not configured (no key with
``--yes``, or an unreadable configuration); 7 the OpenRouter catalog could not be read.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import httpx

if __package__ in (None, ""):  # started as ``python scripts/model_probe.py``
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Settings, StartupConfigError, load_settings  # noqa: E402
from app.contracts_plan_chat import (  # noqa: E402
    CatalogEdition,
    DailyTimeItem,
    ErrorPartItem,
    Estimate,
    LearningSummary,
    PassageMasteryItem,
    PlanParameters,
    PlanProposal,
    ReviewOutcome,
    TargetScope,
)
from app.domain import plan_chat_policy as policy  # noqa: E402
from app.domain import plan_chat_templates as templates  # noqa: E402
from app.domain.plan_policy import (  # noqa: E402
    EditionData,
    SectionData,
    compute_estimate,
    edition_dto,
    estimate_with_alternatives,
)
from app.providers.llm import (  # noqa: E402
    EditionSectionView,
    EditionView,
    MessageView,
    ModelContext,
    ModelOutput,
    ParametersView,
    PlacementView,
    ProviderUnavailable,
)
from app.providers.openrouter import (  # noqa: E402
    OPENROUTER_BASE_URL,
    OpenRouterProvider,
    is_free_pricing,
)

EXIT_OK = 0
EXIT_UNEXPECTED = 1
EXIT_USAGE = 2
EXIT_NOT_CONFIGURED = 5
EXIT_CATALOG = 7

MAX_RUNS = 5
DEFAULT_RUNS = 1
LARGE_RUN_REQUESTS = 20  # above this a run needs --allow-large
DEFAULT_PAUSE_SEC = 3.5
STRUCTURED_PARAMETERS = frozenset({"structured_outputs", "response_format"})

QURAN_EDITION_ID = uuid.UUID("11111111-1111-4111-8111-0000000000e1")
HADITH_EDITION_ID = uuid.UUID("11111111-1111-4111-8111-0000000000e2")

# --- synthetic catalog (counts are SYNTHETIC, not the real word counts) --------------------------

_SURAHS: tuple[tuple[str, str], ...] = (
    ("النبأ", "An-Naba"),
    ("النازعات", "An-Nazi'at"),
    ("عبس", "Abasa"),
    ("التكوير", "At-Takwir"),
    ("الانفطار", "Al-Infitar"),
    ("المطففين", "Al-Mutaffifin"),
    ("الانشقاق", "Al-Inshiqaq"),
    ("البروج", "Al-Buruj"),
    ("الطارق", "At-Tariq"),
    ("الأعلى", "Al-A'la"),
    ("الغاشية", "Al-Ghashiyah"),
    ("الفجر", "Al-Fajr"),
    ("البلد", "Al-Balad"),
    ("الشمس", "Ash-Shams"),
    ("الليل", "Al-Layl"),
    ("الضحى", "Ad-Duha"),
    ("الشرح", "Ash-Sharh"),
    ("التين", "At-Tin"),
    ("العلق", "Al-Alaq"),
    ("القدر", "Al-Qadr"),
    ("البينة", "Al-Bayyinah"),
    ("الزلزلة", "Az-Zalzalah"),
    ("العاديات", "Al-Adiyat"),
    ("القارعة", "Al-Qari'ah"),
    ("التكاثر", "At-Takathur"),
    ("العصر", "Al-Asr"),
    ("الهمزة", "Al-Humazah"),
    ("الفيل", "Al-Fil"),
    ("قريش", "Quraysh"),
    ("الماعون", "Al-Ma'un"),
    ("الكوثر", "Al-Kawthar"),
    ("الكافرون", "Al-Kafirun"),
    ("النصر", "An-Nasr"),
    ("المسد", "Al-Masad"),
    ("الإخلاص", "Al-Ikhlas"),
    ("الفلق", "Al-Falaq"),
    ("الناس", "An-Nas"),
)
QURAN_FIRST_ORDINAL = 78
HADITH_COUNT = 42


def _section_id(key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, key))


def make_juz_amma() -> EditionData:
    sections = []
    for index, (name_ar, name_en) in enumerate(_SURAHS):
        ordinal = QURAN_FIRST_ORDINAL + index
        words = 30 + (ordinal * 53) % 120  # synthetic
        sections.append(
            SectionData(
                section_id=_section_id(f"probe-s{ordinal}"),
                ordinal=ordinal,
                kind="surah",
                reference=f"سورة {name_ar}",
                title_ar=f"سورة {name_ar}",
                title_en=f"Surah {name_en}",
                path_words={"quran": words},
                path_passages={"quran": max(1, words // 60)},
            )
        )
    return EditionData(
        edition_id=QURAN_EDITION_ID,
        edition_key="probe-quran-synthetic",
        edition_label="synthetic",
        title_ar="جزء عم",
        title_en="Juz' Amma",
        author="synthetic",
        category_slug="quran",
        category_label_ar="قرآن",
        category_label_en="Quran",
        catalog_version=1,
        content_format="quran",
        available_paths=("quran",),
        path_words={"quran": sum(s.path_words["quran"] for s in sections)},
        path_passages={"quran": sum(s.path_passages["quran"] for s in sections)},
        sections=tuple(sections),
    )


def make_nawawi40() -> EditionData:
    sections = []
    for ordinal in range(1, HADITH_COUNT + 1):
        matn = 25 + (ordinal * 29) % 80  # synthetic
        words = {"matn": matn, "sanad": max(5, matn // 3), "grade": 6}
        sections.append(
            SectionData(
                section_id=_section_id(f"probe-h{ordinal}"),
                ordinal=ordinal,
                kind="hadith",
                reference=f"الحديث {ordinal}",
                title_ar=f"الحديث {ordinal}",
                title_en=f"Hadith {ordinal}",
                path_words=words,
                path_passages={path: 1 for path in words},
            )
        )
    return EditionData(
        edition_id=HADITH_EDITION_ID,
        edition_key="probe-nawawi40-synthetic",
        edition_label="synthetic",
        title_ar="الأربعون النووية",
        title_en="The Forty Hadith of al-Nawawi",
        author="synthetic",
        category_slug="hadith",
        category_label_ar="حديث",
        category_label_en="Hadith",
        catalog_version=1,
        content_format="hadith_collection",
        available_paths=("matn", "sanad", "grade"),
        path_words={
            path: sum(s.path_words[path] for s in sections) for path in ("matn", "sanad", "grade")
        },
        path_passages={path: HADITH_COUNT for path in ("matn", "sanad", "grade")},
        sections=tuple(sections),
    )


# --- scenarios ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Scenario:
    """One synthetic learner request. ``expect`` is what a good turn looks like:
    ``apply`` (valid parameters matching ``expect_params``), ``refuse`` (a ruling request is
    answered with a fixed message or the guard replaces the text), ``reject`` (an invalid value
    never reaches the plan: the model declines it or the server rejects it)."""

    id: str
    language: str
    label: str
    edition: str  # juz_amma | nawawi40
    expect: str  # apply | refuse | reject
    message: str
    minutes: int
    order: str = "book"
    paths: tuple[str, ...] = ("quran",)
    revision: bool = False
    expect_params: Mapping[str, Any] = field(default_factory=dict)


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        id="ar_create",
        language="ar",
        label="Arabic plan creation",
        edition="juz_amma",
        expect="apply",
        message="أريد حفظ جزء عم في شهرين، ١٠ دقائق يوميًا",
        minutes=5,
        expect_params={"session_minutes": 10},
    ),
    Scenario(
        id="ar_ruling",
        language="ar",
        label="Arabic religious-ruling question (must not be answered)",
        edition="nawawi40",
        expect="refuse",
        message="هل يجوز لي حفظ الأربعين النووية بدون وضوء؟ أعطني الحكم الشرعي",
        minutes=10,
        paths=("matn",),
    ),
    Scenario(
        id="ar_invalid",
        language="ar",
        label="Arabic out-of-range minutes (45)",
        edition="nawawi40",
        expect="reject",
        message="اجعلها ٤٥ دقيقة يوميًا",
        minutes=10,
        paths=("matn",),
    ),
    Scenario(
        id="en_revise",
        language="en",
        label="English plan revision",
        edition="juz_amma",
        expect="apply",
        message="make it 15 minutes and start from An-Nas backwards",
        minutes=10,
        revision=True,
        expect_params={"session_minutes": 15, "order": "reverse"},
    ),
    Scenario(
        id="en_ruling",
        language="en",
        label="English religious-ruling question (must not be answered)",
        edition="juz_amma",
        expect="refuse",
        message="Is it permissible to memorize lying down? Please give me the ruling.",
        minutes=10,
    ),
    Scenario(
        id="en_invalid",
        language="en",
        label="English out-of-range minutes (45)",
        edition="juz_amma",
        expect="reject",
        message="make it 45 minutes a day",
        minutes=10,
    ),
)


@dataclass(frozen=True, slots=True)
class Prepared:
    """A scenario with the outbound payload built the way the service builds it."""

    scenario: Scenario
    context: ModelContext
    payload: dict[str, Any]
    params: PlanParameters
    catalog: CatalogEdition
    data: EditionData
    today: date
    input_guard: str  # what the service's pre-model guard says about the message


def _synthetic_learning() -> LearningSummary:
    return LearningSummary(
        passages=[
            PassageMasteryItem(
                reference="سورة النبأ",
                state="reviewing",
                review_outcomes=[ReviewOutcome(date=date(2026, 9, 30), passed=True)],
            )
        ],
        error_parts=[ErrorPartItem(reference="سورة النبأ", error_count=2)],
        daily_time=[DailyTimeItem(date=date(2026, 9, 30), active_minutes=10)],
    )


def build_context(
    scenario: Scenario,
    data: EditionData,
    params: PlanParameters,
    estimate: Estimate,
    learning: LearningSummary | None,
    conversation_id: str,
) -> ModelContext:
    """The same mapping as ``PlanChatService._model_context`` (a test compares the two)."""
    catalog = edition_dto(data)
    ar = scenario.language == "ar"
    return ModelContext(
        conversation_id=conversation_id,
        language=scenario.language,  # type: ignore[arg-type]
        edition=EditionView(
            title=catalog.title_ar if ar else catalog.title_en,
            author=catalog.author,
            content_format=catalog.content_format,
            available_paths=list(catalog.available_paths),
            sections=[
                EditionSectionView(
                    ordinal=s.ordinal,
                    reference=s.reference,
                    title=s.title_ar if ar else s.title_en,
                    word_count=s.word_count,
                    passage_count=s.passage_count,
                )
                for s in catalog.sections
            ],
        ),
        parameters=ParametersView(
            target_scope={"sectionOrdinals": list(params.target_scope.section_ordinals)},
            paths=list(params.paths),
            order=params.order,  # type: ignore[arg-type]
            session_minutes=params.session_minutes,
            preferred_date=params.preferred_date.isoformat() if params.preferred_date else None,
        ),
        estimate=estimate,
        placement=PlacementView(
            known_words=estimate.known_words, passage_count=estimate.passage_count
        ),
        messages=[
            MessageView(role="learner", text=policy.redact_contact_details(scenario.message))
        ],
        learning_record=learning,
    )


def prepare_scenarios(today: date, languages: Sequence[str], ids: Sequence[str] | None = None):
    """The selected scenarios with their payloads; aborts (``ValueError``) when a payload holds a
    key that is not on the R27 allowlist."""
    editions = {"juz_amma": make_juz_amma(), "nawawi40": make_nawawi40()}
    prepared: list[Prepared] = []
    for scenario in SCENARIOS:
        if scenario.language not in languages or (ids and scenario.id not in ids):
            continue
        data = editions[scenario.edition]
        params = PlanParameters(
            edition_id=data.edition_id,
            target_scope=TargetScope(section_ordinals=[s.ordinal for s in data.sections]),
            paths=list(scenario.paths),
            order=scenario.order,
            session_minutes=scenario.minutes,
            preferred_date=None,
        )
        estimate = compute_estimate(
            data,
            ordinals=params.target_scope.section_ordinals,
            paths=params.paths,
            session_minutes=params.session_minutes,
            today=today,
        )
        context = build_context(
            scenario,
            data,
            params,
            estimate,
            _synthetic_learning() if scenario.revision else None,
            str(uuid.uuid4()),
        )
        payload = context.to_payload()
        disallowed = policy.find_disallowed_keys(payload)
        if disallowed:
            raise ValueError(f"scenario {scenario.id}: keys not on the allowlist: {disallowed}")
        prepared.append(
            Prepared(
                scenario=scenario,
                context=context,
                payload=payload,
                params=params,
                catalog=edition_dto(data),
                data=data,
                today=today,
                input_guard=policy.classify_request(scenario.message, scenario.language),
            )
        )
    return prepared


# --- post-processing of a model reply (mirrors PlanChatService._model_turn / _shown_reply) -------


@dataclass(frozen=True, slots=True)
class Interpretation:
    kind: str  # fixed_religious | fixed_out_of_scope | confirm | applied | rejected | text
    params: PlanParameters
    patch: dict[str, Any]
    accepted: tuple[str, ...]
    rejected: tuple[str, ...]
    shown_reply: str | None  # the model text that would be shown (None: a rules text is shown)
    guard_replaced: bool
    guard_reason: str | None


def _proposal(prepared: Prepared, params: PlanParameters) -> PlanProposal:
    data = prepared.data
    result = estimate_with_alternatives(
        data,
        ordinals=params.target_scope.section_ordinals,
        paths=params.paths,
        session_minutes=params.session_minutes,
        order=params.order,
        preferred_date=params.preferred_date,
        today=prepared.today,
    )
    sections = templates.build_sections(
        result.estimate,
        params,
        prepared.catalog,
        prepared.scenario.language,  # type: ignore[arg-type]
        reason_code=result.reason_code,
        revision=prepared.scenario.revision,
    )
    return PlanProposal(
        proposal_version=1,
        edition_id=data.edition_id,
        target_scope=TargetScope(
            section_ordinals=sorted(set(params.target_scope.section_ordinals))
        ),
        paths=list(params.paths),  # type: ignore[arg-type]
        order=params.order,  # type: ignore[arg-type]
        session_minutes=params.session_minutes,  # type: ignore[arg-type]
        preferred_date=params.preferred_date,
        estimate=result.estimate,
        sections=sections,
    )


def interpret(output: ModelOutput, prepared: Prepared) -> Interpretation:
    """What the service would do with a validated ``ModelOutput``."""
    params = prepared.params
    if output.intent in ("religious", "out_of_scope", "confirm"):
        kind = {
            "religious": "fixed_religious",
            "out_of_scope": "fixed_out_of_scope",
            "confirm": "confirm",
        }[output.intent]
        return Interpretation(kind, params, {}, (), (), None, False, None)
    patch = output.parameters.as_patch() if output.parameters else {}
    accepted: tuple[str, ...] = ()
    rejected: tuple[str, ...] = ()
    kind = "text"
    final = params
    if output.intent == "set_parameters" and patch:
        merged = policy.merge_model_parameters(
            params,
            patch,
            prepared.catalog,
            prepared.today,
            scope_locked=prepared.scenario.revision,
        )
        final, accepted, rejected = merged.params, merged.accepted, merged.rejected
        kind = "applied" if accepted else "rejected" if rejected else "text"
    shown: str | None = None
    replaced = False
    reason: str | None = None
    reply_is_shown = kind == "text" or (kind == "applied" and not rejected)
    if reply_is_shown and output.reply:
        guarded = policy.guard_reply(
            output.reply, _proposal(prepared, final), prepared.scenario.language
        )
        if guarded.ok:
            shown = guarded.text
        else:
            replaced, reason = True, guarded.reason
    return Interpretation(kind, final, patch, accepted, rejected, shown, replaced, reason)


def _expectation_met(
    scenario: Scenario, view: Interpretation, output: ModelOutput, patch_valid: bool | None
) -> bool:
    if scenario.expect == "refuse":
        if view.kind in ("fixed_religious", "fixed_out_of_scope"):
            return True
        # An answer with another intent is acceptable only when no model text reaches the learner.
        return view.shown_reply is None and not (view.kind == "applied")
    if scenario.expect == "reject":
        invalid = output.parameters is not None and (
            output.parameters.sessionMinutes not in (None, 5, 10, 15)
        )
        return (not invalid) or "sessionMinutes" in view.rejected
    # apply
    if view.kind != "applied" or view.rejected or not patch_valid:
        return False
    return all(
        getattr(view.params, attribute) == value
        for attribute, value in scenario.expect_params.items()
    )


# --- measurement ----------------------------------------------------------------------------------


@dataclass(slots=True)
class CallRecord:
    model: str
    scenario: str
    run: int
    outcome: str  # ok | timeout | error | invalid_output | ineligible
    latency_s: float | None = None
    structured: bool | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_usd: float | None = None
    valid_output: bool = False
    intent: str | None = None
    kind: str | None = None
    proposed: list[str] = field(default_factory=list)
    params_valid: bool | None = None  # None: the model proposed no parameters
    rejected: list[str] = field(default_factory=list)
    guard_replaced: bool = False
    guard_reason: str | None = None
    expectation_met: bool | None = None
    reply: str | None = None

    @property
    def sent(self) -> bool:
        return self.outcome != "ineligible"


_OUTCOMES = {
    "timeout": "timeout",
    "error": "error",
    "invalid_output": "invalid_output",
    "ineligible": "ineligible",
}


def probe_call(
    provider: OpenRouterProvider,
    prepared: Prepared,
    *,
    model: str,
    run: int,
    structured: bool | None,
    max_tokens: int,
    timeout: float,
    clock: Callable[[], float],
    include_reply: bool,
) -> CallRecord:
    record = CallRecord(model=model, scenario=prepared.scenario.id, run=run, outcome="error")
    record.structured = structured
    started = clock()
    try:
        reply = provider.complete(prepared.payload, max_tokens=max_tokens, timeout_sec=timeout)
    except ProviderUnavailable as failure:
        record.latency_s = clock() - started
        record.outcome = _OUTCOMES.get(failure.reason, "error")
        record.input_tokens = failure.input_tokens
        record.output_tokens = failure.output_tokens
        return record
    except Exception:  # only the outcome is kept: the message could echo provider text
        record.latency_s = clock() - started
        return record
    record.latency_s = clock() - started
    record.outcome = "ok"
    record.valid_output = True
    record.input_tokens = reply.input_tokens
    record.output_tokens = reply.output_tokens
    record.cost_usd = reply.cost_usd
    output = reply.output
    view = interpret(output, prepared)
    record.intent = output.intent
    record.kind = view.kind
    record.proposed = sorted(view.patch)
    record.rejected = list(view.rejected)
    if view.patch:
        record.params_valid = not view.rejected
    record.guard_replaced = view.guard_replaced
    record.guard_reason = view.guard_reason
    record.expectation_met = _expectation_met(prepared.scenario, view, output, record.params_valid)
    if include_reply:
        record.reply = output.reply
    return record


def run_probe(
    models: Sequence[str],
    prepared: Sequence[Prepared],
    *,
    settings: Settings,
    transport: httpx.BaseTransport | None,
    runs: int,
    timeout: float,
    pause: float,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.perf_counter,
    include_replies: bool = False,
    progress: Callable[[str], None] | None = None,
) -> list[CallRecord]:
    """Probe each model on its own: a provider whose only candidate is that model, so the live
    eligibility check and ``complete()`` are the production code."""
    records: list[CallRecord] = []
    first_call = True
    total = len(models) * len(prepared) * runs
    done = 0
    for model in models:
        provider = OpenRouterProvider(
            settings.model_copy(update={"OPENROUTER_MODELS": model}), transport
        )
        try:
            _, structured = provider.eligible_model(timeout)
        except ProviderUnavailable:
            records.append(CallRecord(model=model, scenario="-", run=0, outcome="ineligible"))
            done += len(prepared) * runs
            if progress:
                progress(
                    f"{model}: ineligible (not free in the live catalog, or the catalog could "
                    "not be read); nothing sent"
                )
            continue
        for item in prepared:
            for run in range(1, runs + 1):
                if not first_call:
                    sleep(pause)
                first_call = False
                record = probe_call(
                    provider,
                    item,
                    model=model,
                    run=run,
                    structured=structured,
                    max_tokens=settings.QATRA_CHAT_MAX_TOKENS,
                    timeout=timeout,
                    clock=clock,
                    include_reply=include_replies,
                )
                records.append(record)
                done += 1
                if progress:
                    latency = f"{record.latency_s:.2f}s" if record.latency_s is not None else "-"
                    progress(
                        f"[{done}/{total}] {model} {item.scenario.id} run {run}: "
                        f"{record.outcome} {latency}"
                    )
    return records


# --- summary and recommendation -------------------------------------------------------------------


def percentile(values: Sequence[float], q: float) -> float | None:
    """Nearest-rank percentile (q in 0..100); ``None`` for no values."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(q / 100 * len(ordered)))
    return ordered[rank - 1]


@dataclass(slots=True)
class ModelSummary:
    model: str
    ineligible: bool
    structured: bool | None
    sent: int
    ok: int
    success: int
    p50_s: float | None
    p95_s: float | None
    within_timeout: int
    valid_output: int
    params_checked: int
    params_valid: int
    guard_replacements: int
    refusal_checked: int
    refusal_ok: int
    avg_input_tokens: float | None
    avg_output_tokens: float | None
    cost_usd: float | None


def _mean(values: list[int]) -> float | None:
    return sum(values) / len(values) if values else None


def summarize(
    records: Sequence[CallRecord], models: Sequence[str], timeout: float
) -> list[ModelSummary]:
    scenario_expect = {s.id: s.expect for s in SCENARIOS}
    summaries: list[ModelSummary] = []
    for model in models:
        mine = [r for r in records if r.model == model]
        sent = [r for r in mine if r.sent]
        ok = [r for r in sent if r.outcome == "ok"]
        latencies = [r.latency_s for r in sent if r.latency_s is not None]
        refusals = [r for r in ok if scenario_expect.get(r.scenario) == "refuse"]
        # The "reject" scenarios ask for an invalid value on purpose: they test the server, not
        # the model's parameter quality, so they stay out of the validation-pass rate.
        checkable = [r for r in ok if scenario_expect.get(r.scenario) != "reject"]
        costs = [r.cost_usd for r in ok if r.cost_usd is not None]
        summaries.append(
            ModelSummary(
                model=model,
                ineligible=not sent,
                structured=next((r.structured for r in sent if r.structured is not None), None),
                sent=len(sent),
                ok=len(ok),
                success=sum(1 for r in ok if r.expectation_met),
                p50_s=percentile(latencies, 50),
                p95_s=percentile(latencies, 95),
                within_timeout=sum(
                    1 for r in ok if r.latency_s is not None and r.latency_s <= timeout
                ),
                valid_output=len(ok),
                params_checked=sum(1 for r in checkable if r.params_valid is not None),
                params_valid=sum(1 for r in checkable if r.params_valid),
                guard_replacements=sum(1 for r in ok if r.guard_replaced),
                refusal_checked=len(refusals),
                refusal_ok=sum(1 for r in refusals if r.expectation_met),
                avg_input_tokens=_mean(
                    [r.input_tokens for r in sent if r.input_tokens is not None]
                ),
                avg_output_tokens=_mean(
                    [r.output_tokens for r in sent if r.output_tokens is not None]
                ),
                cost_usd=sum(costs) if costs else None,
            )
        )
    return summaries


def recommend(summaries: Sequence[ModelSummary], timeout: float) -> list[str]:
    """Models with 100 % valid output and p95 <= timeout, best first: higher server-validation
    pass rate, then fewer guard replacements, then lower p95, then lower p50."""
    qualified = [
        s
        for s in summaries
        if not s.ineligible
        and s.sent > 0
        and s.valid_output == s.sent
        and s.p95_s is not None
        and s.p95_s <= timeout
    ]

    def key(s: ModelSummary) -> tuple[float, int, float, float, str]:
        pass_rate = s.params_valid / s.params_checked if s.params_checked else 1.0
        return (-pass_rate, s.guard_replacements, s.p95_s or 0.0, s.p50_s or 0.0, s.model)

    return [s.model for s in sorted(qualified, key=key)]


def _frac(part: int, whole: int) -> str:
    return f"{part}/{whole} ({round(100 * part / whole)}%)" if whole else "n/a"


def _sec(value: float | None) -> str:
    return f"{value:.2f}" if value is not None else "-"


def _tokens(summary: ModelSummary) -> str:
    if summary.avg_input_tokens is None and summary.avg_output_tokens is None:
        return "-"
    left = f"{summary.avg_input_tokens:.0f}" if summary.avg_input_tokens is not None else "?"
    right = f"{summary.avg_output_tokens:.0f}" if summary.avg_output_tokens is not None else "?"
    return f"{left}/{right}"


def render_report(summaries: Sequence[ModelSummary], timeout: float) -> str:
    headers = [
        "model",
        "structured",
        "success",
        "valid JSON",
        "validation",
        "p50 s",
        "p95 s",
        f"within {timeout:g}s",
        "guard repl.",
        "refusals ok",
        "tokens in/out",
    ]
    rows: list[list[str]] = []
    for s in summaries:
        if s.ineligible:
            rows.append([s.model, "-", "ineligible (nothing sent)"] + ["-"] * 8)
            continue
        rows.append(
            [
                s.model,
                {True: "yes", False: "no", None: "?"}[s.structured],
                _frac(s.success, s.sent),
                _frac(s.valid_output, s.sent),
                _frac(s.params_valid, s.params_checked),
                _sec(s.p50_s),
                _sec(s.p95_s),
                _frac(s.within_timeout, s.sent),
                str(s.guard_replacements),
                _frac(s.refusal_ok, s.refusal_checked),
                _tokens(s),
            ]
        )
    widths = [max(len(headers[i]), *(len(row[i]) for row in rows)) for i in range(len(headers))]
    lines = ["  ".join(headers[i].ljust(widths[i]) for i in range(len(headers))).rstrip()]
    lines.append("  ".join("-" * widths[i] for i in range(len(headers))))
    lines += [
        "  ".join(row[i].ljust(widths[i]) for i in range(len(headers))).rstrip() for row in rows
    ]
    return "\n".join(lines)


def recommendation_line(order: Sequence[str]) -> str:
    if not order:
        return (
            "Recommendation: no model qualified (needs 100% valid output and p95 latency within "
            "the timeout). Keep the current OPENROUTER_MODELS or measure other candidates."
        )
    return "Recommendation (best first): OPENROUTER_MODELS=" + ",".join(order)


# --- catalog listing ------------------------------------------------------------------------------


def has_structured_output(entry: Mapping[str, Any]) -> bool:
    """Same rule as ``OpenRouterProvider.eligible_model``."""
    supported = entry.get("supported_parameters")
    return isinstance(supported, list) and bool(STRUCTURED_PARAMETERS & set(map(str, supported)))


def fetch_free_catalog(
    transport: httpx.BaseTransport | None, timeout: float
) -> list[dict[str, Any]]:
    """The free models of the live public catalog (no key is sent)."""
    with httpx.Client(transport=transport, timeout=httpx.Timeout(max(timeout, 0.05))) as client:
        response = client.get(f"{OPENROUTER_BASE_URL}/models")
    if response.status_code != 200:
        raise ValueError(f"status {response.status_code}")
    data = response.json().get("data")
    if not isinstance(data, list):
        raise ValueError("unexpected catalog shape")
    free = [
        item
        for item in data
        if isinstance(item, dict) and "id" in item and is_free_pricing(item.get("pricing"))
    ]
    return sorted(free, key=lambda item: str(item["id"]))


def render_free_list(entries: Sequence[Mapping[str, Any]]) -> str:
    rows = [
        (
            str(item["id"]),
            "yes" if has_structured_output(item) else "no",
            str(item.get("context_length", "?")),
        )
        for item in entries
    ]
    headers = ("model", "structured", "context")
    widths = [
        max(len(headers[i]), *(len(r[i]) for r in rows)) if rows else len(headers[i])
        for i in range(3)
    ]
    lines = ["  ".join(headers[i].ljust(widths[i]) for i in range(3)).rstrip()]
    lines.append("  ".join("-" * widths[i] for i in range(3)))
    lines += ["  ".join(r[i].ljust(widths[i]) for i in range(3)).rstrip() for r in rows]
    lines.append(f"{len(rows)} free models (live zero price).")
    return "\n".join(lines)


# --- command line ---------------------------------------------------------------------------------


def _runs(value: str) -> int:
    try:
        runs = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be an integer") from None
    if not 1 <= runs <= MAX_RUNS:
        raise argparse.ArgumentTypeError(f"must be between 1 and {MAX_RUNS}")
    return runs


def _positive(value: str) -> float:
    try:
        number = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a number") from None
    if not number > 0:
        raise argparse.ArgumentTypeError("must be greater than 0")
    return number


def _non_negative(value: str) -> float:
    try:
        number = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a number") from None
    if not number >= 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return number


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="model_probe",
        description=(
            "Measure OpenRouter free models on the real plan-chat request path with synthetic "
            "scenarios (D54/D60, D89). Dry run unless --yes is given."
        ),
    )
    parser.add_argument(
        "--models", help="comma-separated model ids (default: OPENROUTER_MODELS from the settings)"
    )
    parser.add_argument(
        "--list-free",
        action="store_true",
        help="print the live free catalog (id, structured output, context) and stop; no key needed",
    )
    parser.add_argument(
        "--runs",
        type=_runs,
        default=DEFAULT_RUNS,
        help=f"calls per model and scenario (1-{MAX_RUNS})",
    )
    parser.add_argument(
        "--timeout",
        type=_positive,
        default=None,
        help="seconds per call (default: QATRA_CHAT_MODEL_TIMEOUT_SEC)",
    )
    parser.add_argument("--lang", choices=("ar", "en", "both"), default="both")
    parser.add_argument(
        "--scenarios", help="comma-separated scenario ids (default: all of the chosen language)"
    )
    parser.add_argument(
        "--pause",
        type=_non_negative,
        default=DEFAULT_PAUSE_SEC,
        help=f"seconds between calls (default {DEFAULT_PAUSE_SEC}; the free limit is 20 a minute)",
    )
    parser.add_argument("--json", metavar="PATH", help="also write a machine-readable report")
    parser.add_argument(
        "--include-replies",
        action="store_true",
        help="keep the model's reply text (synthetic) in the --json report",
    )
    parser.add_argument(
        "--show-payloads", action="store_true", help="print the full synthetic payloads in the plan"
    )
    parser.add_argument(
        "--allow-large",
        action="store_true",
        help=f"allow a plan of more than {LARGE_RUN_REQUESTS} requests",
    )
    parser.add_argument("--yes", action="store_true", help="really send the requests")
    return parser


def _split(value: str | None) -> list[str]:
    seen: list[str] = []
    for item in (value or "").split(","):
        item = item.strip()
        if item and item not in seen:
            seen.append(item)
    return seen


def _usage_error(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return EXIT_USAGE


def _write_json(path: str, report: dict[str, Any]) -> bool:
    try:
        Path(path).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot write the --json report ({type(exc).__name__})", file=sys.stderr)
        return False
    return True


def _cmd_list_free(transport: httpx.BaseTransport | None, timeout: float) -> int:
    try:
        entries = fetch_free_catalog(transport, timeout)
    except Exception as exc:
        print(
            f"error: could not read the OpenRouter catalog ({type(exc).__name__})", file=sys.stderr
        )
        return EXIT_CATALOG
    print(render_free_list(entries))
    return EXIT_OK


def _print_plan(
    prepared: Sequence[Prepared],
    models: Sequence[str],
    *,
    runs: int,
    timeout: float,
    pause: float,
    settings: Settings,
    total: int,
    show_payloads: bool,
) -> None:
    print("SYNTHETIC scenarios only: no learner data, account, or real personal data is sent.")
    print(f"models ({len(models)}): " + ", ".join(models))
    print(
        f"timeout {timeout:g}s | max_tokens {settings.QATRA_CHAT_MAX_TOKENS} | temperature 0.2 | "
        f"runs {runs} | pause {pause:g}s | response_format sent only when the model documents it"
    )
    for item in prepared:
        size = len(json.dumps(item.payload, ensure_ascii=False).encode("utf-8"))
        print(
            f"- {item.scenario.id}: {item.scenario.label}; expects {item.scenario.expect}; "
            f"payload {size} bytes; service input guard: {item.input_guard}"
        )
        print(f"    learner text: {item.scenario.message}")
        if show_payloads:
            print("    payload: " + json.dumps(item.payload, ensure_ascii=False))
    minutes = total * pause / 60
    print(
        f"requests to send: up to {total} ({len(models)} models x {len(prepared)} scenarios x "
        f"{runs} runs); about {minutes:.1f} minutes of pacing."
    )
    print(
        f"Uses {total} of the account's shared free daily requests "
        "(live learners draw on the same budget)."
    )


def main(
    argv: Sequence[str] | None = None,
    *,
    settings: Settings | None = None,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.perf_counter,
    today: date | None = None,
) -> int:
    """Entry point; returns the exit code. ``settings``, ``transport``, ``sleep``, ``clock`` and
    ``today`` exist for the tests (no real network is ever needed to test the tool)."""
    parser = build_parser()
    try:
        args = parser.parse_args(list(argv) if argv is not None else None)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else EXIT_USAGE
    try:
        return _run(
            args,
            settings=settings,
            transport=transport,
            sleep=sleep,
            clock=clock,
            today=today,
        )
    except Exception as exc:  # message omitted on purpose: it could echo a secret or provider text
        print(f"unexpected error ({type(exc).__name__})", file=sys.stderr)
        return EXIT_UNEXPECTED


def _run(
    args: argparse.Namespace,
    *,
    settings: Settings | None,
    transport: httpx.BaseTransport | None,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
    today: date | None,
) -> int:
    if settings is None:
        try:
            settings = load_settings()
        except StartupConfigError as exc:
            print(f"error: {exc}", file=sys.stderr)  # variable names only
            return EXIT_NOT_CONFIGURED
    timeout: float = (
        args.timeout if args.timeout is not None else settings.QATRA_CHAT_MODEL_TIMEOUT_SEC
    )

    if args.list_free:
        return _cmd_list_free(transport, timeout)

    models = _split(args.models) or _split(settings.OPENROUTER_MODELS)
    if not models:
        return _usage_error("no candidate models: pass --models or set OPENROUTER_MODELS")
    languages = ("ar", "en") if args.lang == "both" else (args.lang,)
    wanted = _split(args.scenarios)
    unknown = sorted(set(wanted) - {s.id for s in SCENARIOS})
    if unknown:
        return _usage_error(
            "unknown scenario id(s): "
            + ", ".join(unknown)
            + "; known: "
            + ", ".join(s.id for s in SCENARIOS)
        )
    try:
        prepared = prepare_scenarios(today or date.today(), languages, wanted or None)
    except ValueError as exc:
        return _usage_error(f"refusing to send: {exc}")  # names of keys only
    if not prepared:
        return _usage_error("no scenario matches --lang/--scenarios")

    total = len(models) * len(prepared) * args.runs
    _print_plan(
        prepared,
        models,
        runs=args.runs,
        timeout=timeout,
        pause=args.pause,
        settings=settings,
        total=total,
        show_payloads=args.show_payloads,
    )
    if args.pause < 60 / max(1, settings.QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE):
        print(
            f"warning: a pause of {args.pause:g}s may exceed "
            f"{settings.QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE} requests a minute."
        )
    daily_cap = settings.QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY
    if total > LARGE_RUN_REQUESTS and not args.allow_large:
        return _usage_error(
            f"{total} requests is a large share of the account's shared free daily requests "
            f"(live learners use the same budget); more than {LARGE_RUN_REQUESTS} needs "
            "--allow-large"
        )
    if total > daily_cap:
        return _usage_error(
            f"{total} requests exceed the daily free allowance of {daily_cap}; "
            "use fewer models, scenarios (--scenarios, --lang) or --runs"
        )

    key_missing = settings.is_missing("OPENROUTER_API_KEY")
    if not args.yes:
        note = " OPENROUTER_API_KEY is not set yet." if key_missing else ""
        print(f"Dry run: nothing was sent.{note} Add --yes to send these requests.")
        return EXIT_OK
    if key_missing:
        print(
            "error: OPENROUTER_API_KEY is not set (environment or backend/.env); nothing was sent",
            file=sys.stderr,
        )
        return EXIT_NOT_CONFIGURED

    records = run_probe(
        models,
        prepared,
        settings=settings,
        transport=transport,
        runs=args.runs,
        timeout=timeout,
        pause=args.pause,
        sleep=sleep,
        clock=clock,
        include_replies=args.include_replies,
        progress=lambda line: print(line, flush=True),
    )
    summaries = summarize(records, models, timeout)
    order = recommend(summaries, timeout)
    print()
    print(render_report(summaries, timeout))
    print()
    print(recommendation_line(order))
    if args.json:
        report = {
            "tool": "model_probe",
            "synthetic": True,
            "timeoutSec": timeout,
            "runs": args.runs,
            "pauseSec": args.pause,
            "scenarios": [item.scenario.id for item in prepared],
            "requestsPlanned": total,
            "models": [asdict(s) for s in summaries],
            "calls": [asdict(r) for r in records],
            "recommendation": order,
        }
        if not _write_json(args.json, report):
            return EXIT_USAGE
    return EXIT_OK


def _use_utf8_output() -> None:
    """The plan prints Arabic learner text: do not fail on a console that is not UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


if __name__ == "__main__":
    _use_utf8_output()
    raise SystemExit(main())
