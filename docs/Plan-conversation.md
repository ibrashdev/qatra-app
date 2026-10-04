# Qatra — Plan conversation (Teaching Agent for every learner): analysis and architecture amendment

> Version 1.1 · 4 October 2026 (Asia/Dubai) · Status: **Approved — owner, 4 October 2026 («A1 approved , best practice»): gate G0-A closed for the analysis and architecture amendment of modules M3 and M8**; A2 declined, A3 and A4 approved by the owner (§5). Implementation of B2b, B13 and F14 is authorized under G3 (backend) and G1/G2 (frontend, still pending); G5 and G6 unchanged. Prepared by the coordinator with the Business Analyst (Role 2), Solutions Architect (Role 3) and Senior Software Architect (Role 1) roles. This record implements the owner's decision of 4 October 2026 (§0) as a bounded amendment of the approved analysis (PRD v14, D71) and architecture (D74). Nothing in it is implemented; it opens no gate on its own. Companion documents are amended after the owner approval recorded in §5 (A1).

## 0. The owner's decision (4 October 2026, verbatim) and what it changes

The owner wrote, in answer to the coordinator's questions UQ-01 and UQ-02 of [UI-design.md](UI-design.md):

> «ترتيب جزء عم ليس حقلا ضروريا وانما يختاره المتعلم ضمن المحادثة (المحادثة للمسائل المتخصصة) هناك حقول خاصة مثلا في باب الحديث يظهر checkbox لما يريد تعلمه (سند, متن, تخريج, صحة) اما باقي الابواب يمكن سؤال عن الاسئلة في المحادثة»
>
> «المطلوب ذكاء اصطناعي يبني ويعدل الخطة لكن مع الحفاظ على سرية المتعامل بحيث لا يتم تمرير بياناته لكن صياغة الخطة نفسها تتم عبر نموذج خارجي لكن بالامكان استخدام محرك القواعد لتخفيف استهلاك النموذج الخارجي»
>
> «ملاحظات اساسية: تقتصر المحادثة على لوجستيات الخطة ويلتزم بالقاعد عند الاسئلة الدينية (مذكورة سابقا الاعتذار والاحالة لجهة مختصة)»
>
> «التاخير غير مقبول لذلك يجب اعتماد التحليل والمعامرية باسرع وقت لهذه الوحدة»
>
> «مربع «الهدف والموعد»: يُسمح بتعديله نصًا حرًا»
>
> «when available use best practice»

**Second answer (4 October 2026, verbatim):**

> «يجب ان يرسل سجل تعلم وإجابات لتعديل خطة لمن لا يرسل معرف للمستخدم وانما يستخدم معرف مؤقت للمحادثة , لا داعي للتخريج»
>
> «تأكيد صياغة فقرة الخصوصية وسطر الشفافية: use best practice»
>
> «A4 use best practice as mentioned in open router»

Earlier the same day the owner asked that the plan screen be titled «ما هي خطتك؟», that every selection be written into the «الهدف والموعد» box, that the text be sent to the Teaching Agent, that the screen then become a chat-like screen to discuss the plan before the learner's final confirmation, and that the plan be easy to read and divided into sections (الهدف الكلي، الزمن الكلي، الزمن اليومي، …).

**What this amends.** D17 (no account or learning data to an external model) is narrowed, not dropped: learner-authored plan text, and for a plan revision the learner's anonymized learning record and answers, leave the server under disclosure and under a temporary conversation id; account identifiers never do (§2.4, §2.6). D26 is unchanged and enforced server-side. D38 (the agent chooses ids and timing only; UI text is fixed) is amended: the assistant also writes conversational text, under a server guard, and never the numbers of the plan. D51 (no assistant toggle; fixed transparency line) keeps its rule and changes its text; its post-challenge opt-in condition lapses, since the assistant is part of the product. D72's plan-order field moves from the form to the conversation. Hadith paths stay the three of contract §2.3 (متن، سند، الدرجة): the owner declined takhrij as a path («لا داعي للتخريج»); takhrij is always displayed with the hadith (D68) and never tested. D60 (free models only, rules engine as the permanent fallback) is unchanged and governs every model call.

