# Qatra — QA checklists for Q1, Q1b, Q7 and the Q3 report template (preparation material)

- Version: 0.1
- Date: 2026-10-05 (Asia/Dubai)
- Status: **Draft — Needs Review**
- Build-plan packages served: Q1, Q1b, Q7 (execution checklists) and Q3 (report template) — docs/Qatra-build-plan.md, Phase 7 table.
- Nature of this file: preparation material only. **No test has been executed and nothing has been deployed.** Every status below is preset to "Not run". Nothing here proves any behaviour; expected results are quoted or paraphrased from the approved/draft documents named in the Source column, not from observation.
- Personas: see `references/qa/synthetic-personas.md` (P-01 … P-10). Passwords are generated at run time and never stored.
- Forbidden in this package: executable test code, fixtures, real personal data, secrets.

## How to use

- One row = one case. Execute only after the deployment gate (P3/G5) and the packages named in the build plan (Q1 needs P3 and C6; Q1b needs Q1; Q7 needs B13 and F14).
- Record the result, date, tester, environment and evidence reference in the Q3 evidence log (§4 below), not by overwriting the preset status in this file, until the manager approves the recording method (OQ-12).
- Status vocabulary (build plan, phase 7 row): **Passed**, **Failed**, **Not run**. A case that cannot be run because a precondition is missing stays **Not run** with the reason recorded (OQ-11). A case is never marked Passed from a mocked or local-only run when it targets the deployed behaviour; the environment is always recorded.
- Source abbreviations: **QA** = docs/QA-and-evaluation.md (section heading in Arabic, row label quoted); **PRD** = docs/PRD.md; **API** = docs/API-spec.md (§ number or endpoint E-id); **AUTH** = docs/Authentication-and-privacy.md; **PC** = docs/Plan-conversation.md; **PWA** = docs/PWA-design.md; **IC** = docs/Implementation-contract.md; **DR** = docs/Decision-register.md; **UI** = docs/UI-screens.md; **BP** = docs/Qatra-build-plan.md.
- Several numbers (per-IP rate limits, caps) are configuration defaults, not approved service levels (API §1.8, O-03; NFR-18). Record the observed configuration beside the result.

---

## 1. Q1 — Critical QA cases

### Q1-ISO — Account isolation (P-03 as caller, P-06 as owner of the targeted rows)

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-ISO-01 | Read another account's resources | P-03 signed in; ids of P-06's plan, session, snapshot and plan chat known to the tester | Request each of P-06's ids through the matching GET endpoints | `404 not_found`, indistinguishable from an unknown id; never `403`; no existence leak | API §1.4; QA § الحساب والحفظ «حساب أ يحاول قراءة/تعديل خطة أو جلسة حساب ب»; PRD matrix «قراءة بيانات حسابات أخرى» | Not run |
| Q1-ISO-02 | Modify another account's plan | as above | `POST /api/plans/:id/revise` (E17) with P-06's plan id | `404 not_found`; P-06's plan version and data unchanged (verify as P-06) | API §1.4, E17; QA same row | Not run |
| Q1-ISO-03 | Write events to another account's session | as above | `POST /api/sessions/:id/events` (E21) with P-06's session id and a valid-looking event | `404 not_found`; no attempt or interval rows appear for P-06 | API E21 errors; API §1.4 | Not run |
| Q1-ISO-04 | Forged parent id | P-03 signed in; P-06 ids known | Send a request that references P-06's plan/session id as the parent inside the body or path of an own-account operation (for example creating a session for P-03 with P-06's plan id) | Request refused by API and RLS. The exact status/code for each forged-parent shape is not fixed by the spec: record observed code (OQ-1) | QA § الحساب والحفظ «بما فيها تزوير معرف الوالد»; API §1.4 | Not run |
| Q1-ISO-05 | Row-level security with two JWTs | Operator access to the test database with two user contexts (one per persona); no secrets recorded | As each user context, attempt to select/update the other's rows in every personal table | Zero leaks and zero writes across accounts | PRD NFR-06 item 3 and its measurement column; API §1.4 (RLS second layer) | Not run |
| Q1-ISO-06 | Unauthenticated access | P-01 | Call every Session endpoint (E05, E08–E13, E15–E25, E30–E34) without a cookie | `401 unauthenticated` for each (error envelope) | API §1.3, §2.1; PRD matrix | Not run |
| Q1-ISO-07 | Visitor catalog is metadata only | P-01 | `GET /api/catalog` without cookie, then with a cookie | Titles, editions, section names/references, word and passage counts, available paths only; no religious text, lessons or questions; same payload with or without cookie | PRD matrix «عرض الكتالوج» (D71); API E14 and §4.4 (visitors, learners, demo receive the same payload) | Not run |
| Q1-ISO-08 | Role-based denial | P-03 (learner); P-09 if demo scope built | Learner calls a demo-only endpoint (E28); demo account calls a learner-only endpoint | `403 forbidden` (decided code A-12) | API §1.4 | Not run |
| Q1-ISO-09 | No content write path for learners | P-03 | Attempt content import/publish/withdraw through any HTTP route | No such HTTP operation exists; unknown routes return the envelope `not_found`; content operations exist only in the operator CLI | API §5 (CLI, no HTTP), §1.5 framework errors; PRD matrix «استيراد المحتوى…» | Not run |
| Q1-ISO-10 | Chat isolation (cross-reference) | P-07, P-06 | See Q7-09 | See Q7-09 | QA Q7-09 | Not run |

