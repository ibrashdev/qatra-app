# Qatra — Architecture consistency pass and approval request

> Version 1 · 4 October 2026 (Asia/Dubai) · Status: **Needs Review — awaiting the owner's explicit approval (gate G0)**. Prepared by the coordinator (Senior Software Architect oversight) with the Solutions Architect role after the consistency pass of the architecture package. Nothing in this file is owner approval, and nothing authorizes code, scaffolding, migrations or deployment. The UI/UX design phase starts only after the owner answers Q1–Q7 below and approves the package.

## 1. Is the architecture phase complete?

**Honest answer: the artifacts are complete and internally consistent; the phase is not closed, because closing it needs the owner's explicit approval (AGENTS.md gate table).** Before this pass the drafts carried 15 recorded differences and 47 open points. After it, every difference is resolved, every architect-level point carries a decision, and the only items left are the seven owner questions in §5 and a short list of items deliberately deferred to implementation or provisioning (§4). The owner's approval of this package is gate G0; the design phase (Role 4) follows it.

## 2. The architecture package (what the owner approves)

| Artifact | Version | What it contains | Status |
|---|---|---|---|
| [Database-schema.md](Database-schema.md) | 1.1 | 3 ERDs, 36 tables, RLS and grants, 19 `srv_*` functions, 6 `app_*` commit functions (design), migration order | Needs Review |
| [API-spec.md](API-spec.md) | 1.1 | 30 HTTP operations (E01–E30), access matrix, validation, error codes, limits, CLI interface, keep-awake job, traceability | Needs Review |
| [Qatra-build-plan.md](Qatra-build-plan.md) | 14 | 45 work packages, complexity, estimates, calendar, scope options A/B/C, coordinator calibration, keep-awake design | Needs Review |
| [Implementation-contract.md](Implementation-contract.md) | 1.3 approved (D69) + §13 proposed v1.4 amendments | Cross-package interfaces; the 8 amendments in §3.3 below are appended as a proposal and do not alter the approved body | v1.3 Approved; §13 Needs Review |
| [Architecture-and-data.md](Architecture-and-data.md), [PWA-design.md](PWA-design.md), [Authentication-and-privacy.md](Authentication-and-privacy.md), [QA-and-evaluation.md](QA-and-evaluation.md), [Programming-guide.md](Programming-guide.md) | bumped by one each | Aligned to the contract and D66–D73 on the points listed in §3.1 | changed sections Needs Review |

Governing inputs, unchanged: PRD v14 (D71, approved analysis), D66–D73, the D36/D54/D60/D61/D65 stack and design direction.

## 3. What the consistency pass decided

The rule applied everywhere: **the approved contract plus the owner's D-decisions win over older documents.**

### 3.1 Differences between sources (API-spec §8.1)

| ID | Difference | Resolution |
|---|---|---|
| C-02 | Password change: re-login or revoke the other sessions | Contract: the other sessions are revoked, the current one gets a new cookie; no re-login. Older documents corrected |
| C-03 | Does plan creation create the first session? | No. `POST /api/plans` returns the plan; `POST /api/sessions` creates sessions |
| C-04, C-05, C-06 | Offline `complete` body, event names, `EventsResponse` shape | Contract names and shapes; PWA-design §5 aligned |
| C-07 | Architecture API table missing endpoints | Table completed; `GET /api/catalog` marked public and metadata-only (D71) |
| C-11 | Offline snapshot error for a stale plan version | `409 version_conflict`; `422` for malformed values, unknown references or scope |
| C-12 | Monitoring window and executor | D70/D72: liveness ping 6–15 Oct (22 Oct if qualified), readiness check through 31 Oct, GitHub Actions |
| C-15 | May demo accounts call `POST /api/plans`? | No (`403 forbidden`, PRD v14 roles matrix); the read-only estimate stays allowed |

### 3.2 Architect-level decisions (all Needs Review at G0)

| ID | Decision | Plain-language meaning |
|---|---|---|
| A-01 | Atomic learner writes through `SECURITY INVOKER` functions `app_*`, run with the learner's own token; daily session get-or-create guarded by a partial unique index | Several rows are saved together or not at all, without giving the server a stronger database role |
| A-02 | Learners read editions that are `published` or `superseded`, pinned to their plan's bank version | A learner's plan keeps working if the content is later replaced; revoked content is never shown |
| A-03 | Login throttle in one-minute buckets, progressive delay, bounded opportunistic purge inside the recording function | Brute-force protection works without a scheduler on the free plan |
| A-04 | Revoked text is refused by the API and redacted from stored snapshots by `srv_redact_revoked_content`, run by the operator `withdraw` command | Withdrawn text does not survive inside offline copies |
| A-05 | Value sets fixed with `CHECK` constraints (statuses, error kinds, AI usage status) | The database rejects unknown states |
| A-06 | Keep-awake: liveness ping every 10 minutes (`4-59/10 * * * *`); readiness check Mon and Thu 06:23 Dubai (`23 2 * * 1,4`), **pending Q3**; dates and URL as non-secret repository variables; target the frontend origin | 5-minute margin against the 15-minute idle stop instead of 1 minute |
| A-07 | The plan's `sessionMinutes` governs the daily goal; the profile value is the default for new plans; a change applies from the next learning day | One clear source for "how many minutes today" |
| A-08 | Plan lifecycle defaults: `POST /api/plans/{id}/resume`; auto-complete when every passage is confirmed; maintenance reviews continue; completed plans cannot be revised. **Owner confirms, Q5** | Fills gaps the analysis left open |
| A-09 | Demo limits defaults: 5 demo accounts per IP per day, 10 demo plans per account per day, agent budget then rules fallback. **Owner confirms, Q6** | Protects the free quotas during judging |
| A-10 | `POST /api/account/delete` replaces `DELETE /api/account` with a body | Some proxies drop bodies on DELETE |
| A-11 | `in_process` content execution removed from the MVP; the operator CLI is the only path | One workflow path to test |
| A-12 | The remaining open points adopt their proposed defaults with concrete, configurable values (limits, rate classes, orderings, time rules, offline caps, enumerations) | Implementation has no undefined behaviour; numbers are settings, not promises |
| A-13 | Logical-to-physical proposals confirmed; `srv_*` stays in `public` with the existing controls | No surprise changes to the approved contract |

