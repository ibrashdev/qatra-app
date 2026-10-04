"""Content workflow (contract §2, API-spec §5): acquisition, verification and the job runner.

Invoked only by the operator CLI ``scripts/content_tools.py`` (D48); never by an HTTP route.
B7 provides the core and the ``acquire`` and ``verify`` steps. Segmentation, lessons and the
question bank (B8), publishing and the Supabase ``content_jobs`` repository come later.
"""