**What stays.** The rules engine computes every number (estimate, days, words per day, review rhythm); one active plan per account; placement; the four games and D31; the public catalog; the content workflow; every gate G1–G8.

## 1. Analysis amendment (PRD v14 → v15, modules M3 and M8)

### 1.1 Functional requirements (new rows R24–R29; R01, R02, R14 unchanged in substance)

| ID | Requirement | Acceptance criterion |
|---|---|---|
| R24 Plan conversation | After the start form (S-08) and the placement test (S-09), the learner builds the plan in a conversation with the plan assistant: the assistant proposes a plan presented in six labelled sections (الهدف الكلي، الزمن الكلي، الزمن اليومي، المراحل، المراجعات، الخطوة التالية); the learner replies by free text or quick replies; the plan is saved only when the learner confirms the current proposal | A proposal exists before the confirm action is enabled; confirming saves exactly the shown proposal (same fields and estimate) or answers `409 proposal_stale`; nothing is saved before confirmation (D34) |
| R25 Plan revision by conversation | A learner (or demo account, D71) revises an active or paused plan in the same conversation form, starting from the current plan; changes take effect from the next learning day (D57); a completed plan cannot be revised (A-08) | A revision conversation ends with a new plan version; `409 plan_not_active` for completed plans |
| R26 Scope of the conversation | The conversation is limited to plan logistics: book, edition, scope (sections), hadith paths (متن، سند، الدرجة), Juz' Amma order (book or reverse), daily minutes, preferred date, review rhythm, what happens next. A religious question (fatwa, ruling, explanation, meaning, translation) receives the fixed D26 message verbatim; any other out-of-scope request receives a fixed redirect line. Both are applied by the server before any model call and again on the model's reply | A test set of religious and out-of-scope prompts never reaches the model and always returns the fixed messages; no generated religious content is shown |
| R27 Privacy of the conversation | The model receives data only under one temporary conversation id per conversation (random, not derived from the account or from `chatId`, never shared between conversations). Plan creation: the learner's goal text and messages, the plan parameters, catalog metadata (titles, section names and references, counts), the placement summary and the interface language. Plan revision: additionally the learner's anonymized learning record and answers (owner: «يجب ان يرسل سجل تعلم وإجابات لتعديل خطة … معرف مؤقت للمحادثة»): per-passage mastery states with review outcomes and dates, error-prone parts, the daily-time history and the recent attempts (question type, reference, correct, assisted, error kind, date). Never: user id, username, IP, device, registration date, session data | A schema test on the outbound payload rejects any field outside the allowed list; `ai_usage` rows hold no learner text |
| R28 Rules first, model second | The rules engine computes every number and the structured proposal; the model interprets free text into plan parameters and writes conversational text. No model call when: the first turn's text equals the composed sentence and asks nothing; a quick reply is used; the guard matches; the daily or per-conversation model cap is reached. Timeout 8 s. Any failure, time-out, exhausted free quota or ineligible model falls back to a rules reply with quick replies, shown as a calm notice, never as an error (R09) | The fallback conversation completes the whole journey without the model; every model call is recorded (R09) |
| R29 Hadith paths and the start form | The start form shows, for the hadith category only, a checkbox group of the memorization paths available in the edition — متن (default), سند, الدرجة; takhrij is displayed, never a path — and no plan-order control; the order is chosen in the conversation for the Quran edition (default book); the «الهدف والموعد» box is editable free text whose initial value is the composed sentence | A hadith plan can target any subset of the three paths; a Quran plan can be reversed from the conversation only |

### 1.2 Measurable non-functional requirements (new rows NFR-15 to NFR-18)

| ID | Measure | Target |
|---|---|---|
| NFR-15 Assistant latency | time from a learner message to the assistant reply, warm server | p95 ≤ 10 s with the model (8 s timeout + processing); p95 ≤ 1 s for rules replies (quick replies, guard, fallback) |
| NFR-16 Journey availability | share of plan conversations that can reach confirmation without the model | 100 %: the rules path is complete on its own |
| NFR-17 Privacy of model payloads | personal fields in any outbound model request | 0 (automated test on the payload schema; `ai_usage` carries no text) |
| NFR-18 Cost and quota | paid calls; model requests per minute and per day | 0 paid calls (D60). Caps follow OpenRouter's published limits for free models without purchased credits (owner: «use best practice as mentioned in open router»; the coordinator's reading, to be verified at provisioning because openrouter.ai is unreachable from the build container): 20 requests per minute and 50 requests per day for the whole deployment, shared with the demo planner; per-account share 10 per day; 6 model turns per conversation; over any cap → rules replies (configuration, A-12 style, not approved numbers) |