### Q1-AUTH — Account, recovery and privacy

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-AUTH-01 | Registration and consent box | P-02, clean browser | Open register; check the consent box default; try register unticked, then ticked | Box is mandatory and not pre-ticked; without it no account (`400 terms_required` at API level); on success only `terms_version` and `terms_accepted_at` are stored; terms and privacy links visible before account creation; no e-mail/phone/birth data asked | QA «موافقة الشروط (D52)»; API E03, §1.5; AUTH § تجربة الحساب; PRD R10 | Not run |
| Q1-AUTH-02 | Recovery code shown once | P-02 | Complete registration; inspect the recovery-code state screen; reload | Code is shown once at registration; not retrievable later from the UI; never in logs | AUTH § التنفيذ المخطط على Supabase (code generation); UI S-04 | Not run |
| Q1-AUTH-03 | Duplicate/invalid usernames | P-02 | Register a name that equals an existing one after NFKC and case folding; names with hidden characters or spaces; length 2 and 25 | Duplicate rejected (`409 username_taken`); hidden characters and spaces rejected (`422`); 3–24 chars only | QA «اسم مستخدم مكرر»; AUTH § التنفيذ المخطط; API §1.5 | Not run |
| Q1-AUTH-04 | Password limits | P-02, Arabic and English passwords generated at run time | Try 14 chars, 15 chars, exactly 72 bytes, 73 bytes (Arabic letters are multi-byte) | 14 rejected, 15 accepted; 73 bytes rejected; no silent truncation or normalization | QA «حدود كلمة المرور بالعربية والإنجليزية»; AUTH § التنفيذ المخطط; API E03 (`password_min_chars`, `password_max_bytes`) | Not run |
| Q1-AUTH-05 | Generic login failure and throttle | P-02 | Repeated wrong password/unknown username attempts; observe responses and timing; then a correct login | Generic `401 invalid_credentials`; 5 failures in 15 min → progressive delay; 20 failures → `429 throttled` with `Retry-After`; a successful login clears the username key; registrations do not count; counters stored as hashes only | QA «كلمة مرور/اسم خاطئ»; API §1.8 (auth-throttle row), §1.5; PRD NFR-06 | Not run |
| Q1-AUTH-06 | Throttle not bypassed by client headers | P-02 | Repeat Q1-AUTH-05 while sending a forged `X-Forwarded-For` | Throttle keyed on the trusted-proxy client address, not the forged header | API §1.1 (client IP bullet); IC §8 (`QATRA_TRUSTED_XFF_DEPTH`) | Not run |
| Q1-AUTH-07 | Recovery with valid code | P-05 | Verify code typed plain, with display separators, in upper case and with Arabic-Indic digits | Each accepted; short-lived reset grant issued; grant allows only a password change | QA «رمز استرجاع صحيح»; AUTH § استرجاع آمن قابل للاختبار (normalization, steps 1–3); API E06 | Not run |
| Q1-AUTH-08 | Reset completes correctly | P-05 with a second older session in another browser | Complete the reset; then use the old session; then log in with the new password | New password set; all earlier app sessions revoked (`auth_epoch` increases) so the old session gets `401 unauthenticated`; replacement recovery code shown once; no automatic login after recovery | QA «استرجاع ناجح، ثم استعمال جلسة قديمة»; AUTH § استرجاع آمن (step 4) and `auth_epoch` paragraph; API E07, §1.3 | Not run |
| Q1-AUTH-09 | Used/guessed/concurrent codes | P-05 (a second fresh code on another account) | Reuse a consumed code; try a wrong code; send two simultaneous resets with the same valid code | Reuse and guess return the same generic `401 invalid_credentials`; only one grant becomes active; no double consumption and no full login from a reset grant | QA «رمز مستخدم أو تخمين أو طلبان متزامنان»; AUTH step 2; API E06/E07 | Not run |
| Q1-AUTH-10 | Grant expiry | P-05 | Obtain a grant, wait beyond ten minutes, submit the new password | Rejected with generic `401`; reservation released rather than the code lost | AUTH step 2 and 5; QA «انقطاع مزود Auth…» | Not run |
| Q1-AUTH-11 | Auth-provider interruption during reset | P-05; a way to interrupt the provider mid-reset is **not specified** (OQ-3) | Only if inducible: interrupt then retry with the same operation id | Safe retry; unexecuted reservation released at grant expiry; uncertain outcome checked before the code is reused | QA «انقطاع مزود Auth/ضياع رد التحقق أثناء إعادة التعيين»; AUTH step 5 | Not run |
| Q1-AUTH-12 | Recovery-code regeneration | P-03 | Regenerate from settings without, then with, the current password; try the old code | Current password required; old code invalidated; new code shown once | QA «إعادة توليد الرمز»; API E08 | Not run |
| Q1-AUTH-13 | Password change from settings (C-02) | P-03 with two sessions | Change the password in session 1; call the API from session 2; continue in session 1 | Other sessions rejected (`401 unauthenticated`); the current session receives a new cookie tied to the new epoch and continues without re-login; the previous cookie of the current session no longer works | QA row «تغيير كلمة المرور من الإعدادات… (C-02)»; API E09; AUTH § تجربة الحساب | Not run |
| Q1-AUTH-14 | Lost password and code | P-02 | Look for any alternative recovery route (personal questions, e-mail, support) | None exists; the UI states the recovery limit | QA «فقد كلمة المرور والرمز»; PRD R10 | Not run |
| Q1-AUTH-15 | Logout invalidates the session | P-03 | Log out; replay a request with the previous cookie | `401 unauthenticated`; cookie cleared | API E10, §1.3 | Not run |
| Q1-AUTH-16 | Device copy cleared on logout/switch | P-03 then P-06 on the same browser | Log out, log in as P-06 | No trace of P-03's plan or progress is visible; local copy cleared | QA «تبديل الحساب أو الخروج» | Not run |
| Q1-AUTH-17 | No tokens in browser storage | P-02, P-05 | After register, login, recovery and logout inspect localStorage, sessionStorage, IndexedDB, Cache Storage | No session, Supabase Auth or recovery tokens anywhere | QA «رموز الجلسة والاسترجاع في التخزين المحلي»; API §1.3 (browser never receives Supabase tokens) | Not run |
| Q1-AUTH-18 | Account deletion | P-02 (a fresh throwaway account with a plan, a session and, if built, a chat) | `POST /api/account/delete` with a wrong password; then with the correct password and `confirm:"DELETE"`; then try to log in and use the recovery code | Wrong password: `401 invalid_credentials`, account intact. Correct: `204`, cookie cleared, every personal row, throttle rows for that name and chat rows removed in the one request; login impossible; local copy cleared; no downloadable backup | QA «حذف الحساب»; API E13; PRD NFR-07 | Not run |
| Q1-AUTH-19 | Terms re-consent | P-03; only if the deployment lets the terms version be raised (OQ-4) | Raise the terms version, log in | New consent required at next login; cannot proceed without it | QA «موافقة الشروط (D52)»; UI S-06 | Not run |
| Q1-AUTH-20 | Settings/privacy statement content | P-03 | Open «الخصوصية والبيانات» and the terms page | States book-as-is storage, no fatwa/explanation, data collected (incl. `terms_version`, `terms_accepted_at`), purpose, storage place, deletion and backup duration, no inference of religious attributes; links reachable before sign-up and from settings | QA «بيان الخصوصية وشروط الاستخدام»; PRD R10; UI S-03, S-26 | Not run |

