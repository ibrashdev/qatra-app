# Qatra — Synthetic QA personas (preparation material)

- Version: 0.1
- Date: 2026-10-05 (Asia/Dubai)
- Status: **Draft — Needs Review**
- Build-plan packages served: Q1, Q1b, Q3, Q7 (docs/Qatra-build-plan.md, Phase 7 table)
- Nature of this file: preparation material only. **No test has been executed and nothing has been deployed.** Nothing here is a result, a pass, or evidence of readiness. Personas are descriptions, not fixtures: no fixture files, seed scripts or executable code are created by this document.

## Rules for every persona

1. Every handle below is clearly fake and follows the username policy (3–24 chars; Arabic or English letters, digits, underscore; Authentication-and-privacy.md § «التنفيذ المخطط على Supabase»). No real name, e-mail, phone number, birth date or other personal data is used or may be added (PRD R10, NFR-07).
2. **Passwords are generated at run time and never stored** (not in this file, not in the repository, not in logs). They must be at least 15 Unicode characters and at most 72 UTF-8 bytes (Authentication-and-privacy.md; API-spec E03 `password_min_chars` / `password_max_bytes`). Recovery codes shown once at registration or rotation are likewise handled at run time only and discarded after the case.
3. Persona accounts exist only in a test deployment. Learner free text typed in plan-chat cases must be synthetic goal text (build plan Q7; Plan-conversation.md §3 clause-9 row; QA-and-evaluation.md § «حالات محادثة الخطة»).
4. Role vocabulary follows PRD § «مصفوفة الأدوار والصلاحيات»: visitor, learner, demo account (`is_demo`), content manager (owner; CLI only, D70), content reviewer (owner, D71). The content manager and reviewer have **no application account** (PRD matrix, «التسجيل والدخول والاسترجاع» row), so they appear as an operator persona, not a login.
5. "Seed state" lists the state the persona must be brought to by using the product (register, placement, plan creation, events). If a state can only be reached through a future seeding mechanism, that is listed as an open question rather than invented.

## Persona index

| ID | Handle | Role | Applicability |
|---|---|---|---|
| P-01 | (no account) | Anonymous visitor | Core |
| P-02 | `qa_new_01` | Learner, just registered | Core |
| P-03 | `qa_learner_01` | Learner with an active plan | Core |
| P-04 | `qa_ladder_01` | Learner mid-review ladder (D66) | Core |
| P-05 | `qa_recover_01` | Learner who lost the password and uses the recovery code | Core |
| P-06 | `qa_learner_02` | Second learner (isolation counterpart of P-03) | Core |
| P-07 | `qa_chat_01` | Learner using plan conversation (new plan and revision) | Core (Q7) |
| P-08 | `qa_offline_01` | Offline learner | Conditional — PWA scope (see Open questions OQ-1) |
| P-09 | `qa_demo_01` | Demo (committee) account | Conditional — demo scope (OQ-1) |
| P-10 | (no account; operator CLI) | Content manager / content reviewer (owner) | Core (content integrity) |

---

## P-01 — Anonymous visitor

- **Purpose:** prove what an unauthenticated caller can and cannot do; Origin check on anonymous mutations; catalog is metadata only.
- **Role:** Visitor (not registered). PRD § «مصفوفة الأدوار والصلاحيات».
- **Handle:** none. Browser with no cookie; plus raw HTTP client calls with no cookie.
- **Language / RTL:** run once in Arabic UI (RTL, default) and once in English UI (LTR).
- **Seed state:** none. No account, no cookie.
- **Allowed (per spec):** register with consent box; login and recovery with throttling; read terms and privacy; `GET /api/catalog` metadata only (no religious text, lessons or questions; D71); `GET /api/health`; `GET /api/health/ready` (API-spec E01, E02, E14, matrix §2.2).
- **Denied (per spec):** placement session, plan creation, any Session endpoint (401 `unauthenticated`), content import/publish, other accounts' data.
- **Used by:** Q1 cookie/Origin, Q1 wake-up, Q1 content (catalog metadata exposure), Q3 visitor review area.

## P-02 — New learner

- **Purpose:** registration, consent box (D52), one-time recovery-code display, local-storage hygiene after sign-up, throttle behaviour from a clean state.
- **Role:** Learner (new).
- **Handle:** `qa_new_01` (a second throwaway `qa_new_dup_01` is used only for the duplicate-username case, created by normalization collision, e.g. different letter case).
- **Language / RTL:** Arabic RTL first; repeat registration checks in English LTR.
- **Seed state:** just registered; terms box ticked; recovery code displayed once and acknowledged; no placement, no plan.
- **Allowed:** settings, choose book/edition/minutes, placement session (before a plan), plan conversation (when in scope).
- **Denied:** daily session and games without an active plan (R20; QA «غياب خطة نشطة أو هدف غير مصرح به»).
- **Used by:** Q1 account/auth cases, Q1 privacy/storage cases, Q7 start of journey, Q3 M1 review area.

