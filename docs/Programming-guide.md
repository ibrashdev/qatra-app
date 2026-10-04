# Qatra — Programming Guide and Task-to-File Router

Version 11 · 2026-10-04 · design documentation only.

The application documentation root is `qatra-app/`, with `frontend/` and `backend/` as planned destinations (D61). Every application file/path below is **Planned**. Keep this root limited to current governing documents and necessary source/design references until application work is authorized. Do not store credentials, personal data, or local agent/session state here. GitHub connection or publication requires separate explicit authorization.

D63 authorizes aligned technical design preparation, not approval of unproduced artifacts or a waiver of the analysis, architecture and UI gates. [Readiness.tracker.md](Readiness.tracker.md) records review status. D55 targets a basic version on 5 October 2026 and verification on 6 October, Asia/Dubai; capacity, source evidence and approvals still constrain feasibility. Dates are not guarantees.

## 1. Start here: narrow task router

Paths are relative to `qatra-app/`, all Planned. Read the named authority and responsibility first, and inspect actual existence before later edits. Do not implement unresolved business rules by guessing.

| Task | Proposed files/responsibilities | Governing authority and intended checks |
|---|---|---|
| Authentication/recovery/logout | `backend/app/{routers,services}/auth.py`, `repositories/accounts.py`, `providers/supabase_auth.py`; `frontend/src/components/auth/AuthForm.tsx` | Authentication-and-privacy: Supabase User JWT server-side, HttpOnly application cookie, recovery concurrency, Origin, auth epoch and terms consent |
| Settings/deletion | `backend/app/{routers,services}/account.py`; `frontend/src/app/settings/page.tsx`, `src/lib/offline/db.ts` | D52/D57/D58: next-learning-day settings effect, account purge and reconnect limitation |
| Goal/placement/estimate/plan | `backend/app/{routers,services}/plans.py`, `domain/plan_policy.py`, `repositories/plans.py`; `frontend/src/components/plans/PlanBuilder.tsx` | PRD R01/R02/R14/R20; D42/D57: owned placement, estimate read-only, one active plan, immutable histories |
| Daily progress | `backend/app/{routers,services}/progress.py`, `domain/time_policy.py`, `repositories/progress.py`; `frontend/src/components/progress/ProgressSummary.tsx` | D40/D57: games alone suffice, no overlap/replay/zone-change double credit or retroactive target rewrite |
| Confirmed mastery | `backend/app/domain/mastery_policy.py`, `services/sessions.py`, `repositories/progress.py` | D41/D64: initial ≥3 consecutive correct answers is preliminary evidence; the targeted passage needs full cumulative coverage through training/reviews and successful reviews on days 1/3/7. `word_choice` accepts a word or contiguous source segment; question-to-segment evidence and round sizing are Needs Review. STOP on unresolved mastery-target grouping, overall ratio denominator/weight, or later-review failure effect. Displayed source text alone is not coverage evidence. |
| Source-bound games | `frontend/src/{components,lib}/games/`; `backend/app/services/sessions.py`, `domain/{answer_policy,plan_policy}.py` | D20/D22/D31/D42: unchanged source, in-plan targets, future-day play, transient answers, provisional local feedback |
| Sources/import/publication | `backend/app/workflow/{runner,content_management,lesson_question_builder,validation}.py`, `repositories/content.py`, `scripts/content_tools.py` | D25/D37/D44/D62/D64: edition/rights/pages evidence and whole unchanged source; resumable workflow. Use larger ordered segments and focused keyword/continuation prompts to cover each targeted passage cumulatively with little repetition; suitability by source section and segment/evidence representation remain Needs Review. Preserve the four existing games and D31; do not add a game or change `game_kind` because `word_choice` accepts a segment. |
| External AI | `backend/app/services/planner.py`, `domain/planning_rules.py`, `providers/{llm,openrouter}.py`, `repositories/ai_usage.py` | D17/D38/D60: free-only budget0, OpenRouter primary, rules fallback; optional extra provider only when actual free eligibility verified |
| Install/offline/update | `frontend/src/app/{manifest.ts,offline/page.tsx}`, `src/components/pwa/OfflineShell.tsx`, `src/lib/{pwa,offline}/`, `scripts/build-sw.mjs`; `backend/app/{routers,services}/offline.py` | PWA-design: complete shell/snapshot, no personal API/Auth cache, accepted D58 limitation, selected devices still Needs Input |
| Queue/reconnect | `frontend/src/lib/offline/{outbox,sync}.ts`; `backend/app/services/{offline,sessions}.py` | D59: verified old events in original plan/version only; disputed pending; device timestamps are not proof |
| First request/free-server wake-up | `frontend/src/lib/api/client.ts`, `src/components/ui/StatusMessage.tsx`; `backend/app/routers/health.py` | D48: short requests/backoff/waking state, timeout does not revoke snapshot or delete queue; deployment checks later |
| Arabic/English/RTL | `frontend/src/i18n/messages.ts`, `src/components/ui/AppShell.tsx` | UX/Design-system/D28/D49: original Arabic stays RTL; translated books deferred |
| Conditional feedback/admin | Conditional modules in section 6 | D43–D45/Additional-features: feedback first, no proof of Day-1 gate yet |

## 2. Authority, gates and dependency direction