### 1.3 Roles and permissions (delta to the PRD roles matrix)

| Capability | Visitor | Learner | Demo account | Content manager / reviewer |
|---|---|---|---|---|
| Plan conversation (create, message, read, confirm) | denied (session required) | allowed; one open conversation at a time | allowed with quick replies only (D29: no free text from a demo account reaches the model; the free-text input is disabled with a note); the model receives synthetic context only; confirmation creates the demo plan in `synthetic_demo` mode | denied (no UI) |
| Religious question in the conversation | — | fixed D26 message | fixed D26 message | — |

### 1.4 Open points resolved by this amendment

UQ-01 and UQ-02 of [UI-design.md](UI-design.md) §9.3 are answered; contract §11 "English religious labels" stays open (unchanged); API-spec [O-17] (placement persistence for revisions) is resolved in §2.3 below. UG-04 of UI-design.md (the version of a completed plan for maintenance reviews) is resolved by adding `currentVersion: number` to `PlanProgress` (E19, API-spec O-32) in the API-spec v1.2 and contract v1.5 amendments of §4, so the client can open an E20 `daily` session on a completed plan with the right `expectedPlanVersion`.

## 2. Architecture amendment

### 2.1 Data model (Database-schema v1.1 → v1.2; new migration `0006_plan_chats`)

The conditional feedback migration moves from `0006` to `0007`. Both tables are personal rows (delete class A, `P-OWN`, RLS enabled, privileges revoked from `anon`, `authenticated` and `service_role`; the backend reads and writes them through `app_*`-style learner functions or the learner's token exactly as the other personal tables; no `srv_*` function is needed).

**`plan_chats`**

| Column | Type | Rules |
|---|---|---|
| `id` | uuid, pk, default `gen_random_uuid()` | |
| `user_id` | uuid, not null → `auth.users (id)` on delete cascade | composite keys `(id, user_id)` for children |
| `plan_id` | uuid, null → `master_plans (id, user_id)` (B) | set for a revision conversation; null for a creation |
| `status` | text, check in (`open`, `confirmed`, `abandoned`) | one `open` conversation per account: partial unique index on `(user_id) where status = 'open'` |
| `language` | text, check in (`ar`, `en`) | interface language of the conversation |
| `proposal` | jsonb, null, `jsonb_typeof = 'object'` | the current `PlanProposal` (§2.2); null until the first proposal |
| `proposal_version` | integer, not null, default 0 | incremented on every new proposal; confirmation must quote it |
| `model_turns` | integer, not null, default 0 | model calls consumed by this conversation |
| `created_at`, `updated_at` | timestamptz | `set_updated_at` trigger |
| `closed_at` | timestamptz, null | set on confirm or abandon |

**`plan_chat_messages`**

| Column | Type | Rules |
|---|---|---|
| `id` | uuid, pk, default `gen_random_uuid()` | |
| `chat_id`, `user_id` | uuid, not null → `plan_chats (id, user_id)` on delete cascade | |
| `ordinal` | integer, not null; unique `(chat_id, ordinal)` | reading order |
| `role` | text, check in (`learner`, `assistant`) | |
| `kind` | text, check in (`text`, `proposal`, `refusal`, `redirect`, `fallback`, `quick_reply`) | `proposal` messages carry the proposal snapshot in `payload` |
| `text` | text, not null, ≤ 2 000 characters (check) | learner text ≤ 500 characters is enforced by the API |
| `source` | text, check in (`learner`, `rules`, `model`, `fixed`) | provenance of assistant text |
| `payload` | jsonb, null | proposal snapshot or quick-reply code; no model raw output |
| `created_at` | timestamptz | |

`ai_usage` (0004) is reused unchanged: `prompt_version` values `plan-chat-v1` distinguish these calls from the demo planner's; no learner text, no account id. Retention: messages live with the account and are deleted with it (D52 list of personal rows is extended); an `abandoned` conversation is one superseded by a newer conversation; no separate purge exists in the MVP (no `DELETE` path is granted; Database-schema OPEN-18 closed on that basis).

### 2.2 DTOs (Implementation-contract §7 additions)

```ts
type Path = 'quran' | 'matn' | 'sanad' | 'grade';               // unchanged: the owner declined takhrij as a path (§0)
type QuickReplyCode = 'fewer_minutes' | 'more_minutes' | 'smaller_scope' | 'later_date' | 'no_date'
                    | 'order_book' | 'order_reverse' | 'paths_matn_only' | 'paths_all' | 'confirm';
interface QuickReply { code: QuickReplyCode; labelAr: string; labelEn: string; }
interface PlanSections { goal: string; totalTime: string; dailyTime: string; stages: string;
  reviews: string; nextStep: string; }                           // plain text, interface language, server-built
interface PlanProposal { proposalVersion: number; editionId: string; targetScope: TargetScope; paths: Path[];
  order: PlanOrder; sessionMinutes: 5 | 10 | 15; preferredDate: ISODate | null; estimate: Estimate;
  sections: PlanSections; }
interface ChatMessage { messageId: string; ordinal: number; role: 'learner' | 'assistant';
  kind: 'text' | 'proposal' | 'refusal' | 'redirect' | 'fallback' | 'quick_reply'; text: string;
  source: 'learner' | 'rules' | 'model' | 'fixed'; createdAt: ISODateTime; }
interface PlanChat { chatId: string; status: 'open' | 'confirmed' | 'abandoned'; planId: string | null;
  language: 'ar' | 'en'; messages: ChatMessage[]; proposal: PlanProposal | null; quickReplies: QuickReply[];
  modelTurnsLeft: number; assistant: { source: 'rules' | 'model'; model?: string }; }
interface Today { /* unchanged fields */ openPlanChatId?: string | null; }   // optional addition, lets S-11/S-08 resume
```

`PlanSections` text is assembled by the server from templates and the rules engine's numbers (and, when a model turn succeeded, the model's phrasing of the *goal* and *nextStep* lines only, after the output guard); the numbers never come from the model.

