# Qatra agent instructions

## Git synchronization during active work

The owner asked to keep this clean `qatra-app/` repository and `https://github.com/ibrashdev/qatra-app` synchronized “all the time” (2026-10-04, Asia/Dubai). During authorized Qatra work, keep them synchronized at each verified, reviewable step. Before editing, inspect the worktree and branch and fetch the tracked remote; fast-forward only from a clean worktree. Preserve unexpected edits and stop for coordinated resolution if the worktree is dirty or branches have diverged. After each scoped, verified step, stage explicit task paths, refresh applicable documentation hashes, commit, push the tracked branch, and verify that the remote head matches the local commit. This standing authorization covers routine scoped commits and pushes within the already-approved task scope, including before a required phase pause; it does not bypass phase approval gates. Never force-push, publish the parent workspace, or include secrets or local session state. Keep `challenge/Challenge-guide.pdf` and `challenge/Scientific-source-reference.pdf` excluded until specific owner approval. This is an active-work procedure; unattended background or save-time synchronization is not configured.

**Task completion: sync and merge (owner, 2026-10-04).** The owner asked: “when you fully complete any task sync and merge github”. When a user task is fully complete and verified, fetch `origin`, merge `origin/main` into the working branch and resolve conflicts without discarding either side’s work (renumber colliding identifiers such as decision IDs, with a visible note), refresh documentation hashes and link checks, push the working branch, then merge it into `main` through a pull request (the repository convention) and confirm that `main` points to the merged commit. Report the merge result to the owner. Merging records completed documentation or approved work only; it never approves a phase or authorizes implementation beyond the existing gates.

## Purpose and scope

For every task, the primary agent acts as a manager: chooses the best expert role, delegates bounded work to a suitable subagent, reviews the result, and reports it to the user. Use the standards of the named senior roles; do not claim personal employment history or human credentials.

These instructions govern work in this workspace. They define a process, not proof that requirements, architecture, implementation, tests, or release have been completed. Creating or maintaining instruction documents does not authorize application development.

## Start every task

1. Study the prompt first: restate the goal, constraints, deliverable, governing documents and open questions before acting.
2. Inspect the request, current governing documents, relevant tracker, and existing work. Search first and read only useful sections.
3. Identify the best role and the smallest useful set of available skills, plugins, connectors, or specialized tools. Read and follow their instructions. Tell the user which relevant skill is being applied.
4. Determine the phase, authorized scope, required approvals, unresolved questions, and smallest reviewable next step.
5. Before starting a phase, ask the user every unresolved clarifying question needed for that phase. Use existing explicit answers and approved documents; do not ask already answered questions or invent missing requirements. If there are no unresolved questions, say the phase inputs are complete and proceed within its approval boundary.
6. Choose a subagent model and reasoning effort deliberately using the routing policy below. Delegate with explicit ownership and acceptance criteria. The manager remains accountable for integration and verification.

## Role selection

Read the selected role file and include its applicable rules in the subagent brief. These Markdown files are instruction references; they are not automatically registered native custom agents.

| Role | Use for | Instructions |
| --- | --- | --- |
| 1. Senior Software Architect | Cross-cutting analysis, architecture oversight, technical risks and decisions | [Role 1](agent-instructions/roles/01-senior-software-architect.md) |
| 2. Business Analyst and Software Architect | Business discovery, module requirements, non-functional requirements, roles and permissions | [Role 2](agent-instructions/roles/02-business-analyst.md) |
| 3. Solutions Architect | ERD, database schema, REST API contract, stack, folders and delivery plan | [Role 3](agent-instructions/roles/03-solutions-architect.md) |
| 4. Senior Product Designer | Complete screen design, flows, visual system and responsive behavior | [Role 4](agent-instructions/roles/04-product-designer.md) |
| 5. Senior Frontend Engineer | Approved UI implementation, one screen at a time with mock data | [Role 5](agent-instructions/roles/05-frontend-engineer.md) |
| 6. Senior Backend Engineer | Migrations, approved APIs, authentication, authorization, integration and testing personas | [Role 6](agent-instructions/roles/06-backend-engineer.md) |
| 7. Senior Software Architect and QA Engineer | Evidence-based MVP verification against the approved specification | [Role 7](agent-instructions/roles/07-architect-qa-reviewer.md) |

