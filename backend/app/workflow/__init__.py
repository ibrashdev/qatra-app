"""Content workflow (contract §2, API-spec §5): acquisition, verbatim verification (with the
source-only mode of D83), segmentation, the question bank, validation, the owner's approval and
the publishing SQL file, driven by the job runner.

Invoked only by the operator CLI ``scripts/content_tools.py`` (D48); never by an HTTP route.
The Supabase ``content_jobs`` repository and the private bucket upload are not part of this build,
and ``withdraw``, ``archive`` and ``delete-unused-draft`` come later.
"""