### 2.3 API operations E31–E34 (API-spec v1.1 → v1.2)

Conventions of API-spec §1 apply (envelope, `no-store`, Origin check, session cookie, 64 KiB cap). Rate class **Chat write**: E31, E32, E34 — 20 per client IP per minute (configuration default). E33 is **Session read**.

| Op | Method and path | Auth | Learner | Demo | Notes |
|---|---|---|---|---|---|
| E31 | `POST /api/plan-chats` | S | yes | yes | creates the conversation and the first assistant turn |
| E32 | `POST /api/plan-chats/{id}/messages` | S | yes | yes | one learner turn (free text or quick reply) → one assistant turn |
| E33 | `GET /api/plan-chats/{id}` | S | yes | yes | reload and resume (UG-01 style gap closed for conversations) |
| E34 | `POST /api/plan-chats/{id}/confirm` | S | yes | yes | saves the plan (creation: E16 semantics; revision: E17 semantics) and closes the conversation |

**E31 request** `{editionId, targetScope, paths, sessionMinutes, preferredDate?, placementSessionId?, goalText, language, planId?}` — `goalText` ≤ 500 characters after trimming (the composed sentence or the learner's edit; `422 goal_text_length`); `paths` ⊆ the edition's `availablePaths` (`422 path_not_available`); `planId` present → revision conversation (the plan must be the caller's and not completed: `409 plan_not_active`); an existing `open` conversation is marked `abandoned` and replaced (`details.replacedChatId`). **Response** `201 PlanChat` whose first assistant message is a `proposal` built by the rules engine (no model call when `goalText` equals the composed sentence; otherwise one model turn to interpret the text, then the rules proposal). Errors: `401`, `403 forbidden_origin`, `404 not_found` (plan or placement session), `409 plan_not_active`, `422 validation_error`, `429 throttled`, `503`, `500`.

**E32 request** `{text?: string, quickReply?: QuickReplyCode}` — exactly one of the two (`422 one_of_text_or_quick_reply`); `text` ≤ 500 characters. **Behaviour (the turn pipeline, §2.4)** → **Response** `200 PlanChat` with the learner message and the assistant reply appended; `proposal` and `proposalVersion` updated when parameters changed. Errors: `409 version_conflict` `details.reason = chat_closed` when the conversation is not `open`; `429 throttled` for the IP class only (the model cap is not an error: the reply is a rules reply with `kind = 'fallback'`).

**E33** → `200 PlanChat` (own conversations only; `404` otherwise).

**E34 request** `{proposalVersion}` — must equal the conversation's current version (`409 version_conflict`, `details.reason = proposal_stale`, with the current proposal in `details.proposal`). Creation: the server calls the E16 function with the proposal's fields and `confirmedEstimate = proposal.estimate` (the previous active plan is paused; `409 active_plan_conflict` on a race); revision: the E17 function with `expectedVersion` taken from the conversation's plan snapshot (`409 plan_version` if the plan moved). **Response** `201 Plan` (creation) or `200 Plan` (revision); the conversation becomes `confirmed`. Demo accounts: creation runs in `synthetic_demo` mode exactly as E28 (no real data; `planner.source` reports `rules` or `model`); E28 remains for the scripted scenarios of option C.

**Placement persistence ([O-17] resolved).** `plan_chats.proposal` keeps `placementSessionId`; a revision conversation reuses the plan's original placement session for `knownWords`, as E17 does with `agreedEstimate`.

### 2.4 The turn pipeline (backend `services/plan_chat.py`, `domain/plan_chat_policy.py`, `providers/openrouter.py`)

1. **Guard (pure, no model).** `classify_request(text, language)` returns `religious | out_of_scope | logistics` from a reviewed keyword and pattern list in Arabic and English (fatwa, حكم, تفسير, معنى, شرح, ترجمة, حلال, حرام, ruling, meaning, explain, translate, …). `religious` → the fixed D26 message verbatim («نعتذر، التطبيق مخصص لحفظ الكتب كما هي ولا يقدم فتوى أو شرحًا. للفتوى أو الشرح يرجى مراجعة أهل العلم والاختصاص.») as an assistant `refusal`; `out_of_scope` (not about the plan) → the fixed redirect line (proposed: «يمكنني مساعدتك في خطة الحفظ فقط: المدة والوقت اليومي والنطاق والترتيب والمراجعات.»). No model call, no record of the text in logs.
2. **Quick reply (rules only).** The code maps to a parameter patch (fewer/more minutes → next option; smaller scope → first half in plan order; later date → +25 % days; order → `book`/`reverse` (Quran only); paths → sets; `confirm` → the client calls E34). The rules engine (E15 function) recomputes the estimate; the server builds the proposal and the templated reply; `source = 'rules'`.
3. **Free text (model turn).** When the caps allow (NFR-18) and the model is eligible (D60 live-pricing check, as E28): one request with structured output. **Payload (R27):** system instructions (prompt `plan-chat-v1`), the catalog metadata of the chosen edition (title, author, sections with reference, word counts), the current parameters and estimate, the placement summary `{knownWords, passageCount}`, the last ten messages, the interface language, and one temporary conversation id per conversation (random, unrelated to `chatId` and to the account, never shared between conversations). For a revision conversation the payload also carries the anonymized learning record (R27): per-passage mastery states with review outcomes and dates, error-prone parts, the daily-time history of the last 30 learning days and the last 50 attempts (question type, reference, correct, assisted, error kind, date) — source-text references only, no personal fields. **Required output (JSON schema):** `{intent: 'set_parameters' | 'question' | 'confirm' | 'religious' | 'out_of_scope', parameters?: {targetScope?, paths?, order?, sessionMinutes?, preferredDate?}, reply: string}`. The server validates every parameter against the catalog and the rules (`reverse` only for the Quran edition; minutes ∈ {5, 10, 15}; sections exist; paths available; date ≥ today), recomputes the estimate by rules, builds the proposal, and shows `reply` only after the output guard (same classifier; ≤ 600 characters; no numbers that contradict the proposal are allowed: numbers in `reply` are replaced by the server's values or the templated reply is used). `intent = religious | out_of_scope` → the fixed messages. `source = 'model'`.
4. **Fallback (rules).** Timeout (8 s), provider error, invalid JSON, ineligible model, exhausted quota or cap → a templated reply that restates the proposal and offers the quick replies, `kind = 'fallback'`, shown once per conversation as a calm notice (proposed: «المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.»). Never an HTTP error; `ai_usage` records the failure (`status` failed/timed_out/rules_fallback).
5. **Record.** Every model call writes one `ai_usage` row (`prompt_version = plan-chat-v1`, tokens, cost or `null`, status); the learner message and the assistant message are stored in `plan_chat_messages`; the model's raw output is never stored.

**Prompt rules (`plan-chat-v1`, AI-agent.md).** The assistant: speaks only about plan logistics; never gives rulings, explanations, meanings or translations and answers such requests with the fixed message; never invents numbers (the server owns them); never reveals or asks for personal data; writes in the interface language; keeps replies short. The prompt text is reviewed documentation, versioned, and tested with the guard test set.

**Model selection (D60).** OpenRouter free models from `OPENROUTER_MODELS`, in order, only when live pricing is zero (as E28); structured output requested when the model documents it, otherwise the JSON is validated and a parse failure is a fallback. No paid call ever; no second provider without a verified free allowance.

### 2.5 Configuration (contract §8 additions)

`QATRA_OPENROUTER_FREE_REQUESTS_PER_DAY` (default 50, OpenRouter's published daily limit for free models without purchased credits; shared by the plan conversation and the demo planner), `QATRA_OPENROUTER_FREE_REQUESTS_PER_MINUTE` (default 20), `QATRA_CHAT_MODEL_CALLS_PER_ACCOUNT_PER_DAY` (default 10), `QATRA_CHAT_MODEL_TURNS_PER_CHAT` (default 6), `QATRA_CHAT_MODEL_TIMEOUT_SEC` (default 8), `QATRA_CHAT_MAX_TOKENS` (default 400), `QATRA_CHAT_GUARD_VERSION` (default `guard-v1`), `QATRA_CHAT_MODEL_FOR_LEARNERS` (default `true`; `false` = rules-only conversation for real accounts, §3 clause-9 risk). `OPENROUTER_API_KEY` becomes required in production for this feature; without it every turn is a rules turn (the journey still completes).

### 2.6 Privacy, terms and transparency (Authentication-and-privacy amendment)

- **D17 amended (D75):** what reaches the external provider is the plan goal and conversation text the learner types for this purpose and, for a plan revision, the learner's anonymized learning record and answers (R27), always under a temporary conversation id and never with account identifiers; account and session data never leave. The learner can complete the plan without free text (quick replies only).
- **Privacy statement, new paragraph (Arabic; owner-approved wording, A3, 4 October 2026):** «عند بناء خطتك أو تعديلها في المحادثة يُرسل نص هدفك ورسائلك في المحادثة وخيارات الخطة وبيانات الكتاب العامة إلى مزود نموذج ذكاء اصطناعي خارجي (OpenRouter، نماذج مجانية) لصياغة الخطة؛ وعند تعديل الخطة يُرسل أيضًا ملخص سجل تعلمك وإجاباتك (حالات الحفظ والمراجعات والأخطاء) تحت معرّف مؤقت للمحادثة لا يرتبط بحسابك. لا يُرسل اسم حسابك ولا معرّفه. تُحسب أرقام الخطة داخل التطبيق. يمكنك إكمال الخطة أو تعديلها بالخيارات الجاهزة دون كتابة نص حر.» (approved by the owner on 4 October 2026: «use best practice») `TERMS_VERSION` is set before the first public account; no re-consent is needed because no account exists yet.
- **Transparency line (replaces the D51 text in S-08, S-34 and S-22; proposed):** «تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي يستقبل وصف هدفك وخيارات الخطة، وعند التعديل ملخص تعلمك وإجاباتك، تحت معرّف مؤقت لا يكشف حسابك؛ وتُحسب الأرقام بمحرك القواعد داخل التطبيق.» (approved by the owner on 4 October 2026: «use best practice»)
- **Logging:** message text, goal text and model output are never logged (API-spec §1.12 list extended with E31, E32, E34 bodies).

### 2.7 UI changes (UI-design.md, UI-screens.md)

S-08 start form: title «ما هي خطتك؟»; category → book → edition; for the hadith category the path checkbox group (متن default, سند, الدرجة); 5/10/15 minutes; preferred date; the editable «الهدف والموعد» box pre-filled with the composed sentence; no order control; primary action «ابدأ المحادثة» → S-09 placement (skippable) → S-34. S-34 conversation screen: thread, plan card with the six sections, quick replies, text input (≤ 500), «اعتماد الخطة» enabled when a proposal exists, fallback notice, fixed refusal rendering, transparency line. S-13 revision: opens S-34 with `planId`; the structured fallback (minutes, date, paths, order) stays reachable when the model is unavailable. Flows 3.1 and 3.5 of UI-design.md are updated accordingly.

### 2.8 Build-plan impact (Qatra-build-plan v15 → v16)

| Package | Content | Depends on | Parallel | Size | Hours | Gate |
|---|---|---|---|---|---|---|
| B2b | migration `0006_plan_chats` with harness checks | B2 | yes | S | 1–2 | G3 |
| B13 | conversation backend: guard, quick-reply rules, templates (ar/en), OpenRouter structured-output provider with free-eligibility check, turn pipeline, E31–E34, `ai_usage`, payload-schema test, guard test set, memory-mode tests | B0, B2b, B4 (plan functions) | yes (R2) | XL | 14–20 | G3 |
| F14 | S-34 conversation screen, plan card, quick replies, S-08 and S-13 changes, mock conversation in memory mode | F0, G1 | with batch 2 | L | 8–12 | G2 (batch 2) |
| Q7 | QA cases: guard set, privacy payload, fallback journey, caps, latency | B13, F14 | yes | S | 2–4 | — |

Estimated added effort 25–38 hours; with the R2 workers the backend part runs in parallel with B3–B6. The D55 dates were already at very high risk (Qatra-build-plan §calibration); this package moves the earliest estimated finish later by about one calendar day unless capacity proves higher at CP1. No date is guaranteed.

### 2.9 Decisions on the points the propagation left open (coordinator, 4 October 2026; API-spec §4.10.3)

1. A revision conversation never changes the edition or the scope (E17 rule): `smaller_scope` is not offered and a model `targetScope` change is ignored with a templated reply explaining that a new scope needs a new plan.
2. E31 returns `replacedChatId?: string` inside `PlanChat` when an open conversation was replaced.
3. Validation rule names follow E15–E17 (`paths_invalid`, `scope_invalid`, `order_invalid`, `goal_text_length`).
4. `chat_closed` applies to E32 and E34; `quickReply = "confirm"` on E32 is `422 validation_error` (`quick_reply_confirm_use_e34`); `later_date` adds 25 % to the days, `no_date` clears `preferredDate`.
5. `goalText` is stored as the first learner message; when it is religious or out of scope, the first assistant turn is the fixed refusal or redirect followed by the rules proposal built from the structured selections.
6. Demo accounts: quick replies only (§1.3). `planner.source` keeps the contract values: `rules` for rules-built plans, `teaching_agent` for plans whose parameters came from a model turn (the model id in `planner.model`).
7. Confirming closes the conversation in the same transaction as the plan commit; `placementSessionId` is kept in the stored proposal only (not in the DTO).
8. No purge of abandoned conversations in the MVP (§2.1).

## 3. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Free models unavailable or slow at judging time | rules path completes every journey; 8 s timeout; calm fallback notice; keep-awake unchanged |
| Prompt injection through the goal text | structured output only; every parameter validated against the catalog and rules; the model has no tools, no data beyond the payload; the output guard filters religious or out-of-scope text |
| Arabic quality of free models | templates carry the plan; the model's text is limited to the goal and next-step phrasing and short replies; fallback templates are reviewed copy |
| Religious content generated despite instructions | double guard (input and output) with a maintained test set; the fixed D26 message is the only religious answer |
| Quota abuse | per-account daily cap, per-conversation cap, IP rate class, free-only (D60) |
| Organizer acceptance of external AI | D60 unchanged (free tier, no billing); disclosure in the terms; the comparison report of option C stays deferred |
| **Challenge terms clause 9** (as cited in [terms-citation.md](../references/terms-citation.md)): real users' conversations or personal data must not be uploaded to external AI services; testing must use synthetic or anonymized data | **Open risk for the owner (raised 4 October 2026).** The conversation sends learner-typed text under a temporary id with no personal fields, which the coordinator reads as anonymized, but a stricter reading of "conversations" would forbid it during judging. Mitigation built in: a configuration switch `QATRA_CHAT_MODEL_FOR_LEARNERS` (default `true`); when `false`, real accounts get the rules-only conversation (quick replies, templates) and the model serves demo accounts' synthetic context only. The owner decides the value for the judging window, ideally after asking the organizers |

## 4. Document amendments to apply after approval (owner approval of A1 (§5) authorizes these edits only)

| Document | Change |
|---|---|
| Decision-register.md | D75: the owner's decision (§0) with the amendments of D17, D38, D51, D72 (field placement), the declined takhrij path, and the approval record of this package |
| PRD.md v15 | M3 and M8 rows; R24–R29; NFR-15–18; roles matrix delta |
| UX.md v12 | S-08 fields, the conversation screen, D26 handling in the conversation, transparency line |
| Implementation-contract.md v1.5 | §5 conversation rules and caps; §7 DTOs and E31–E34; §8 configuration; §10 ownership (B13 files) |
| API-spec.md v1.2 | §1.8 chat rate class; §1.12 bodies never logged; §2.2 matrix rows E31–E34; §4.10 full operation specs; `sectionOrdinals` default raised to 60 (A-12 configuration, UG-13); §7 traceability |
| Database-schema.md v1.2 | `plan_chats`, `plan_chat_messages`, policies, `0006_plan_chats`; feedback → `0007` |
| AI-agent.md | the plan assistant for all learners: prompt `plan-chat-v1`, guard, structured output, free-model policy, budget |
| Authentication-and-privacy.md | D17 amendment, privacy paragraph, transparency line, personal-rows list |
| Programming-guide.md | router rows and files for the conversation (`routers/plan_chats.py`, `services/plan_chat.py`, `domain/plan_chat_policy.py`, `providers/openrouter.py`, `frontend/src/components/plans/PlanChat.tsx`) |
| QA-and-evaluation.md | the Q7 cases |
| Qatra-build-plan.md v16 | packages B2b, B13, F14, Q7; calendar note |
| UI-design.md, UI-screens.md | S-08, S-13, S-34 as in §2.7 (U1 update already in progress) |
| Readiness.tracker.md, README.md | status rows and index |

## 5. What the owner is asked to approve (gate G0-A)

| # | Decision | Default if the answer is «best practice» |
|---|---|---|
| A1 | Approve this amendment package (§1 analysis, §2 architecture, as amended in v1.1 by the owner's second answer) for modules M3 and M8, so that B2b, B13 and F14 may be scheduled | **Approved by the owner** («A1 approved , best practice», 4 October 2026) |
| A2 | ~~Confirm that takhrij becomes a fourth hadith memorization path~~ | **Declined by the owner** («لا داعي للتخريج», 4 October 2026): the three paths of contract §2.3 stay; takhrij is display-only |
| A3 | Confirm the privacy paragraph and the transparency line of §2.6 (wording), and that `TERMS_VERSION` is set before the first public account | **Approved by the owner** («use best practice», 4 October 2026): the v1.1 wording of §2.6 |
| A4 | Confirm the configuration defaults of NFR-18 as tunable settings, not promises | **Approved by the owner** («use best practice as mentioned in open router», 4 October 2026): caps derived from OpenRouter's published free-tier limits (§2.5), verified at provisioning |

A1 was approved by the owner on 4 October 2026 («A1 approved , best practice»); the document amendments of §4 are applied as Approved (D75), and B2b, B13 and F14 are scheduled under G3 and G1/G2. Before that answer, the only work that proceeds is documentation and the already-authorized B0–B2 and B7 packages; the migration `0006_plan_chats` and the B13/F14 code wait for A1.
