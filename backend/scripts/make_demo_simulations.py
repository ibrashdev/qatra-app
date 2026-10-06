"""Generator of ``fixtures/demo_simulations.json`` (E29, demo path, WP-B).

The file holds multi-day simulations that are COMPUTED IN ADVANCE from the pure domain rules, on
SYNTHETIC edition-size profiles (``scripts.demo_catalog``), with a SCRIPTED learner. They are never
a live run and never a measurement of a person: every record is labelled ``precomputed_synthetic``
and declares the script that drove it (``learnerScript``).

Run from ``backend/``::

    uv run python -m scripts.make_demo_simulations            # write fixtures/demo_simulations.json
    uv run python -m scripts.make_demo_simulations --check    # exit 1 when the file is stale
    uv run python -m scripts.make_demo_simulations --output PATH

Rules used (all imported, none copied):

- capacity per learning day 12/25/40 words for 5/10/15 minutes (``session_policy.CAPACITY_WORDS``)
  and the plan length ``plan_policy.review_buffered_days`` (it only sets how many days are shown:
  the estimated days plus the 7 days of the review ladder, capped);
- new material: passages still being learned, then new ones, in plan order, up to the capacity; the
  first passage is taken even when it alone exceeds the capacity;
- absence (R07): three or more full days without activity make the day a light review
  (``session_policy.absence_days`` / ``is_light_review_day``): no new material;
- reviews: due rounds, overdue first (ties: plan order), whole rounds while the question total
  stays within ``REVIEW_QUESTION_CAP``; the first round that does not fit ends the step; a round has
  ``review_round_size`` questions;
- the ladder: ``mastery_policy.apply_round`` with real ``PassageMastery`` states (initial evidence
  due after ``REVIEW_INTERVAL_DAYS[0]``, then +2, +4, confirmation, maintenance +14/+30/+60);
- overall progress: ``mastery_policy.summarize_plan_progress`` (D66: floor(100 x confirmed words /
  total words), a ``needs_refresh`` passage is outside the numerator).

The scripted learner: a round or an introduction is correct when ``stable_hash(...) / 10000`` is
below ``dailyCorrectRate`` (a platform-independent hash, so no random generator is involved);
every round and introduction of a day listed in ``errorDays`` fails; a day in ``absentDays`` has no
activity. A passed round clears the error parts it tested (error parts are tested first, as in
``session_policy.rank_parts``).

``adjustment`` of a day (the first that applies): ``absence_light_review`` (light-review day),
``error_priority`` (a passage with error parts was reviewed, so its round targeted them first),
``pace_reduced`` (the plan was revised to a shorter session length and the day runs at the new
pace), else ``null``.

Reproducibility: the output depends on nothing but this file and the imported rules (a fixed
anchor date, no clock, no randomness). The file is written with sorted keys, ``indent=2``,
separators ``(",", ": ")``, UTF-8, a trailing newline and no newline translation.
``contentHash`` is the SHA-256 (hex) of the canonical JSON of the ``simulations`` list:
``json.dumps(simulations, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`` in UTF-8.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any

if __package__ in (None, ""):  # started as ``python scripts/make_demo_simulations.py``
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.domain.learning_state import STREAK_TARGET, PassageMastery  # noqa: E402
from app.domain.mastery_policy import (  # noqa: E402
    REVIEW_INTERVAL_DAYS,
    RoundResult,
    apply_round,
    days_overdue,
    summarize_plan_progress,
)
from app.domain.plan_policy import review_buffered_days  # noqa: E402
from app.domain.session_policy import (  # noqa: E402
    CAPACITY_WORDS,
    is_light_review_day,
    plan_order,
    review_round_size,
    stable_hash,
)
from scripts import demo_catalog as catalog  # noqa: E402

FIXTURE_VERSION = 1
GENERATOR_PATH = "backend/scripts/make_demo_simulations.py"
GENERATOR_VERSION = 1
LABEL = "precomputed_synthetic"
ANCHOR = date(2026, 1, 5)  # only differences between days matter
DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "fixtures" / "demo_simulations.json"

ADJUSTMENT_ABSENCE = "absence_light_review"
ADJUSTMENT_ERRORS = "error_priority"
ADJUSTMENT_PACE = "pace_reduced"

EXIT_OK = 0
EXIT_STALE = 1
EXIT_USAGE = 2


@dataclass(frozen=True, slots=True)
class SimSpec:
    """One scripted simulation. ``pace_change`` is ``(first day, new session minutes)``."""

    scenario_id: str
    title_ar: str
    title_en: str
    profile_name: str
    edition: str  # catalog.JUZ_AMMA | catalog.NAWAWI40
    ordinals: tuple[int, ...]
    path: str
    session_minutes: int
    daily_correct_rate: float
    absent_days: tuple[int, ...] = ()
    error_days: tuple[int, ...] = ()
    pace_change: tuple[int, int] | None = None
    max_days: int = 21

    def minutes_on(self, day: int) -> int:
        if self.pace_change is not None and day >= self.pace_change[0]:
            return self.pace_change[1]
        return self.session_minutes


_TEN_SECTIONS = tuple(range(105, 115))
_ALL_SECTIONS = tuple(range(78, 115))

SPECS: tuple[SimSpec, ...] = (
    SimSpec(
        scenario_id="scenario-03",
        title_ar="وقت قليل: خمس دقائق يوميًا",
        title_en="Little time: five minutes a day",
        profile_name="synthetic-juz-amma",
        edition=catalog.JUZ_AMMA,
        ordinals=_TEN_SECTIONS,
        path="quran",
        session_minutes=5,
        daily_correct_rate=1.0,
        max_days=21,
    ),
    SimSpec(
        scenario_id="scenario-04",
        title_ar="غياب ثلاثة أيام: عودة بمراجعة خفيفة",
        title_en="Three days away: return with a light review",
        profile_name="synthetic-juz-amma",
        edition=catalog.JUZ_AMMA,
        ordinals=_TEN_SECTIONS,
        path="quran",
        session_minutes=10,
        daily_correct_rate=1.0,
        absent_days=(5, 6, 7),
        max_days=14,
    ),
    SimSpec(
        scenario_id="scenario-05",
        title_ar="أخطاء متكررة: الأخطاء أولًا في المراجعة",
        title_en="Repeated errors: mistakes come first in review",
        profile_name="synthetic-juz-amma",
        edition=catalog.JUZ_AMMA,
        ordinals=_TEN_SECTIONS,
        path="quran",
        session_minutes=10,
        daily_correct_rate=0.8,
        error_days=(3, 4, 6),
        max_days=21,
    ),
    SimSpec(
        scenario_id="scenario-06",
        title_ar="خطة كبيرة: أول ثمانية وعشرين يومًا",
        title_en="Large plan: the first twenty-eight days",
        profile_name="synthetic-juz-amma",
        edition=catalog.JUZ_AMMA,
        ordinals=_ALL_SECTIONS,
        path="quran",
        session_minutes=10,
        daily_correct_rate=1.0,
        max_days=28,
    ),
    SimSpec(
        scenario_id="scenario-07",
        title_ar="سورة واحدة: من البداية إلى التثبيت",
        title_en="One surah: from the first day to confirmation",
        profile_name="synthetic-juz-amma",
        edition=catalog.JUZ_AMMA,
        ordinals=(108,),
        path="quran",
        session_minutes=10,
        daily_correct_rate=1.0,
        max_days=21,
    ),
    SimSpec(
        scenario_id="scenario-08",
        title_ar="حديث واحد: من البداية إلى التثبيت",
        title_en="One hadith: from the first day to confirmation",
        profile_name="synthetic-nawawi40",
        edition=catalog.NAWAWI40,
        ordinals=(7,),
        path="matn",
        session_minutes=10,
        daily_correct_rate=1.0,
        max_days=21,
    ),
    SimSpec(
        scenario_id="scenario-09",
        title_ar="تقدير ذاتي مرتفع مع أخطاء: بدء خفيف",
        title_en="High self-rating with errors: a light start",
        profile_name="synthetic-juz-amma",
        edition=catalog.JUZ_AMMA,
        ordinals=_TEN_SECTIONS,
        path="quran",
        session_minutes=5,
        daily_correct_rate=0.75,
        error_days=(3, 6),
        max_days=21,
    ),
    SimSpec(
        scenario_id="scenario-10",
        title_ar="تعديل الخطة: من خمس عشرة دقيقة إلى خمس دقائق من اليوم الثامن",
        title_en="Plan revision: from fifteen to five minutes from day 8",
        profile_name="synthetic-juz-amma",
        edition=catalog.JUZ_AMMA,
        ordinals=_TEN_SECTIONS,
        path="quran",
        session_minutes=15,
        daily_correct_rate=1.0,
        pace_change=(8, 5),
        max_days=21,
    ),
)


def _draw(sim_id: str, kind: str, day: int, index: int) -> float:
    """A reproducible number in ``[0, 1)`` for one scripted event."""
    return (stable_hash("demo-simulation", sim_id, kind, day, index) % 10_000) / 10_000


def simulate(sim_id: str, spec: SimSpec) -> dict[str, Any]:
    """The simulation record of ``spec`` (the schema of demo-decisions, one element)."""
    edition = catalog.harness_editions()[spec.edition]
    passages = catalog.passages_for(edition, spec.ordinals, (spec.path,))
    ordered = plan_order(passages, "book")
    index_of = {p.id: i for i, p in enumerate(ordered)}
    total_words = sum(p.word_count for p in ordered)
    plan_id = ordered[0].id  # any stable id: the pure rules only carry it along
    initial_capacity = CAPACITY_WORDS[spec.session_minutes]
    horizon = min(
        spec.max_days,
        review_buffered_days(total_words, initial_capacity)
        + sum(REVIEW_INTERVAL_DAYS)
        + len(spec.absent_days)
        + len(spec.error_days),
    )
    for scripted in (*spec.absent_days, *spec.error_days):
        if not 1 <= scripted <= horizon:
            raise ValueError(f"{sim_id}: scripted day {scripted} is outside 1..{horizon}")

    mastery: dict[Any, PassageMastery] = {}
    last_active: date | None = None
    days: list[dict[str, Any]] = []
    for day in range(1, horizon + 1):
        on = ANCHOR + timedelta(days=day - 1)
        now = datetime.combine(on, time(12, 0), tzinfo=UTC)
        minutes = spec.minutes_on(day)
        if day in spec.absent_days:
            days.append(_record(day, 0, 0, False, None, ordered, mastery, total_words))
            continue
        light = is_light_review_day(on, last_active)

        due = [p for p in ordered if (row := mastery.get(p.id)) is not None and row.is_due(on)]
        due.sort(key=lambda p: (-days_overdue(mastery[p.id], on), index_of[p.id]))
        reviews = 0
        error_focus = False
        for passage in catalog.rounds_within_cap(due, minutes):
            size = review_round_size(len(passage.parts))
            state = mastery[passage.id]
            error_focus = error_focus or bool(state.error_part_ids)
            index = index_of[passage.id]
            passed = day not in spec.error_days and (
                _draw(sim_id, "review", day, index) < spec.daily_correct_rate
            )
            part_ids = tuple(part.id for part in passage.parts)
            failing: tuple[Any, ...] = ()
            if not passed:
                pick = stable_hash("demo-simulation", sim_id, "part", day, index)
                failing = (part_ids[pick % len(part_ids)],)
            moved = apply_round(
                state,
                RoundResult(passed=passed, failing_part_ids=failing),
                passage_part_ids=part_ids,
                covered_part_ids=part_ids,
                review_date=on,
                now=now,
            )
            if passed:  # a passed round tested the error parts first and clears them
                moved = replace(moved, error_part_ids=moved.error_part_ids[size:])
            mastery[passage.id] = moved
            reviews += 1

        new_words = 0
        if not light:
            capacity = CAPACITY_WORDS[minutes]
            learning = [p for p in ordered if _status(mastery, p.id) == "learning"]
            fresh = [p for p in ordered if _status(mastery, p.id) == "new"]
            chosen: list[Any] = []
            for passage in (*learning, *fresh):
                if chosen and new_words + passage.word_count > capacity:
                    break
                chosen.append(passage)
                new_words += passage.word_count
            for passage in chosen:
                index = index_of[passage.id]
                reached = day not in spec.error_days and (
                    _draw(sim_id, "intro", day, index) < spec.daily_correct_rate
                )
                if reached:
                    mastery[passage.id] = PassageMastery(
                        plan_id=plan_id,
                        passage_id=passage.id,
                        status="reviewing",
                        consecutive_correct=STREAK_TARGET,
                        initial_success_at=now,
                        initial_learning_date=on,
                        review_stage=1,
                        next_review_due=on + timedelta(days=REVIEW_INTERVAL_DAYS[0]),
                    )
                else:
                    mastery[passage.id] = PassageMastery(
                        plan_id=plan_id, passage_id=passage.id, status="learning"
                    )
        last_active = on

        adjustment: str | None = None
        if light:
            adjustment = ADJUSTMENT_ABSENCE
        elif error_focus:
            adjustment = ADJUSTMENT_ERRORS
        elif spec.pace_change is not None and day >= spec.pace_change[0]:
            adjustment = ADJUSTMENT_PACE
        days.append(
            _record(day, new_words, reviews, light, adjustment, ordered, mastery, total_words)
        )

    return {
        "simulationId": sim_id,
        "scenarioId": spec.scenario_id,
        "titleAr": spec.title_ar,
        "titleEn": spec.title_en,
        "label": LABEL,
        "profile": {
            "name": spec.profile_name,
            "totalWords": total_words,
            "sessionMinutes": spec.session_minutes,
        },
        "learnerScript": {
            "dailyCorrectRate": spec.daily_correct_rate,
            "absentDays": list(spec.absent_days),
            "errorDays": list(spec.error_days),
        },
        "days": days,
    }


def _status(mastery: dict[Any, PassageMastery], passage_id: Any) -> str:
    row = mastery.get(passage_id)
    return "new" if row is None else row.status


def _record(
    day: int,
    new_words: int,
    reviews: int,
    light: bool,
    adjustment: str | None,
    ordered: Sequence[Any],
    mastery: dict[Any, PassageMastery],
    total_words: int,
) -> dict[str, Any]:
    facts = summarize_plan_progress(ordered, mastery)
    assert facts.total_words == total_words
    return {
        "day": day,
        "newWords": new_words,
        "reviews": reviews,
        "lightReviewDay": light,
        "adjustment": adjustment,
        "confirmedWordsCumulative": facts.confirmed_words,
        "overallPercent": facts.overall_percent,
    }


# --- the file ---------------------------------------------------------------------------


def canonical_json(value: Any) -> str:
    """The canonical form that ``contentHash`` is computed over."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def content_hash(simulations: Sequence[dict[str, Any]]) -> str:
    return hashlib.sha256(canonical_json(list(simulations)).encode("utf-8")).hexdigest()