Read [README.md](README.md), [Decision-register.md](Decision-register.md), the affected [PRD.md](PRD.md) requirement, then the relevant [Architecture-and-data.md](Architecture-and-data.md) section. [PWA-design.md](PWA-design.md), [AI-agent.md](AI-agent.md), [Content-and-sources.md](Content-and-sources.md) and [Authentication-and-privacy.md](Authentication-and-privacy.md) own their policies. [QA-and-evaluation.md](QA-and-evaluation.md) owns future evidence; UX/Design-system own screens. This router does not approve a screen, schema or endpoint.

Current stack D36/D48/D60/D65: Next.js App Router/TypeScript on Vercel Hobby; FastAPI/Python on a Render free web service; Supabase Free PostgreSQL/Auth/Storage/pgvector; server-side OpenRouter with eligible free models and permanent rules fallback. Additional Gemini/OpenAI adapters are optional, not connected or assumed free. No paid fallback, custom JWT issuer or browser token storage. Content preparation is a resumable Background Workflow (CLI or bounded in-process invocation) with its cursor in Supabase; it has no separate free-plan worker and is not promised to run through Render suspension/restart. The workflow's content-management and lesson/question-preparation names denote software stages, not autonomous LLM services. Teaching Agent (D38) is a separate plan role that consumes published content and learner progress and chooses existing IDs and review timing; during the challenge, model calls are synthetic demo only (D17).

Browser → same-origin `/api/*` forwarding → FastAPI. Application HttpOnly cookie stays on frontend origin; Supabase User JWT remains server-side for RLS. Service-role use is restricted by the auth/content authority. Verify provider forwarding/cookies/Origin/trusted IP handling later; design prose does not prove deployment behavior. Do not create a second business API in Next route handlers or Server Actions.

Frontend: route → focused component → API/offline client. Backend: router/DTO → service transaction → domain policy plus repository/provider. Domain does not import FastAPI or DB clients. Repositories persist facts; providers isolate external calls. Game components never award authoritative time/mastery. Keep layers proportional to actual responsibility.

| Input/review boundary | Settled policy | Still incomplete |
|---|---|---|
| D41/D64 mastery | Three consecutive correct answers are preliminary evidence; cumulatively cover the targeted passage through training/reviews, plus successful reviews on days 1/3/7; unchanged source and little repetition | Mastery-target grouping, overall ratio denominator/weighting and later-review failure effect are Needs Input. Segment-to-question evidence and round sizing are Needs Review; affected calculation stops until resolved. |
| D57 goal/day | Daily minutes/time-zone changes next learning day; history fixed, no retroactive or duplicate credit | Effective-date/time-zone DTO/schema and uncertain offline-clock adjudication require completed review |
| D58/D59 offline | Device-holder access and remote-action delay accepted; no new lock/expiry; verified prior events in original plan | Local-download rights, verifiability/ordering, prepared-session lifecycle, transfer sizing, schema compatibility and device matrix |
| Answer policy | Immutable original; server correction; local provisional feedback | Normalization tolerances and ambiguous-answer rejection before affected grading |
| D62 sources | Eligible scientific-guide sources approved | Actual edition, numbered pages, reproduction/download rights and comparison evidence before publication |
| APIs/schema | Responsibility and invariants documented | Missing DTO types/limits/statuses/pagination/concurrency/constraints completed before affected implementation |
| Conditional extras | D43–D45 remain conditional | No invented proof, roles/retention/limits |

## 3. Proposed clean layout and status

All application paths are Planned; this map is not an instruction to scaffold now. Choose exact dependencies from current official documentation during authorized setup.

```text
qatra-app/
  docs/                         curated product/design authorities and trackers
  frontend/                     Planned Next.js/TypeScript
    src/app/                    routes/layout/manifest/public offline entry
    src/components/{auth,plans,progress,games,pwa,ui}/
    src/lib/{api,games,offline,pwa}/
    src/i18n/                   reviewed static UI messages
    scripts/                    future reviewed SW build generator
    public/                     static assets; sw.js later build output
    tests/                      future focused evidence
  backend/                      Planned FastAPI/Python
    app/{routers,services,domain,repositories,providers,workflow}/
    scripts/                    future content CLI → workflow runner
    tests/                      future focused evidence
  supabase/migrations/          Planned only, no migrations now
  fixtures/                     Planned synthetic scenarios only
```

Keep one shared migrations/fixtures path, and frontend/backend tests only. `docs/` is a curated authority destination, not proof of completed approval. Keep the planned structure aligned with approved documents and update concrete existence/status only after authorized implementation.

## 4. Proposed frontend file contracts

All names/signatures in this section are **Planned / PROPOSED**; no application symbols are present in the clean root. API DTOs must match the reviewed backend contract; `contracts.ts` does not license inventing one. Network failure → explicit retry/pending state; 401 → online reauthentication state; 409 → version conflict; no pretending local success is server acknowledgment.

