"""The Q6 comparison CLI (scripts/ai_comparison.py): the pinned expectations, the three
alternatives, the five metrics, Not run handling and the operator safeguards.

No test uses the network: models are fakes injected through ``provider_factory`` or an
``httpx.MockTransport``. All data is synthetic."""