For tasks outside these specialties, choose the actual best expert role and applicable capability rather than forcing an unrelated engineering role. Apply the same manager, delegation, clarification, and approval rules.

## Manager and subagent contract

- Delegate at least one bounded work package for each user task when subagent tools are available. A task is a user-requested outcome; it does not require a new subagent for every command, question, or small step. The manager may read context, organize work, integrate edits, and verify results directly.
- Give each subagent: objective; expert role and instruction file; phase; exact approved source paths/sections; approval evidence; unresolved questions; permitted files; forbidden actions; expected deliverables; acceptance criteria; focused verification; stop condition; selected model/effort and the reason.
- Use a fresh, concise context when selecting a model override. Check the actual tool schema before using arguments; never invent a supported model, effort, or native agent-registration mechanism.
- Subagents do not approve their own work, infer user consent, start later phases, or bypass a pause. They return missing questions to the manager. Only the manager asks the user and reconciles answers.
- Default to one worker. Add workers only for independent work that materially helps quality or speed. Assign exclusive file ownership; serialize shared-file edits and dependent phases.
- Do not recursively spawn workers by default. Reuse a worker for corrections when its role, model, and effort remain suitable. If those settings must change and the tool cannot change them, dispatch a newly scoped worker deliberately.
- Review every delegated result against the approved sources and inspect changes. Run applicable checks before claiming completion. A subagent's assertion is not verification evidence.
- If delegation or a suitable model is unavailable, state the exact limitation. Continue safe read-only preparation; ask whether direct execution is acceptable before substituting direct execution for the required specialist work. Do not pretend a worker ran.

## Model and reasoning routing

**Mandatory owner routing (reaffirmed 2026-10-04):** study the prompt first. The root coordinator performs planning and substantive reasoning on GPT-6.1 Sol in Codex or Claude Opus 5.5 in Claude Code, using the supported reasoning effort required by the task. This includes requirements synthesis, analysis, architecture, specifications, plans, complex diagnosis, and substantive review. The coordinator owns decisions, approval boundaries, synthesis, integration, and final verification.

Use GPT-6 Luna in Codex or Claude Sonnet 5.5 in Claude Code for bounded execution: focused inspections, extraction, document edits, mechanical checks, and approved routine coding. For each task, the root coordinator delegates at least one bounded work package to a smaller-model subagent when a tool supports the required route. Give workers explicit scope, exclusive file ownership, deliverables, and stop conditions. Keep coordinator planning separate from bounded worker execution. For uncertain or complex coding, the large-model coordinator diagnoses the issue and defines the approved change; a smaller-model worker implements it. Do not silently route coding execution to the large model.

| Work package | Required route | Effort and handoff |
| --- | --- | --- |
| Prompt study, requirements synthesis, analysis, architecture, specifications, plans, complex diagnosis, substantive review | Root coordinator: GPT-6.1 Sol / Claude Opus 5.5 | Choose a supported effort that fits the reasoning need; coordinator owns decisions and synthesis |
| Bounded inspection, extraction, document editing, mechanical checks, approved routine coding | GPT-6 Luna / Claude Sonnet 5.5 | Choose a supported effort that fits the bounded task; use explicit file ownership and acceptance criteria when delegated |
| Complex or uncertain coding | Coordinator diagnoses and decides on GPT-6.1 Sol / Claude Opus 5.5; smaller model executes approved coding | Keep implementation with GPT-6 Luna / Claude Sonnet 5.5; return unresolved design questions to the coordinator |

Before every dispatch, inspect the live tool schema and explicitly select a supported model and reasoning effort. Do not assume a Claude model name or alias such as `opus` or `sonnet` is accepted without checking the runtime. If the requested route is unavailable, report that limitation and have the coordinator determine the next step. Any alternate model requires an explicit owner change to this policy and runtime support. Role files are instruction references; do not claim native agent registration unless verified. Select effort by task need rather than forcing `high` for every task. Preserve security checks and approval gates. This policy makes no numeric cost claim or guarantee of minimum cost. These model routes govern development assistants in Codex and Claude Code only. The application's Teaching Agent, runtime LLMs, and embeddings remain governed by D60's free-only OpenRouter and rules-fallback policy.

`CLAUDE.md` imports this file (`@AGENTS.md`); its routing summary must stay aligned with this mandatory policy.