| Exact file (`frontend/`) | Proposed symbols, input/output, invariant and code owner |
|---|---|
| `src/app/page.tsx` | Planned product `Home` directs online/offline state without changing server facts and shows the D48 waking state when the free server is asleep; frontend |
| `src/app/layout.tsx` | Planned metadata/RootLayout for approved navigation, locale and PWA registration; no personal snapshot serialized into public static shell; frontend |
| `src/app/globals.css` | Approved blue identity, RTL/LTR, focus/contrast/reduced motion; no game logic; frontend/design |
| `src/app/manifest.ts` | Default `manifest():MetadataRoute.Manifest`; identity/start route/icons from reviewed PWA design; public metadata only; frontend/PWA |
| `src/app/error.tsx` | Default `ErrorBoundary({error,reset})`; safe message/retry, no raw server/secrets; frontend |
| `src/app/loading.tsx` | Default `Loading()`; accessible progress placeholder, no invented completion; frontend |
| `src/app/login/page.tsx` | Default `LoginPage()`→AuthForm login mode; network required; frontend |
| `src/app/register/page.tsx` | Default `RegisterPage()`→register mode plus terms and RecoveryCode; D52: required, unchecked-by-default checkbox «قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها» with links to the terms/privacy page before the create-account button (same for demo signup); never silently persist recovery code; frontend |
| `src/app/recovery/page.tsx` | Default `RecoveryPage()`→RecoveryForm; short server grant only, network required; frontend |
| `src/app/setup/page.tsx` | Default `SetupPage()`→PlanBuilder; catalog→placement→estimate→confirmed plan; no offline plan creation; frontend |
| `src/app/today/page.tsx` | Default `TodayPage()` reads reviewed today DTO, presents session/download entry; no GET writes; frontend |
| `src/app/sessions/[id]/page.tsx` | Default `SessionPage` reads ID using verified Next conventions selected at authorized setup, mounts owned prepared session; unavailable snapshot/network shows honest state; frontend |
| `src/app/games/page.tsx` | Default `GamesPage()` lists allowed active-plan targets, future-day content allowed; no independent book picker for personal play; frontend |
| `src/app/progress/page.tsx` | Default `ProgressPage()`→ProgressSummary; authoritative response online, provisional label offline; frontend |
| `src/app/settings/page.tsx` | Default `SettingsPage()`→SettingsForm; zone/goal edits STOP at D40 policy gate; frontend |
| `src/app/privacy/page.tsx` | Default `PrivacyPage()` displays reviewed fixed terms/privacy text; no generated religious/legal prose; frontend |
| `src/app/offline/page.tsx` | Default `OfflinePage()` mounts public client-only OfflineShell; no server cookie-dependent personal HTML cached; frontend/PWA |
| `src/app/demo/page.tsx` | Default `DemoPage()` selects server-owned scenarios and reads labeled ready-made simulations; no client mode/is_demo override; frontend |
| `src/components/ui/AppShell.tsx` | `AppShell({children,locale,activeRoute,profile,dueReviews})`; navigation/static UI locale and direction; show D34 in-app due-review reminder when opened using server-confirmed dueReviews and reviewed profile settings; no push/email subsystem or unapproved goal/time-zone mutation; frontend |
| `src/components/ui/StatusMessage.tsx` | `StatusMessage({status,message})`; accessible saved/pending/error wording, no false cloud-save label; also the D48 waking state «جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.» as a non-error loading status; frontend |
| `src/components/ui/SourceReference.tsx` | `SourceReference({edition,pageSpans,reference})`; canonical metadata only, cannot infer pages; frontend |
| `src/components/auth/AuthForm.tsx` | `AuthForm({mode})`; submit reviewed credentials payload; in register mode renders the D52 terms checkbox (required, unchecked by default, no registration without it) and sends the accepted terms version; handles a re-consent prompt after a major terms change; returns UI state/server response to route, secrets held only transiently; frontend |
| `src/components/auth/RecoveryForm.tsx` | `RecoveryForm()`; verify→reset grant flow, transient values, generic failures; frontend |
| `src/components/auth/RecoveryCode.tsx` | `RecoveryCode({code,onAcknowledge})`; one-time display/copy/download under user action; no IndexedDB/logging; frontend |
| `src/components/plans/PlanBuilder.tsx` | `PlanBuilder()` orchestrates placement/estimate/confirmation; no plan save without confirmed estimate, conflict shown; no AI-assistant checkbox/toggle (D51), shows the fixed transparency line instead; frontend |
| `src/components/sessions/LearningSession.tsx` | `LearningSession({snapshot,onPendingEvent})`; review/new/training from fixed source refs; pause/resume/time intervals; local answers provisional; shows the edition's takhrij as written, and the fixed D50 notice beside a hadith only when its edition cites neither the Sahihayn (Bukhari/Muslim) nor a grade (D53); frontend |
| `src/components/progress/ProgressSummary.tsx` | `ProgressSummary({progress,provisional})`; daily percent cap plus extra time separately; initial/confirmed mastery distinct; ratio gate enforced; frontend |
| `src/components/settings/SettingsForm.tsx` | `SettingsForm({profile})`; allowed edits/password/logout/delete; require online mutation acknowledgment and local purge; shows the fixed AI transparency line, no AI toggle (D51); frontend |
| `src/components/games/GameHost.tsx` | `GameHost({session,onAnswer,onActivity})`; dispatch one of four templates, owns UI pause/input state, no server correctness authority; frontend |
| `src/components/games/OrderWords.tsx` | `OrderWords({question,onSubmit})`; emits ordered token refs, original never overwritten; frontend |
| `src/components/games/ChooseWord.tsx` | `ChooseWord({question,onSubmit})`; emits option ref from exact edition; under D64 an option may be a word or contiguous source segment. Multi-token option representation is Draft / Needs Review; frontend |
| `src/components/games/DistinguishSimilar.tsx` | `DistinguishSimilar({question,onSubmit})`; displays source and permitted error option, marks error after answer; no LLM distractors; frontend |
| `src/components/games/RecallWord.tsx` | `RecallWord({question,onSubmit})`; one transient word answer, approved hint only; no cloud free-text storage; frontend |
| `src/components/pwa/OfflineShell.tsx` | `OfflineShell()` reads committed owner-bound snapshot; unavailable/pending states and account-clear failure handling; no added offline lock; no automatic new server sessions; frontend/PWA |
| `src/components/pwa/InstallPrompt.tsx` | `InstallPrompt()` displays supported installation action/help, not a universal browser promise; frontend/PWA |
| `src/components/pwa/UpdateNotice.tsx` | `UpdateNotice({updateState,onApply})`; user-visible safe activation under PWA design, protect outbox; frontend/PWA |
| `src/i18n/messages.ts` | Typed static `UiMessages`, `getMessages(locale):UiMessages`, `directionForLocale(locale):"rtl"|"ltr"`; Arabic/English UI copy only, approved religious UI terminology follows D28. Never translates or rewrites canonical religious content; Arabic source components remain RTL independently of UI locale; frontend/localization |
| `src/lib/api/contracts.ts` | Typed DTOs `Profile`, `Plan`, `SessionSnapshot`, `TodayProgress`, `ApiError` from reviewed Architecture contract; compile-time types + runtime validation strategy Needs Review; frontend/API owner |
| `src/lib/api/client.ts` | `requestApi<T>(path,options):Promise<T>` same-origin fetch with cookie; reject structured safe ApiError; no direct Supabase/Render browser calls, no automatic non-idempotent retries; proposed D48 helper `waitForApiReady(onWaking):Promise<void>` repeating short `GET /api/health` calls with backoff (never one long request) until the free server answers, then resolving; never changes snapshot state on timeout; frontend/API |
| `src/lib/games/types.ts` | `GameKind`, `GameQuestion`, `AnswerSubmission`, `ActivityInterval`; refs/version/target identifiers, transient answer semantics; frontend |
| `src/lib/games/evaluation.ts` | `evaluateProvisionalAnswer(question,answer,normalizationPolicy):ProvisionalFeedback`; question is the downloaded game descriptor containing server-issued normalizationPolicyVersion/scoringPolicyVersion. Validate policy match and all four template answer shapes/allowed source refs; D64 permits a word or contiguous source segment for `word_choice`, with multi-token option/answer representation Draft / Needs Review. Normalize a transient recall word under the issued policy without altering original source. Missing/unsupported policy yields unavailable feedback, never guessed correctness. Returns local correct/needs-review feedback only, never authoritative time/streak/mastery; no raw-word logging. Offline raw-answer retention/replay follows the reviewed PWA contract; frontend/games |
| `src/lib/games/session.ts` | `createAnswerEvent(session,answer):OfflineEvent`, `createActivityEvent(session,interval):OfflineEvent`; stable event UUIDs, owner/plan/session refs; no authoritative correct/mastery fields; frontend |
| `src/lib/offline/types.ts` | `PlanSnapshot`, `CacheResult`, `OfflineEvent`, `PendingEvent`, `SyncResult` aligned to PWA-design; OfflineEvent is the event payload, PendingEvent is the durable queue record wrapping ownerId/state plus OfflineEvent; frontend/PWA |
| `src/lib/offline/db.ts` | `openOfflineDb():Promise<IDBDatabase>`, `clearAccountCache(ownerId):Promise<void>`; reviewed schema upgrades, transactional account purge; no credentials or shared-account namespace; frontend/PWA |
| `src/lib/offline/plan-cache.ts` | `cacheActivePlan(snapshot):Promise<CacheResult>`, `readReadyPlan(ownerId):Promise<PlanSnapshot|null>`; commit ready only after complete integrity/schema/owner checks; unavailable/expired never presented as ready; frontend/PWA |
| `src/lib/offline/outbox.ts` | `enqueueEvent(ownerId,event:OfflineEvent):Promise<void>`, `listPending(ownerId):Promise<PendingEvent[]>`, `acknowledgeEvents(ownerId,ids):Promise<void>`; preserve stable IDs, remove only after server acknowledgment; frontend/PWA |
| `src/lib/offline/sync.ts` | `syncForeground(ownerId):Promise<SyncResult>`; online identity→snapshot/session revalidation→original events replay under D59→ack/pull state; retry/pending disputes explicit; retain verifiable prior events in original plan only; no background-sync assumption; a D48 wake-up timeout is not a revalidation result and never marks a snapshot stale/revoked/expired; frontend/PWA |
| `src/lib/pwa/register.ts` | `registerServiceWorker():Promise<ServiceWorkerRegistration|null>`; supported secure context only, safe registration error; frontend/PWA |
| `src/lib/pwa/update.ts` | `inspectUpdate(registration):UpdateState`, `applyUpdateWhenSafe(registration):Promise<void>`; reviewed compatibility/outbox policy before activation, no unconditional skipWaiting; frontend/PWA |
| `scripts/build-sw.mjs` | `buildServiceWorker(buildArtifacts):BuildResult` (proposed script entry); generate complete public-shell asset allowlist and build/version identity; fail on missing artifacts or private routes/API inclusion; frontend/PWA |
| `public/icons/icon-192.png`, `icon-512.png`, `maskable-512.png` | Maintained approved-identity install assets; design owner, validate dimensions/maskable safe area; not created here |

