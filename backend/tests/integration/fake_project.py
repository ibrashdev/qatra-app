"""One fake Supabase project for packages B4 and B5 together (``httpx.MockTransport``, no network).

B4's fake serves the catalog views, profiles, plans, versions and the plan functions; B5's fake
serves the bank, the learner state and ``app_open_session``. They share the ``learning_sessions``
and ``attempts`` rows (one database), and ``app_open_session`` is checked against the plan state
of B4's fake, like the migration does: the version id must be the row of the plan's current
version (``QT002`` otherwise, ``P0002`` for an unknown plan).

It is a test double: nothing here was run against a Supabase project.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import httpx

from app.repositories.catalog import MemoryContent
from tests.plans.fake_postgrest import FakePostgrest as PlansFake
from tests.sessions.ss_postgrest import ANON, TOKEN
from tests.sessions.ss_postgrest import FakePostgrest as BankFake
from tests.sessions.ss_support import HADITH, OTHER_USER, QURAN, USER

OTHER_TOKEN = "other-learner-access-token-0002"

PLAN_SIDE = frozenset(
    {
        "catalog_editions",
        "catalog_sections",
        "profiles",
        "master_plans",
        "plan_versions",
        "rpc/app_create_plan",
        "rpc/app_revise_plan",
        "rpc/app_resume_plan",
    }
)


class OpenSessionFake(BankFake):
    def __init__(self, plans: PlansFake, bundles: Sequence[dict[str, Any]]) -> None:
        super().__init__(bundles, user_id=USER, token=TOKEN, anon=ANON)
        self.plans = plans

    def _rpc(self, name: str, args: dict[str, Any]) -> httpx.Response:
        plan_id = args["p_plan_id"]
        if plan_id is not None:
            plan = self.plans.plans.get(plan_id)
            if plan is None or plan["user_id"] != self.user_id:
                return httpx.Response(
                    500, json={"code": "P0002", "message": "plan_not_found", "details": None}
                )
            current = next(
                v
                for v in self.plans.versions
                if v["plan_id"] == plan_id and v["version_no"] == plan["current_version"]
            )
            self.plan_version_in_force = current["id"]
        return super()._rpc(name, args)


class FakeProject:
    def __init__(self, bundles: Sequence[dict[str, Any]] = (QURAN, HADITH)) -> None:
        content = MemoryContent.from_bundles(list(bundles))
        entries = [
            (content.edition(edition.edition_id), content.passages(edition.edition_id))
            for edition in content.editions()
        ]
        self.plans = PlansFake(entries, anon_key=ANON)
        self.plans.add_user(USER, TOKEN)
        self.plans.add_user(OTHER_USER, OTHER_TOKEN)
        self.bank = OpenSessionFake(self.plans, bundles)
        self.plans.sessions = self.bank.tables["learning_sessions"]
        self.plans.attempts = self.bank.tables["attempts"]
        self.requests: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        name = request.url.path.removeprefix("/rest/v1/")
        side = self.plans if name in PLAN_SIDE else self.bank
        return side.handle(request)

    def calls_to(self, fragment: str) -> list[httpx.Request]:
        return [r for r in self.requests if fragment in str(r.url)]