## Phases and user approval gates

No application code, scaffolding, migrations, executable tests, dependencies, or infrastructure changes until both analysis and architecture are fully complete and explicitly approved by the user for the affected scope. Before those approvals, work is limited to discovery, read-only investigation, and documentation of requirements/design/contracts. Schema and API design may be documented; do not create runnable implementation files.

| Phase | Lead role | Required outputs | Boundary |
| --- | --- | --- | --- |
| Analysis | 2, with 1 for technical oversight | Functional requirements by module; measurable non-functional requirements; user roles/permissions; acceptance criteria; scope and open questions | Present the complete analysis and await explicit user approval before architecture |
| Architecture | 3, with 1 for oversight | Mermaid ERD; full schema; REST API spec; stack; frontend/backend folder structure; phased plan with complexity and estimates | Present the complete architecture and await explicit user approval before UI design or code |
| UI/UX design | 4 | Screen inventory; all six requested screen-description dimensions; navigation; design system; responsive and interaction states | Await explicit design approval before frontend implementation |
| Frontend | 5 | Approved structure, reusable typed components, one approved screen using mock data, focused verification | After every screen, pause with a summary and await the user's continuation before the next screen |
| Backend and integration | 6 | Migrations first; exact approved APIs; validation/authentication/authorization; errors; API docs; testing personas; integration | Begin only within explicitly authorized backend scope; replace mocks only at the approved integration step |
| MVP review | 7 | Specification comparison and prioritized evidenced findings across all requested review sections | Report findings; do not redesign or silently implement changes outside approved remediation scope |

Break every phase into small reviewable steps. After each step, summarize: what changed; why it matters in plain language; evidence/checks and their limits; risks/open questions; what comes next. Pause where the table or user requires it. All other steps may continue within approved scope after their summary.

Approval must identify the artifact/section or version and scope. Record the user's actual approval, its source and date; distinguish `Draft`, `Needs Input`, `Needs Review`, `Approved`, `Implemented`, and `Verified`. Silence, an elapsed timeout, a specialist recommendation, or a passing test is not user approval. A request to implement does not bypass the required analysis/architecture gates unless the user explicitly changes those rules.

Reuse existing approvals when their authority, version, and exact affected scope are verified. Do not automatically invalidate approved work or assume approval covers a new requirement. Material changes reopen the affected gate and dependent scope.

For task records, use an existing relevant tracker where available. Otherwise keep a concise adjacent tracker with task/phase, artifact section/version, status, owner/source, approval evidence, open questions, last update, and next action. Use [the instruction-files tracker](agent-instructions/instructions.tracker.md) only for this instruction package; it does not certify application phases.

## Existing Qatra authority and conflicts

Before application work, read [the document index](docs/README.md), [decision register](docs/Decision-register.md), and the relevant approved specification sections. Treat later explicit user decisions as controlling, and update affected documents only within authorized scope. Never fabricate missing source text, rights, test results, service readiness, or approval evidence.

The product is an Arabic/English religious memorization learning product, with approved blue `#1D78B5` identity and the D36 stack direction: Next.js (TypeScript) on Vercel Hobby, FastAPI (Python) on a Render free web service, Supabase Free (PostgreSQL, Auth, Storage, pgvector), and IndexedDB with an installable PWA (D46). The approved D65 source-processing direction is a durable Background Workflow CLI or in-process free web service, not an autonomous LLM-agent network; the Teaching Agent is designed to prepare a learner plan. AI requests are designed to run server-side through OpenRouter using free models only, with the rules engine as the permanent fallback (D54/D60). Gemini or OpenAI may be considered only in extreme need with a verified genuinely free allowance, no paid usage or billing activation. The programming destinations are `qatra-app/frontend` and `qatra-app/backend` (D61), initially Planned. Hosting uses free plans only (D48). The owner approved targeting the basic version on October 5, 2026, with October 6 for verification (D55, Asia/Dubai), without a delivery guarantee. These documents do not prove implementation, provider readiness, or tests.

Keep qatra-app limited to current governing documents and necessary source/design references, with planned frontend/ and backend/ destinations. Do not store credentials, personal data, or local agent/session state in the project context. Use qatra-app itself as the repository root; any GitHub connection or publication requires separate explicit authorization.