`public/sw.js` is generated from the reviewed build strategy. Install/activate/fetch listeners must serve only the public shell and verified static allowlist, not arbitrary cached navigations, authenticated HTML, RSC payloads or `/api/*`. Its precise Next production artifact collection and safe update policy are gated by PWA-design; a handwritten wildcard cache is not an acceptable substitute.

<a id="backend"></a>
## 5. Proposed backend file contracts and endpoint routing

The following modules and callable signatures are **PROPOSED**. DTO names indicate ownership, not completed schemas. Use the exact fields, auth/ownership, status/error and concurrency rules in “عقود API المخططة” in Architecture; unresolved contracts are affected implementation stops. A router parses input, resolves server identity, invokes a service and serializes its result; it does not hold transaction or mastery logic.

| Exact file (`backend/app/`) | Proposed callable contract and invariants; owner |
|---|---|
| `contracts.py` | Pydantic request/response DTOs for reviewed endpoint contracts, UUID/reference/version types; reject unknown/untrusted authority flags; backend/API |
| `errors.py` | `AppError(code,status,safe_detail)`, `install_error_handlers(app)`; consistent safe errors, no token/free-text diagnostics; backend |
| `dependencies.py` | `require_session(request)->SessionContext`, `require_content_operator(context)->OperatorContext`, `require_valid_origin(request)->None`; cookie/epoch/expiry, ownership from server only; backend/security |
| `routers/auth.py` | `register`, `login`, `verify_recovery`, `reset_password`, `rotate_recovery`, `change_password`, `logout`; auth services, no browser JWT response; backend |
| `routers/account.py` | `get_me`, `update_me`, `delete_account`; authenticated preference/deletion handlers; backend |
| `routers/catalog.py` | `get_catalog`; published permitted visible catalog only, not permission to use outside plan; no translated editions in the challenge build (D49); backend |
| `routers/plans.py` | `estimate_plan`, `create_plan`, `revise_plan`; read-only estimate, placement ownership, one active plan/version conflicts; backend |
| `routers/progress.py` | `get_today`, `get_progress`; pure reads of validated facts, not GET writes; backend |
| `routers/sessions.py` | `create_session`, `record_events`, `complete_session`; validated plan/edition/scope, placement exception; backend |
| `routers/demo.py` | `create_demo_plan`, `get_simulations`; server is_demo/fixtures only; backend |
| `routers/offline.py` | `create_offline_snapshot`, `get_offline_snapshot`, `revalidate_offline_snapshot`; new proposed endpoints gated by PWA-design; no-store responses, no offline session creation; backend/PWA |
| `services/auth.py` | `register_account(input)->RegistrationResult`, `authenticate(input)->SessionResult`, `verify_recovery(input)->ResetGrant`, `reset_password(input)->RecoveryResult`, `rotate_recovery(context,input)->RecoveryResult`, `change_password(context,input)->None`, `logout(context)->None`; normalize names/recovery, throttle, reserve/consume recovery atomically, revoke epoch/session; D52: `register_account` rejects registration (demo accounts included) without terms acceptance and stores only `terms_version`/`terms_accepted_at` in `profiles`, and `authenticate` signals re-consent required when the accepted version is older than the current one after a major change; backend/security |
| `services/account.py` | `read_profile(context)->Profile`, `update_profile(context,input)->Profile`, `delete_account(context,input)->None`; restricted writes/provider deletion coordination and safe retry evidence; time/zone gate; backend |
| `services/plans.py` | `estimate_goal(context,input)->Estimate`, `create_plan(context,input)->Plan`, `revise_plan(context,id,input)->Plan`; confirmed estimate, target coverage, pause previous plan atomically, immutable history, protect open session; D57 daily settings effective next learning day; backend |
| `services/progress.py` | `read_today(context)->TodayProgress`, `read_progress(context)->PlanProgress`; daily union time + capped percent + extra, initial/confirmed separation; D57 next-day settings without retrospective credit; denominator/weighting Needs Input; backend |
| `services/sessions.py` | `prepare_session(context,input)->SessionSnapshot`, `apply_events(context,id,events)->EventAcknowledgment`, `close_session(context,id)->Completion`; transactional event dedup; D59 verifies old queued events in their original plan/version independently of active-plan status; after scope/edition/bank validation invoke answer_policy.evaluate_answer, then feed ValidatedAttempt to mastery/time/reviews/day update; no grading algorithm in the transaction orchestrator and no trusted client correctness; backend |
| `services/planner.py` | `plan_with_fallback(context,trigger,input)->PlanProposal`; allowed trigger/privacy mode, validate IDs/coverage/free eligibility/timeout, bounded repair policy Needs Review, rules fallback always; backend/AI |
| `services/offline.py` | `build_offline_snapshot(context,plan_id,input)->PlanSnapshot`, `read_offline_snapshot(context,snapshot_id)->PlanSnapshot`, `revalidate_snapshot(context,input)->RevalidationResult`; complete prepared-session refs; current source validity governs new display, while D59 adjudicates old events independently in original plan; contracts Needs Review; backend/PWA |
| `domain/plan_policy.py` | `assert_active_plan_target(plan,target_refs,edition)->None`, `validate_plan_revision(current,input)->RevisionDecision`; future-day content allowed, active ownership/scope strict; backend |
| `domain/answer_policy.py` | `evaluate_answer(validated_question,submission,reviewed_normalization_policy)->ValidatedAttempt`; scope/edition/bank/question validity checked before grading; handles ordered tokens, `word_choice` selection of a word or contiguous source segment (D64; representation Needs Review), similar-option choice and single-word recall against server source refs and reviewed normalization/scoringPolicyVersion. Raw recall word transient/no logs; unsupported/missing reviewed policy rejects affected grading, never invent Arabic normalization. Returns validated correctness/error/target refs, not mastery/time credit; backend/games |
| `domain/time_policy.py` | `merge_activity_intervals(intervals)->ValidatedIntervals`, `summarize_day(intervals,goal)->DailySummary`; union overlap, pause/background exclusion, cap percent/extra time; input bounds/date policy gate; backend |
| `domain/mastery_policy.py` | `advance_target_streak(state,validated_attempt)->StreakState`, `evaluate_confirmation(evidence,reviewed_policy)->MasteryDecision`; same canonical target, error reset, unique evidence, cumulative full coverage of targeted passage + successful 1/3/7-day reviews per D41/D64; segment evidence/round representation Needs Review and target grouping/ratio denominator-weight/later-review failure effect Needs Input; cannot supply unapproved policy defaults; backend |
| `domain/planning_rules.py` | `estimate_by_rules(input,bank)->Estimate`, `propose_by_rules(input,bank,state)->PlanProposal`, `schedule_review(state,result,date)->ReviewDecision`; reviewed 1/3/7 days and absence handling, no authored content; backend |
| `domain/content_policy.py` | `assert_publishable(edition,validation)->None`, `decide_removal(edition,references)->RemovalDecision`; immutable used publication, unused-draft delete, archive distinct from revoked; backend/content |
| `repositories/accounts.py` | `find_handle`, `reserve_recovery`, `consume_recovery`, `create_app_session`, `revoke_sessions`, `read_profile`, `write_profile`, `delete_personal_rows`; restricted DB functions/roles, scoped transactions and no secret printing; backend/security |
| `repositories/content.py` | `read_catalog`, `read_bank`, `read_targets`, `load_job`, `save_job_cursor`, `save_draft`, `publish_version`, `withdraw_version`, `archive_version`, `delete_unused_draft`; exact source/edition and usage references; backend/content |
| `repositories/plans.py` | `read_owned_plan`, `read_active_plan`, `create_with_phases`, `append_revision`; context-bound ownership, optimistic version/one-active constraint; backend |
| `repositories/sessions.py` | `read_owned_session`, `insert_session`, `insert_event_once`, `close_session`; stable event key + transaction, immutable snapshot; backend |
| `repositories/progress.py` | `read_daily_facts`, `read_target_evidence`, `save_progress_transaction`; atomic union/streak/reviews/day record, unique daily completion; backend |
| `repositories/ai_usage.py` | `check_free_eligibility`, `record_usage`, `read_quota`; budget 0 and free-quota control; record provider/model, prompt version, token usage, verified free quota before requests and measured actual cost after responses; missing cost/token metrics are unknown rather than zero, no real learner payload logging; backend/AI |
| `providers/database.py` | `open_user_database(session)->DatabaseContext`, `open_restricted_database()->DatabaseContext`; user JWT remains server-side, restricted private access, transaction contexts; backend/security |
| `providers/supabase_auth.py` | `create_identity`, `authenticate_identity`, `refresh_identity`, `reset_identity_password`, `delete_identity`; provider result→safe internal DTO, explicit failure handling, limited Admin API usage; backend/security |
| `providers/storage.py` | `put_source`, `read_source`, `delete_unused_source`; private sources bucket, operator-only, immutable version/ref checks; backend/content |
| `providers/embeddings.py` | `embed_units(edition,units)->Vectors`; approved source text only; configured provider/model choice must be reviewed, no feedback/learner free text; backend/content |
| `providers/llm.py` | Planned provider-neutral request/result and free-eligibility contract; implementations never authorize learner-data export, billing or new providers; backend/AI |
| `providers/openrouter.py` | `request_plan(allowed_input,budget)->ProviderPlanResult`; OpenRouter primary per D60; optional extra provider only after actual free eligibility verification, constrained JSON, timeout/usage, no real learner data during challenge; backend/AI |
| `workflow/runner.py` | `run_content_job(job_id)->JobResult`; ordered resumable idempotent steps/cursor persisted in Supabase; resume on a later invocation after interruption; no concurrent duplicate publication; D48: invoked by `scripts/content_tools.py` or inside the server process (`job_execution_mode=in_process`), never as a separate background worker or Cron job, and keeps no local files (Supabase Storage); no continuity promise through Render suspension/restart; backend/content |
| `workflow/content_management.py` | `acquire_source(input)->SourceArtifact`, `extract_and_segment(artifact)->EditionDraft`, `map_and_verify_pages(draft)->VerifiedEdition`; “Content Management Agent” is bounded programmatic workflow name; URL acquisition validates approved host/source eligibility and each redirect before fetching; upload format/size validation precedes extraction. Accepted formats/size/redirect/network constraints require a reviewed contract, no numeric defaults invented; backend/content |
| `workflow/lesson_question_builder.py` | `build_lessons(edition)->LessonDrafts`, `build_question_bank(edition,lessons)->BankDraft`; “Lesson and Question Creation Agent”, deterministic source refs/four templates, no LLM content; backend/content |
| `workflow/validation.py` | `validate_edition`, `validate_bank`, `validate_plan_proposal`; exact original/rights/pages/edition/published IDs/target coverage, fail-closed; backend/content |