def build_fixture() -> dict[str, Any]:
    ordered_specs = sorted(SPECS, key=lambda spec: spec.scenario_id)
    simulations = [
        simulate(f"sim-{number:02d}", spec) for number, spec in enumerate(ordered_specs, start=1)
    ]
    return {
        "fixtureVersion": FIXTURE_VERSION,
        "generator": GENERATOR_PATH,
        "generatorVersion": GENERATOR_VERSION,
        "label": LABEL,
        "contentHash": content_hash(simulations),
        "simulations": simulations,
    }


def render(fixture: dict[str, Any]) -> bytes:
    text = json.dumps(fixture, sort_keys=True, indent=2, separators=(",", ": "), ensure_ascii=False)
    return (text + "\n").encode("utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="make_demo_simulations",
        description="Write fixtures/demo_simulations.json from the pure domain rules.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="file to write (default: fixtures/demo_simulations.json at the repository root)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="write nothing; exit 1 when --output is missing or differs from a fresh build "
        "(a checkout that turned LF into CRLF still counts as equal)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(list(argv) if argv is not None else None)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else EXIT_USAGE
    data = render(build_fixture())
    output: Path = args.output
    if args.check:
        try:
            current = output.read_bytes()
        except OSError:
            print(f"stale: {output} is missing", file=sys.stderr)
            return EXIT_STALE
        if current.replace(b"\r\n", b"\n") != data:
            print(f"stale: {output} differs from a fresh build", file=sys.stderr)
            return EXIT_STALE
        print(f"up to date: {output}")
        return EXIT_OK
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
    except OSError as exc:
        print(f"error: cannot write {output} ({type(exc).__name__})", file=sys.stderr)
        return EXIT_USAGE
    print(f"wrote {output} ({len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()})")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