### Q1-CO — Session cookie, Origin check and transport

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-CO-01 | Cookie attributes | P-02 on the deployed HTTPS Vercel origin | Register/log in; inspect `Set-Cookie` | `__Host-qatra_session`; `Secure; HttpOnly; SameSite=Strict; Path=/`; no `Domain`; set on the frontend origin | API §1.3; AUTH § استرجاع آمن (session paragraph); QA § الحساب والحفظ «كوكي الجلسة والأصل» | Not run |
| Q1-CO-02 | HttpOnly | P-03 | Read `document.cookie` in the console | Session cookie is not readable by script | API §1.3 | Not run |
| Q1-CO-03 | Foreign Origin on mutation | P-03, P-01 | Send POST/PATCH to mutating endpoints (including anonymous ones: register, login, recovery) with `Origin` of another site | `403 forbidden_origin` on every mutation | API §1.3; QA «كوكي الجلسة والأصل»; QA § التشغيل والتوافر «وكيل /api/*» | Not run |
| Q1-CO-04 | Origin checked before body/auth | P-01 | Send a wrong Origin with an invalid body and no cookie | `403 forbidden_origin` (not 422 or 401): the check runs before authentication and body processing | API §1.3 | Not run |
| Q1-CO-05 | Missing Origin | P-03 | State-changing request with the `Origin` header omitted | Treated as mismatch: `403 forbidden_origin` | API §1.3 | Not run |
| Q1-CO-06 | GET exempt | P-03 | `GET` requests with a foreign Origin | Not blocked by the Origin rule (no state change) | API §1.3 | Not run |
| Q1-CO-07 | Same-origin, no CORS | P-01 | Inspect responses of `/api/*` for `Access-Control-*`; send a preflight | No `Access-Control-*` header and no preflight served; browser talks only to the Vercel origin | API §1.1; QA «وكيل /api/*» | Not run |
| Q1-CO-08 | No browser tokens or Authorization header | P-03 | Inspect network traffic and storage during a session | Browser never receives Supabase tokens and never sends `Authorization` | API §1.3 | Not run |
| Q1-CO-09 | Cache-Control | P-01, P-03 | Inspect headers of E01, E02, E14 and several Session endpoints | `no-store` everywhere | API §1.9 | Not run |
| Q1-CO-10 | Error envelope | P-03 | Provoke 401, 403, 404, 422, 429 and an unknown route/method | Envelope `{error:{code,message,details}}`; messages contain no submitted values, tokens or stack traces; unknown route/method → `not_found`, bad content type/unparsable JSON → `validation_error` | API §1.5 | Not run |
| Q1-CO-11 | Rate-limit response | P-02 | Exceed a configured class limit | `429 throttled` with `Retry-After` and `details.retryAfterSec`; observed limit recorded (config default) | API §1.5, §1.8 | Not run |
| Q1-CO-12 | Body size cap | P-03 | Send a body above 64 KiB | `413 payload_too_large` | API §1.5 (decided A-12), §1.7 | Not run |
| Q1-CO-13 | Logs free of personal data | Operator access to Render/Vercel logs after running other cases | Sample logs for passwords, recovery codes, tokens, cookies, request/response bodies, usernames, raw IPs, answers, goal/chat text | None present; logs carry method, route template, status, latency, error code only | API §1.12; PRD NFR-13, NFR-07; QA «فحص حركة الطلبات والسجلات» | Not run |
| Q1-CO-14 | Secrets not exposed | Operator | Inspect built browser bundle, repository (secret scan) and Vercel variable names | No `OPENROUTER_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `QATRA_SERVER_DB`, encryption/HMAC keys or embeddings key in bundle, repository or Vercel; Vercel carries only the proxy target | QA «الأسرار»; PRD NFR-06 item 4 | Not run |

### Q1-FRG — Client authority and forged `correct`

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-FRG-01 | Forged `correct` field | P-03 with an open session | `POST /api/sessions/:id/events` with `correct:true` inside an answer event | Whole request fails `422 validation_error`, `details.fields` names `events[i].correct` rule `forbidden_field`; no attempt recorded | API E21 processing step 1; QA «correct=true مزور…» | Not run |
| Q1-FRG-02 | Wrong answer cannot be marked right | P-03 | Submit an answer known to be wrong by every allowed shape | Server grades; `results[].correct=false`; `expected` returned for display with reference | API E21 step 7; QA same row | Not run |
| Q1-FRG-03 | Other forbidden client fields | P-03, P-02 | Add `userId`, `mode`, `isDemo`, mastery or daily totals to bodies of E03, E16, E20, E21, E26 | `422 validation_error` with `forbidden_field`; identity and demo status only from the session | API §1.3 (No client authority), §1.2 (strict bodies) | Not run |
| Q1-FRG-04 | Forged demo/synthetic mode | P-03; P-09 if demo built | Call `POST /api/demo/plans` as a learner; send a mode flag on any route | `403 forbidden` for the learner; no mode flag accepted; no change of data policy | QA «وضع synthetic_demo مزور في طلب حقيقي»; API §1.4, E26/E28 | Not run |
| Q1-FRG-05 | Question not in session | P-03 | Event with a `questionId` not part of this session | Per-event `rejected` with `question_not_in_session`; no credit | API E21 O-21 codes | Not run |
| Q1-FRG-06 | Out-of-scope or other-edition material | P-03 (Quran plan) | Event/session request for Hadith material or a Quran section outside `target_scope` | Server rejects: `out_of_scope` or `edition_mismatch`; session creation for out-of-scope refused | QA «غياب خطة نشطة أو هدف غير مصرح به»; API E21; PRD R20 | Not run |
| Q1-FRG-07 | Answer shape and payload bounds | P-03 | `{text}` for a choice question; empty `events`; 101 events; `durationMs` above 30 minutes; activity longer than its interval | `events_empty` / `events_too_many` → `422`; wrong answer shape and out-of-bounds activity rejected per the code sets. **Whether a shape mismatch is `422` (error table) or per-event `invalid_answer_shape` is stated both ways** (OQ-5): record observed | API E21 errors table and O-21 sets | Not run |
| Q1-FRG-08 | Hint flag | P-03 | Correct answer with `hintUsed:true`, then without | With hint: counted as assisted, not independent recall evidence; the flag is client-reported — an accepted, documented risk, not a defect to file | QA «إجابة صحيحة بعد كشف التلميح (D64)»; API E21 (S-5 accepted risk); PRD NFR open risk (D69) | Not run |
| Q1-FRG-09 | No placement mastery credit | P-02 | Answer a placement session | Attempts recorded for the estimate only; no mastery credit; activity not counted in daily totals | API E21 step 6; PRD matrix «جلسة الاختبار الأولي» | Not run |
| Q1-FRG-10 | Server-side grading of recall normalisation | P-03 | Recall answer without diacritics, with tatweel, with alternate characters; and a different word | Accepted per the declared normalisation; original text shown unchanged; a different word rejected | QA «إدخال كلمة دون تشكيل أو بتطويل أو بمحارف بديلة» | Not run |

### Q1-EVT — No duplicate events, ordering and time

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-EVT-01 | Resend identical batch | P-03; batch with stable `clientEventId`s (kept in tester notes) | Send the batch twice | Second response lists all ids in `duplicate`; attempts, intervals and daily totals unchanged | API E21 processing step 2, §1.6; PRD NFR-08 (0 double counting) | Not run |
| Q1-EVT-02 | Same id, different content | P-03 | Resend an id with changed answer or time | First accepted payload wins; later one reported `duplicate`; no effect | API E21 «Idempotency/concurrency» | Not run |
| Q1-EVT-03 | Parallel batches sharing ids | P-03 | Fire two batches with shared ids at the same time | Exactly one effect per id (database constraint arbitrates) | API §1.6, E21 | Not run |
| Q1-EVT-04 | Overlapping intervals/sessions | P-03 | Two overlapping activity intervals or two concurrent sessions | Time not doubled; daily time derived from the union of verified intervals | QA «حدث معاد أو جلستان متداخلتان»; API E21 side effects | Not run |
| Q1-EVT-05 | Repeat completion | P-03 | Call session complete twice; complete the day twice | Same result both times; a single daily completion per learning date | QA «تكرار إتمام اليومية»; API §1.6 (E22 idempotent) | Not run |
| Q1-EVT-06 | Daily session get-or-create | P-03 | Two concurrent `POST /api/sessions` kind `daily` | Same open session returned (200 vs 201); no second session | API §1.6 (A-01), E20 | Not run |
| Q1-EVT-07 | One active plan race | P-03 | Concurrent creation of two plans; starting a second plan | Only one active plan; race yields `409 version_conflict` reason `active_plan_conflict`; starting another plan pauses the current one and keeps its progress | QA «بدء خطة ثانية»; API §1.5, §1.6 | Not run |
| Q1-EVT-08 | Stale plan version | P-03 | Revise with an old `expectedVersion` | `409 version_conflict` with `details.currentVersion` | QA «تعديل الوقت أو الخطة»; API §1.6 | Not run |
| Q1-EVT-09 | Late/unordered events from two devices | P-03 on two browsers | Submit events out of order from both | Consistent counting of reviews and day; no silent replacement of a newer result | QA «أحداث متأخرة/غير مرتبة من جهازين»; API E21 step 8 | Not run |
| Q1-EVT-10 | Network loss and reconnect | P-03 | Drop connectivity during a batch; resend the same ids | No duplication via `clientEventId`; if the database fails mid-request `503` and committed events return `duplicate` on resend (induce only if possible, OQ-3) | QA «انقطاع الشبكة ثم العودة»; API E21 step 3 | Not run |
| Q1-EVT-11 | Wrong-recall display | P-03 | Give a wrong recall answer | Original shown in context with surah/ayah or hadith number, edition and page (or canonical link), gently; error recorded for review; nothing built on the wrong answer | QA «خطأ استرجاع المتعلم» | Not run |
| Q1-EVT-12 | Learner recall text not stored | Operator database view | After Q1-EVT-11 inspect `attempts` | Only a reference (`wrong_token_ref`), never the raw recall text | API E21 side effects; API §1.12 | Not run |

### Q1-MST — Daily progress and mastery (supplementary to the listed Q1 areas; P-04)

These cases come from the D66 acceptance rows. They are included because the build plan names "all modules" for Q1 and Q3; they are not in the Q1 headline list (OQ-6). Older QA rows still mention reviews on days 1/3/7; AGENTS.md and the QA «D66» rows state D66's 1/2/4-day intervals amend them, so D66 is used here.

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-MST-01 | Initial streak | P-04 | Three consecutive verified correct answers on the same target, then a wrong one | Streak is an initial condition only; an error resets that target's streak only; other targets and daily time unaffected; no confirmation from the streak alone | QA «تسلسل نفس الهدف عبر الألعاب», «خطأ أثناء التسلسل», «كلمة واحدة أو ثلاث نجاحات في يوم واحد» | Not run |
| Q1-MST-02 | Review round rules | P-04 | Review rounds on passages with ≤2, 3–5 and ≥6 parts | Round succeeds only if every question is correct, unassisted and at first attempt; size 1 / 2 / 3 respectively; at most one stage per learning day per passage | QA «D66 — قاعدة نجاح المراجعة» | Not run |
| Q1-MST-03 | Failure before confirmation | P-04 | Fail a round at stage 2 | Chain returns to stage 1, due next learning day; coverage and initial evidence kept; focused practice on failed parts | same row | Not run |
| Q1-MST-04 | Confirmation | P-04 | Pass stage 3 with all parts covered, and separately stage 3 with a coverage gap | Confirmed only with stage 3 plus full coverage; a gap stays visible; showing source context alone is not coverage | same row; QA «تغطية تراكمية وكشف فجوة (D64)» | Not run |
| Q1-MST-05 | Maintenance and `needs_refresh` | P-04 (maintenance state; see OQ-2 on advancing dates) | Pass then fail a maintenance review | Maintenance at 14 / 30 / every 60 days; failure → `needs_refresh`, excluded from the overall numerator, coverage kept, separate counter with next review date; missed review stays due without penalty | QA «D66 — مراجعة الصيانة…» | Not run |
| Q1-MST-06 | Overall percentage | P-04 | Compare displayed overall percentage with confirmed words ÷ active-scope words | `floor(100 × confirmed words ÷ active scope words)`; long passages weigh by words; a cancelled Hadith path leaves the denominator from the next learning day; confirmed / in progress / `needs_refresh` shown separately | QA «D66 — الإنجاز العام موزون بالكلمات»; PRD NFR/R19 | Not run |
| Q1-MST-07 | Daily time and completion | P-03 | 7 of 10 active minutes; 12 of 10; games only with wrong answers; pause/background/placement | 70%; 100% plus 2 separate extra minutes with one completion record; games alone reach the goal without crediting memorization; placement, pause and background excluded. Rounding of the daily percentage is open (API O-24): record observed | QA «٧ دقائق من هدف ١٠ دقائق», «تجاوز الوقت اليومي», «ألعاب فقط وإجابات خاطئة»; PRD R06; API §1.2 | Not run |
| Q1-MST-08 | Absence | P-04 | Skip three learning days | Light review without new material by default; the rest of due items stay for following days; no pile-up | QA «غياب ثلاثة أيام»; PRD R07 | Not run |

### Q1-CNT — Content integrity (P-10 operator, P-03 and P-01 as viewers)

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-CNT-01 | Literal verification gate, Quran | P-10; Juz' Amma draft | Run verify/validate; then force a mismatch in a copy of one verse | Published Quran text after NFC equals the King Fahd Complex (Hafs v18) verification reference for every verse of Juz' Amma; any difference blocks that unit from publishing | QA «D68 — بوابة النشر: التحقق الحرفي»; PRD NFR-11; IC §2.7 | Not run |
| Q1-CNT-02 | Literal verification gate, Hadith | P-10 | Acquire each hadith twice independently; compare; where the host is available, re-acquire over HTTP and compare byte for byte | Both acquisitions identical; any difference blocks the affected unit | same row; PRD NFR-11 | Not run |
| Q1-CNT-03 | Stored text equals displayed text | P-03 viewing the lesson; P-10 reference | Compare API/UI text of sampled units with the verified source: letters, diacritics, order, margins, zero-width characters | Exact match; API never trims, normalises or rewrites; publisher zero-width characters preserved | QA «وحدة أصلية»; API §1.2 | Not run |
| Q1-CNT-04 | Canonical link and no invented pages | P-03 | Open sampled passages of both editions | Canonical (original) URL shown beside each passage; web editions have no printed page numbers, page tables empty; no page number generated when missing | QA «صفحة أو نطاق صفحات», «D68 — الرابط الأصلي بجانب النص»; PRD NFR-11 | Not run |
| Q1-CNT-05 | Hadith narrator/grade | P-03 | Open sampled Forty Hadith | Narrator and Grade shown exactly as the HadeethEnc record gives them and labelled as that record's; no grading or takhrij from another source | QA «حديث من الأربعين النووية», «D68 — الرابط الأصلي»; D25 | Not run |
| Q1-CNT-06 | Fixed caution line | P-03 | Open a hadith whose edition states no attribution/grade | Published as is, with the fixed caution line: «تنبيه: نُقل هذا النص حرفيًا عن الكتاب، ولم يُتحقق من صحة الحديث.» (styling per the QA row) | QA «حديث لا تذكر طبعته المختارة نسبة…» (D50, D53) | Not run |
| Q1-CNT-07 | No enrichment or commentary | P-10, P-03 | Search store, API responses and UI for HadeethEnc commentary/benefits, QuranEnc translations/tafsir, any added ruling or translation | None stored or displayed | QA «إضافة حكم حديث أو شرح أو ترجمة…», «D68 — الرابط الأصلي»; PRD NFR-11 | Not run |
| Q1-CNT-08 | Gap reporting (41 of 42) | P-10 | Review the publication report for the Forty | Reports the published count out of 42 (may be 41, accepted by the owner); a hadith with no record in the Forty phrasing is reported as a gap and excluded; never filled from memory or another source; "Forty complete" not claimed unless all are published | QA «D68 — الإبلاغ عن الفجوات (٤١ من ٤٢)» | Not run |
| Q1-CNT-09 | Unqualified source/edition refused | P-10 | Try to publish a unit from a source outside the approved reference list or an unqualified edition | Publication refused even if freely available; approved source here is Islamic Content MCP for the two books | QA «مصدر خارج المرجعية أو طبعة غير مؤهلة» | Not run |
| Q1-CNT-10 | Question bank integrity | P-10 | Inspect/validate sampled questions of all four types; craft invalid cases (missing position, two correct answers after normalisation, distractor from another book/edition) | Questions built from source positions with fixed templates; invalid ones rejected before publish; no mixing books/editions; no generated or conceptual question | QA «سؤال من الأنواع الأربعة», «مشتت/موضع غير موجود…», «تمييز متشابه…» | Not run |
| Q1-CNT-11 | Workflow idempotency | P-10 | Count rows and fingerprints; re-run each step for the same (edition, version, step); interrupt and resume | No duplicated rows, embeddings, lessons or questions; resume from the durable cursor gives the same state; a failing step leaves the edition draft with step name and cursor recorded | QA «idempotency سير الإعداد…», «فشل خطوة من سير الإعداد»; IC; API §5.2 | Not run |
| Q1-CNT-12 | Withdraw | P-10, P-03 with a pinned plan | Withdraw a published edition | Display and dependent sessions stop; withdrawn text not shown even for plans already pinned | QA «سحب إصدار أو اكتشاف خطأ»; API §5 `withdraw` | Not run |
| Q1-CNT-13 | Language switch does not translate | P-03 | Switch UI between Arabic and English | Only UI strings change; the book text remains original with no parallel translation; English terms follow the Jamhara dictionary list | QA «تغيير لغة الواجهة», «مصطلحات الواجهة الإنجليزية…»; PRD R11 | Not run |
| Q1-CNT-14 | Rights/terms recorded before public display | Manager/owner record | Check the publisher-terms record exists before the public link is shared | Publisher terms logged (owner accepted rights pending verification) | QA «D68 — بوابة النشر»; PRD § النطاق الحالي | Not run |

### Q1-WAKE — Wake-up and availability check

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-WAKE-01 | Cold-wake time | P-01; backend idle at least 15 minutes (free plan sleeps after 15 min) | Request `GET /api/health` through the Vercel origin; time to first successful health; repeat | API ready within 60 s at p95 after the first wake request. The number of repetitions needed for a p95 is **not specified** (OQ-7); record each timing | PRD NFR-02 (3); API §1.11; QA «GET /api/health والتوافر (D48)» | Not run |
| Q1-WAKE-02 | Waiting message timing | P-01 | Load the app against the sleeping backend; time the message | Within 1 s of the first slow or failed request the UI shows «جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.» | PRD NFR-02 (1); API §1.11 | Not run |
| Q1-WAKE-03 | Polling pattern | P-01 | Watch network calls during the wake | Short repeated `GET /api/health` requests with backoff 1, 2, 4, 8 s then every 10 s, up to 90 s total, then a retry button; never one long request | PRD NFR-02 (2); API §1.11 | Not run |
| Q1-WAKE-04 | Rewrite timeout risk | P-01 | Compare wake through the Vercel rewrite with the wake time of the backend alone | The Vercel rewrite timeout does not cut the wake request (currently an unverified risk) — record the finding either way | QA «GET /api/health والتوافر» (risk statement); API §1.11 and O-02; BP phase 5 | Not run |
| Q1-WAKE-05 | Wake is connectivity, not invalidation | P-03 with a session, (P-08 if PWA built) | Trigger a wake timeout/un-enveloped 5xx during use | Treated as connectivity: no logout, no new login prompt, snapshot not marked stale/revoked/expired, outbox not cleared | PRD NFR-02 (4); API §1.11; QA same row | Not run |
| Q1-WAKE-06 | Health response | P-01 | `GET /api/health` | `200 {status:"ok", version, time}`; no database, no cookie read, no account data; `no-store` | API E01, §1.9 | Not run |
| Q1-WAKE-07 | Readiness | Operator | `GET /api/health/ready`; exceed 6 requests per client IP per minute | Touches the database; not part of the wake loop; excess is `429` (configured default, not an approved number) | API E02, §1.8, §1.11 | Not run |
| Q1-WAKE-08 | Keep-warm job (K1) | Operator; K1 deployed | Review the scheduled runs | Health checks every 10–14 minutes from delivery on 6 October to the end of judging; database touch so the project is not paused; Supabase project not paused before or during judging. **The documents differ on frequency: NFR-02 says weekly, BP Q3 decision says twice weekly (Monday, Thursday)** — OQ-8 | PRD NFR-02 (5)(6); QA «GET /api/health والتوافر»; BP §«خيارات النطاق» item (4); API §6 | Not run |
| Q1-WAKE-09 | Free plans only | Operator | Inspect service configuration | No paid plan, background worker or cron on Render; the only scheduled job is the GitHub Actions workflow; no persistent local files on Render; README and demo link warn about first-request delay | QA «الاستضافة بخطط مجانية فقط (D48)» | Not run |
| Q1-WAKE-10 | Post-wake sequence | P-08 if PWA built | After health answers, observe client calls | `GET /api/me` → revalidate (E25) → replay events (E21) | API §1.11 step 4; PWA §6 | Not run |

### Q1-MDL — Model failure and AI cost control

| ID | Area | Persona / preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1-MDL-01 | No key configured | P-07; `OPENROUTER_API_KEY` absent | Run the plan journey | Every turn is a rules turn; journey completes; no HTTP error | PC §2.5; QA Q7-05; PRD R09, NFR-16 | Not run |
| Q1-MDL-02 | Provider error/timeout/quota | P-07; requires a way to simulate failure (OQ-3, OQ-9) | Cause provider error, 8-second timeout, exhausted free quota | Fallback to rules; no visible failure; `ai_usage` records failed / timed_out / rules_fallback without text | QA «فشل OpenRouter أو المزود المجاني…»; PC §2.4 step 4 | Not run |
| Q1-MDL-03 | Free-usage cap reached | P-07 | Reach the configured cap | Requests go to the rules engine with no visible failure; reason logged; no model call after the cap | QA «بلوغ حد الاستخدام المجاني»; PRD R09; API §1.8 (shared budget) | Not run |
| Q1-MDL-04 | Invalid model output | P-07; fake provider (OQ-9) | Fake provider returns unknown ids, extra fields, religious or generated content | Output rejected; rules applied; identifiers only are accepted | QA «AI يعيد أي نص محتوى/سؤال/شرح/حكم…»; PRD R08 | Not run |
| Q1-MDL-05 | No paid call | Operator | Review eligibility check and `ai_usage` | Free-pricing and quota check precede every request; no paid call; no key rotation to evade limits; extra key only after proof of free use without billing | QA «D60 — نفاد الحصة أو مسار مدفوع»; PRD NFR-05, NFR-18 | Not run |
| Q1-MDL-06 | Usage ledger | Operator | Compare `ai_usage` rows with the number of model calls | One row per call with provider, model, prompt version, tokens, cost; unavailable tokens/cost recorded as unknown, not zero; no learner text | QA «سجل استدعاء الوكيل»; PRD NFR-13; API §1.12 | Not run |
| Q1-MDL-07 | Session runs without the model | P-03 | Run a session with the model unavailable | Questions come from the bank; no question waits for the model | PRD R09 | Not run |
| Q1-MDL-08 | Teaching Agent triggers | P-09 if demo built | Normal session vs trigger events (create goal, edit plan, 3+ day absence, repeated errors) | Agent invoked only on triggers; a normal session does not call it | QA «محفزات استدعاء وكيل التعليم» (D38) | Not run |

---

## 2. Q1b — PWA and offline cases (R23, D46)

**Applicability:** the build plan lists Q1b only under option C, and the owner chose option B (D74). Unless PWA/offline is built, every case below stays **Not run — out of built scope**. If it is built, execute on a production HTTPS build. The Next.js experimental `useOffline` does not prove cold-reopen support; acceptance is by the actual run (QA § PWA closing note). Persona P-08 unless stated; P-06 for account-switch cases.

| ID | Area | Preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q1b-01 | Install | Production HTTPS build; supported browser | Install the app; verify shell assets are cached | Installs; shell assets verified — not just a dev server or a manifest | QA § PWA «تثبيت بناء إنتاجي عبر HTTPS» | Not run |
| Q1b-02 | Cold reopen offline | Plan downloaded | Close app and browser, disable network, open the icon, reload | Active plan, lessons and games restored; explicit message if the download was incomplete; not dependent on a page left open | QA § PWA «تنزيل خطة ثم إغلاق…»; PWA §9 | Not run |
| Q1b-03 | Four game templates offline | Plan downloaded | Run each template offline, including a chunk never opened before | All runtime files, fonts and assets present; every item within the plan's target and edition; no live load of another book; no required API/RSC request | QA § PWA «تشغيل القوالب الأربعة دون شبكة»; PWA §9 | Not run |
| Q1b-04 | Later-day material offline | Plan downloaded | Play a later day's material early | Allowed within target (D42); local active time saved as pending (D40); no skipping of reviews across days and no mastery without D41/D66 evidence | QA § PWA «لعب مادة يوم لاحق مبكرًا دون اتصال» | Not run |
| Q1b-05 | Reconnect and replay | Outbox with offline events | Restore network; resend; cut the connection during acknowledgment; resend | Re-check of authentication, ownership, snapshot validity and events; stable ids prevent double time, attempts or progress; no cloud-saved claim before acknowledgment | QA § PWA «عودة الشبكة وإعادة إرسال الطابور…»; PWA §6; API E21 | Not run |
| Q1b-06 | Revoked session / withdrawn edition on return | Revoke session or withdraw edition meanwhile | Reconnect | Sync not shown as success without verification; state explained; local pending kept separate from server-confirmed; `401` stops replay and asks for an online login, pending kept | QA § PWA «جلسة ملغاة أو نسخة مسحوبة»; API E21 client rules; PWA §5–§6 | Not run |
| Q1b-07 | Sign-out, switch and delete on the device | P-08 and P-06 on the same device | Sign out offline; switch account; delete account then open offline | No access to the previous account's plan or queue; no auth secrets in Cache Storage or IndexedDB; sign-out offline clears the copy at once and records `logoutPending` | QA § PWA «خروج أو تبديل حساب…»; PWA §7 | Not run |
| Q1b-08 | Multiple tabs | Two tabs open | Sign out in one tab | All tabs cleared before another account is shown; generation check | PWA §7 | Not run |
| Q1b-09 | Service-worker update | Newer build available | Trigger an update while a session is running | New worker waits; no forced `skipWaiting`/`clients.claim` during a session or outbox write; caches named by build id | PWA §8; QA § PWA «تحديث service worker…» | Not run |
| Q1b-10 | Storage quota/eviction | Constrain or clear storage | Fill quota; clear site data | Snapshot not marked ready; no claim of a full download; no claim a failed answer was saved; clear recovery message; the risk to unsynced events is stated | PWA §8; QA § PWA same row | Not run |
| Q1b-11 | Offline login/plan creation | Offline | Try to log in or create a plan | Message that a connection is needed; no account or plan created; no external model call locally | QA § PWA «محاولة دخول أو إنشاء خطة جديدة دون شبكة» | Not run |
| Q1b-12 | Unprepared game | Offline | Open a game with no prepared session | Message «هذه اللعبة تحتاج اتصالًا لتجهيزها مجددًا»; rest of the plan and the outbox preserved; client does not invent a server id | PWA §4 | Not run |
| Q1b-13 | Stale snapshot version | Online | Request a snapshot with an old `expectedPlanVersion` | `409 version_conflict` (`plan_version`) | API §1.5, E23 | Not run |
| Q1b-14 | Events from an older plan (D59) | Plan changed after offline events | Replay | Valid events recognised only in the original plan and version; nothing transferred to the new plan; disputed or unverifiable events stay `pending` without credit; device clock not trusted | QA «D59 — حدث من خطة قديمة بعد تغيير الخطة»; API E21 outcomes | Not run |
| Q1b-15 | Device holder visibility (D58) | P-08 | Read the privacy statement; use clear-local | Statement says local data is visible to the device holder; remote revocation applies on reconnect; clear-local explains the effect on unsynced events; no new lock or expiry | QA «D58 — حامل الجهاز…»; PWA §7 | Not run |
| Q1b-16 | Wake timeout does not invalidate the plan | P-08 | Wake timeout while offline-capable | Snapshot and queue not invalidated; work continues offline | PRD NFR-02 (4); QA § التشغيل «GET /api/health» | Not run |
| Q1b-17 | Install/offline matrix (D67) | Real devices available (unknown, BP Q2 row) | Install and reopen offline on each available combination: Android Chrome, Samsung Internet, desktop Chrome, desktop Edge, iOS 17+ Safari (manual Add to Home Screen) | Record per combination. Only tested combinations may be called "verified"; unsupported: IE, legacy Edge, iOS < 17, Android < 10; in-app browsers online-only with an "open in browser" hint | QA «D67 — مصفوفة الأجهزة…»; PWA §9 matrix | Not run |

---

## 3. Q7 — Plan-conversation cases (D75)

Source of every case: QA § «حالات محادثة الخطة (Q7، D75)» (Q7-01 … Q7-10) with detail from PC §1–§2 and API §4.10 (E31–E34), §1.7, §1.8, §1.12. They need B13 and F14. A fake provider is a test tool and data is synthetic only. Under D76 the deployed judging build runs `QATRA_CHAT_MODEL_FOR_LEARNERS=false`; model-path cases may run only against a fake provider in a non-judging environment or stay Not run (OQ-9). Persona P-07 unless stated.

| ID | Area | Preconditions | Steps | Expected result (from spec) | Source | Status |
|---|---|---|---|---|---|---|
| Q7-01a | Guard: religious text in goal | Fake provider counting requests; Arabic and English religious test set (fatwa, حكم, تفسير, معنى, شرح, ترجمة, حلال, حرام, ruling, meaning, explain, translate …) | Send each phrase as goal text (E31) | Provider receives 0 requests; reply is the fixed D26 message verbatim as a `refusal` message, source `fixed`; no generated religious content; conversation stays usable; no text in logs | QA Q7-01; PC §2.4 step 1; PRD R12, R26 | Not run |
| Q7-01b | Guard: religious text in messages | same | Send each phrase as a chat message (E32) | Same as Q7-01a | QA Q7-01 | Not run |
| Q7-01c | Fixed message exactness | same | Compare the reply with the D26 text | «نعتذر، التطبيق مخصص لحفظ الكتب كما هي ولا يقدم فتوى أو شرحًا. للفتوى أو الشرح يرجى مراجعة أهل العلم والاختصاص.» — complete, including the sentence referring to scholars; English UI gets the English rendering with D28 terms; identical wording regardless of tone (including hostile) | QA § مستويات المرجعية rows 1–12, Q7-01; PRD R12 | Not run |
| Q7-02a | Guard: off-scope | Same set-up | Send messages unrelated to the plan | Fixed redirect line as a `redirect` message; 0 model calls; no text in logs | QA Q7-02; PC §2.4 step 1 | Not run |
| Q7-02b | Guard lets logistics through | same | Send messages about duration, date, order | Not blocked by the guard | QA Q7-02 | Not run |
| Q7-03 | Model-output and number guard | Fake provider returns: religious/out-of-scope intent; religious text; numbers differing from the proposal; over 600 characters; invalid JSON; invalid parameters (reverse for Hadith, minutes other than 5/10/15, nonexistent section, unavailable path, past date) | Run each | Reply rejected or replaced by the fixed message or template; offending model text never shown; raw output not stored; all displayed numbers come from the rules engine | QA Q7-03; PC §2.4 step 3 | Not run |
| Q7-04a | Outbound payload schema | Fake provider capturing the payload | Run a creation chat | Schema test rejects any field outside the allow-list (user id, username, IP, device, registration date, session data); temporary conversation id random, not derived from the account or `chatId`, not reused; creation payload has no learning record | QA Q7-04; PRD R27, NFR-17; PC §2.4 step 3 | Not run |
| Q7-04b | Revision payload | P-07 with an active plan | Run a revision chat | Payload carries the anonymised record and answers (source-text references only) under the temporary id; not built for quick replies, guard or fallback | QA Q7-04; PC §2.4 step 3 | Not run |
| Q7-04c | Ledger and logs | Operator | Inspect `ai_usage` and request logs | No goal text, messages or model output; zero personal fields | QA Q7-04; API §1.12; PRD NFR-17 | Not run |
| Q7-05 | Fallback journey | Each of: key absent, model disabled, timeout (8 s), invalid JSON, ineligible model | Run start → placement → chat → confirm, and a plan review | Journey completes with quick replies and templates; fallback notice once per conversation; no HTTP error; `ai_usage` records failed/timed_out/rules_fallback without text; the composed first sentence and quick replies do not call the model | QA Q7-05; PRD NFR-16, R28; PC §2.4 step 4 | Not run |
| Q7-06 | Caps return to rules | Configured caps known: per account per day, per chat (6 turns), shared daily/per-minute | Reach each cap | Replies revert to rules with no model call and no visible error; no `429` for a model cap (`429` only for the IP rate class); no paid call; caps are configuration; OpenRouter limits verified at provisioning | QA Q7-06; PRD NFR-18; API §1.7, §1.8; PC §2.5 | Not run |
| Q7-07 | Stale proposal | A proposal exists; make it stale | Confirm (E34) with the old proposal version; confirm with the current one; confirm on a closed chat; race on the active plan | Old version: `409 version_conflict` reason `proposal_stale` with the current proposal; nothing saved; after fresh confirmation the saved plan equals the displayed proposal; nothing saved before confirmation; plan race `active_plan_conflict`; closed chat `chat_closed` | QA Q7-07; API §1.5 details table, E34; PRD R24 (D34) | Not run |
| Q7-08 | Latency | Warm server; fake provider with known delays, later the real provider if provisioned | Measure many turns | p95 ≤ 1 s for rules replies (quick reply, guard, fallback); p95 ≤ 10 s with the model (8 s timeout + processing); label the environment. Sample size not specified (OQ-7) | QA Q7-08; PRD NFR-15 | Not run |
| Q7-09 | Delete and isolation | P-07, P-06 | Delete P-07's account; separately P-06 requests P-07's chat | After `POST /api/account/delete`, `plan_chats` and `plan_chat_messages` rows are gone in the same request; no message text remains; other account reading a chat gets `404` (E33) and RLS blocks it | QA Q7-09; API E13, E33 | Not run |
| Q7-10a | Input limits | P-07 | Text over 500 chars; text and quick reply together | `422` for both | QA Q7-10; PC §1.1 R24–R25 | Not run |
| Q7-10b | Review on completed plan | P-07 with a completed plan | Start a review chat | `409 plan_not_active` | QA Q7-10 | Not run |
| Q7-10c | Hadith paths and Quran order | P-07 | Hadith: any subset of text/chain/grade; look for a takhrij path; reverse order for Hadith; reverse order for Quran | Hadith accepts any partial set, no takhrij path; reverse order selectable via chat for Quran only; rejected for Hadith | QA Q7-10; PRD R29, R26 | Not run |
| Q7-10d | New chat replaces open | P-07 | Start a second chat while one is open | New chat replaces the open one (`replacedChatId`) | QA Q7-10 | Not run |
| Q7-11 | D76 configuration switch | Deployment config readable by operator | Check `QATRA_CHAT_MODEL_FOR_LEARNERS` in the judging deployment and observe a real-account chat | Judging deployment value is `false`: real accounts get the rules-only conversation and no model call; the code default is meant to become `false` (scheduled in B13, not yet implemented when D76 was recorded — verify state) | PC §2.5, §3 clause-9 row; DR D76; terms-citation.md | Not run |
| Q7-12 | Access matrix for chat | P-01, P-03, P-09 (if built) | Call E31–E34 anonymously; as learner; as demo | Visitor `401`; learner permitted, one open chat at a time; demo permitted under D71 rights with synthetic context and `synthetic_demo` plan; religious question → D26 for both | PRD matrix «محادثة الخطة»/«سؤال ديني»; API §2.2 | Not run |
| Q7-13 | Chat rate class and log exclusion | P-07 | Exceed 20 chat writes per IP per minute; inspect logs for E31/E32/E34 bodies | `429 throttled` with `Retry-After` (config default); bodies of E31, E32, E34 never logged | API §1.8 (Chat write), §1.12 | Not run |
| Q7-14 | Plan card content | P-07 | Read the proposal card | Six titled sections (overall goal, overall time, daily time, phases, reviews, next step); numbers from the rules engine | PRD R24; PC §1.1 | Not run |

---

## 4. Q3 — Role-7 review report template (skeleton)

Use this skeleton to compile Q3 after Q1, Q1b (if built), Q2 and Q7 have run. The reviewer works for the manager; the report is specialist review, **not owner approval** (Role 7). Nothing in this file is a finding.

### 4.0 Rules for the report

1. Compare the deployed behaviour with the **approved specification versions**, listed in 4.1; never against personal preference. Do not redesign during QA.
2. Report only real problems with evidence. Each finding states: ID; severity (Critical / High / Medium / Low) by actual impact and likelihood; the approved requirement or contract; affected behaviour or file; trigger; expected vs actual result; evidence reference; impact; scoped correction recommendation.
3. **A section with no confirmed problems says "No issues found." only after verification actually performed**, followed by what was checked and its limits. A section not run says "Not run" (or "Not tested") with the reason; a blocked one says why. The exact sentence "No issues found." is never used for missing coverage.
4. Results use **Passed / Failed / Not run** per case with evidence (build plan Q3). Mocked or local-only evidence is never reported as deployed behaviour; record the environment.
5. Keep unresolved requirement questions separate from defects, and specialist conclusions separate from human approval.
6. Never fabricate results, service readiness or approval evidence.

### 4.1 Header

| Field | Value (to fill when the report is made) |
|---|---|
| Report version / date | |
| Reviewer role and model route | |
| Deployment under review (URLs, build id, commit) | |
| Specification versions (PRD, API-spec, Implementation-contract, Database-schema, UI-screens, QA, PWA-design, decision register range) | |
| Scope option (A / B / C) and what was built | |
| Environment notes (config defaults observed: rate limits, caps, `QATRA_CHAT_MODEL_FOR_LEARNERS`) | |

### 4.2 Executive summary table

| Review section | Cases run / total | Passed | Failed | Not run | Findings (IDs) | Verdict sentence |
|---|---|---|---|---|---|---|
| 1 Functional and business correctness | | | | | | |
| 2 Backend (validation, authentication, authorization, errors, shapes, schema alignment) | | | | | | |
| 3 Frontend (forms, navigation, states, responsive, RTL/LTR, keyboard, labels) | | | | | | |
| 4 Relevant MVP security | | | | | | |
| 5 Code quality | | | | | | |
| 6 Non-functional requirements NFR-01 … NFR-18 | | | | | | |
| 7 PWA and offline (R23) | | | | | | |
| 8 Plan conversation (R24–R29) | | | | | | |
| 9 Content integrity | | | | | | |

### 4.3 Section skeleton (repeat for each row of 4.2)

```
Section N — <name>
Covered by: <case IDs from this file / other evidence>
Result: Passed x / Failed y / Not run z
Findings: <IDs or "none confirmed">
Statement: <"No issues found." — only if verification was performed — followed by what was
            checked and its limits;  OR  "Not run — <reason>";  OR  "Blocked — <reason>">
Untested areas: <list>
```

Suggested content per section and the source to compare against:

| Section | Compare with | Case sets feeding it |
|---|---|---|
| 1 Functional | PRD § المتطلبات R01–R29 and § المتطلبات الوظيفية M1–M12 (acceptance column); QA | Q1-AUTH, Q1-EVT, Q1-MST, Q7; manual journey walkthrough |
| 2 Backend | API-spec E01–E34 (status codes, shapes, error envelope), Database-schema alignment, IC | Q1-ISO, Q1-CO, Q1-FRG, Q1-EVT |
| 3 Frontend | UI-screens S-01 … S-27, S-34 (S-10 superseded; S-28 … S-33 deferred), UX/Design-system, PRD NFR-09, NFR-10, NFR-14 | Q2 matrix and accessibility results; Arabic RTL / English LTR passes |
| 4 Security | PRD NFR-06, NFR-07; AUTH; API §1.3–§1.5 | Q1-ISO, Q1-AUTH, Q1-CO, Q1-FRG. Do not assert coverage from a checklist alone: tie to actual code paths and runs |
| 5 Code quality | PRD NFR-12 (lint, types, tests, coverage ≥ 90% domain / ≥ 70% backend), Programming-guide | Code inspection; CI output |
| 6 NFRs | PRD NFR-01 … NFR-18 measurement columns | Q1-WAKE (NFR-01/02), Q2 (NFR-09/10), Q7-08 (NFR-15), Q7-04/05/06 (NFR-16–18) |
| 7 PWA | PRD R23; PWA §9 | Q1b (or "Not run — out of built scope") |
| 8 Plan conversation | PRD R24–R29; PC | Q7-01 … Q7-14 |
| 9 Content | PRD NFR-11, R03, R08; QA § المحتوى والبنك | Q1-CNT |

### 4.4 Findings list (template)

| ID | Severity | Requirement / contract | Affected behaviour or file | Trigger | Expected | Actual | Evidence ref | Impact | Scoped correction recommendation |
|---|---|---|---|---|---|---|---|---|---|
| F-001 | | | | | | | | | |

### 4.5 Evidence log (template)

| Case ID | Date and time (Asia/Dubai) | Tester | Environment (URL, build id) | Persona | Result (Passed / Failed / Not run) | Evidence reference (log excerpt, screenshot id, request id; no secrets or personal data) | Notes (observed config values, deviations) |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

### 4.6 Not-run and blocked register (template)

| Case ID | Reason (missing precondition, out of built scope, cannot be induced, environment limit) | Owner decision needed? |
|---|---|---|
| | | |

### 4.7 Unresolved requirement questions (separate from defects)

(Carry forward the open questions below and any new ones; never convert a question into a finding.)

### 4.8 Approval status

State plainly: this report is a specialist review; it records no owner approval; phase gates (G7, G8) remain the owner's decision (BP gates table). Record any approval only with its actual source and date.

---

## 5. Open questions and coverage gaps (for the manager; not decided here)

- **OQ-1** Forged-parent-id expectations: the spec says refused by RLS and API but does not fix a status/code for each shape (Q1-ISO-04).
- **OQ-2** No specified way to advance learning dates in a test deployment (needed for Q1-MST-02/05/08 and the day-1/2/4 and 14/30/60 intervals).
- **OQ-3** No specified way to induce an auth-provider interruption, a database failure mid-batch, or a provider timeout in a deployed environment (Q1-AUTH-11, Q1-EVT-10, Q1-MDL-02).
- **OQ-4** Whether the deployment allows raising the terms version for Q1-AUTH-19.
- **OQ-5** API E21 lists both `422` (answer shape) and per-event `rejected: invalid_answer_shape`; the intended behaviour for a wrong shape needs confirmation (Q1-FRG-07).
- **OQ-6** Mastery (Q1-MST) and the D66 rules are not in the Q1 headline list; confirm they belong in Q1 or should be reported only in Q3. Older QA rows still cite 1/3/7-day reviews while D66 sets 1/2/4; confirm D66 governs.
- **OQ-7** Sample sizes for p95 claims (NFR-02 wake-up, NFR-15 latency) are not specified.
- **OQ-8** Keep-warm DB-touch frequency differs between PRD NFR-02 (weekly) and the build plan's Q3 decision (Monday and Thursday).
- **OQ-9** A fake model provider in a deployed environment is not specified; under D76 the judging deployment may have no model path, so Q7 model-path cases and Q1-MDL-02/04 may only be runnable in a separate synthetic environment.
- **OQ-10** Scope: PWA (Q1b, P-08) and demo (P-09, Q1-ISO-08, Q1-FRG-04, Q7-12) belong to option C; the owner chose option B (D74) and D76 forbids code updates after 6 October. Confirm they are recorded as Not run — out of built scope.
- **OQ-11** Whether "Blocked" should be a recorded status (Role 7 uses Not tested/Blocked; the build plan names only Passed, Failed, Not run). This file keeps the build-plan three and records reasons separately.
- **OQ-12** Where run results are recorded (this file vs the Q3 evidence log vs a tracker); the checklist status column stays "Not run" until the manager decides.
- **Coverage gaps by design:** device/browser matrix, accessibility (axe, keyboard, screen reader) and WCAG checks belong to Q2, not here; Q6 (fixed vs rules vs constrained-AI comparison), the human trial and the NFR-03 performance/Core Web Vitals measurements are not prepared here; screen-by-screen UI state checks (S-xx) are only referenced in the Q3 template.