Repository method signatures must accept a resolved server context/transaction and bounded typed identifiers or reviewed DTOs, return scoped records/results, and raise mapped AppError for conflict/unavailable/invalid state. Never accept `user_id`, `correct`, `dailyCompleted`, mastery or mode from the client as authority. Do not implement all private operations through a blanket service-role client.

<a id="contracts"></a>
### Exact endpoint → router → service map

All paths retain `/api` through Next rewrites. “Known contract” means the document contract exists, not a running endpoint. Router handler names below are proposed. All application endpoints remain Planned.

| Method/path | Proposed router handler | Proposed service callable |
|---|---|---|
| POST `/api/auth/register` | auth.register | auth.register_account |
| POST `/api/auth/login` | auth.login | auth.authenticate |
| POST `/api/auth/recovery/verify` | auth.verify_recovery | auth.verify_recovery |
| POST `/api/auth/recovery/reset` | auth.reset_password | auth.reset_password |
| POST `/api/auth/recovery/rotate` | auth.rotate_recovery | auth.rotate_recovery |
| POST `/api/auth/password` | auth.change_password | auth.change_password |
| POST `/api/auth/logout` | auth.logout | auth.logout |
| GET/PATCH `/api/me` | account.get_me/update_me | account.read_profile/update_profile |
| DELETE `/api/account` | account.delete_account | account.delete_account |
| GET `/api/catalog` | catalog.get_catalog | repositories.content.read_catalog through reviewed scoped read |
| POST `/api/plans/estimate` | plans.estimate_plan | plans.estimate_goal (no writes) |
| POST `/api/plans` | plans.create_plan | plans.create_plan |
| POST `/api/plans/:id/revise` | plans.revise_plan | plans.revise_plan |
| GET `/api/today` | progress.get_today | progress.read_today |
| GET `/api/progress` | progress.get_progress | progress.read_progress |
| POST `/api/sessions` | sessions.create_session | sessions.prepare_session |
| POST `/api/sessions/:id/events` | sessions.record_events | sessions.apply_events |
| POST `/api/sessions/:id/complete` | sessions.complete_session | sessions.close_session |
| POST `/api/demo/plans` | demo.create_demo_plan | plans.create_plan + planner.plan_with_fallback under server demo context |
| GET `/api/demo/simulations` | demo.get_simulations | server-owned synthetic fixtures read; no new simulation API writes |
| GET `/api/health` | health.read_health | health.read_health_status — minimal public result, Planned |
| POST `/api/plans/:id/offline-snapshots` | offline.create_offline_snapshot | offline.build_offline_snapshot — PROPOSED authenticated mutation, expectedPlanVersion/downloadTargetRefs/clientOperationId; Needs Review in PWA-design |
| GET `/api/offline-snapshots/:snapshotId` | offline.get_offline_snapshot | offline.read_offline_snapshot — PROPOSED read-only/resumable retrieval, Needs Review in PWA-design |
| POST `/api/offline/revalidate` | offline.revalidate_offline_snapshot | offline.revalidate_snapshot — PROPOSED new contract, Needs Review in PWA-design |

