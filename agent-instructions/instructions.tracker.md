# Qatra — current agent instruction tracker

Updated: 2026-10-04 (Asia/Dubai); reflects owner decisions D66–D69 (AGENTS.md mastery bullet, Roles 01–03). Scope: current instruction state only; application phase status belongs in the readiness tracker.

| Artifact | Current status | Owner / source | Next action |
|---|---|---|---|
| `AGENTS.md` and `CLAUDE.md` | Current process, approval gates, mandatory development-assistant routing, and stack responsibilities | Owner reaffirmation 2026-10-04; D36, D48, D54, D60, D61, D65 | Apply on future tasks and keep aligned with current owner decisions |
| Active-work Git synchronization | Procedure added to root and clean-root `AGENTS.md`; routine scoped commit/push authorization applies within approved task scope, with phase gates preserved. No unattended autosync. | Owner request “sync between them all the time,” 2026-10-04 (Asia/Dubai) | Apply at each verified reviewable step; resolve dirty worktrees/divergence before continuing |
| Task-completion sync and merge | Added to root `AGENTS.md`: when a task is fully complete and verified, merge `origin/main` into the working branch, resolve conflicts, refresh hashes/links, push, then merge into `main` via pull request; gates unchanged | Owner request “add this as instruction when you fully complete any task sync and merge github”, 2026-10-04 (Asia/Dubai) | Apply at the end of every completed task |
| Roles 01–07 | Current role instructions | Named role standards and current project authority | Apply only to bounded, approved work |
| Application phase authority | Analysis, architecture, and design approval gates remain in force; `frontend/` and `backend/` remain Planned | Owner phase policy; D61 and current readiness tracker | Read current authority and approvals before application work |

Use [the application readiness tracker](../docs/Readiness.tracker.md) for artifact approvals, unanswered inputs, and application evidence. Keep credentials, personal data, and local agent/session state out of project context. Read current authority documents before each assigned task.
