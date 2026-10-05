"""Support for the B6 journey: the combined fake project of B4 and B5 with the two functions that
package B6 calls. ``OpenSessionFake`` of ``fake_project`` reads ``p_plan_id`` from every function
call, which ``app_apply_events`` and ``app_complete_session`` do not have, so those two go straight
to the fake of the learner state. Test double only: nothing here ran against a Supabase project."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import httpx

from tests.integration.fake_project import FakeProject, OpenSessionFake
from tests.sessions.ss_postgrest import FakePostgrest as BankFake
from tests.sessions.ss_support import HADITH, QURAN

B6_FUNCTIONS = frozenset({"app_apply_events", "app_complete_session"})


class B6OpenSessionFake(OpenSessionFake):
    def _rpc(self, name: str, args: dict[str, Any]) -> httpx.Response:
        if name in B6_FUNCTIONS:
            return BankFake._rpc(self, name, args)
        return super()._rpc(name, args)


class B6Project(FakeProject):
    def __init__(self, bundles: Sequence[dict[str, Any]] = (QURAN, HADITH)) -> None:
        super().__init__(bundles)
        self.bank = B6OpenSessionFake(self.plans, bundles)
        self.plans.sessions = self.bank.tables["learning_sessions"]
        self.plans.attempts = self.bank.tables["attempts"]