The proposed POST prepares an owned snapshot and server sessions online; GET only retrieves that saved snapshot and does not create sessions. The PWA proposal returns snapshot/schema/owner/plan/version/edition/bank/scope, downloaded targets and prepared server-session/question descriptors. Revalidation uses snapshot ID and expected plan version and yields available/stale/revoked/expired plus permitted prepared sessions; exact DTOs/statuses remain PWA-design review items; D58 adds no lock or expiry. Offline runs retain prepared owned session refs plus stable clientRunId/clientEventId. Replay is proposed through the session-events endpoint with original stable event IDs; D59 separates per-event eligibility from current snapshot availability. Do not add a “grant mastery” endpoint, offline-created server sessions or a client-authorized demo flag.

### Configuration, migrations and tools

| Proposed maintained file | Responsibility and sequencing |
|---|---|
| `backend/app/config.py` (Planned) | Reviewed OpenRouter/Supabase/restricted DB/session encryption/HMAC/embedding configuration; startup validates required production settings, diagnostics names/presence only; no guessed environment value; `job_execution_mode` stays `in_process`/CLI on the free plan (D48) |
| `backend/.env.example` (Planned) | Blank non-secret reviewed variable names matching Settings; free-only OpenRouter eligibility fields; no actual credentials |
| `backend/scripts/content_tools.py` | Proposed `main()->int`: operator-only import/run/validate/publish/withdraw/archive/delete-unused-draft commands delegate services/workflow; no public content mutation requirement; exact CLI arguments Needs Review |
| `fixtures/demo_scenarios.json` | Reviewed synthetic scenario IDs/targets/initial placement summaries only; backend/QA owns source-controlled artificial data, never real learner rows; validates published edition refs |
| `fixtures/demo_simulations.json` | Clearly labeled precomputed synthetic multi-day results; backend/QA owns preparation and evidence, no fabricated live/human results; not an empty file presented as a working simulation |
| `supabase/migrations/0001_content.sql` | Sources/rules/books/editions/pages/units/lessons/questions/embeddings/content jobs and source integrity references; reviewed schema first |
| `supabase/migrations/0002_identity.sql` | Profiles (including D52 `terms_version` and `terms_accepted_at`, nothing else about consent) + private handles/recovery/grants/app sessions/throttle; least privilege, no browser token table access |
| `supabase/migrations/0003_plans_sessions.sql` | Master plans/versions/phases/snapshots/attempt ownership and unique event IDs; one active plan |
| `supabase/migrations/0004_progress.sql` | Reviews/time evidence/daily completions/target mastery evidence; STOP at D40/D41 unresolved schema policy |
| `supabase/migrations/0005_rls_functions.sql` | Composite parent ownership, RLS, indexes/constraints and restricted SECURITY DEFINER functions/grants; no production use before security review |
| `supabase/migrations/0006_feedback.sql` (C) | Conditional private feedback/state/audit/ownership/retention design only after gate and reviewed contract |

