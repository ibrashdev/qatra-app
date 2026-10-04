# Qatra — Claude Code instructions

@AGENTS.md

The project instructions live in AGENTS.md and are imported above, so every Claude Code session starts with its current version. If AGENTS.md changes during a session, re-read it before the next task step and follow the newer text.

## Model routing (owner instruction, reaffirmed 2026-10-04)

For every task:

1. Study the prompt first: restate the goal, constraints, deliverable, governing documents and open questions before acting.
2. The root coordinator performs planning and substantive reasoning — requirements synthesis, analysis, architecture, plans, specifications, complex diagnosis, substantive review, decisions and final verification — on Claude Opus 5.5 or GPT-6.1 Sol, using an effort supported by the runtime and suited to the task.
3. Bounded inspections, extraction, document edits, mechanical checks and approved routine coding use Claude Sonnet 5.5 or GPT-6 Luna, with a supported effort suited to the task. For each task, the root coordinator delegates at least one bounded work package to a smaller-model subagent when a tool supports the required route. Use explicit scope and exclusive file ownership. For complex or uncertain coding, the coordinator diagnoses and decides first; a smaller-model worker performs the approved implementation.
4. Before every dispatch, check the live tool schema and explicitly choose a supported model and effort. Do not assume aliases such as `opus` or `sonnet` resolve without checking the runtime. Any alternate model requires an explicit owner change to this policy and runtime support. Do not claim native agent registration unless verified. Select effort by task need rather than forcing `high` for every task. These instructions make no numeric cost claim or guarantee of minimum cost. These development-assistant routes do not select the application's Teaching Agent, runtime LLM, or embedding model; those remain subject to D60's free-only OpenRouter and rules-fallback policy.

Read role files as instruction references. Each worker reads AGENTS.md first.

## Clean project context

The application root is `qatra-app/` (D61), with current governing documents and necessary source/design references. Planned application destinations are `frontend/` and `backend/`. Do not store credentials, personal data, or local agent/session state in the project context. Any GitHub connection or publication requires separate explicit authorization. D55 targets the basic version on 5 October 2026 and verification on 6 October; D60 permits free-only AI. Preserve phase approval gates. The approved design direction uses Next.js/TypeScript on Vercel, FastAPI on Render, Supabase, IndexedDB/PWA, and server-side OpenRouter with free models and the rules engine fallback. Source processing is planned as a durable Background Workflow CLI or in-process free web service, not an autonomous LLM-agent network; the Teaching Agent is designed to prepare learner plans. The `frontend/` and `backend/` destinations remain Planned.