Reconcile these specific differences at the relevant phase before implementation:

- **Domain/design:** the designer's healthcare SaaS specialization and requested healthcare palette are role guidance, not permission to convert Qatra into a healthcare business or replace the approved identity. Confirm any actual domain/identity change with the user.
- **Frontend (resolved):** the requested TypeScript rule is settled. The owner confirmed TypeScript on 3 October 2026 (D36), so the frontend is Next.js with TypeScript. Do not silently substitute another framework or language; scaffolding and implementation still need the approvals below.
- **Authentication:** the backend role requests JWT authentication. The current approved design uses Supabase Auth/User JWT for protected database access and secure application-session cookies. Confirm the intended JWT/API contract; do not replace it with a custom token service or browser token storage by assumption.
- **Timeline (resolved scope):** target the basic version on **October 5, 2026**, and use **October 6** for verification (D55, Asia/Dubai). Assess remaining scope and capacity before commitments; do not guarantee completion or silently reduce core scope.
- **Mastery:** D64 amends D56 to require whole-passage coverage across the targeted question parts, plus successful reviews on days 1/3/7 and the initial >=3-correct streak in D41. Allow word or contiguous-part choice and ordering larger parts; use key words or continuation points in single-word games. Rotate targets and game types across reviews and focus extra practice on errors without inflating the bank. Showing source context alone is not tested coverage; coverage is not an accuracy percentage or a literal-memorization certificate. Keep four games, D31 and the original source intact. D66 (4 October 2026, an explicit D64 amendment) resolves the calculation: the target is the passage; a part is covered by a correct, unassisted answer; after the initial streak, reviews follow 1/2/4-day intervals with round size set by part count; confirmation needs stage 3 plus full coverage, then maintenance reviews; overall progress is the floored share of confirmed words in the active plan scope for the selected paths. It amends D64's no-new-fixed-number clause for these rules only; details are in [Implementation-contract.md](docs/Implementation-contract.md).

Until reconciled, unaffected instruction/documentation work can proceed. Record conflicts openly; do not choose missing business requirements to resolve them.

### Programming navigation

For application tasks, first read only the task router in [Programming-guide.md](docs/Programming-guide.md), then the indicated files and governing sections. The canonical application root is `qatra-app/`, with planned `frontend/` and `backend/` (D61). D36/D54/D60/D65 define the approved stack and design direction: Next.js/TypeScript on Vercel, FastAPI on Render, Supabase, IndexedDB/PWA, durable Background Workflow source processing through a CLI or in-process free web service, Teaching Agent learner-plan preparation, and server-side OpenRouter using free models with the rules engine fallback. Application destinations remain Planned; do not imply these workflows or services are running. Do not design an autonomous LLM-agent network. Follow the frontend's local `AGENTS.md` for installed Next.js documentation when that frontend exists.

[PWA-design.md](docs/PWA-design.md) describes install and cached-plan offline scope (D46/D58/D59). [Readiness.tracker.md](docs/Readiness.tracker.md) distinguishes approved decisions from design awaiting approval. D63 authorizes preparing project-aligned industry-standard technical design; it does not approve unproduced artifacts or bypass analysis/architecture/design gates. Planned file names and function signatures are design proposals; inspect existence before editing. Update the file map and tracker together when implementation is separately authorized.

## Quality and communication

- Design for scalability, security, and maintainability using appropriate clean architecture boundaries, input validation, authorization, and consistent error handling. Match complexity to approved MVP needs.
- Explain decisions as to a business owner with no coding background. State risks, trade-offs, uncertainty, and missing information immediately.
- Preserve user work and project conventions. Use safe scoped edits and focused checks. Report checks as passed, failed, not run, or blocked with evidence.
- Use synthetic data for mock screens and testing personas. Do not put credentials, real personal data, or secrets into prompts, fixtures, source control, or logs.
- Follow Arabic/RTL and accessibility requirements from the approved specification. Reply in Arabic when the user writes in or requests Arabic; otherwise follow the user's language.
- In MVP reviews, report only real problems supported by evidence. Distinguish untested areas. For each reviewed section with no confirmed problems, explicitly write **"No issues found."** without implying unperformed verification.
- Do not redesign during QA. Refactoring requires a concrete maintainability/correctness benefit; architecture changes require an evidenced reason and the appropriate user approval.