SQL file names/order are proposed, not runnable migrations or an approved complete physical schema. Compare every column/type/null/default/key/index/role/delete behavior with reviewed Architecture before authoring SQL; add verified provider-role deployment prerequisites to the implementation record. Each table-creation migration establishes restrictive privileges and RLS immediately; `0005_rls_functions.sql` adds the reviewed policies/functions/grants before application access. Migration-first means execute no module against guessed tables. Database/provider libraries, test runners and PWA build integration are not installed by this document.

<a id="conditional"></a>
## 6. Conditional feedback and manager interface

[Additional-features.md](Additional-features.md) is the scope authority: baseline content operations use developer tools. Both learner feedback and full manager UI are future/conditional on most core programming completed during Day 1 with acceptance evidence, unresolved-failure/capacity review; feedback has higher priority. Passing the capacity gate does not approve unfinished UI/API design. No numeric percentage/hours define “most”.

| Conditional exact file | Proposed symbols and responsibility |
|---|---|
| `frontend/src/app/content/page.tsx` | `ContentPage()` manager list/versions/actions; operator authorization enforced server-side |
| `frontend/src/app/content/add/page.tsx` | `AddContentPage()` child of content management: URL/file+source rights→bounded workflows; not a separate top-level admin product |
| `frontend/src/app/content/lessons/page.tsx` | `LessonsPage()` version-bound lesson order/preview/validation; no rewritten religious text |
| `frontend/src/app/content/questions/page.tsx` | `QuestionsPage()` bank templates/refs/preview; no LLM options |
| `frontend/src/app/content/feedback/page.tsx` | `ContentFeedbackPage()` scoped manager inbox/ack/state/result/closure reason |
| `frontend/src/app/feedback/page.tsx` | `FeedbackPage()` own learner reports and results only |
| `frontend/src/components/feedback/FeedbackForm.tsx` | `FeedbackForm({lessonId?,questionId?,sessionContext})`; “أرسل ملاحظة”, automatic bounded refs, acknowledgment only after save |
| `frontend/src/components/feedback/FeedbackInbox.tsx` | `FeedbackInbox({mode})`; own reports or authorized manager scope; no arbitrary user selection |
| `backend/app/routers/feedback.py` | `submit_feedback`, `list_my_feedback`; POST/GET `/api/feedback` per Architecture conditional contract |
| `backend/app/routers/content.py` | `list_content_feedback`, `update_content_feedback`; GET `/api/content/feedback`, PATCH `/api/content/feedback/:id`; do not invent public CRUD endpoints for CLI operations |
| `backend/app/services/feedback.py` | `submit_feedback(context,input)->FeedbackReceipt`, `read_feedback(context,query)->FeedbackPage`, `update_feedback(operator,id,input)->FeedbackResult`; owner/source context, stable client ID, expectedUpdatedAt, explicit ack vs resolved/closed |
| `backend/app/repositories/feedback.py` | `insert_once`, `read_owned`, `read_operator_scope`, `update_with_version`; scoped rows, no feedback/free-text logging or external AI/embeddings |
| `backend/tests/test_feedback.py` | Conditional tests: duplicate ID mismatch, owner/manager access, snapshot context, optimistic update, ack≠resolved, closure reason, no free-text leakage |