## P-03 — Learner with an active plan

- **Purpose:** the main "owner" account for isolation tests, event idempotency, forged-field tests and cookie/Origin tests.
- **Role:** Learner.
- **Handle:** `qa_learner_01`.
- **Language / RTL:** Arabic RTL; one pass in English LTR for UI checks.
- **Seed state:** one active plan on a published Quran (Juz' Amma) edition, daily goal 10 minutes, placement completed; at least one open daily session with at least one answered question and one activity interval; a stable set of `clientEventId` values recorded by the test notes (not committed).
- **Allowed:** its own plans/sessions/progress; change password; rotate recovery code; delete account.
- **Denied:** anything about P-06's rows (expected `404 not_found`, indistinguishable from an unknown id, API-spec §1.4); material outside the plan's `target_scope` or edition (`rejected: out_of_scope` / `edition_mismatch`, API-spec E21 O-21 codes).
- **Used by:** Q1 isolation, events, forged `correct`, cookie/Origin, password change (C-02), delete account; Q1b (as online counterpart); Q3 M4–M6.

## P-04 — Learner mid-review ladder

- **Purpose:** mastery rules of D66: stages 1/2/3, round size by part count, one stage per learning day, failure resets before confirmation, maintenance reviews and `needs_refresh`, overall percentage floor.
- **Role:** Learner.
- **Handle:** `qa_ladder_01`.
- **Language / RTL:** English LTR (to cover LTR progress direction) with an Arabic RTL spot check.
- **Seed state (to be reached by play, not fabricated):** Hadith plan (Forty) with several passages of different part counts (≤2, 3–5, ≥6 parts) in different states: one with initial ≥3-correct streak only; one at stage 1 passed; one confirmed (stage 3 plus full part coverage); one in maintenance whose review is due; one `needs_refresh`. Reaching these states requires days of learning dates; the way to advance learning dates in a test deployment is **not specified** (OQ-2).
- **Allowed / denied:** as P-03.
- **Used by:** Q1 mastery/ladder cases, Q3 M5–M6 review area.

## P-05 — Learner who lost the password and uses the recovery code

- **Purpose:** the recovery flow, reset grant, `auth_epoch`, stale sessions, the "no recovery possible without password and code" boundary.
- **Role:** Learner.
- **Handle:** `qa_recover_01` (plus a second browser context holding an older session of the same account).
- **Language / RTL:** Arabic RTL (Arabic-Indic digits in code entry case), English LTR for one pass.
- **Seed state:** registered; recovery code captured once at run time (kept in the tester's memory/notes for the session only); at least two live app sessions (two browsers); one active plan optional.
- **Allowed:** recovery verify/reset with the valid code; login with the new password afterwards.
- **Denied:** reuse of a consumed code; reset after the grant expired (10 minutes); automatic login after recovery (none by design); personal-question recovery (none).
- **Used by:** Q1 recovery cases, Q1 throttle cases, Q3 M1 area.

## P-06 — Second learner (isolation counterpart)

- **Purpose:** the "other account" in every cross-account attempt; also proves RLS with two accounts (NFR-06 item 3).
- **Role:** Learner.
- **Handle:** `qa_learner_02`.
- **Language / RTL:** English LTR (different from P-03 to catch locale leakage).
- **Seed state:** one active plan on the **Hadith (Forty)** edition (different edition from P-03), at least one session with attempts, one plan-chat conversation (optional, for Q7 isolation).
- **Allowed:** own rows only.
- **Denied:** reading or changing P-03's plan, sessions, attempts, snapshots, plan chats (404, no existence leak).
- **Used by:** Q1 isolation, Q1b account-switch case, Q7 chat isolation, Q3 security area.

## P-07 — Learner using the plan conversation

- **Purpose:** Q7 plan-chat cases: guard test set, off-scope redirect, payload privacy, fallback journey, caps, stale proposal, delete-with-account.
- **Role:** Learner (and, when in scope, a revision conversation for a learner with an active plan).
- **Handle:** `qa_chat_01`.
- **Language / RTL:** both: the guard test set runs in Arabic RTL and English LTR (Q7-01 requires both).
- **Seed state:** (a) new-plan journey: registered, start form completed, placement completed, no plan yet; (b) revision journey: one active plan with a short synthetic learning record (the revision payload carries an anonymized record, Plan-conversation.md §2.4 step 3). Goal text is synthetic and logistics-only (e.g. "ten minutes a day, finish by a date"); **no real goal text**.
- **Allowed:** one open conversation at a time; quick replies; confirm (E34).
- **Denied:** religious questions get the fixed D26 message; off-scope gets the redirect line; conversation on a completed plan (409 `plan_not_active`).
- **Environment constraint:** under D76 the judging deployment runs `QATRA_CHAT_MODEL_FOR_LEARNERS=false` (rules-only conversation); the model path is exercised only with a fake provider and synthetic data (Plan-conversation.md §3 clause-9 row). See OQ-3.
- **Used by:** Q7-01…Q7-10, Q1 model-failure cases, Q3 M3/M8 area.

## P-08 — Offline learner (conditional)

- **Purpose:** R23 install, plan snapshot download, cold reopen offline, replay on reconnect, sign-out/switch cleanup.
- **Role:** Learner on an installable device/browser from the D67 install-and-offline list.
- **Handle:** `qa_offline_01`.
- **Language / RTL:** Arabic RTL; one pass English LTR.
- **Seed state:** active plan; snapshot downloaded and `snapshotReady`; at least one prepared daily session and one game session; an outbox with events created offline.
- **Applicability:** PWA (M7) and Q1b are listed only under build option C in the build plan; the owner chose option B (D74). If PWA is not built, P-08 and all Q1b cases stay **Not run — out of built scope** and must be reported as such in Q3, never as passed.
- **Used by:** Q1b cases, Q3 M7 area.

## P-09 — Demo (committee) account (conditional)

- **Purpose:** `is_demo` boundaries: server-enforced `synthetic_demo`, no client mode flag, demo limits, same rights as learner for settings/password/plan edit (D71).
- **Role:** Demo account (created via `POST /api/demo/accounts`, API-spec E26).
- **Handle:** `qa_demo_01`.
- **Language / RTL:** English LTR (committee view) with Arabic RTL spot check.
- **Seed state:** registered through the demo link with the same consent box; scenario selected from fixtures.
- **Applicability:** M9 / demo endpoints are option C only. Plan-Conversation.md §3 states that under option B there are no demo accounts (UA-08 in UI-design.md). If not built: **Not run — out of built scope**.
- **Used by:** forged `synthetic_demo`/`isDemo` case (Q1), demo limits, Q7 matrix row (demo gets D26 message, synthetic context only), Q3 M9 area.

## P-10 — Content manager / content reviewer (operator; no application account)

- **Purpose:** content integrity and publish-gate cases that run through the operator CLI, not the app (D70, D71).
- **Role:** Content manager (owner; developer tools and CLI only) and content reviewer (owner currently).
- **Handle:** none (no application account; the PRD matrix marks login as denied for these roles). Operator uses the local CLI with a local `.env` that is excluded from the repository (QA «الأسرار»).
- **Language / RTL:** n/a (CLI); verified text is Arabic RTL, rendered separately by learners' views.
- **Seed state:** draft editions for Juz' Amma and Forty Hadith at various workflow steps (`uploaded → … → published`), including a deliberately failing literal-verification case and the documented hadith gap (41 of 42 may publish, D68).
- **Allowed:** acquire, verify, segment, build-bank, validate, approve, publish, withdraw, archive (API-spec §5).
- **Denied:** reading learners' accounts; enriching text from other sources; publishing before literal verification.
- **Used by:** Q1 content-integrity cases, Q3 M11 area.

---

## Persona-to-case coverage map (planned)

| Persona | Q1 | Q1b | Q7 | Q3 area |
|---|---|---|---|---|
| P-01 | cookie/Origin, wake-up, catalog | — | — | visitor/M2 |
| P-02 | auth, privacy, storage | — | journey start | M1 |
| P-03 | isolation, events, forged `correct`, password, delete | online counterpart | — | M4–M6 |
| P-04 | mastery ladder | — | — | M5–M6 |
| P-05 | recovery | — | — | M1 |
| P-06 | isolation counterpart | account switch | chat isolation | security |
| P-07 | model failure | — | Q7-01…Q7-10 | M3, M8 |
| P-08 | — | all | — | M7 |
| P-09 | forged demo flag | — | demo row | M9 |
| P-10 | content integrity | — | — | M11 |

## Open questions (not decided here)

- **OQ-1** Scope of PWA and demo: the build plan lists M7/M9 only for option C; the owner chose option B (D74), and D76 forbids code updates after 6 October. Are P-08, P-09 and the Q1b cases to be executed at all, or recorded as Not run — out of built scope?
- **OQ-2** How can a test deployment advance the learning date (needed for stages on days 1/2/4, maintenance at 14/30/60 days, 3-day absence)? The spec defines the rules (QA «حالات قبول السياسات المحدثة», D66), not a test clock mechanism. Do not invent one; ask the owner/backend engineer.
- **OQ-3** Which fake model provider is available in a deployed environment for Q7 (the QA file calls it a test tool, not a real service)? Under D76 the deployed judging build may have no model path.
- **OQ-4** Seeding: the spec states no approved way to create persona states other than normal product use. Whether a fixtures mechanism is permitted for personas is a decision for the manager/owner (this document creates none).
