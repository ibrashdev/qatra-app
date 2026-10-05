"""An independent strict checker for ``fixtures/demo_simulations.json``.

Written from the "Simulation fixture schema" of the coordinator's demo-decisions (every object has
exactly the listed keys, ``label`` equals ``precomputed_synthetic``, ``overallPercent`` is
``floor(100 * confirmedWordsCumulative / totalWords)``, ``contentHash`` is the SHA-256 of the
canonical JSON of the simulations list) and deliberately NOT using the generator's code, so a
mistake of the generator cannot hide behind itself.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

LABEL = "precomputed_synthetic"
ADJUSTMENTS = {None, "absence_light_review", "error_priority", "pace_reduced"}
TOP_KEYS = {
    "fixtureVersion",
    "generator",
    "generatorVersion",
    "label",
    "contentHash",
    "simulations",
}
SIM_KEYS = {
    "simulationId",
    "scenarioId",
    "titleAr",
    "titleEn",
    "label",
    "profile",
    "learnerScript",
    "days",
}
PROFILE_KEYS = {"name", "totalWords", "sessionMinutes"}
SCRIPT_KEYS = {"dailyCorrectRate", "absentDays", "errorDays"}
DAY_KEYS = {
    "day",
    "newWords",
    "reviews",
    "lightReviewDay",
    "adjustment",
    "confirmedWordsCumulative",
    "overallPercent",
}


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _keys(name: str, value: Any, expected: set[str], problems: list[str]) -> bool:
    if not isinstance(value, dict):
        problems.append(f"{name}: not an object")
        return False
    if set(value) != expected:
        problems.append(f"{name}: keys {sorted(set(value) ^ expected)} differ from the schema")
        return False
    return True


def canonical_hash(simulations: list[Any]) -> str:
    text = json.dumps(simulations, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check(data: Any) -> list[str]:
    """Every way ``data`` departs from the schema (an empty list means it conforms)."""
    problems: list[str] = []
    if not _keys("file", data, TOP_KEYS, problems):
        return problems
    if data["fixtureVersion"] != 1 or not _is_int(data["fixtureVersion"]):
        problems.append("fixtureVersion must be 1")
    if not isinstance(data["generator"], str) or not data["generator"]:
        problems.append("generator must be a non-empty string")
    if not _is_int(data["generatorVersion"]) or data["generatorVersion"] < 1:
        problems.append("generatorVersion must be a positive integer")
    if data["label"] != LABEL:
        problems.append("label must be precomputed_synthetic")
    sims = data["simulations"]
    if not isinstance(sims, list) or not sims:
        problems.append("simulations must be a non-empty list")
        return problems
    if data["contentHash"] != canonical_hash(sims):
        problems.append("contentHash does not match the canonical JSON of the simulations")
    seen_ids: set[str] = set()
    for sim in sims:
        _check_simulation(sim, seen_ids, problems)
    return problems


def _check_simulation(sim: Any, seen_ids: set[str], problems: list[str]) -> None:
    if not _keys("simulation", sim, SIM_KEYS, problems):
        return
    name = str(sim["simulationId"])
    if not re.fullmatch(r"sim-\d{2}", name) or name in seen_ids:
        problems.append(f"{name}: simulationId must be unique and look like sim-NN")
    seen_ids.add(name)
    if not re.fullmatch(r"scenario-(0[1-9]|10)", str(sim["scenarioId"])):
        problems.append(f"{name}: scenarioId must be scenario-01 .. scenario-10")
    for key in ("titleAr", "titleEn"):
        if not isinstance(sim[key], str) or not sim[key].strip():
            problems.append(f"{name}: {key} must be a non-empty string")
        elif "—" in sim[key]:
            problems.append(f"{name}: {key} holds an em dash")
    if sim["label"] != LABEL:
        problems.append(f"{name}: label must be precomputed_synthetic")
    profile, script, days = sim["profile"], sim["learnerScript"], sim["days"]
    total = 0
    if _keys(f"{name}.profile", profile, PROFILE_KEYS, problems):
        if "synthetic" not in str(profile["name"]):
            problems.append(f"{name}: the profile name must say synthetic")
        total = profile["totalWords"] if _is_int(profile["totalWords"]) else 0
        if total <= 0:
            problems.append(f"{name}: totalWords must be a positive integer")
        if profile["sessionMinutes"] not in (5, 10, 15):
            problems.append(f"{name}: sessionMinutes must be 5, 10 or 15")
    if not isinstance(days, list) or not days:
        problems.append(f"{name}: days must be a non-empty list")
        return
    if _keys(f"{name}.learnerScript", script, SCRIPT_KEYS, problems):
        rate = script["dailyCorrectRate"]
        if isinstance(rate, bool) or not isinstance(rate, int | float) or not 0 <= rate <= 1:
            problems.append(f"{name}: dailyCorrectRate must be a number from 0 to 1")
        for key in ("absentDays", "errorDays"):
            values = script[key]
            ok = isinstance(values, list) and all(
                _is_int(v) and 1 <= v <= len(days) for v in values
            )
            if not ok or values != sorted(set(values)):
                problems.append(f"{name}: {key} must be ascending unique days inside the plan")
    previous_confirmed = 0
    for index, entry in enumerate(days, start=1):
        if not _keys(f"{name}.day {index}", entry, DAY_KEYS, problems):
            continue
        if entry["day"] != index:
            problems.append(f"{name}: day numbers must run 1, 2, 3 ...")
        for key in ("newWords", "reviews", "confirmedWordsCumulative", "overallPercent"):
            if not _is_int(entry[key]) or entry[key] < 0:
                problems.append(f"{name}.{index}: {key} must be a non-negative integer")
        if not isinstance(entry["lightReviewDay"], bool):
            problems.append(f"{name}.{index}: lightReviewDay must be a boolean")
        if entry["adjustment"] not in ADJUSTMENTS:
            problems.append(f"{name}.{index}: unknown adjustment")
        if not all(_is_int(entry[k]) for k in ("confirmedWordsCumulative", "overallPercent")):
            continue
        confirmed = entry["confirmedWordsCumulative"]
        if total and confirmed > total:
            problems.append(f"{name}.{index}: confirmed words exceed totalWords")
        if total and entry["overallPercent"] != (100 * confirmed) // total:
            problems.append(f"{name}.{index}: overallPercent is not floor(100 x confirmed / total)")
        if confirmed < previous_confirmed:
            problems.append(f"{name}.{index}: confirmed words decreased")
        previous_confirmed = confirmed
        if entry["lightReviewDay"] and (
            entry["newWords"] != 0 or entry["adjustment"] != "absence_light_review"
        ):
            problems.append(f"{name}.{index}: a light-review day has no new words and says why")
        if entry["adjustment"] == "absence_light_review" and not entry["lightReviewDay"]:
            problems.append(f"{name}.{index}: absence_light_review needs lightReviewDay")
        if (
            isinstance(script, dict)
            and index in (script.get("absentDays") or [])
            and (entry["newWords"] or entry["reviews"] or entry["lightReviewDay"])
        ):
            problems.append(f"{name}.{index}: an absent day has no activity")