Names/classes in this section are proposals; fixed field limits, role matrix, retention, pagination bounds and transition rules remain the Architecture/Additional-features `Needs Review` gate. Published used material is withdrawn/archived with history, not destructively deleted. “CRUD” never bypasses original text/rights/publication validation or immutable edition references.

<a id="verification"></a>

## 7. Verification and handoff

No runnable verification commands are specified until tooling exists. Record commands after authorized setup and actual manifest inspection. Planned checks:

- Auth/RLS: two-account isolation, recovery retry/race, revocation epoch, Origin/cookie handling, terms and deletion.
- Content/games: whole unchanged source, page/edition/rights evidence, four templates, wrong-scope rejection and early future-day play; larger ordered segments and focused keyword/continuation prompts support cumulative coverage with little repetition. D64 applies to `word_choice`; option/reference representation and source-section fit remain Needs Review.
- Time/mastery: no overlap/replay credit, next-day setting transition/history preservation; D64 full cumulative target coverage and reviews 1/3/7 apply. Segment coverage evidence/round sizing remain Needs Review; calculation waits for mastery-target grouping, ratio denominator/weight and later-review-failure inputs.
- Offline: complete production cold reopen/four games, tab purge and failures, original-plan event retention/disputes, altered clock, withdrawal discovery, update and storage eviction, selected browser matrix.
- AI: server free eligibility gate/budget0, quota/timeout/schema failure → rules, synthetic-only outbound mode, no learner/secret logs.
- Delivery: affected approvals and source/provider prerequisites, 5 October basic-build target versus 6 October verified evidence; no readiness inferred from dates.

Before later edits inspect the actual file and affected approval, constrain ownership and complete the missing contract. After authorized implementation, update this map with existence/status and focused verification evidence. An agent recommendation cannot turn Planned into Implemented or Verified.