Details: Database-schema §15, API-spec §8.2, and the coordinator brief applied in both.

### 3.3 Proposed Implementation-contract v1.4 amendments (not applied before approval)

1. `POST /api/plans/{id}/resume` (A-08).
2. `POST /api/account/delete` replaces `DELETE /api/account` (A-10).
3. Optional `Plan.pendingSessionMinutes` (A-07).
4. Optional `order` in the estimate request and optional `confirmedEstimate` in the revise request.
5. Error codes `forbidden` 403 and `payload_too_large` 413, a `details` shape, and 409 for a stale offline-snapshot plan version.
6. `Idempotency-Key` optional on `complete` only.
7. The enumerations of API-spec O-21 (`rejected`, `pending`, `revalidate` reason codes).
8. `SessionEvent` and `EventsResponse` confirmed as the only names.
9. One exception to the `srv_*` grant rule: `srv_redact_revoked_content` is executable by `service_role` only (the CLI's publishing role); `srv_throttle_record` takes an outcome argument so a successful login clears the username key (A-03).

## 4. Deliberately deferred (not blocking approval)

| Item | Deferred to | Why |
|---|---|---|
| Request timeouts and the Vercel rewrite timeout (O-02) | Backend foundation (B0) | Only measurable on the real services |
| Health `version` source; whether `select 1` counts as database activity (O-08) | Provisioning (G5) | Provider behaviour to verify |
| CLI flag names and exit codes (O-26) | Content workflow package (B7) | Implementation detail |
| Supabase facts: custom role through the pooler, PostgreSQL version, default grants (OPEN-15) | Provisioning | Cannot be checked without a project |
| Embeddings (OPEN-12), feedback feature (OPEN-13), English labels (OPEN-10) | Postponed by D69, D45, D28 | Owner decisions already taken |

## 5. Owner questions (answer to close gate G0)

| # | Question | Default if you answer "best practice" |
|---|---|---|
| Q1 | Scope: **A** (one surah + one hadith), **B** (full sample: Juz' Amma + the Forty, extras deferred), or **C** (full basic version, later)? | B |
| Q2 | Levers: may the pause-after-every-screen rule become a pause after each of 4 screen batches (R1), may up to 4 backend workers run after the migrations (R2), and is the backend scope (G3) granted together with G0? | Yes to all three |
| Q3 | Readiness check twice a week (Mon and Thu) instead of weekly (amends D72's "weekly")? | Twice weekly |
| Q4 | Under the reverse Juz' Amma order, passages inside one surah stay in mushaf order? | Yes |
| Q5 | Plan lifecycle defaults of A-08 (resume endpoint, auto-completion, completed plans not revisable)? | Accept |
| Q6 | Demo limits of A-09 (5 accounts per IP per day, 10 demo plans per account per day, agent budget then rules fallback)? | Accept |
| Q7 | **Approve the architecture package** in §2 (schema v1.1, API v1.1, build plan v14, contract v1.4 amendments) so the UI/UX design phase can start? | — (explicit approval needed; silence is not approval) |

## 6. Timeline, said plainly

- The approved target (basic version 5 October, verification 6 October, D55) and the challenge close (6 October 23:59 Riyadh) are at **very high risk**. No code exists yet, and the design gate plus one owner pause per screen sit on the critical path.
- As estimated (Qatra-build-plan v14): earliest finish about 9 October, latest about 14 October for A or B; C later.
- The coordinator's calibration: the package hours may be pessimistic by up to about 2x for routine coding, but even at 2x capacity the close is reached **only** with the R2 levers (Q2) and an approval this evening, and then with a margin of roughly 13 hours. That is a calculation on unmeasured capacity, not a forecast. The first calibration point (CP1, after the first migrations and the frontend foundation) remeasures it.
- Whether updates after the close count is unknown and is a question for the organizers.

## 7. What happens after approval

1. Record the approval as D74 (Approved) with the answers to Q1–Q7; apply the contract v1.4 amendments to the body; mark the package Approved.
2. Start the UI/UX design phase (Role 4): screen inventory, the six description dimensions, navigation, design system, responsive and interaction states, with the design gate (G1) before any frontend work.
3. In parallel and only if G3 is granted: backend foundation and migrations (B0–B2), Supabase provisioning (G5), content acquisition and verification (C1–C3).
