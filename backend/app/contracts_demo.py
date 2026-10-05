"""DTOs of the demo operations E26-E29 (API-spec §4.9; package B10).

Pure pydantic, strict like every request body (API-spec §1.2, S-1): camelCase names only, an
unknown property is ``422`` rule ``forbidden_field`` (so ``isDemo``, ``mode``, ``userId`` or a
free-text goal can never be sent). E26 takes the body of E03 and answers like E03 (the profile
then carries ``isDemo: true``); E28 answers with the ``Plan`` of E16.
"""

from __future__ import annotations

from typing import Annotated, Any
from uuid import UUID

from pydantic import Field, StrictStr

from app.contracts_auth import RegisterRequest, RegisterResponse
from app.contracts_plan_chat import CamelModel, RequestModel, TargetScope

MAX_SCENARIO_ID_CHARS = 100


class CreateDemoAccountRequest(RegisterRequest):
    """E26 body: identical to E03. A demo flag is never accepted."""


class DemoAccountResponse(RegisterResponse):
    """E26 ``201``: ``{profile, recoveryCode}`` with ``profile.isDemo = true``."""


class DemoScenario(CamelModel):
    scenario_id: str
    title_ar: str
    title_en: str
    edition_key: str
    target_scope: TargetScope


class DemoScenariosResponse(CamelModel):
    scenarios: list[DemoScenario]


class CreateDemoPlanRequest(RequestModel):
    """E28 body. The edition, the scope and every other plan parameter come from the fixture; there
    is no goal text. ``scenarioId`` must name a resolvable fixture scenario (otherwise ``422`` rule
    ``unknown_scenario``)."""

    scenario_id: Annotated[StrictStr, Field(max_length=MAX_SCENARIO_ID_CHARS)]
    placement_session_id: UUID | None = None


class DemoSimulationsResponse(CamelModel):
    """E29 ``200``: the ``simulations`` list of ``fixtures/demo_simulations.json`` verbatim."""

    simulations: list[dict[str, Any]]
