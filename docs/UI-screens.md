# Qatra — UI screen specifications (six dimensions)

> Version 1 · 4 October 2026 (Asia/Dubai) · Status: Draft — Needs Review (gate G1). Prepared by the Senior Product Designer role (Role 4); companion of UI-design.md (inventory) and UI-tokens.md (tokens); nothing here is approved or implemented.

**Contents:** [0 How to read](#0-how-to-read) · [1 Batch 1 — Account](#1-batch-1--account) · [2 Batch 2 — Catalog and plan](#2-batch-2--catalog-and-plan) · [3 Batch 3 — Games](#3-batch-3--games) · [4 Batch 4 — Session, progress, settings](#4-batch-4--session-progress-settings) · [5 Open points](#5-open-points)

## 0. How to read

**Purpose.** Work package U2, part A of [Qatra-build-plan.md](Qatra-build-plan.md): the six-dimension specification of S-01 to S-07 as inventoried in [UI-design.md](UI-design.md). The S-, G-, UA- and UG- IDs are fixed there and only cited here; part B appends the remaining screens in the batches below. Design documentation only: no screen, component or file of the application exists and nothing here authorizes implementation. Every screen is **Draft, Needs Review**; none is approved.

**Sources.** [UI-tokens.md](UI-tokens.md) (tokens and components, cited as «§n Name»); [UX.md](UX.md) v11 (rows «الدخول»، «إنشاء الحساب»، «حفظ رمز الاسترجاع»، «استرجاع الحساب» and § «الحساب والخصوصية في النصوص»); [Authentication-and-privacy.md](Authentication-and-privacy.md); [API-spec.md](API-spec.md) §1.5, §1.8, §1.11, §4.2 (E03–E10), §4.4 (E14); [PRD.md](PRD.md) (R03, R08, R10, R11, R12, R17, M1, M2, NFR-02, 06, 07, 09, 10, 14, roles matrix); [Decision-register.md](Decision-register.md) D52 (consent box), D67 (devices, WCAG 2.2 AA), D71 (public catalog, metadata only).

**The six dimensions**, numbered the same way for every screen: (1) purpose, role, entry and exit, primary action, acceptance references; (2) layout and hierarchy; (3) components, content, validation and dialogs, numbered `c1…` in reading order; (4) all UI states with trigger, change and copy, focus target and live-region announcement, inapplicable ones listed with the reason; (5) responsive, RTL/LTR and accessibility; (6) colour and typography.

**Conventions.**
- **Copy.** Arabic is verbatim where a governing source fixes it (column *Src* `F` plus the source, including a UX.md element name used as a label); everything else is **proposed** (`P`, with the document that proposed it where one did). Strings tagged with a G-ID come from UI-design §4, where they are themselves proposed; this file settles them. English is always proposed: no source fixes English copy (UI-tokens A7). Arabic examples use Arabic-Indic digits and English ones Western digits (UI-tokens §3.4, Q3 pending); usernames, passwords, recovery codes and references stay Western, left to right, in `<bdi>`. `{n}` marks a placeholder.
- **Tokens.** Names only; this file introduces no colour value. Contrast ratios are quoted from UI-tokens §2.3. An accessible name equals the visible label (icon buttons: the name given in the table), in the interface language.
- **Shells and widths.** S-01, S-02, S-03, S-05, S-07 use the public shell; S-04 and S-06 are focus screens (UI-design §2.1). None has a tab bar or rail at any width, so the UI-tokens §5 rail breakpoint (bottom bar below 1024 px, rail from 1024 px) does not apply (O-03). Width changes only margin and column: margin 24 px phone, 32 px tablet, 40 px desktop; form column at most 480 px, centred (O-06); reading column 640 px below 1024, 720 px from 1024. Spacing follows the scale of UI-tokens §4 (`--q-space-4`, `-8`, `-12`, `-16`, `-24`): 24 px between regions, 16 px between fields and as card padding, 8 px between adjacent targets.
- **Banner slots.** Slot T is directly below the H1 (arrival banners, error summary). Slot B is directly above the submit button, so a banner raised by a press is visible where the finger is.
- **Credential or state-changing submit** means E03 to E07; none is ever retried without a user gesture.

### 0.1 Shared patterns (P-01 to P-10)

- **P-01 Page chrome.** `<html lang dir>` follows the interface language (`ar`/`rtl` default, `en`/`ltr`). `<title>` «{screen name} — قطرة غيث» («{name} — Qatra», O-12). The first focusable element is the skip link «انتقل إلى المحتوى» (UI-tokens §7, proposed). After a route change focus moves to the H1 (`tabindex="-1"`); opening S-03 by an anchor focuses the target heading. No autofocus on first load. Landmarks: `header`, `main`.
- **P-02 Header and language switch.** Top app bar (§6.6; `--q-size-appbar`, fill `--q-color-bg`, no shadow, 1 px `--q-color-divider` once content scrolls). Start edge: back control (icon button 44×44, arrow mirrors in RTL, name «رجوع إلى {destination}» / "Back to {destination}") where the screen has one. End edge: switch «العربية \| EN», a Radio group and segmented control (§6.4) of two segments at least 44×44 px (§6.4 asks 88 px; narrower so back or logo plus switch fit 272 px at 320 px, O-05); hidden group label «اللغة» / "Language"; segment names «العربية» (`lang="ar"`) and «EN — English» (`lang="en"`); selected = fill `--q-color-selection`, 2 px `--q-color-border-selected`, check icon. Switching sets `lang` and `dir` at once, with no reload and no loss of typed values; focus stays on the segment; a polite status says «تم تغيير اللغة إلى العربية» / "Language changed to English". The choice is remembered for the visitor (O-14); the default follows the browser (English if it reports English, else Arabic, UA-11); E03 sends it as `language`; after login the profile language prevails.
- **P-03 Form validation and errors.** Format rules run on blur of a field with content (or one already in error) and all rules on submit, never per keystroke. An error clears at the field's next blur or submit; `username_taken` clears when the username is edited. The submit stays enabled (§6) except while loading or throttled. A field in error takes the Error recipe (2 px `--q-color-error-border`, message below with alert-circle icon in `--q-color-error-text`, `aria-invalid="true"`, `aria-describedby` helper then error). On submit focus goes to the first invalid field; with two or more errors a Banner (Error, `role="alert"`, title «يوجد {n} أخطاء في النموذج» / "There are {n} errors in the form") in Slot T lists the messages as links to the fields; with one error there is no summary (the field is announced through its description). Messages are keyed on `rule` or `error.code`; the API `message` is never shown and no value is echoed. Passwords are never trimmed or normalized.
- **P-04 Wake-up (G-01).** Banner (Info, loader icon, `role="status"`, not dismissible, §6.13) in Slot B, fixed copy «جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.» / "Starting the free server, this may take about a minute." Shown within 1 s of the first request that is slow or fails outside the error envelope, or when the first E01 probe fails. The form stays editable and submittable; the client polls E01 at 1, 2, 4, 8 s then every 10 s up to 90 s, then adds «إعادة المحاولة» inside the banner (restarts polling). When E01 answers the banner goes and, if a submit was in flight or failed, a polite status «الخادم جاهز. يمكنك المحاولة الآن.» / "The server is ready. You can try again now." (P) is announced. Credential or state-changing submits are not resent; a read (E14 on S-07) is. No elapsed-time counter, no error tone, typed values and the reset grant kept, focus unmoved, static loader under reduced motion. If a throttle delay (P-06) raises it, it disappears when E01 answers (UG-06).
- **P-05 Connectivity (G-02).** Banner (Info, no error tone, `role="status"`, not dismissible while offline) in Slot B. Forms: «لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.» / "There is no network connection. Check your connection and try again." (P; the G-02 sentence promises an automatic retry these screens never make, O-02). S-07 adds «إعادة المحاولة» / "Try again". The browser `offline` event raises it before any press; `online` removes it with the status «عاد الاتصال.» / "The connection is back." (P). The submit is never disabled for it (the browser flag is unreliable).
- **P-06 Throttle (G-15).** Banner (Warning, `role="status"`) in Slot B, static wording frozen at receipt: up to 60 s «محاولات كثيرة. انتظر {n} ثانية ثم أعد المحاولة.» / "Too many attempts. Wait {n} seconds and try again."; longer (the 15-minute lock) «محاولات كثيرة. يمكنك المحاولة بعد {mm:ss}.» / "Too many attempts. You can try again in {mm:ss}." `{n}` is the `Retry-After` header (equal to `details.retryAfterSec`). The submit takes the Disabled recipe with `aria-disabled="true"` and `aria-describedby` to the banner (it stays focusable so focus is not lost; activation is ignored). A visible line under it counts the remaining time each second in an `aria-hidden` element on a monotonic clock, so assistive technology hears only the start and the end; at zero the button re-enables and a polite status «يمكنك المحاولة الآن.» / "You can try again now." is announced, focus unmoved. This departs from §6.8 (static wording, no ticking countdown) to follow G-15 (O-01). The progressive-delay phase (after the fifth failure the server holds the answer 1 to 60 s) is a busy state: button Loading, no double submit, and after 5 s the polite line «ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.» / "We are still processing your request; this may take a moment." (P).
- **P-07 Service errors.** At most one banner (§6.8) in Slot B, replacing any earlier one; generic; values and grant kept; focus stays on the submit, which is the retry (no banner action). `internal` (G-16, Error, `role="alert"`) «حدث خطأ غير متوقع. حاول مرة أخرى.» / "Something unexpected happened. Try again." `unavailable` (G-17, Warning, `role="status"`) «الخدمة غير متاحة مؤقتًا. حاول بعد قليل.» / "The service is temporarily unavailable. Try again shortly." `forbidden_origin` (G-05, Error, `role="alert"`, with «إعادة تحميل الصفحة» / "Reload page", which loses typed values) «تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.» / "The request could not be completed. Reload the page and try again."
- **P-08 Password fields.** Text input (§6.2) with the show/hide icon button at the end edge inside the field (44×44, `aria-pressed`, names «إظهار كلمة المرور» / «إخفاء كلمة المرور», "Show password" / "Hide password", icon not mirrored; O-07); `dir="auto"`; paste and password managers allowed; no `autocomplete="off"`; no `maxlength` (it counts UTF-16 units and truncates silently, while the rule is 72 bytes). Client rule (S-02, S-05 step 2): at least 15 Unicode code points and at most 72 UTF-8 bytes on the raw value. Messages: empty «أدخل كلمة المرور.» / "Enter a password."; `password_min_chars` «كلمة المرور ١٥ حرفًا على الأقل.» (G-14) / "The password must be at least 15 characters."; `password_max_bytes` «كلمة المرور أطول من الحد المسموح (٧٢ بايت). اختصرها قليلًا؛ الحرف العربي الواحد يُحتسب بايتين.» / "The password is longer than the allowed limit (72 bytes). Shorten it a little; each Arabic letter counts as two bytes."; confirmation empty «أكّد كلمة المرور.» / "Confirm the password."; mismatch «كلمتا المرور غير متطابقتين.» (G-14) / "The two passwords do not match." (re-checked when either field blurs).
- **P-09 Arrival banner (S-01).** At most one, in Slot T, from in-memory flash state (never a URL parameter), shown once; priority: session ended (G-03), then reset done, then account deleted. Dismissible; not announced on load (it follows the H1, which has focus, so it is read next).
- **P-10 Uncertain outcome.** If E03 or E07 ends with no response at all, the screen cannot know whether it worked. A Warning banner in Slot B says so (copy per screen) and offers the safe path; if the next attempt answers `username_taken` (E03) or `invalid_credentials` (E07), the answer carries an extra hint line and a link to S-01 instead of implying a wrong entry.

### 0.2 Shared patterns of part B (P-11 to P-17)

Part B covers S-08, S-09, S-11, S-12, S-13, S-19, S-20, S-21 and S-34; all **Draft, Needs Review (G1)**. The conversation items follow D75 and the package [Plan-conversation.md](Plan-conversation.md) v1.1, whose approval A1 the owner gave on 4 October 2026; the screens themselves stay Draft until G1. Owner corrections of 4 October 2026 are applied: **three hadith paths only** (متن, سند, الدرجة; takhrij is always displayed with the hadith and never tested, so there is no takhrij box and no takhrij quick reply) and the transparency line v1.1 (P-15). In §4 tables Arabic copy is not repeated in English (the English counterparts of banner and status lines belong to the copy deck, UI-tokens A7); §3 tables and dialogs carry English. `P-01` to `P-10` are the patterns above.

- **P-11 Focus-flow chrome (S-08, S-09, S-19, S-34).** Top app bar (§6.6): back control at the start edge where there is one (icon button, name «رجوع إلى {destination}» / "Back to {destination}"), the H1 as the bar title (`--q-text-title`, may wrap, never clipped), actions at the end edge. No tab bar or rail at any width; reading column 640 px below 1024, 720 px from 1024. A **sticky action bar** (fill `--q-color-bg`, 1 px `--q-color-divider` top edge, `env(safe-area-inset-bottom)`, z-order 10) holds the primary action; `scroll-padding-block-start/-end` cover both bars (2.4.11). Margins `--q-space-24` (320–767 px), `-32` (768–1023), `-40` (from 1024); `--q-space-24` between regions, `-16` in cards, `-8` label to field.
- **P-12 Confirm dialogs and the sheet.** Native `<dialog>` with `showModal()` (§6.9); below 768 px docked to the bottom edge as a sheet (top corners `--q-radius-md`, `--q-shadow-raised`, `--q-color-scrim`), from 768 px the centred dialog (up to 400 px). Buttons stack, primary first. **Initial focus and Esc are the safe action** (continue or Cancel); a backdrop click closes only dialogs that lose nothing; focus returns to the opener. The sheet presentation is not in UI-tokens (O-22).
- **P-13 The six labelled sections.** Exact labels in this order: «الهدف الكلي»، «الزمن الكلي»، «الزمن اليومي»، «المراحل»، «المراجعات»، «الخطوة التالية». S-34: one description list inside the card (`dt`, `dd`); S-11, S-12: a `section` with an `h2` per pair. Label `--q-text-section`, text `--q-text-body-compact`, `--q-space-12` between pairs. Parts shown per screen follow the section map of UI-design §1.1 (S-11 omits «الزمن الكلي»). Numbers are printed as received; no screen computes a plan number.
- **P-14 Row-creating submits (E20 `placement`, E31, E32, E34).** Never retried automatically; button Loading (§6.1), width fixed, extra presses ignored; failures use P-05 (no automatic-retry promise), P-06, P-07 and keep the values. After a **no-response** outcome: E31 may be repeated (it replaces an open conversation); for E32 the retry first runs E33 and resends only if the learner's message is not the last one; for E34 it runs E33 first and, if `status = confirmed`, goes to S-11 (O-36).
- **P-15 Transparency notice** (§6.12 Notice: `--q-text-small`, `--q-color-text-secondary`, info icon, no fill, never dismissible, no live region), directly above the primary action or the composer, on S-08, S-13, S-34. Owner-approved wording (Plan-conversation v1.1 §2.6, A3, 4 October 2026): «تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي يستقبل وصف هدفك وخيارات الخطة، وعند التعديل ملخص تعلمك وإجاباتك، تحت معرّف مؤقت لا يكشف حسابك؛ وتُحسب الأرقام بمحرك القواعد داخل التطبيق.» English (P): "Your plan is built and revised in a conversation with an AI assistant that receives the description of your goal and the plan options, and, when you revise, a summary of your learning and answers, under a temporary identifier that does not reveal your account; the numbers are computed by the rules engine inside the app." No assistant switch exists (D51).
- **P-16 Numbers and dates.** One formatter with `ar-u-nu-arab` (Arabic UI) or Western digits (English UI), UI-tokens §3.4; learning dates are written from their parts, never through a time zone; durations «٩:٠٠» in `<bdi dir="ltr">`; Arabic plural forms via `Intl.PluralRules`. Server-built text must follow the same digit rule (O-29).
- **P-17 Original text and source line.** Original-text block (§6.12) `dir="rtl" lang="ar"` in both UI languages, no truncation, `text-align: start`, `font-synthesis: none`: Quran `--q-text-quran` in `--q-font-quran`, hadith `--q-text-hadith` in `--q-font-hadith`, words inside questions `--q-text-token`. Source line (`--q-text-small`, `--q-color-text-secondary`, « · » in `<bdi>`): «{bookTitleAr} · {editionLabel} · {reference}», then the printed page, or for electronic editions the canonical URL as a text link with the external-link icon (`rel="noopener noreferrer"`, name «{reference} — يفتح في نافذة جديدة» / "opens in a new tab"). **Never shown anywhere in part B:** translation or its button, an assistant switch, a certificate, a ranking, a countdown, generated religious text, a partial-recall indicator.

## 1. Batch 1 — Account

### S-01 Login — الدخول

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** A returning visitor opens a session with username and password (E04). No demo link in option B (UA-08).
- **Entry.** `/login` from S-07, S-02, S-05, S-27 (after deletion), S-06 (log out), S-04 (after reset), or guard 1 `/login?next=<path>` (same-origin app paths only). Guard 2: a valid session sends `/login` to `/today`, or `/start` without a plan.
- **Exit.** Success goes to `next`, else `/today` (`/start` when E18 says no plan); `reconsentRequired: true` goes to S-06 keeping `next`. Links: S-05, S-02. Back: S-07; until Batch 2 ships `/` redirects to `/login` and S-01 has no back control.
- **Primary action.** «دخول» / "Log in" (E04). **References.** R10; NFR-02, 06, 09, 10, 14; UX.md row «الدخول»; E04, E01; G-01 to G-05, G-15 to G-17.

**2. Layout and hierarchy**
- Public shell; header P-02 (back at the start edge, switch at the end edge).
- Phone, 24 px between regions, 16 px between fields: brand (droplet mark at the 32 px icon size of §4, app name in `--q-color-primary-deep`); H1; Slot T; username; password; Slot B; submit (full width, 48 px); «نسيت كلمة المرور» on its own 44 px line; create-account line. Tablet and desktop: the same column (480 px), nothing added. At 320×568 the page scrolls and `scroll-padding-block-start` covers the 56 px header.

**3. Components, content, validation**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | Back control (icon button), name | رجوع إلى تصفّح الكتب | Back to Browse books | P |
| c2 | H1 | الدخول | Log in | F UX.md (screen name) |
| c3 | Text input, username | اسم المستخدم | Username | P (UX.md names the element) |
| c4 | Text input, password (P-08) | كلمة المرور | Password | P (UX.md names the element) |
| c5 | Icon button show/hide | إظهار كلمة المرور / إخفاء كلمة المرور | Show password / Hide password | P (§6.2) |
| c6 | Button primary; loading | دخول؛ جارٍ الدخول… | Log in; Logging in… | «دخول» F UX.md element; loading P |
| c7 | Link | نسيت كلمة المرور | Forgot your password? | F UX.md |
| c8 | Text and link | ليس لديك حساب؟ إنشاء حساب | Don't have an account? Create an account | P; link text F UX.md |

Chrome (skip link, switch): P-01, P-02.
- **Field rules.** Username: `dir="auto"`, `autocomplete="username"`, `autocapitalize="none"`, `autocorrect="off"`, `spellcheck="false"`, `inputmode="text"`, `enterkeyhint="next"`; outer spaces trimmed before sending (P). Password: P-08 without length checks (E04 does not apply the registration rules), `autocomplete="current-password"`, `enterkeyhint="go"`. No placeholders.
- **Validation.** On submit only: empty username «أدخل اسم المستخدم.» / "Enter your username."; empty password «أدخل كلمة المرور.» / "Enter your password." (G-14 client-only).
- **E04 mapping.** `invalid_credentials` (G-04): Error banner Slot B, `role="alert"`, «اسم المستخدم أو كلمة المرور غير صحيحة.» / "The username or password is not correct."; no field is marked invalid; the password is cleared and focused. `throttled`: P-06. `forbidden_origin`, `internal`, `unavailable`: P-07 (a `validation_error` cannot occur after the client checks and is treated as `internal`). No response: P-04 or P-05. `200`: redirect, password wiped from memory.
- **Dialogs.** None. **Never shown.** Whether an account exists, which part was wrong, attempts left, a demo link, "remember me", a CAPTCHA or puzzle (3.3.8), email or phone fields.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Initial | route load | empty form | c2 | page title |
| Field error | empty field on submit | P-03 messages | first invalid field | summary if two |
| Submitting | E04 in flight | c6 Loading, `aria-busy`, fields kept | stays on c6 | polite «جارٍ الدخول» |
| Generic failure | `401` (G-04) | banner above; password cleared | c4 | alert |
| Throttled | `429` | P-06; c6 `aria-disabled` | stays on c6 | start and end |
| Wake-up; offline | G-01; G-02 | P-04; P-05 | unchanged | status |
| Service error | 500, 503, 403 origin | P-07 | c6 | alert or status |
| Session ended | arrival after G-03 | Warning banner Slot T «انتهت جلستك. سجّل الدخول للمتابعة.» / "Your session ended. Log in to continue." (P); `next` kept | c2 | none |
| Reset done | arrival from S-04 | Success banner «تم تعيين كلمة مرور جديدة. سجّل الدخول بها.» / "Your new password is set. Log in with it." (P) | c2 | none |
| Account deleted | arrival from S-27 | Info banner «تم حذف حسابك.» / "Your account was deleted." (P; S-27 owns it) | c2 | none |
| Retry and recovery | after any banner | c6 is the retry; after wake-up the banner clears and the ready status is announced; after a throttle the button re-enables; the username stays, the password is cleared only for G-04 | c6 | per pattern |
| Success | `200` | redirect, no message | H1 of destination | its title |
| Not applicable | empty and populated (a form lists no data); access denied (public, a session redirects); pending sync (option B stores nothing, UA-08); offline shell (S-31 deferred); disabled (only the throttle case above) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- One column from 320 px, 480 px column from 560 px; no horizontal scroll at 200 % zoom (1.4.4, 1.4.10); containers grow with text. Logical properties, DOM order equals visual order; back arrow mirrors, eye icon does not; typed values are `dir="auto"`. Fields and button 48 px, icon button 44×44, each link on its own 44 px line 8 px apart.
- **Focus order.** skip link, c1, switch, [banner dismiss], c3, c4, c5, c6, c7, c8 link. **Keyboard.** Enter in either field submits; Space or Enter on c5; Esc has no role; the switch is one tab stop (Left is next in RTL).
- **Errors and names.** `aria-invalid` and `aria-describedby` as P-03; banners `role` per P-04 to P-07; one H1. Paste, password managers and show-password are allowed; nothing blocks or tests the user.
- **Contrast pairs.** `--q-color-text` on `--q-color-bg` 11.19; `--q-color-link` on `--q-color-bg` 8.27; `--q-color-on-primary` on `--q-color-primary` 4.77; `--q-color-error-text` on `--q-color-error-bg` 5.81; `--q-color-warning-text` on `--q-color-warning-bg` 5.79; field border `--q-color-border` on `--q-color-surface` 3.32; focus ring 8.27. Autofill styling must keep `--q-color-text` legible. Reduced motion: static loader, instant banners.

**6. Colour and typography**
- Page `--q-color-bg`; fields `--q-color-surface` with `--q-color-border`; primary button `--q-color-primary` (hover `--q-color-primary-deep`, pressed `--q-color-primary-pressed`); links `--q-color-link` underlined. H1 `--q-text-title`; labels `--q-text-body-compact`; inputs `--q-text-body`; errors `--q-text-small`; button `--q-text-button`; app name `--q-text-section`; fonts `--q-font-ui-ar` or `--q-font-ui-en`. No religious text appears on this screen and no religious font is loaded for it.

### S-02 Register — إنشاء الحساب

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** A visitor creates a learner account with the minimum data and the mandatory, unchecked consent box (D52). The time zone comes from the browser (fallback O-15) and the language from the switch; neither is a field.
- **Entry.** `/register` from S-07 and S-01; guard 2 redirects a signed-in user. Demo registration (E26, same box) is deferred S-28.
- **Exit.** E03 `201` (cookie set) goes to S-04 by `replace` navigation, so back never returns to the filled form; S-04 continues to S-08 (placeholder until Batch 2). Links: S-03, S-01. Back: S-07 (`/login` until Batch 2).
- **Primary action.** «إنشاء الحساب» / "Create account" (E03). **References.** R10, R17; NFR-06, 07 (no email, phone or birth date), 09, 10, 14; D52; UX.md row «إنشاء الحساب»; E03; G-01, G-02, G-05, G-08, G-14 to G-18.

**2. Layout and hierarchy**
- Public shell; header as S-01. Phone order, 24 px between regions: H1; Slot T; statement and terms link; username; password; confirmation; recovery-code Notice; consent block (box row, then one 44 px link line per document); Slot B; submit; login line. The terms link appears before the button and the consent block sits right above it (D52). Tablet and desktop: the 480 px column. No progress steps, no illustration.

**3. Components, content, validation**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | Back control, name | رجوع إلى تصفّح الكتب | Back to Browse books | P |
| c2 | H1 | إنشاء الحساب | Create an account | F UX.md (screen name) |
| c3 | Body text | لا نطلب بريدًا إلكترونيًا ولا رقم هاتف ولا تاريخ ميلاد؛ اسم مستخدم وكلمة مرور فقط. جميع الحقول مطلوبة. | We do not ask for an email address, phone number or date of birth; only a username and a password. All fields are required. | P (UX.md fixes the statement, not its words) |
| c4 | Link, own line | شروط الاستخدام وبيان الخصوصية | Terms of use and privacy statement | F UX.md |
| c5 | Text input, username, helper | اسم المستخدم — من ٣ إلى ٢٤ حرفًا: حروف عربية أو إنجليزية وأرقام وشرطة سفلية (_). | Username — 3 to 24 characters: Arabic or English letters, digits and underscore (_). | P |
| c6 | Text input, password (P-08), helper | كلمة المرور — ١٥ حرفًا على الأقل. يمكنك استخدام عبارة طويلة، ومدير كلمات المرور مقبول. | Password — At least 15 characters. A long phrase works well and a password manager is welcome. | P |
| c7 | Icon button show/hide | P-08 | P-08 | P (§6.2) |
| c8 | Text input, confirmation | تأكيد كلمة المرور | Confirm password | P |
| c9 | Icon button show/hide | P-08 | P-08 | P (§6.2) |
| c10 | Notice (no fill, not dismissible) | بعد إنشاء الحساب نعرض لك رمز استرجاع مرة واحدة. إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك. | After you create the account we show you a recovery code once. If you lose both your password and the code, we cannot recover your account. | P (said at registration, Authentication-and-privacy) |
| c11 | Checkbox, unchecked, `aria-required` | قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها | I have read the terms of use and privacy statement and I agree to them. | F D52, UX.md, §6.3; English P |
| c12 | Link, own 44 px line, `/terms#terms` | شروط الاستخدام | Terms of use | P (§6.3) |
| c13 | Link, own 44 px line, `/terms#privacy` | بيان الخصوصية | Privacy statement | P (§6.3) |
| c14 | Button primary; loading | إنشاء الحساب؛ جارٍ إنشاء الحساب… | Create account; Creating your account… | P (screen name reused) |
| c15 | Text and link | لديك حساب؟ تسجيل الدخول | Already have an account? Log in | P |

- **Field rules.** Username: S-01 attributes, no `maxlength`, no trimming (a space is an error, not silently removed). Passwords: `autocomplete="new-password"`. `<form novalidate>`: no browser bubbles; the box is checked by script, not `required`.
- **Validation (P-03).** Username, first failure only, in this order: empty «أدخل اسم المستخدم.» / "Enter a username."; space or invisible character (`username_invisible_or_space`) «لا يقبل اسم المستخدم مسافات أو محارف غير مرئية.» / "A username cannot contain spaces or invisible characters."; other character (`username_chars`; allowed: Arabic letters, English letters, digits 0–9, Arabic-Indic digits, underscore) «يقبل اسم المستخدم حروفًا عربية أو إنجليزية وأرقامًا وشرطة سفلية فقط.» / "A username can contain only Arabic or English letters, digits and underscore."; length after NFKC (`username_length`) «اسم المستخدم من ٣ إلى ٢٤ حرفًا.» (G-14) / "The username must be 3 to 24 characters." Passwords: P-08. Consent unchecked on submit, no request sent: «يلزم الموافقة على شروط الاستخدام وبيان الخصوصية لإنشاء الحساب.» (G-18) / "You must agree to the terms of use and privacy statement to create an account." Uniqueness is answered by the server at submit only.
- **E03 mapping.** `username_taken` (G-08): field error at c5, «اسم المستخدم غير متاح. اختر اسمًا آخر.» / "This username is not available. Choose another.", values kept, c5 focused. `terms_required`: if `details.requiredVersion` differs from the version bundled with S-03, Error banner «تحدّثت الشروط. أعد تحميل الصفحة لقراءة الإصدار الأحدث.» / "The terms were updated. Reload the page to read the latest version." with the reload button (O-09); otherwise the field error at c11. `validation_error`: `username_*`, `password_*` map to the messages above; `time_zone_invalid`, `language_invalid`, `forbidden_field` are not learner-fixable and show as `internal`. `throttled` (10 per minute per IP): P-06. `forbidden_origin`, `internal`, `unavailable`: P-07. No response outside the error envelope: P-10 (a request that was sent may have succeeded), plus P-04 when E01 also fails or P-05 when offline. P-10 copy: «تعذّر تأكيد إنشاء الحساب. إن كان قد أُنشئ فسجّل الدخول بالاسم وكلمة المرور ثم أنشئ رمز استرجاع جديدًا من الإعدادات؛ وإلا أعد المحاولة.» / "We could not confirm that the account was created. If it was, log in with your username and password and create a new recovery code in Settings; otherwise try again." Hint after `username_taken`: «إن كنت قد أنشأت هذا الحساب قبل لحظات فسجّل الدخول بدل ذلك.» / "If you created this account a moment ago, log in instead."
- **Dialogs.** None; consent is inline. Opening S-03 keeps every typed value, passwords included, in a route-persistent in-memory store (never storage), wiped on success, reload and logout; S-02 prefetches `/terms`.
- **Never shown.** Email, phone or birth fields; the time zone or language as fields; the recovery code (S-04 owns it); suggestions of free usernames.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Initial | route load | empty form, box unchecked | c2 | title |
| Field errors | blur or submit | messages above; summary in Slot T from two errors | first invalid field | summary alert |
| Consent missing | submit, c11 unchecked | Error recipe at c11; no request | c11 | via description |
| Submitting | E03 in flight | c14 Loading; fields kept | stays on c14 | polite «جارٍ إنشاء الحساب» |
| Username taken | `409` (G-08) | field error at c5; P-10 hint if applicable | c5 | via description |
| Throttled | `429` (G-15) | P-06 | stays | start and end |
| Wake-up; offline; uncertain | G-01; G-02; no answer after sending | P-04; P-05; P-05 plus P-10 | unchanged | status |
| Service error | 500, 503, 403 origin | P-07 | c14 | alert or status |
| Terms mismatch | `terms_required`, other version | Error banner with reload | its button | alert |
| Retry and recovery | after any banner | c14 is the retry, values kept; after an uncertain outcome the learner may log in instead | c14 | per pattern |
| Success | `201` | fields wiped; to S-04 | H1 of S-04 | its title |
| Not applicable | empty and populated (a form lists no data); access denied (a session redirects); pending sync (UA-08); disabled (throttle only) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- One column from 320 px, 480 px column from 560 px, no horizontal scroll at 200 % zoom; logical properties; the box row (the label is part of the target) and the link lines are at least 44 px high and 8 px apart; fields and button 48 px.
- **Focus order.** skip link, c1, switch, [summary links], c4, c5, c6, c7, c8, c9, c11, c12, c13, c14, c15. **Keyboard.** Enter submits; Space toggles c11; Esc has no role; summary links focus their field.
- **Names and errors.** Errors and helpers linked by `aria-describedby`; the box label is exactly the fixed sentence, with its two links outside the label.
- **Contrast pairs.** As S-01 plus `--q-color-text-secondary` on `--q-color-bg` 5.10 (helpers), `--q-color-error-border` on `--q-color-surface` 5.52, box border `--q-color-border` on `--q-color-surface` 3.32. Reduced motion as S-01.

**6. Colour and typography**
- Tokens as S-01; helper and Notice text `--q-text-small` in `--q-color-text-secondary` (Notice with info icon); errors `--q-color-error-text` with alert-circle icon, never colour alone; checked box `--q-color-primary` with `--q-color-on-primary` check. No religious text appears on this screen.

### S-03 Terms & privacy — شروط الاستخدام وبيان الخصوصية

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** Static text page in the interface language with its version (`TERMS_VERSION`, now `2026-10-04`); visitor, learner, demo (guard 13: always open). The wording is owned by [Authentication-and-privacy.md](Authentication-and-privacy.md) § «شروط الاستخدام وبيان الخصوصية», written during the build, not legally reviewed; this screen owns presentation only, which S-26 reuses in the app shell.
- **Entry.** `/terms` from S-02 (three links, two with anchors `#terms`, `#privacy`), from S-06, or directly. **Exit.** Back to the opener with its state kept, or `/` when opened directly.
- **Primary action.** Reading; one secondary button returns. There is no agree control here: consent lives only in S-02 and S-06.
- **References.** R10, R17; NFR-09, 14 (both languages); D52, D53, D50, D26, D25, D17, D51; no API operation.

**2. Layout and hierarchy**
- Public shell; header: back and switch. Reading column (640 px below 1024, 720 px from 1024; 24 px margin on phone), no cards. Order: H1; version line; H2 «شروط الاستخدام» (`id="terms"`); divider (decorative); H2 «بيان الخصوصية» (`id="privacy"`); each part has H3 topics with paragraphs and short lists; closing return button. Space: 24 px between topics, 16 px between paragraphs, 8 px between list items.
- Proposed topic headings, mapped to the source bullets (body wording stays with the source): Terms: «الكتاب كما هو» / The book as it is (book as written, takhrij and grade as in the edition, the D53 sentence); «صحة المراجع» / Accuracy of references (content manager's duty); «لا فتوى ولا شرح» / No fatwa or explanation (D26). Privacy: «البيانات التي نجمعها» / Data we collect; «بيانات الحساب والنموذج الخارجي» / Account data and external models (nothing sent; the D51 line); «الحذف والاحتفاظ» / Deletion and retention; «ما لا نستنتجه عنك» / What we do not infer (no religion or traits). The source's offline paragraph describes option C and is shown only when F13 ships (O-13).

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | Back control, name | رجوع إلى {إنشاء الحساب / الموافقة / الصفحة الرئيسية} | Back to {Create account / Consent / Home} | P |
| c2 | H1 | شروط الاستخدام وبيان الخصوصية | Terms of use and privacy statement | F UX.md |
| c3 | Version line | إصدار الشروط: {TERMS_VERSION} | Terms version: {TERMS_VERSION} | P |
| c4 | H2, H3, paragraphs, lists | as above | as above | P headings; text owned by source |
| c5 | Quoted fixed sentences in the text | «تنبيه: نُقل هذا النص حرفيًا عن الكتاب، ولم يُتحقق من صحة الحديث.»؛ «تُبنى خطتك أثناء التحدي بمحرك قواعد داخل التطبيق دون إرسال بياناتك إلى نموذج خارجي؛ وكيل التعليم يعمل في حساب العرض على حالات اصطناعية.» | proposed translations | F D53, D51 |
| c6 | Button secondary | العودة إلى إنشاء الحساب / العودة إلى الموافقة / العودة إلى الصفحة الرئيسية | Back to create account / consent / home | P |

- **Validation, dialogs, links.** None; no outbound links. **Never shown.** An agree control, legal-advice wording, a cookie banner (not in the sources), any text from outside the source document.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Populated | route load | static text | c2, or the anchor's H2 (`tabindex="-1"`, `scroll-margin-block-start` = header + 8 px) | title |
| Route loading | chunk still loading | skeleton lines (§6.14) after 300 ms, `aria-busy` | unchanged | «جارٍ التحميل» |
| Text unavailable | route chunk fails | Error banner «تعذّر فتح شروط الاستخدام وبيان الخصوصية. تحقّق من الاتصال ثم أعد المحاولة.» / "The terms of use and privacy statement could not be opened. Check your connection and try again." with «إعادة المحاولة» | the button | alert |
| Language switched | P-02 | text re-renders; scroll kept | segment | status |
| Not applicable | data loading (static), empty, access denied (guard 13), wake-up and throttle (no API call), pending sync, disabled, success | — | — | — |

S-02 and S-06 prefetch this route, so "text unavailable" should not follow a loaded opener. A missing translation fails the build (NFR-14), never a runtime fallback.

**5. Responsive, RTL/LTR, accessibility**
- H1, H2, H3 in order; real lists; anchor targets focusable (`tabindex="-1"`); text reflows at 320 px and under text-spacing overrides; version in `<bdi>`; no smooth scroll under reduced motion.
- **Focus order.** skip link, c1, switch, then the text (nothing focusable), c6. Esc does nothing; back keeps the opener's state.
- **Contrast pairs.** `--q-color-text` on `--q-color-bg` 11.19; version `--q-color-text-secondary` on `--q-color-bg` 5.10; Error banner as S-01.

**6. Colour and typography**
- Page `--q-color-bg`; divider `--q-color-divider` (decorative). H1 `--q-text-title`; H2 `--q-text-section`; H3 `--q-text-body` at weight 600; body `--q-text-body`; version `--q-text-small`; UI fonts only. No religious text appears here: the D53 sentence is interface copy about a hadith, not hadith text, so `--q-font-hadith` is not used.

### S-04 Recovery-code save (state) — حفظ رمز الاسترجاع

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** Shows the 128-bit recovery code once, has the learner store it outside the app, and gates continuing on an explicit confirmation. Learner or demo with a session (hosts E03, E08) or a visitor mid-recovery without one (host E07). It calls no API: the code arrives with the host's response and lives in memory only (UA-06).
- **Entry.** `/recovery-code` by `replace` navigation after E03 `201`, E07 `200` or E08 `200` (S-24, Batch 4). Guard 9: without the in-memory code the route returns to the host with an Info banner.
- **Exit.** «متابعة» goes to the host's next screen: after E03 S-08 (placeholder until Batch 2); after E07 S-01 with the reset-done banner (P-09); after E08 S-22. S-04 is also step 3 of S-05.
- **Primary action.** «متابعة» / "Continue", gated by the confirmation box: an error appears instead of a disabled button (§6.15). **References.** R10, R17; NFR-06 (128-bit code), NFR-09; UX.md row «حفظ رمز الاسترجاع»; Authentication-and-privacy «تجربة الحساب»; E03, E07, E08; UA-06.

**2. Layout and hierarchy**
- Focus screen: no tab bar, no back control (back would abandon an unconfirmed one-time code), no language switch; the header shows only the droplet mark and app name, not a link. Phone order, 24 px between regions: step line (recovery host only); H1; lead; Warning banner; code block; Copy and Download side by side (8 px apart); confirmation box; Continue (full width). The block keeps two lines of four groups at every width (about 230 px, fits 272 px), so the code is dictated the same way on every device; tablet and desktop use the same 480 px column.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | Step line (recovery host), `--q-text-small` | الخطوة ٣ من ٣ | Step 3 of 3 | P |
| c2 | H1 | حفظ رمز الاسترجاع | Save your recovery code | F UX.md (screen name) |
| c3 | Lead, referenced by `aria-describedby` of the H1 | يظهر هذا الرمز مرة واحدة فقط ولن نستطيع عرضه لك مرة أخرى. احفظه في مكان آمن خارج التطبيق. | This code is shown only once and we cannot show it to you again. Keep it in a safe place outside the app. | P |
| c3b | Extra sentence (E07, E08 hosts) | الرمز القديم لم يعد صالحًا. | Your old code no longer works. | P |
| c4 | Banner Warning, not dismissible | لا يمكن استرجاع الحساب دون الرمز — إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك. | The account cannot be recovered without the code — If you lose both your password and this code, we cannot recover your account. | P (UX.md requires the loss statement) |
| c5 | Recovery-code display block (§6.15); name and description | رمز الاسترجاع؛ يظهر مرة واحدة فقط | Recovery code; Shown once only | P |
| c6 | Button secondary, copy icon | نسخ | Copy | P (§6.15) |
| c7 | Button secondary, download icon | تنزيل | Download | P (§6.15) |
| c8 | Checkbox, unchecked | حفظت الرمز في مكان آمن خارج التطبيق | I have saved the code in a safe place outside the app | P (base «حفظت الرمز», §6.3) |
| c9 | Button primary | متابعة | Continue | P |

- **The block.** 32 lowercase hex characters in eight groups of four joined by `-`, `dir="ltr"`, `translate="no"`, `--q-font-mono`, `user-select: all`, each group a `<span>`. The code is never in the URL, history state, storage, document title, an `aria-live` region, logs or analytics; it is wiped on continue, on leave and on reload.
- **Copy.** Writes the code with its dashes to the clipboard; Toast (§6.8) «تم النسخ» / "Copied" (P, §6.8). If the clipboard is unavailable: Notice «تعذّر النسخ تلقائيًا. حدّد الرمز وانسخه يدويًا.» / "Automatic copy is not available. Select the code and copy it by hand." and the text is selected.
- **Download.** A client-generated UTF-8 file `qatra-recovery-code.txt`, three lines (P): «قطرة غيث — رمز الاسترجاع» / "Qatra — recovery code"; the code; «احتفظ بهذا الملف في مكان آمن ولا تشاركه.» / "Keep this file somewhere safe and do not share it." It never contains the username, since username plus code would let anyone reset the password (O-17). Toast «تم تنزيل الملف» / "File downloaded" (P).
- **Validation.** Continue with c8 unchecked: Error recipe at c8, no navigation, «أكّد أنك حفظت الرمز قبل المتابعة.» / "Confirm that you have saved the code before you continue." (P).
- **Leave dialog** (browser back, edge swipe or any in-app route change while c8 is unchecked; Dialog §6.9, `role="alertdialog"`; leaving is allowed, O-16). Title «لم تؤكد حفظ الرمز» / "You have not confirmed saving the code"; body «إن غادرت الآن فلن يظهر هذا الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.» (recovery host: «… من الإعدادات بعد تسجيل الدخول.») / "If you leave now this code will not be shown again. You can create a new one in Settings." (recovery host: "… in Settings after you log in."); buttons «البقاء وحفظ الرمز» / "Stay and save the code" (primary, initial focus) and «المغادرة دون حفظ» / "Leave without saving" (secondary); Esc means stay. Leaving goes to the host's next screen with the guard-9 banner. A `beforeunload` prompt covers tab close and reload while c8 is unchecked (the browser's own wording).
- **Never shown.** The code again after leaving; an old code; the username; a masked or hidden-by-default code.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Default | arrival | code shown, box unchecked | c2 | H1 plus its description (the one-time sentence) |
| Copied; downloaded | c6; c7 pressed | toast «تم النسخ»; toast «تم تنزيل الملف» | stays on the button | polite, once |
| Copy unavailable | clipboard rejects | Notice below the buttons; text selected | stays on c6 | status |
| Unconfirmed | Continue, c8 unchecked | field error at c8 | c8 | via description |
| Leave attempt | back or route change, c8 unchecked | Leave dialog | «البقاء وحفظ الرمز» | dialog title and body |
| Continue | c9, c8 checked | memory wiped; navigate | H1 of destination | its title |
| Code absent | reload or deep link (guard 9) | back to the host with Info banner «لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.» / "The code cannot be shown again. You can create a new one in Settings." (recovery host: S-01 and «… بعد تسجيل الدخول») | H1 of host | none |
| Not applicable | loading and empty (no request; guard 9 is the empty case); wake-up, offline, throttle, service errors and session ended (no request; copy and download work offline); access denied; pending sync; disabled (nothing is disabled) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- The block stays left to right in an Arabic page; the copy and download icons do not mirror; buttons at least 44 px high and 88 px wide, 8 px apart; text selectable; reflow at 320 px and 200 % zoom.
- **Focus order.** skip link, c6, c7, c8, c9; the block is not focusable and is read in place after the banner. No second hidden copy of the code is added for assistive technology: Copy is the non-visual route and screen-reader users review the visible text by character. The one-time nature is announced through the H1 description and repeated in c4.
- **Keyboard.** Space toggles c8; Enter activates buttons; Esc closes the dialog (stay); focus returns to the opener element.
- **Contrast pairs.** `--q-color-text` on `--q-color-surface` 11.76 (code); `--q-color-warning-text` on `--q-color-warning-bg` 5.79; toast white on `--q-color-inverse-bg` 11.76. Toast without slide under reduced motion.

**6. Colour and typography**
- Block fill `--q-color-surface`, 1 px `--q-color-border`, `--q-radius-md`, padding `--q-space-16`; code `--q-font-mono` 20 px, line height 1.8, `--q-color-text`; banner `--q-color-warning-*`; buttons §6.1; H1 `--q-text-title`; lead `--q-text-body`. No religious text appears on this screen and no religious font is loaded for it.

### S-05 Account recovery (3 steps) — استرجاع الحساب

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** A visitor who lost the password regains access with username and recovery code (E06), sets a new password (E07) and receives a replacement code (S-04). No personal questions, email or SMS. The reset grant and its start time live in memory only, never in storage or the URL; a reload discards the grant (O-10).
- **Entry.** `/recovery` from S-01 «نسيت كلمة المرور»; guard 2 redirects a signed-in user. **Exit.** Step 3 is S-04 (recovery host), then S-01 with the reset-done banner; E07 creates no session, so the learner always logs in again. Back: S-07 (`/login` until Batch 2), which discards the grant.
- **Primary action per step.** Step 1 «تحقق» (E06); step 2 «تعيين كلمة المرور» (E07); step 3 «متابعة» (S-04). **References.** R10; NFR-06, 09; UX.md row «استرجاع الحساب»; Authentication-and-privacy «استرجاع آمن قابل للاختبار»; E06, E07; G-01, G-02, G-04, G-05, G-14 to G-17.

**2. Layout and hierarchy**
- Public shell; header as S-01. Phone order: H1; step H2 (its text carries the step number); Slot T; lead; fields; Notice; Slot B; button; for step 1 the line «تذكّرت كلمة المرور؟ تسجيل الدخول». Tablet and desktop: 480 px column. Steps change in place without extra history entries, so the browser back button leaves the flow.

**3. Components, content, validation**

| # | Step | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|---|
| c1 | all | Back control, name | رجوع إلى تصفّح الكتب | Back to Browse books | P |
| c2 | all | H1 | استرجاع الحساب | Account recovery | F UX.md (screen name) |
| c3 | 1 | H2 | الخطوة ١ من ٣: التحقق من الرمز | Step 1 of 3: Verify your code | P |
| c4 | 1 | Lead | أدخل اسم المستخدم ورمز الاسترجاع الذي حفظته عند التسجيل. | Enter your username and the recovery code you saved when you registered. | P |
| c5 | 1 | Text input, username | اسم المستخدم | Username | P (UX.md names the element) |
| c6 | 1 | Text input, recovery code, helper | رمز الاسترجاع — ٣٢ خانة، مع الفواصل أو بدونها. | Recovery code — 32 characters, with or without dashes. | P |
| c7 | 1 | Notice | بعد التحقق تكون أمامك ١٠ دقائق لتعيين كلمة مرور جديدة. | After verification you have 10 minutes to set a new password. | P |
| c8 | 1 | Button primary; loading | تحقق؛ جارٍ التحقق… | Verify; Verifying… | P |
| c9 | 1 | Text and link | تذكّرت كلمة المرور؟ تسجيل الدخول | Remembered your password? Log in | P |
| c3′ | 2 | H2 | الخطوة ٢ من ٣: كلمة مرور جديدة | Step 2 of 3: New password | P |
| c4′ | 2 | Lead | تم التحقق. اختر كلمة مرور جديدة. | Verified. Choose a new password. | P |
| c5′ | 2 | Text inputs (P-08) and toggles | كلمة المرور الجديدة؛ تأكيد كلمة المرور الجديدة | New password; Confirm new password | P |
| c7′ | 2 | Notice | سيتوقف الرمز الحالي، وسنعرض لك رمزًا بديلًا مرة واحدة. | Your current code will stop working and we will show you a replacement once. | P |
| c8′ | 2 | Button primary; loading | تعيين كلمة المرور؛ جارٍ التعيين… | Set password; Setting… | P |

- **Field rules.** Username as S-01. Code: `dir="ltr"`, `--q-font-mono`, `autocomplete="off"`, `inputmode="text"`, `autocapitalize="none"`, `autocorrect="off"`, `spellcheck="false"`, paste allowed, shown unmasked, no input mask and no automatic dashes (they move the caret). Step 2 adds a visually hidden username field (`autocomplete="username"`, `tabindex="-1"`, `aria-hidden`) so password managers save the new password under the right name; the new fields use `autocomplete="new-password"`.
- **Validation.** Step 1 on blur and submit: empty username «أدخل اسم المستخدم.»; empty code «أدخل رمز الاسترجاع.» / "Enter the recovery code."; after removing dashes and spaces, mapping Arabic-Indic digits to 0–9 and A–F to a–f, anything other than 32 hexadecimal characters «رمز الاسترجاع يتكوّن من ٣٢ خانة (أرقام وحروف من a إلى f).» / "The recovery code has 32 characters (digits and letters a to f)." This format check sends nothing, so it neither counts toward the throttle nor reveals anything about an account (O-11). Step 2: P-08. Before sending E07 the client compares the time since the E06 answer with `expiresInSec` (600 s, counted from the response, so never earlier than the server); if elapsed it sends nothing and shows the generic message below. No timer is shown: the limit is stated once in c7 (an essential security limit, WCAG 2.2.1).
- **E06 and E07 mapping.** `invalid_credentials` (G-04) in step 1: Error banner Slot B «بيانات الاسترجاع غير صحيحة أو لم تعد صالحة.» / "The recovery details are not correct or are no longer valid."; code cleared and focused, username kept, counted by the throttle. The same single message covers unknown username, wrong code, used code and, in step 2, an expired, used or lost grant: the flow returns to step 1 with that banner, passwords wiped, username kept, focus on c3. `validation_error` in step 2: the password messages at the field. `throttled` (E06, E07): P-06. `unavailable`: P-07; in step 2 the grant and typed passwords are kept and the same grant is reused. `internal`, `forbidden_origin`: P-07. No response in step 1: P-04 or P-05. No response in step 2: P-10, Warning banner «تعذّر تأكيد النتيجة. إن كانت كلمة المرور قد تغيّرت فسجّل الدخول بها، وإلا أعد المحاولة. بعد الدخول يمكنك إنشاء رمز جديد من الإعدادات.» / "We could not confirm the result. If your password changed, log in with it; otherwise try again. After you log in you can create a new code in Settings." with a link «تسجيل الدخول» / "Log in"; if the retry then answers `invalid_credentials`, add «إن كنت قد غيّرت كلمة المرور قبل لحظات فجرّب الدخول بها.» / "If you changed your password a moment ago, try logging in with it."
- **Dialogs.** None. **Never shown.** Whether the username exists; whether a code was used or expired; personal questions; an automatic login; any code outside S-04.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Step 1 initial | route load | empty fields | c2 | title |
| Field errors | blur or submit | P-03 messages | first invalid field | summary if two |
| Verifying; resetting | E06; E07 in flight | c8 or c8′ Loading | stays | polite «جارٍ التحقق» / «جارٍ التعيين» |
| Generic failure | `401` (G-04) | banner; code cleared | c6 | alert |
| Throttled; wake-up; offline; service | `429`; G-01; G-02; 5xx | P-06; P-04; P-05; P-07 | unchanged or the button | per pattern |
| Step 2 initial | E06 `200` | step 2 in place; grant held in memory | c3′ | the H2 (names the step) |
| Grant expired or used | `401`, or client clock past 600 s | back to step 1, generic banner | c3 | alert |
| Uncertain outcome | no response to E07 | P-10 banner | stays on c8′ | status |
| Success | E07 `200` | passwords wiped; to S-04 (step 3) | H1 of S-04 | its title |
| Not applicable | empty and populated (forms list no data); access denied (a session redirects); pending sync; offline shell (deferred); disabled (throttle only) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- One column from 320 px, 480 px column from 560 px; logical properties; code and username stay left to right in an RTL page; fields and buttons 48 px, links on 44 px lines.
- **Focus order.** Step 1: skip link, c1, switch, c5, c6, c8, c9. Step 2: skip link, c1, switch, new password, toggle, confirmation, toggle, c8′. A step change moves focus to its H2 so the step is announced. **Keyboard.** Enter submits the current step; Esc has no role; paste is never blocked.
- **Contrast pairs.** As S-01 and S-02; code field border `--q-color-border` on `--q-color-surface` 3.32. Static loaders; instant step change under reduced motion.

**6. Colour and typography**
- Tokens as S-01; code field `--q-font-mono` at `--q-text-body`; step H2 `--q-text-section`; Notice `--q-text-small` in `--q-color-text-secondary`. No religious text appears on this screen.

### S-06 Re-consent gate — موافقة جديدة على الشروط

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** After a material terms change, a signed-in learner or demo account confirms the new terms with the same unchecked box as S-02, or logs out (D52). Only the version and the date are recorded (E05). The sources fix the box and the rule, not a title: the title is proposed (inventory).
- **Entry.** `/consent` by `replace` navigation after E04 `reconsentRequired: true` or any call answering `400 terms_required` (guard 3, G-18); the path to return to is kept in memory. A visit without a pending change goes to `/today` (the client compares the profile's `termsVersion`, from E11, with the bundled version); without a session, to `/login?next=/consent`.
- **Exit.** E05 `200` returns to the kept path (`next`, `/today` or `/start`); log out (E10) goes to S-01. No back control: the only ways out are consent or logout. Link: S-03, state kept.
- **Primary action.** «متابعة» / "Continue" (E05). **References.** R10; NFR-06, 09; UX.md § «الحساب والخصوصية في النصوص»; E05, E10, E11; G-02, G-03, G-05, G-15 to G-18.

**2. Layout and hierarchy**
- Focus screen: no tab bar, no language switch (the profile language rules); header with droplet mark and app name only. Phone order, 24 px between regions: H1; Slot T; lead; version and account lines; terms link; consent block; Slot B; Continue; «تسجيل الخروج» tertiary button. Tablet and desktop: 480 px column.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | H1 | موافقة جديدة على الشروط | Agree to the updated terms | P (inventory) |
| c2 | Lead | تغيّرت شروط الاستخدام وبيان الخصوصية. اقرأها ثم أكّد موافقتك للمتابعة. | The terms of use and privacy statement have changed. Read them, then confirm your agreement to continue. | P (G-18) |
| c3 | Version line, account line, `--q-text-small` | إصدار الشروط: {TERMS_VERSION}؛ أنت مسجّل باسم {username} | Terms version: {TERMS_VERSION}; You are signed in as {username} | P |
| c4 | Link, own 44 px line | شروط الاستخدام وبيان الخصوصية | Terms of use and privacy statement | F UX.md |
| c5 | Checkbox, unchecked | قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها | I have read the terms of use and privacy statement and I agree to them. | F D52; English P |
| c6 | Links, own lines | شروط الاستخدام؛ بيان الخصوصية | Terms of use; Privacy statement | P (§6.3) |
| c7 | Button primary; loading | متابعة؛ جارٍ الحفظ… | Continue; Saving… | P |
| c8 | Button tertiary; loading | تسجيل الخروج؛ جارٍ الخروج… | Log out; Logging out… | P (§6.9 label) |

- **Validation.** Submit with c5 unchecked: no request; Error recipe at c5, «يلزم تأكيد موافقتك على شروط الاستخدام وبيان الخصوصية للمتابعة.» / "You must confirm your agreement to the terms of use and privacy statement to continue." (P; G-18 sample). The box is unchecked when first shown; a return from S-03 keeps what the learner set.
- **E05 mapping.** `terms_required`: Error banner Slot B «تحدّثت الشروط. أعد تحميل الصفحة لقراءة الإصدار الأحدث.» with the reload button (a version the client has not shown is never sent, O-09). `unauthenticated` (G-03): S-01 with the session-ended banner, `next=/consent` kept. `throttled` (session-write limit): P-06. `forbidden_origin`, `internal`, `unavailable`: P-07; `validation_error` is treated as `internal`. No response: P-04 or P-05.
- **Logout (E10).** No dialog (nothing is unsynced in option B, so §6.9 skips it). `204`, or a `401`: go to S-01. On `403`, `503` or no answer: Error banner Slot B «تعذّر تسجيل الخروج. حاول مرة أخرى.» / "Logging out failed. Try again." and the learner stays (script cannot clear the session cookie).
- **Never shown.** A "what changed" comparison (no source defines one; D52 stores no copy of the text), a decline-and-continue path, the full text inline (S-03 owns it).

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Initial | arrival | box unchecked | c1 | title |
| Box unchecked | submit | field error at c5 | c5 | via description |
| Saving | E05 in flight | c7 Loading, c8 inert | stays | polite «جارٍ الحفظ» |
| Version mismatch | `400 terms_required` | Error banner with reload | its button | alert |
| Session ended | `401 unauthenticated` (G-03) | to S-01 with banner | H1 of S-01 | its title |
| Throttled; wake-up; offline; service | `429`; G-01; G-02; 5xx | P-06; P-04; P-05; P-07 | unchanged or c7 | per pattern |
| Logging out; failed | c8 pressed; no answer or 5xx | c8 Loading, c7 inert; Error banner | stays; c8 | polite «جارٍ الخروج»; alert |
| Success | E05 `200` | to the kept path | its H1 | its title |
| Not applicable | empty and populated (a form lists no data); pending sync; disabled; access denied (guards: no session goes to S-01, no pending change to `/today`) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- One column from 320 px, 480 px column from 560 px; logical properties; box row, link lines at least 44 px, buttons 48 px.
- **Focus order.** skip link, c4, c5, c6 (both links), c7, c8. Space toggles c5; Enter on the buttons; Esc has no role. The box label is exactly the fixed sentence with its two links outside it; the error is linked by `aria-describedby`.
- **Contrast pairs.** As S-02. Static loaders under reduced motion.

**6. Colour and typography**
- Tokens as S-02; H1 `--q-text-title`; lead `--q-text-body`; version and account lines `--q-text-small` in `--q-color-text-secondary`; the logout button uses the Tertiary recipe (not destructive: the Destructive recipe is reserved for account deletion, §6.1). No religious text appears on this screen.

## 2. Batch 2 — Catalog and plan

### S-07 Public catalog — تصفّح الكتب

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** Anyone without a session sees which books are published before registering (D71). **Metadata only:** categories, books, editions, section names and references, word and passage counts, available paths. No religious text, lessons or questions, and none can be reached from here (R12, M2: a visitor asking for them needs an account).
- **Entry.** `/` for visitors; guard 2 sends a signed-in user to `/today` (or `/start`), so S-07 is visitor-only (UA-02). Back target of S-01, S-02, S-05; link of the 404 page. Until Batch 2 ships `/` redirects to `/login`.
- **Exit.** «إنشاء حساب» to S-02; «تسجيل الدخول» to S-01. No per-book action: choosing a book happens in S-08 after registration.
- **Primary action.** «إنشاء حساب» / "Create an account"; «تسجيل الدخول» / "Log in" is secondary. **References.** R03, R08, R11, R12; NFR-02, 09, 10, 14; D71, D49; E14 (public, `no-store`, 60 per minute per IP); G-01, G-02, G-15 to G-17, G-23, G-27.

**2. Layout and hierarchy**
- Public shell. Header (P-02 chrome): logo (droplet mark and app name, a link to `/`) at the start edge, switch at the end edge. From 768 px the header also carries «إنشاء حساب» (Primary) then «تسجيل الدخول» (Tertiary); below 768 px the two actions sit under the intro because logo, switch and two actions do not fit 272 px (O-04). One instance is rendered per width (`display: none` removes the other from the tab order).
- Phone order, 24 px between regions: H1; intro; actions (below 768 px); banner area (P-04 to P-07, below the intro); Notice; per category an H2 then its edition Cards, 16 px apart (adjacent editions of one category share the H2). Edition Card (§6.7: fill `--q-color-surface`, 1 px `--q-color-divider`, `--q-radius-md`, padding 16 px, no shadow, no whole-card link): H3 title; author and edition label; facts line; paths line; disclosure row «الأقسام ({n})» of at least 56 px; when open, one list row per section (at least 56 px, divider between rows). Sections start collapsed so 37 to 42 rows do not push the page. One column at all widths (640 px below 1024, 720 px from 1024).

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | Logo link, name | قطرة غيث | Qatra | P (O-12) |
| c2 | Buttons (links styled as buttons), header or body | إنشاء حساب؛ تسجيل الدخول | Create an account; Log in | «إنشاء حساب» F UX.md element; the other P |
| c3 | H1 | تصفّح الكتب | Browse books | P (inventory) |
| c4 | Intro | اطّلع على الكتب والأقسام المتاحة قبل إنشاء حسابك. لا يُعرض هنا نص الكتاب؛ يبدأ التعلم بعد إنشاء الحساب. | See the books and sections available before you create an account. The text of the books is not shown here; learning starts after you create an account. | P |
| c5 | Notice (no fill, not dismissible) | يعرض التطبيق الكتاب كما هو في نسخته الموثقة للحفظ، دون إضافة أو شرح. | The app shows the book as it is in its verified edition for memorization, without additions or explanation. | F UX.md, §6.12; English P |
| c6 | H2 per category | `category.labelAr` or `labelEn`, as returned | as returned | data |
| c7 | H3 per edition; meta line | `titleAr` or `titleEn`؛ {author} · {editionLabel} | `titleEn`; {author} · {editionLabel} | data |
| c8 | Facts line `--q-text-body-compact` | {n} قسمًا · {total} كلمة | {n} sections · {total} words | P (`totalWords` sums the default paths) |
| c9 | Paths line | المسارات المتاحة: {labels} | Available paths: {labels} | P |
| c10 | Disclosure (native `<details>`; not in UI-tokens, O-06) | الأقسام ({n}) | Sections ({n}) | P |
| c11 | Section row | {titleAr} · {reference}؛ {w} كلمة · {p} مقاطع | {titleEn} (`Surah 78`, `Hadith 1`); {w} words · {p} passages | data; counts P |

- **Content rules.** Order as returned (category display order, then `editionKey`). English UI: a section shows `titleEn` only, since it already carries the number (UA-05); Arabic UI: `titleAr` and the reference as stored. Counts use Arabic plural forms (واحد، اثنان، قليل، كثير) and the numeral rule of §3.4. Whether the English UI also shows the Arabic book title is O-19. Path labels, proposed: Quran «النص القرآني» / "Quran text"; hadith «المتن»، «السند»، «الدرجة» / "Matn", "Sanad", "Grade" (O-18). Neither the reverse plan order nor per-section `paths` appear here.
- **Validation and dialogs.** None. Links: logo and the two actions only; no outbound link and no canonical URL (E14 never returns one; they appear only beside text).
- **Never shown.** Any verse, hadith, first line or sample of a text; lessons; questions; translations; commentary; a per-book start button; learner data; user counts.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Loading | E14 in flight | two card-shaped skeleton blocks after 300 ms (§6.14), region `aria-busy`, hidden text «جارٍ التحميل» / "Loading" (G-23) | c3 | none |
| Wake-up | slow or un-enveloped first E14 (G-01) | P-04; skeleton stays; E14 reruns when E01 answers | unchanged | status |
| Populated | E14 `200` | categories and cards | unchanged | none |
| Empty | `editions` is `[]` | Empty state (§6.14): title «لا توجد كتب متاحة الآن.» / "No books are available right now." and «ستظهر هنا الكتب فور نشرها.» / "Books will appear here as soon as they are published." (P); actions stay | unchanged | status |
| Category without material | a category known without an available edition (G-27; not derivable from E14, O-08) | Notice row «لا تتوفر مادة» / "No material available" under its H2 | — | none |
| Throttled | `429` (G-15) | P-06 with «إعادة المحاولة» `aria-disabled` during the countdown | stays | start and end |
| Offline | G-02 | P-05 with «إعادة المحاولة» | unchanged | status |
| Service error | 500, 503 (G-16, G-17) | P-07 plus «إعادة المحاولة» (a read, so retry is safe); no stale list | the button | alert or status |
| Language switched | P-02 | labels re-render from `titleAr`/`titleEn`; no refetch | segment | status |
| Section list opened | disclosure toggled | rows shown; state not remembered | summary row | native expanded state |
| Not applicable | access denied (public; a session redirects, guard 2); disabled (retry button during throttle only); pending sync and offline shell (option B stores nothing; S-31 deferred, G-33); success and field errors (read-only, no inputs) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Breakpoints.** 320 px: facts and rows wrap, card inner width 240 px, no horizontal scroll; 768 px: actions move into the header; 1024 px and wider: no rail (public shell), column 720 px. Logical properties; the disclosure chevron is vertical and does not mirror; English titles and `Surah 78` labels sit in `<bdi>` inside an RTL page and Arabic names inside an LTR page.
- **Focus order.** Phone: skip link, c1, switch, c2 (Create an account, Log in), then each edition's disclosure row (rows inside are not focusable). From 768 px: skip link, c1, c2, switch, then the disclosure rows. Disclosure: Enter or Space toggles, name «الأقسام (٣٧)» / "Sections (37)", expanded state native. Headings H1, H2, H3; the section list is a real list. Buttons 48 px; disclosure rows 56 px.
- **Contrast pairs.** `--q-color-text` on `--q-color-surface` 11.76; `--q-color-text-secondary` on `--q-color-surface` 5.36 (meta) and on `--q-color-bg` 5.10 (Notice); the card border is decorative. Skeleton without shimmer under reduced motion.

**6. Colour and typography**
- Page `--q-color-bg`; Cards `--q-color-surface`; H1 `--q-text-title`; H2 `--q-text-section`; H3 `--q-text-body` at weight 600; facts `--q-text-body-compact`; meta and Notice `--q-text-small` in `--q-color-text-secondary`; buttons §6.1; UI fonts only.
- No religious text appears on this screen. Titles and section names are catalog metadata in the UI font; if one ever carries a Uthmani mark of UI-tokens §3.2 (Cairo has none), that string must use `--q-font-quran` (O-20).

### S-08 Start & goal — ما هي خطتك؟ (البداية والهدف)

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** A learner chooses what to memorize and the daily time in one short form and hands the choices and an editable goal sentence to the plan conversation. Nothing is saved and nothing reaches a model here (R02, D34); E31 runs at the end of S-09. A demo account would use S-29 (deferred).
- **Entry.** `/start` after S-04, after login without a plan (guards 2, 4), the «ابدأ خطتك» buttons of G-24, S-12 «بدء خطة أخرى» (O-31), S-09 «تعديل الخيارات», the G-20 path. **Exit.** «ابدأ المحادثة» to S-09 with the selections in memory (guard 5); «متابعة المحادثة» to S-34. Back: none (UI-design §2.4); with an active plan a close control to S-12 (O-31).
- **Primary action.** «ابدأ المحادثة» / "Start the conversation". **References.** R01, R02, R12, R24, R26, R27, R29; NFR-09, 10, 14; UX.md row «البداية والهدف»; D49, D51, D72, D75; E14, E12, E11, E18; G-01, G-02, G-14 to G-17, G-20, G-24, G-27, G-38; UA-12 to UA-14; UQ-02.

**2. Layout and hierarchy**
- Focus flow (P-11). Bar: H1 «ما هي خطتك؟» at the start, the language switch of P-02 at the end (calls E12). Phone, 390×844: Slot T; subtitle; category, book, edition (§6.5 lists); daily time; preferred date; hadith paths (hadith only); goal box with counter, helper, restore action; Notice (P-15); Slot B; primary button with helper, in flow (a sticky bar would hide fields). Regions `--q-space-24` apart, fields `-16`; about two screens tall.
- 768 px: daily time and date share a row (DOM order kept). From 1024 px: column 720 px, no rail. At 320 px the three minute segments stay on one line (3 × 88 px). Left out: plan-order control, scope picker, preset plan, translated edition.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | App bar H1 | ما هي خطتك؟ | What is your plan? | F UI-design |
| c2 | Language switch (§6.4, P-02) | العربية \| EN | العربية \| EN | F P-02 |
| c3 | Subtitle | اختر ما تريد حفظه ووقتك اليومي، ثم نكمل الخطة معًا. | Choose what to memorize and your daily time, then we finish the plan together. | P |
| c4 | Info banner (§6.8) + tertiary button, only if `Today.openPlanChatId` | لديك محادثة خطة لم تعتمدها بعد. إن بدأت محادثة جديدة فستحلّ محلها.؛ متابعة المحادثة | You have an unconfirmed plan conversation. Starting a new one replaces it.; Continue the conversation | banner P; button F UI-design |
| c5–c7 | Single-choice lists (§6.5; select from six options): category, book (title, author), edition (`editionLabel`) | الباب؛ الكتاب؛ النسخة | Category; Book; Edition | F UX.md |
| c8 | Segmented radio group (§6.4) | وقتك اليومي؛ ٥ دقائق، ١٠ دقائق، ١٥ دقيقة | Daily time; 5, 10, 15 minutes | label P; segments F UX.md |
| c9 | Date input (§6.2) and «clear» | الموعد المفضل (اختياري)؛ اختياري. اتركه فارغًا إن لم يكن لديك موعد.؛ مسح الموعد | Preferred date (optional); Optional. Leave empty if you have no date.; Clear the date | label F PRD R01; rest P |
| c10 | Checkbox group (§6.3 rows), **hadith only** | ما تريد تعلمه؛ متن، سند، الدرجة؛ يبقى مسار واحد على الأقل. | What you want to learn; Matn, Sanad, Grade; At least one path stays selected. | F UI-design, Plan-conversation R29; helper P |
| c11–c14 | Multi-line input (§6.2 variant, O-22), counter, helper, restore button (after a manual edit) | الهدف والموعد؛ {n}/٥٠٠؛ لا تكتب اسمك أو أي بيانات شخصية.؛ استعادة الجملة المقترحة | Goal and date; {n}/500; Do not type your name or personal data.; Restore the suggested sentence | label, restore F UI-design; rest P |
| c15 | Notice (P-15) | the transparency line v1.1 | see P-15 | F Plan-conversation §2.6 |
| c16 | Primary button, helper | ابدأ المحادثة؛ تسبقها أسئلة قصيرة لتحديد نقطة البداية، ويمكنك تجاوزها. | Start the conversation; Short questions to find your starting point come first; you can skip them. | button F UI-design; helper P |

- **Cascade and defaults.** Lists come from E14 (`category`, `titleAr`/`titleEn` with `author`, `editionLabel`). A level with one option is preselected and still shown; a higher choice clears the lower ones and the path boxes. A category without an available edition is a disabled row «لا تتوفر مادة» (G-27, P). No translated edition exists (D49). Minutes default to `Profile.sessionMinutes` (E11, initially 10). The date control has `min` = today in the account time zone; empty means no date. Path boxes are those in the edition's `availablePaths`, متن checked; when one box is left it takes `aria-disabled="true"`, keeps focus and announces the helper; the Quran edition shows no group.
- **Goal box.** Initial value: the composed sentence of UI-design §1.1, rebuilt on each selection change until the learner edits, then never overwritten (UA-13); empty with a placeholder until a book is chosen: «اكتب هدفك هنا، أو اختر الكتاب لنكتب لك جملة مقترحة.» / "Write your goal here, or choose a book and we suggest a sentence." (P). Trimmed; counted in code points (O-23); no `maxlength` (it truncates a paste silently); Enter inserts a newline.
- **Validation (P-03; E31 repeats the rules).** No edition: «اختر الباب ثم الكتاب والنسخة.» / "Choose a category, then a book and an edition." (R01) at the first unchosen group. Empty box: «اكتب هدفك أو استعد الجملة المقترحة.» / "Write your goal or restore the suggested sentence." Over 500: «الهدف حتى ٥٠٠ حرف.» / "The goal can be up to 500 characters." (`goal_text_length`, G-14). Past date: «اختر موعدًا من اليوم فصاعدًا.» / "Choose a date from today onward." (`date_invalid`). The button stays enabled; focus goes to the first invalid field.
- **Dialogs.** None (c4 already says a new conversation replaces the old one).

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Loading; wake-up; offline | E14 in flight; G-01; G-02 | skeleton rows after 300 ms (§6.14), `aria-busy`; P-04; P-05 with «إعادة المحاولة» (a read) | c1 | per pattern |
| Catalog error | 500, 503 | P-07 plus retry; no stale list | retry button | alert or status |
| Edition chosen | selection | lower groups appear or preselect; the box shows the sentence | unchanged | polite «تم تحديث الجملة المقترحة» (debounced) |
| Hadith category | category = hadith | c10 appears with متن checked | unchanged | polite «أضيف خيار «ما تريد تعلمه»» |
| Last path | uncheck of the only box | stays checked | the box | status «يبقى مسار واحد على الأقل.» |
| Goal edited; restored | typing; c14 | box detached, c14 shown; restore refills | box | status «تمت استعادة الجملة» |
| Near or over the limit | 450 or more; above 500 | counter in warning text with icon; over: error recipe, no truncation | box | polite at 450 and 500 only |
| Ambiguity; date; empty box | submit | field errors above | first invalid field | summary if two |
| Open conversation | `openPlanChatId` set | c4 in Slot T | c1 | none |
| Language switching | c2 | E12 in flight; success flips `lang`/`dir`, values kept; failure restores the old language with P-05 or P-07 | c2 | status «تم تغيير اللغة إلى العربية» |
| Revoked edition | return from S-09 after E31 `edition_not_available` (G-20) | edition row disabled «غير متاح»; «هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.»; selection cleared | edition group | alert |
| Throttled; service error | E12 `429`; 500, 503 | P-06; P-07 | c2 | per pattern |
| Submit | rules pass | go to S-09, selections in memory, nothing sent | S-09 H1 | its title |
| Not applicable | demo scenario list (S-29 deferred); offline, pending sync (option B, G-22, S-31); access denied (guard 1); large goal (handled in S-34 by the card and «هدف أصغر», R02) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Focus order.** skip link, c2, [c4 button], c5, c6, c7 (each list one tab stop, roving), c8 (one stop), c9 and clear, c10 (one stop per box), c11, c14, c16. **Keyboard.** Arrows move and select in the logical direction (Left is next in RTL), Space selects or toggles, Enter never submits from the box, Esc has no role.
- Groups are `fieldset`/`legend` or labelled `radiogroup`; c11 has `aria-describedby` (counter, helper, error). Box and date are `dir="auto"`; catalog titles in `<bdi lang="ar">`. Targets: rows 56 px, segments 44×88 px, checkbox rows 44 px, buttons 48 px.
- **Contrast pairs.** `--q-color-text` on `--q-color-bg` 11.19; `--q-color-text-secondary` on `--q-color-bg` 5.10; selected row `--q-color-text-accent` on `--q-color-selection` 7.75 with `--q-color-border-selected` 4.25 (never `--q-color-border` on selection, 2.96); field border on `--q-color-surface` 3.32; focus ring 8.27. Reduced motion: nothing animates.

**6. Colour and typography**
- Page `--q-color-bg`; fields and rows `--q-color-surface` with `--q-color-border`; selection `--q-color-selection` plus 2 px `--q-color-border-selected` and a check icon; primary `--q-color-primary`. H1 `--q-text-title`; labels `--q-text-body-compact`; inputs and rows `--q-text-body`; helpers, counter, errors `--q-text-small`; button `--q-text-button`. UI fonts only; no religious text.

### S-09 Placement test — الاختبار الأولي

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** A short, skippable recall test (up to 8 passages, one `word_choice` continuation or `word_recall` per step) so the plan starts where the learner is. Never counted in daily time (D42, R20); no concept or recitation test; nothing is saved to the plan. Learner and demo.
- **Entry.** Only from S-08 (guard 5). **Exit.** After the last step: E22 then E31 with `placementSessionId`, to S-34; «تخطي الاختبار»: E31 without it (UG-12). Back: S-08 through the leave sheet (UI-design §2.4, §2.5).
- **Primary action.** «التالي»; «متابعة إلى الخطة» on the done step. **References.** R01, R02, R20; NFR-09, 10, 14; UX.md row «الاختبار الأولي»; D42, D66; E20 `placement`, E21, E22, E31; G-01, G-02, G-14 to G-17, G-20, G-21, G-23; UG-01, UG-12, UA-09.
- **Step order (O-21).** The optional self-rating is the **first** step: E20 takes `selfRating` only at creation and no operation accepts it later, so «then» (UX.md, UI-design) cannot be built.

**2. Layout and hierarchy**
- Focus flow (P-11). Bar: back, H1 «اختبار قصير», end-edge «تخطي الاختبار». **Self-rating step:** intro, the three-segment group, helper. **Question step:** progress «السؤال {k} من {n}» (steps variant of §6.10, 8 px, fill from the start edge); prompt; original-text block with the blank; options or recall input; source line; sticky action bar with «التالي» over «تجاوز السؤال». **Done step:** status heading, one sentence, optional calm line, sticky «متابعة إلى الخطة».
- 768 px: options in two columns when each tile is at least 128 px (§6.16). From 1024 px: column 720 px, no rail. At 320 px the action bar stays and the question scrolls.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1–c3 | Back control; H1; tertiary button | رجوع إلى ما هي خطتك؟؛ اختبار قصير؛ تخطي الاختبار | Back to What is your plan?; Short test; Skip the test | P; skip F UI-design UG-12 |
| c4 | Intro | أسئلة تذكر قصيرة، وليست تقييمًا للتلاوة. لا يُحتسب وقتها في هدفك اليومي. | Short recall questions, not a recitation assessment. Their time does not count toward your daily goal. | P (image 02) |
| c5–c7 | Segmented group (§6.4) with legend and helper; primary button | ما مقدار ما تحفظه من هذا الكتاب الآن؟ (اختياري)؛ لم أحفظ، بعضه، أغلبه؛ لا يؤثر هذا الاختيار في التقدير؛ تعتمد الخطة على إجاباتك.؛ ابدأ الاختبار | How much of this book do you already know? (optional); None, Some, Most; This choice does not affect the estimate; the plan relies on your answers.; Start the test | segments F UX.md; rest P |
| c8–c9 | Progress label; prompt | السؤال {k} من {n}؛ اختر الكلمة التي تكمل العبارة. / اكتب الكلمة الناقصة. | Question {k} of {n}; Choose the word that completes the phrase. / Type the missing word. | P |
| c10 | Original-text block with context and the blank (P-17) | … ______ … (name of the blank «كلمة ناقصة») | (“missing word”) | data; name P |
| c11 | Option tiles (§6.16) or recall input (§6.2) with «اكتب الكلمة بالعربية» | from the snapshot | — | part C pieces |
| c12–c14 | Source line; primary; secondary | {book} · {edition} · {reference}؛ التالي (last: إنهاء الاختبار)؛ تجاوز السؤال | Next (last: Finish the test); Skip this question | data; P (F UX.md «تجاوز») |
| c15–c16 | Done heading and text; primary | انتهى الاختبار؛ سنستخدم إجاباتك لتقدير نقطة البداية.؛ متابعة إلى الخطة | The test is finished; we will use your answers to estimate your starting point.; Continue to the plan | P |

- **Rules.** Piece behaviour is that of §6.16 and §6.2 (part C); S-09 has **no hint and no per-answer feedback** (a measurement; the learner is not told which answers were wrong). Answers are final. «التالي» with nothing chosen: «اختر إجابة أو اضغط «تجاوز السؤال».» / "Choose an answer or press “Skip this question”." (P-03). A skipped question sends no event and counts as unanswered; each answer is one E21 `answer` event with `hintUsed: false`.
- **Calm line (done step),** only when «أغلبه» was chosen and no answered passage was correct (no new threshold, D64): «يعتمد التقدير على إجاباتك في الاختبار، ويمكنك تعديل الخطة في المحادثة.» / "The estimate relies on your answers, and you can adjust the plan in the conversation."
- **Dialogs (P-12).** *Leave* (back, browser back, edge swipe; UA-09): «الخروج من الاختبار؟» / "Leave the test?"; «تعود إلى اختيارات الخطة. لا يُحتسب وقت الاختبار في هدفك اليومي.»; «متابعة الاختبار» (initial focus) / «الخروج إلى اختيارات الخطة». *Skip* (c3): «تخطي الاختبار؟»; «ستُبنى الخطة دون نتيجة اختبار، فيُقدَّر الزمن على أنك تبدأ من الصفر.» / "The plan is built without a test result, so time is estimated as if you start from zero."; «متابعة الاختبار» (initial focus) / «تخطي والمتابعة إلى الخطة».
- **Never shown.** A score, percentage, pass or fail, which answers were wrong, a hint, a countdown.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Self-rating | route load | c4 to c7; no rating is valid | c2 | page title |
| Creating | c7 pressed | E20 `placement` in flight (P-14): «جارٍ تجهيز الأسئلة…» | c7 | polite |
| Question; skipped; answered | E20 `201`; c14; «التالي» | next step (a skip sends nothing); nothing chosen raises the P-03 message | prompt c9 | polite «السؤال ١ من ٣» |
| Event rejected or pending | G-21 | nothing is shown (not a scored result) | unchanged | none |
| Edition unavailable | E20 `422` (G-20) | Error banner Slot T «هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.» with «تعديل الخيارات» to S-08 | the action | alert |
| Done | last answer or skip | c15, calm line if it applies, c16 | c15 | polite |
| Opening the conversation | c16 | E22 best effort, then E31 (up to the 8 s model timeout): «جارٍ تجهيز المحادثة…» | c16 | polite |
| Conversation failed | E31 `422` (`goal_text_length`, `path_not_available`, `date_invalid`, `edition_not_available`) | Error banner Slot B «تعذّر بدء المحادثة بسبب خيارات الخطة. عدّلها ثم أعد المحاولة.» with «تعديل الخيارات» to S-08, selections kept | the action | alert |
| Network, throttle, wake-up, service | G-02, 429, G-01, G-16, G-17 | P-05, P-06, P-04, P-07; answers already sent stay recorded | c16 or c13 | per pattern |
| Session ended | G-03 | S-01 with `next=/start`; selections lost | — | per S-01 |
| Not applicable | per-answer feedback, hints (a measurement); resume (a reload returns to S-08, UG-01); version conflict, empty, offline, pending sync (no plan, option B) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Focus order.** skip link, c1, c3, the tile group (one tab stop, arrows, Home, End, Space) or the recall input, c14, c13. After each step focus moves to the prompt (`tabindex="-1"`). Enter in the recall input acts as «التالي»; Esc opens the leave sheet.
- Original text always `lang="ar"` RTL; arrows mirror; the blank is a line, not colour. Targets: tiles 56 px, buttons 48 px.
- **Contrast pairs.** `--q-color-text` on `--q-color-surface` 11.76; `--q-color-text-secondary` on `--q-color-bg` 5.10; selected tile 7.75; progress fill on `--q-color-disabled` 3.90; focus ring 8.27.

**6. Colour and typography**
- Page `--q-color-bg`; block and tiles `--q-color-surface`; selection `--q-color-selection` plus `--q-color-border-selected`; progress track `--q-color-disabled`, fill `--q-color-primary`; no status colours (no correctness is shown). H1 `--q-text-title`; prompt `--q-text-section`; intro, helpers, source `--q-text-small`; options and context `--q-text-token` in `--q-font-quran` or `--q-font-hadith`; buttons `--q-text-button`.

### S-11 Plan & today — الخطة واليوم

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** The learner's day at a glance: the goal in one line, today's time, the current stage, what is due, the next passage, and one button to start or continue the session. Learner and demo.
- **Entry.** Tab «اليوم» (`/today`); landing after login with a plan (guard 2); after S-34 (flash); return from S-19 and S-20. **Exit.** Session button to S-19 (E20 `daily`); «عرض الخطة» to S-12; «تعديل الوقت والهدف» to S-13; «ابدأ خطتك» (G-24) to S-08; «متابعة المحادثة» to S-34. Back: none (tab root).
- **Primary action.** «ابدأ جلسة اليوم» / «تابع جلسة اليوم». **References.** R04, R06, R07, R14, R20; NFR-09, 10, 14; UX.md row «الخطة واليوم»; D40, D57, D66; E18, E19 (O-28), E20; G-01, G-02, G-09, G-11, G-16, G-17, G-20, G-23 to G-25, G-30 to G-32, G-38.

**2. Layout and hierarchy**
- App shell: tab bar below 1024 px (§6.6, «اليوم» active), rail from 1024 px. Header row: droplet mark and name at the start, tertiary «عرض الخطة» at the end. Then, `--q-space-24` apart: H1; Slot T (at most one error banner); five `section`s of P-13 in the fixed order «الهدف الكلي»، «الزمن اليومي»، «المراحل»، «المراجعات»، «الخطوة التالية»; the primary button inside the last. On phones the button is **sticky** above the tab bar (`--q-size-tabbar` plus safe area plus `--q-space-8`), in flow from 1024 px. About 700 px of content at 390 px.
- 768 px: column 640 px. From 1280 px: two columns inside 960 px (today and next step at the start, goal, stages, reviews at the end); DOM order stays as listed, the button last.
- Left out: the overall percentage (S-21), a streak, a calendar, a leaderboard.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1–c2 | Header link; H1 | عرض الخطة؛ خطوتك اليوم | View the plan; Your step today | P (image 03) |
| c3 | «الهدف الكلي», one line | {titleAr} · الموعد {date} (no date: title only) | {titleEn} · Target {date} | label F; line P |
| c4 | «الزمن اليومي»: text; daily bar (§6.10); extra line; tertiary link | {n} دقائق يوميًا، وحتى {w} كلمة جديدة في اليوم؛ الإنجاز اليومي، ٧/١٠ دقائق، ٧٠٪؛ + {m} دقيقة إضافية؛ تعديل الوقت والهدف | {n} minutes a day, up to {w} new words; Daily progress, 7/10 minutes, 70%; + {m} extra minutes; Change time and goal | labels F; text P |
| c5 | «المراحل»: one row (§6.7) with a bar | {sectionTitle}؛ المرحلة الحالية؛ {p}٪ | Current stage; {p}% | label F; row P (E19) |
| c6 | «المراجعات» | مراجعات مستحقة اليوم: {n}؛ لا توجد مراجعات مستحقة اليوم.؛ موعد المراجعة التالي: {date} | Reviews due today: {n}; Next review: {date} | G-25 F; rest P |
| c7 | «الخطوة التالية»: line; button (§6.1) | المقطع الجديد التالي: {sectionTitleAr} ({reference}).؛ ابدأ جلسة اليوم؛ تابع جلسة اليوم | Next new passage: {…}.; Start today's session; Continue today's session | line P; button F (image 03) |
| c8 | Empty state (§6.14) | لا توجد خطة نشطة بعد.؛ ابدأ خطتك | No active plan yet.; Start your plan | F G-24 |

- **Data.** E18 (`plan`, `dailyPercent`, `extraActiveMs`, `dueReviews`, `nextNewPassage`, `openSessionId`, `dailyCompleted`) and E19 (stage `percent`, `nextReviewDate`) load in parallel; if E19 fails the stage row loses its percent and the date line is omitted. Current stage = the section of `nextNewPassage`. Words per day = `agreedEstimate.newWordsPerDay`. The button says «تابع جلسة اليوم» when `openSessionId` is set; pressing it calls E20 `daily` with the plan id and `currentVersion` (P-14).
- **Dialogs.** None. **Never shown.** The overall percentage, remaining time, a streak effect, a sync chip in option B (G-22, O-33).

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Loading; wake-up; offline; service error | E18, E19 in flight; G-01; G-02; 500, 503 | five skeletons after 300 ms (§6.14); P-04; P-05; P-07, each with «إعادة المحاولة» (reads) | c2 | per pattern |
| New plan; in progress; open session | first day; normal; `openSessionId` | empty bar and the G-25 line on day one; button «تابع جلسة اليوم» when open | c2 | none |
| Day goal reached | `dailyCompleted` | check icon and «أكملت هدف اليوم» (P) beside the bar, extra minutes on their own line; the button stays | unchanged | polite, once, only on a change while open |
| Near horizon | `nextNewPassage` null | c7 line «لا توجد مقاطع جديدة؛ تتبقى المراجعات لتأكيد ما حفظته.» | c2 | none |
| Return after absence | G-30 | Info banner «نبدأ اليوم بمراجعة خفيفة.»; c7 line «مراجعة خفيفة اليوم، دون مقاطع جديدة.»; no missed-day count; trigger derived (O-25) | c2 | none |
| Pending setting | G-32 | Info banner «يبدأ هذا التغيير من يوم التعلم التالي ({التاريخ}).» (date = `learningDate` plus one day, O-24); c4 keeps the value in force | c2 | none |
| Open conversation; plan confirmed | `openPlanChatId`; arrival from S-34 | Info banner «لديك محادثة خطة لم تعتمدها بعد.» with «متابعة المحادثة»; Success toast «تم اعتماد خطتك.» or «تم اعتماد التعديل.» | c2 | polite (toast) |
| Starting the session | button pressed | Loading «جارٍ تجهيز الجلسة…» | c7 | polite |
| Version conflict; plan not active | E20 `409 plan_version` (G-09); `plan_not_active` (G-11) | Warning banner «عُدّلت خطتك في مكان آخر. حدّث الصفحة ثم أعد المحاولة.» or «هذه الخطة غير نشطة.» with «تحديث» (reloads E18, E19) | banner action | status |
| Revoked content | E18 or E20 `edition_not_available` (G-20) | Error banner with the label «غير متاح» and «هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.»; the button disabled with that reason visible, plus «ابدأ خطة جديدة» to S-08; plan and history stay | banner action | alert |
| Session start failed | G-02, 429, 500, 503 on E20 | P-05, P-06, P-07 in Slot T; the button is the retry | c7 | per pattern |
| No active plan | `plan` null (G-24) | c8; tabs stay; «الخطط السابقة» to S-12 when E19 lists a paused plan | c8 | none |
| Completed plan | no active plan, E19 `completed` (G-31) | banner «اكتملت هذه الخطة، وتستمر مراجعات الصيانة.»; only c6 shown; maintenance button blocked until `currentVersion` is exposed (O-26) | c2 | none |
| Session ended | G-03 | S-01 with `next=/today` | — | per S-01 |
| Not applicable | pending sync, offline plan (option B, G-22, S-32); field errors (no inputs); access denied (guard 1) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Focus order.** skip link, c1, [banner action], c4 link, c7 button, then the tab bar or rail; after a route change focus goes to c2; the sticky button never hides a focused control. Bars are `role="progressbar"` (`aria-valuenow` capped at 100, `aria-valuetext` «٧ من ١٠ دقائق، ٧٠ بالمئة»); milestones are announced once; sections are `h2`. Bars fill from the start edge; titles and references in `<bdi>`. Targets: links 44 px, button 48 px.
- **Contrast pairs.** `--q-color-text` on `--q-color-bg` 11.19; `--q-color-text-secondary` 5.10; progress fill on `--q-color-disabled` 3.90; `--q-color-success-text` on `--q-color-success-bg` 6.16; `--q-color-warning-text` on `--q-color-warning-bg` 5.79; focus ring 8.27. Reduced motion: instant bars.

**6. Colour and typography**
- Page `--q-color-bg`; the stage row `--q-color-surface` with `--q-color-divider`; bars as §6.10; success tokens only for the day-goal line; banners by §6.8. H1 `--q-text-title`; section labels `--q-text-section`; lines `--q-text-body-compact`; dates and helpers `--q-text-small`; button `--q-text-button`. UI fonts only.

### S-12 Plan overview — الخطة الكبرى

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** The whole plan in the six labelled sections, the other plans, resuming a paused plan, and the way to revise (S-13) or start another plan (S-08). Learner and demo; **demo accounts get no «استئناف»** (E30 `403`, G-06; never offered).
- **Entry.** S-11 «عرض الخطة»; S-13 back. **Exit.** «تعديل الوقت والهدف» to S-13; «بدء خطة أخرى» (O-31) to S-08; «استئناف» (E30, after the dialog) refreshes the screen. Back: S-11. **Primary action.** «تعديل الوقت والهدف» (secondary button); «استئناف» on a paused row.
- **References.** R14, R02, R07; D57, D66, D74 Q5; UX.md row «الخطة واليوم»; E18, E19, E30, E14 (edition label, section titles); G-06, G-07, G-11, G-20, G-23, G-24, G-31, G-32; UG-04, UG-08, UG-14.

**2. Layout and hierarchy**
- App shell (tab «اليوم»), with the top app bar of §6.6 (back, title). `--q-space-24` apart: Slot T; the six sections of P-13 as `section`s, each one or two plain lines; **«المراحل» is a native disclosure** (open when five stages or fewer; summary row 56 px names the current stage and the count); the actions row; «خطط أخرى» rows (§6.7). No dense tables. 768 px: column 640 px. From 1024 px: rail plus column 720 px. At 320 px a stage's badge wraps under its title.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1–c2 | Back control; H1 | رجوع إلى اليوم؛ الخطة الكبرى | Back to Today; Overall plan | P; F inventory |
| c3 | «الهدف الكلي»: title and edition; scope; paths; order (Quran only); date | {titleAr} · {editionLabel}؛ كل الأقسام أو {n} من {m} {سورة/حديث}؛ المسارات: {labels}؛ ترتيب الكتاب أو من الناس رجوعًا؛ الموعد المفضل: {date} أو دون موعد محدد | {titleEn} · {edition}; All sections or {n} of {m}; Paths: {labels}; Book order or From An-Nas backwards; Preferred date: {date} or No set date | label F; lines P; orders F UX.md, §6.4 |
| c4 | «الزمن الكلي» | التقدير المتفق عليه: نحو {days} يومًا، حتى {endDate}. | Agreed estimate: about {days} days, until {endDate}. | label F; text P (`agreedEstimate`) |
| c5 | «الزمن اليومي» (+ G-32 line) | {n} دقائق يوميًا، وحتى {w} كلمة جديدة في اليوم. | {n} minutes a day, up to {w} new words. | label F; text P |
| c6 | «المراحل»: disclosure; rows in plan order with title, mastery badge (§6.11), percent; the current row marked | المراحل ({m})؛ جديد، قيد التعلم، قيد التقدم، مؤكد، يحتاج تحديثًا؛ الحالية | Stages ({m}); New, Learning, In progress, Confirmed, Needs refresh; Current | label F; badges F §6.11; marker P |
| c7 | «المراجعات»: rhythm, due line (or G-25), next date | تُراجَع كل مقطع بعد يوم، ثم بعد يومين، ثم بعد ٤ أيام؛ وما فاتك يبقى مستحقًا دون عقوبة. بعد التأكيد تستمر مراجعات الصيانة بفواصل أطول. | Each passage is reviewed after 1, then 2, then 4 days; missed reviews stay due with no penalty. After confirmation, maintenance reviews continue at longer intervals. | label F; text P (D66 ladder) |
| c8 | «الخطوة التالية» | المقطع التالي: {sectionTitleAr} ({reference}). أو المراجعة التالية: {date}. أو لا مقاطع جديدة؛ تستمر مراجعات الصيانة. | Next passage…; Next review…; No new passages; maintenance continues. | label F; text P |
| c9 | Buttons | تعديل الوقت والهدف؛ بدء خطة أخرى | Change time and goal; Start another plan | F UX.md; P |
| c10 | «خطط أخرى» rows: title, status chip (§6.11), percent, G-31 line, button on paused rows | خطط أخرى؛ متوقفة مؤقتًا، مكتملة؛ استئناف | Other plans; Paused, Completed; Resume | heading P; chips from G-31; button F UI-design |

- **Stage order** = plan order (reverse the `sections[]` list when `order = reverse`). A completed plan appears only as a row (E18 `plan` is the active plan) with «اكتملت هذه الخطة، وتستمر مراجعات الصيانة.» and no actions; a paused row shows «هذه الخطة متوقفة مؤقتًا، وتقدمها محفوظ.». «تعديل الوقت والهدف» is hidden with no active plan.
- **Dialog (P-12): resume while another plan is active** (§6.9 «Replace active plan» variant): «استئناف هذه الخطة؟» / "Resume this plan?"; «ستتوقف خطتك الحالية «{titleAr}» مؤقتًا ويبقى تقدمها محفوظًا، وتستأنف هذه الخطة من حيث توقفت.» / "Your current plan “{title}” pauses with its progress kept, and this plan resumes where it stopped."; «استئناف الخطة» (primary) / «إلغاء» (initial focus). With no active plan E30 runs directly.
- **Never shown.** Resume to a demo account, revise on a completed plan, a certificate, a date promise beyond the agreed estimate.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Loading; wake-up; offline; service error | E18, E19, E14; G-01; G-02; 500, 503 | as S-11 | c2 | per pattern |
| Populated; no active plan | active plan; `plan` null (G-24) | six sections and the list; or «لا توجد خطة نشطة بعد.» with «ابدأ خطتك», the list remains | c2 or the button | none |
| Pending setting; revoked content | G-32; G-20 | Info banner with the date line; Error banner «غير متاح» + G-20 line with a path to S-08 (sections keep their text) | c2 / banner action | none / alert |
| Resuming; resumed | E30 after the dialog | button Loading «جارٍ الاستئناف…»; then lists refresh and Success toast «تم استئناف الخطة.» | button; the plan heading | polite |
| Resume refused | E30 `409 plan_not_active` (G-11); `403` (G-06); `404` (G-07) | Warning banner with the G-11, G-06 or G-07 text | banner | status or alert |
| Not applicable | field errors, disabled inputs (none); offline plan (option B, S-32); version-conflict banner (this screen reads and resumes only) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Focus order.** skip link, c1, [banner action], c6 summary, c9 buttons, c10 buttons, tab bar or rail. Disclosure: Enter or Space; name «المراحل (٣٧)» / "Stages (37)". H1, then six `h2`; stages are an ordered list with `aria-current="step"` on the current row; badges carry icon plus text; Arabic titles in `<bdi lang="ar">` in the English UI. Targets: rows 56 px, links 44 px, buttons 48 px.
- **Contrast pairs.** `--q-color-text` on `--q-color-surface` 11.76; `--q-color-text-accent` on `--q-color-selection` 7.75; `--q-color-success-text` on `--q-color-success-bg` 6.16; `--q-color-warning-text` on `--q-color-warning-bg` 5.79; `--q-color-text-secondary` on `--q-color-bg` 5.10.

**6. Colour and typography**
- Page `--q-color-bg`; rows `--q-color-surface` with `--q-color-divider`; badges §6.11; banners §6.8. H1 `--q-text-title`; labels `--q-text-section`; text `--q-text-body-compact`; dates `--q-text-small`; badges `--q-text-caption`; buttons `--q-text-button`. UI fonts only.

### S-13 Plan revision — تعديل الوقت والهدف

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** Start a **revision conversation** for the plan in force (S-34 with the plan id) or, when the conversation is unavailable, use a short **structured form**. A revision takes effect from the next learning day (D57, D72). Learner and demo (a demo account revises with quick replies only and its text is never sent to the model, D29).
- **Entry.** «تعديل الوقت والهدف» on S-11 and S-12 (guard 6: active or paused plan); the «تعديل بالنموذج» link under S-34's G-35 notice on revision conversations (O-22). **Exit.** «ابدأ التعديل مع المساعد» to S-34 through E31 with `planId`; the form's «اعتماد التعديل» to S-11 through E17. Back: S-12.
- **Primary action.** «ابدأ التعديل مع المساعد» / "Start the revision with the assistant". **References.** R14, R25, R26, R02; D57, D72, D75; E31, E15, E17, E18; G-01, G-02, G-07, G-09, G-11, G-12, G-14 to G-17, G-20, G-32, G-35; UG-07 (deferred).

**2. Layout and hierarchy**
- App shell with the top app bar (§6.6). `--q-space-24` apart: Slot T; plan summary (the «الهدف الكلي» and «الزمن اليومي» lines of P-13); explanation; helper; Notice (P-15); primary button. Below, only when the form is revealed: a divider, H2 «تعديل بالنموذج», four fields, the estimate preview, the confirm button. 768 px: form minutes and date share a row. From 1024 px: rail plus column 720 px.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1–c2 | Back control; H1 | رجوع إلى الخطة الكبرى؛ تعديل الوقت والهدف | Back to Overall plan; Change time and goal | P; F inventory |
| c3 | Summary (P-13 lines, G-32 line when pending) | as S-11 c3, c4 | as S-11 | F labels |
| c4 | Explanation | تُعدَّل الخطة بالحديث مع المساعد: أقل دقائق، موعد أبعد، مسارات الحديث، أو ترتيب جزء عم. يسري التعديل من يوم التعلم التالي، ويبقى ما أنجزته كما هو. | You change the plan by talking to the assistant: fewer minutes, a later date, hadith paths, or the Juz' Amma order. It takes effect from the next learning day and what you did stays. | P (D57) |
| c5 | Helper (owner correction); demo accounts see the second sentence instead | يمكنك التعديل بالاختصارات وحدها دون كتابة نص حر.؛ في حساب العرض تُعدَّل الخطة بالخيارات الجاهزة فقط. | You can make the change with the shortcuts alone, without typing free text.; In a demo account the plan is changed with the ready-made options only. | P |
| c6–c7 | Notice (P-15); primary button | the transparency line v1.1؛ ابدأ التعديل مع المساعد | see P-15; Start the revision with the assistant | F §2.6; P |
| c8 | Form H2 and intro | تعديل بالنموذج؛ المساعد غير متاح الآن. عدّل الخيارات هنا ثم راجع التقدير الجديد. | Change with the form; The assistant is unavailable right now. Change the options here, then review the new estimate. | P |
| c9–c12 | Fields: minutes (§6.4), date (§6.2), hadith paths (§6.3; three), order (§6.4; Quran only) | وقتك اليومي؛ الموعد المفضل (اختياري)؛ ما تريد تعلمه: متن، سند، الدرجة؛ ترتيب الخطة: ترتيب الكتاب، من الناس رجوعًا | Daily time; Preferred date; What you want to learn: Matn, Sanad, Grade; Plan order: Book order, From An-Nas backwards | as S-08; order F UX.md, §6.4; label P |
| c13 | Secondary button | احسب التقدير | Calculate the estimate | P |
| c14 | Estimate preview: «الزمن الكلي»، «الزمن اليومي»، «الخطوة التالية» (P-13), reason line | نحو {days} يومًا، حتى {endDate}؛ {n} دقائق يوميًا، وحتى {w} كلمة جديدة؛ عند الاعتماد يسري التعديل من يوم التعلم التالي.؛ `exceeds_preferred_date`: يتجاوز هذا التقدير موعدك المفضل. يمكنك اختيار وقت يومي أطول أو موعد أبعد.؛ `fits_preferred_date`: يناسب هذا التقدير موعدك المفضل. | about {days} days, until {endDate}; {n} minutes a day…; On confirmation it takes effect from the next learning day.; This estimate goes past your preferred date. You can choose more daily time or a later date.; This estimate fits your preferred date. | labels F; text P (numbers from E15) |
| c15 | Primary button | اعتماد التعديل | Confirm the change | P |

- **Form rules.** At least one field must differ from the plan in force, else c13 is `aria-disabled` with «لم يتغير شيء بعد.» / "Nothing has changed yet." (E17 would answer `no_fields`). Scope and edition cannot change. E15 sends `editionId`, the plan's `targetScope`, `paths`, `sessionMinutes`, `preferredDate`, `order`, and no `placementSessionId` (UG-07 deferred, so the estimate may differ from the agreed one; c14 shows the fresh numbers). E17 sends `expectedVersion` = `currentVersion`, only the changed fields, and `confirmedEstimate` when the estimate changes. Messages (P-03, G-14): `paths_invalid` «اختر مسارًا واحدًا على الأقل.»; `date_invalid` «اختر موعدًا من اليوم فصاعدًا.»; `order_not_available` «هذا الترتيب غير متاح لهذا الكتاب.»; `session_minutes_invalid` «اختر ٥ أو ١٠ أو ١٥ دقيقة.»
- **Dialog (P-12): confirm the revision (D57).** «اعتماد التعديل؟» / "Confirm the change?"; «يسري هذا التعديل من يوم التعلم التالي. ما أنجزته اليوم يبقى كما هو، وتبقى أدلة الخطة السابقة محفوظة.» / "It takes effect from the next learning day. What you did today stays, and the evidence of the previous plan is kept."; paused plan adds «وتبقى الخطة متوقفة مؤقتًا.»; «اعتماد التعديل» / «إلغاء» (initial focus).
- **Revealing the form.** Not shown by default: it appears when E31 fails with 500, 503 or no response and the learner presses «تعديل بالنموذج» in the banner (P-14), or on arrival from the link under S-34's G-35 notice. **Never shown.** A scope or edition picker, free text outside the conversation.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Loading; wake-up; offline | E18; G-01; G-02 | skeleton for c3; P-04; P-05 | c2 | per pattern |
| Ready | active or paused plan | c3 to c7; paused adds «تبقى الخطة متوقفة مؤقتًا بعد التعديل.» | c2 | page title |
| Starting; started | c7; E31 `201` | E31 with `planId`, the plan's parameters, no placement id, `goalText` = the composed sentence of the plan in force (O-23; for a demo account it is not sent to the model): «جارٍ تجهيز المحادثة…»; then S-34 | c7; S-34 H1 | polite |
| Start failed | G-02, 429, 500, 503 | banner P-05, P-06, P-07 with «إعادة المحاولة» and «تعديل بالنموذج» | first action | alert or status |
| Plan not active; not found; revoked | E31 `409 plan_not_active` (G-11); `404` (G-07); G-20 | banner «اكتملت هذه الخطة؛ لا يمكن تعديلها أو استئنافها.» or «هذه الخطة غير نشطة.»; «لم نعثر على هذا العنصر.» with a button to S-12; «غير متاح» + G-20 line; c7 and the form removed or disabled | banner | status or alert |
| Form changed; estimating; estimate shown | field differs; c13; E15 `200` | c13 enabled; «جارٍ الحساب…» (a read); c14 and c15 appear | c14 heading | polite «ظهر التقدير الجديد» |
| Estimate changed | E17 `409 estimate_changed` (G-12) | c14 shows `details.estimate`; Warning banner «تغيّر التقدير. راجع التقدير الجديد ثم أكّد.»; nothing saved | c14 heading | status |
| Plan moved | E17 `409 plan_version` (G-09) | Warning banner «عُدّلت خطتك في مكان آخر. حدّث الصفحة ثم أعد المحاولة.» with «تحديث» (E18; valid inputs kept) | banner action | status |
| Field errors | E15 or E17 `422` (G-14) | P-03 messages at the fields | first invalid field | alert if two |
| Confirming; done | E17; `200` | «جارٍ الاعتماد…»; then S-11 with the toast «تم اعتماد التعديل.» and the G-32 banner | S-11 H1 | polite |
| Not applicable | access denied (guard 1); empty; offline plan (option B); G-06 (demo may revise, D71) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Focus order.** skip link, c1, [banner actions], c7, then (revealed) c9 to c12, c13, c14 heading, c15; after E15 focus goes to the c14 heading, after a dialog to the opener. Keyboard as S-08; Esc cancels the dialog. c14 is a `section` labelled by its H2; c13's disabled reason is in `aria-describedby`. Dates and numbers per P-16; Arabic names in `<bdi lang="ar">`.
- **Contrast pairs.** As S-08 plus `--q-color-warning-text` on `--q-color-warning-bg` 5.79 (G-09, G-12 banners).

**6. Colour and typography**
- As S-08: page `--q-color-bg`, fields `--q-color-surface` with `--q-color-border`, selection tokens, primary `--q-color-primary`. H1 `--q-text-title`; H2 and labels `--q-text-section`; body `--q-text-body`; helpers `--q-text-small`; buttons `--q-text-button`. UI fonts only.

### S-34 Plan review with the assistant — مراجعة الخطة مع المساعد

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** The learner builds a plan (from S-09) or revises the plan in force (from S-13, with the plan id) in a conversation with the plan assistant, then confirms. Each assistant turn shows the plan as a **card of the six labelled sections**; **all numbers come from the rules engine**, never from the model, which only interprets free text and phrases short replies. Nothing is saved before «اعتماد الخطة» (R02, D34). Learner and demo: a **demo account uses quick replies only** (the text area is disabled with a note, below) and its goal text is never sent to the model (D29); the server creates its plan in `synthetic_demo` mode (UG-18).
- **Entry.** S-09 (E31 done), S-13 (E31 with `planId`), the «متابعة المحادثة» entries of S-08 and S-11, a reload of `/plan/chat/[chatId]` (E33). **Exit.** «اعتماد الخطة» (dialog first when it replaces or revises a plan), E34, then S-11 with the history entry replaced. Back: S-08 (new), S-13 or S-12 (revision); the thread stays on the server and **no plan is saved**, so back needs no confirmation (UI-design §2.4, §2.5; UA-15).
- **Primary action.** «اعتماد الخطة» / "Confirm the plan". **References.** R24 to R29, R09; NFR-09, 10, 14 to 18; D26, D34, D57, D60, D75; E31 to E34 (E15, E16, E17 run on the server); G-01 to G-03, G-09, G-11, G-13 to G-17, G-28, G-34 to G-39; UA-14, UA-15, UG-15, UG-17 to UG-19.

**2. Layout and hierarchy**
- Focus flow (P-11). Bar: back and the H1 (wraps to two lines). Phone, 390×844: the **thread** (`role="log"`, scrolls) with the Notice (P-15) as its first item, then the messages; the latest assistant message carries the quick replies. **Slot T** sticks under the bar: at most one banner. The sticky **dock**: confirm button with its hint, then the composer (label, text area with the send button at the end edge, helper and counter on one line); about 180 px, leaving about 600 px for the thread.
- Messages: an author label (icon and name, `--q-text-caption`), then the bubble. Assistant at the start edge, learner at the end edge (logical, mirrored in LTR), at most 85 % wide; the card is full width. A new proposal scrolls so the **top of its card** sits under the bar (instant, never smooth). 768 px: column 640 px, bubbles 80 %. From 1024 px: no rail, column 720 px. At 320×568 the dock keeps the button and a one-line composer.
- Left out: timestamps, avatars, typing animation, reactions, an assistant switch, a model name, any cap number.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1–c2 | Back control; H1 | رجوع إلى ما هي خطتك؟ (new) · رجوع إلى تعديل الوقت والهدف (revision)؛ مراجعة الخطة مع المساعد | Back to What is your plan? · Back to Change time and goal; Plan review with the assistant | P; F inventory |
| c3 | Notice (P-15), first item of the thread | the transparency line v1.1 | see P-15 | F §2.6 |
| c4 | Thread (`role="log"`, `aria-relevant="additions"`); author labels | المساعد · أنت | Assistant · You | P |
| c5–c6 | Learner bubble (fill `--q-color-selection`; a quick reply shows its label); assistant text bubble (`--q-color-surface`, 1 px `--q-color-divider`, `--q-radius-md`) | server text | server text | data |
| c7 | **Plan card** (§6.7 card, `kind = proposal`): chip row, then six `dt`/`dd` pairs from `PlanSections` (`goal`, `totalTime`, `dailyTime`, `stages`, `reviews`, `nextStep`) | الاقتراح {n} · الحالي؛ الهدف الكلي، الزمن الكلي، الزمن اليومي، المراحل، المراجعات، الخطوة التالية | Proposal {n} · Current; the six labels in English | chip P; labels F UI-design |
| c8 | Earlier cards: collapsed disclosure, chip «سابق» | اقتراح سابق ({n}) | Earlier proposal ({n}) | P |
| c9 | Fixed refusal (`kind = refusal`), assistant bubble with an info icon | نعتذر، التطبيق مخصص لحفظ الكتب كما هي ولا يقدم فتوى أو شرحًا. للفتوى أو الشرح يرجى مراجعة أهل العلم والاختصاص. | Sorry, the app is for memorizing books as they are and does not give fatwas or explanations. For a fatwa or an explanation, please consult qualified scholars. | F D26, UX.md; English P |
| c10–c11 | Fixed redirect (G-39); fallback notice (G-35), once per conversation | يمكنني مساعدتك في خطة الحفظ فقط: المدة والوقت اليومي والنطاق والترتيب والمراجعات.؛ المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه. | I can only help with your memorization plan: duration, daily time, scope, order and reviews.; The assistant is unavailable right now; you can continue with the options below. | P (Plan-conversation §2.4) |
| c12 | Quick replies: group named «اختصارات التعديل» / "Edit shortcuts"; interactive chips (§6.11, 44 px) from `quickReplies`, server order | table below | table below | F or P |
| c13 | Status line (G-34), `role="status"`, loader icon | يرد المساعد… | The assistant is replying… | F G-34 |
| c14 | Primary button, full width; hints when disabled | اعتماد الخطة؛ اطلب خطة أو اختر اختصارًا أولًا.؛ لم يتغير شيء بعد؛ اطلب تعديلًا أو اختر اختصارًا. | Confirm the plan; Ask for a plan or choose a shortcut first.; Nothing has changed yet; ask for a change or choose a shortcut. | P (UI-design G-36 only requires the button to be disabled) |
| c15–c17 | Text area (§6.2 multi-line, label above); icon button (arrow mirrors); helper and counter | رسالتك إلى المساعد؛ إرسال؛ لا تكتب اسمك أو أي بيانات شخصية.؛ {n}/٥٠٠ | Your message to the assistant; Send; Do not type your name or personal data.; {n}/500 | P |

- **Quick replies (c12).** Rendered exactly as returned (`code`, `labelAr`, `labelEn`): the screen never adds, computes or reorders them, so one that cannot apply is absent (UA-14). Labels to be matched by the server (O-29): `fewer_minutes` «أقل دقائق» / Fewer minutes (F); `more_minutes` «دقائق أكثر» / More minutes; `smaller_scope` «هدف أصغر» / Smaller goal (F); `later_date` «موعد أبعد» / Later date (F); `no_date` «دون موعد محدد» / No set date (F); `order_book` «ترتيب الكتاب» / Book order (F §6.4); `order_reverse` «الترتيب العكسي للقرآن» / Reverse order (Quran) (F UI-design; O-29); `paths_matn_only` «المتن فقط» / Matn only; `paths_all` «كل المسارات» / All paths (the edition's three); `confirm` «اعتماد» / Confirm (F). `confirm` is the same action as c14 (E34 with the current `proposalVersion`, never E32) and takes the same dialogs (O-30). Any other chip sends E32 with `quickReply`.
- **Card rules.** Section text is `PlanSections` as received; the client computes no number and reformats no date. The chip «الاقتراح {n} · الحالي» (info tokens) marks the card whose `proposalVersion` equals `proposal.proposalVersion`; older cards collapse into c8 with the chip «سابق» (`--q-color-disabled`, `--q-color-text`) and have no actions; only the current card is described by c14 (`aria-describedby`).
- **Demo accounts.** The text area and send button are disabled (`aria-disabled`, kept in the tab order) and a Notice sits under the label: «في حساب العرض تُعدَّل الخطة بالخيارات الجاهزة فقط.» / "In a demo account the plan is changed with the ready-made options only." (P, owner package update). Quick replies and c14 work as for learners; the counter and the privacy helper are hidden.
- **Composer (learner accounts).** Plain text, trimmed, at most 500 characters in code points, no `maxlength`, paste allowed, `dir="auto"`, `enterkeyhint="send"`. **Enter sends; Shift+Enter inserts a newline;** Enter during IME composition does not send. Sending is blocked (`aria-disabled`) when the text is empty, over the limit or a reply is pending; the text area stays editable so a draft is never lost. Over 500: counter and «الرسالة حتى ٥٠٠ حرف.» / "The message can be up to 500 characters." turn error (G-14, no truncation).
- **Confirm.** Enabled only with a `proposal`, `status = open` and no reply pending; for a **revision** also only when the proposal differs from the plan in force, so E34 never meets `no_fields` (O-23). It sends the current `proposalVersion` (R24: it saves exactly the shown proposal); P-14 applies.
- **Dialogs (P-12).** *Replace the active plan* (creation while E18 shows an active plan; §6.9 variant): «بدء خطة جديدة؟» / "Start a new plan?"; «ستتوقف خطتك الحالية «{titleAr}» مؤقتًا ويبقى تقدمها محفوظًا، وتبدأ هذه الخطة مكانها. يمكنك استئناف السابقة لاحقًا من «الخطة الكبرى».» / "Your current plan “{title}” pauses with its progress kept and this plan starts in its place. You can resume the previous one later from “Overall plan”."; «اعتماد الخطة الجديدة» / «إلغاء» (initial focus). *Confirm the revision* (D57): as S-13's dialog. A first plan opens no dialog.
- **Not-found and closed state (§6.14).** «لم نعثر على هذه المحادثة.» / "We could not find this conversation." or «أُغلقت هذه المحادثة.» / "This conversation was closed." with «ابدأ من جديد» to S-08 (new) or «العودة إلى الخطة الكبرى» to S-12 (revision); a `confirmed` thread shows «اعتُمدت هذه الخطة.» and «افتح اليوم» to S-11.
- **Never shown.** A translation, explanation or ruling, generated religious text, an assistant switch (D51), a model name, a takhrij path.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Loading thread | reload, E33 in flight | thread skeleton after 300 ms (§6.14), `aria-busy`, dock inert | c2 | none |
| No proposal yet (G-36) | `proposal` null | c14 `aria-disabled` with its hint; defensive, since E31 returns a rules proposal as the first message | c2 | none |
| Populated | E31 or E33 with a proposal | cards, chips under the last assistant message, c14 enabled | c2 | page title |
| Assistant replying (G-34) | E32 in flight | the learner bubble shows at once; c13 below it; chips, c14 and send `aria-disabled`; **no typing animation ever** (the reply arrives whole; the loader is a static icon under reduced motion); up to the 8 s timeout | unchanged | polite «يرد المساعد…» |
| Reply received | E32 `200` | message appended; a new card scrolls into view; c13 removed; chips refresh. Focus stays in the text area if the learner typed; if a chip was used it moves to the new assistant message (`tabindex="-1"`, name «رد المساعد») | per rule | the log reads the message; a card as its six sections |
| Fallback (G-35) | a reply with `kind = fallback` (timeout, provider error, invalid output, ineligible model, exhausted free quota) | c11 appears **once per conversation** as a calm assistant message (UI-design G-35: never an error, no banner); rules replies and quick replies continue, free text is only partly understood, confirm stays enabled; on a revision c11 is followed by a tertiary «تعديل بالنموذج» to S-13 | unchanged | polite (log) |
| Caps reached | `modelTurnsLeft` 0, or the shared free-tier budget is spent (the server answers `kind = fallback`) | per conversation: Info banner «بلغت حد ردود المساعد في هذه المحادثة؛ نتابع بالاختصارات.»; shared free-tier budget: the c11 notice. At `modelTurnsLeft` 1 the helper adds «بقي رد واحد للمساعد في هذه المحادثة.» **Rules replies and quick replies continue**; the journey completes (NFR-16); no cap number is shown | unchanged | polite, once |
| Model switched off (configuration) | `QATRA_CHAT_MODEL_FOR_LEARNERS` is `false` (rules-only for real accounts) | the conversation is rules-only from the first turn with the same rendering as G-35 replies but **no «unavailable» notice and no error**; quick replies and free text (limited to what the rules and the guard understand) work; confirm works | unchanged | none |
| Demo account | `isDemo` | text area disabled with the note above; chips and c14 enabled; no model-related banner | c14 or the first chip | none |
| Refusal (G-28); redirect (G-39) | guard result | c9; c10 as assistant messages; no model call; the conversation continues | per rule | polite (log) |
| Send failed | G-02, 500, 503; 429 (G-15) | the learner bubble stays with an Error line «لم تُرسل الرسالة.» and «إعادة المحاولة» (P-14); P-05, P-06, P-07 in Slot T; text kept | retry | alert or status |
| Message too long | over 500 | counter and message in error (G-14) | text area | alert (debounced) |
| Confirming; confirmed | dialog accepted; E34 `201` or `200` | «جارٍ الاعتماد…», dock inert; then S-11 (history replaced) with the toast «تم اعتماد خطتك.» or «تم اعتماد التعديل.» and the G-32 banner | c14; S-11 H1 | polite |
| Proposal stale (G-37) | E34 `409 proposal_stale` | Warning banner «تغيّرت الخطة المقترحة. راجع البطاقة الجديدة ثم أكّد.»; the card in `details.proposal` becomes current (E33 refresh); nothing saved | new card's chip row | status |
| Plan moved (revision) | E34 `409 plan_version` (G-09) | Warning banner «عُدّلت خطتك في مكان آخر. ابدأ التعديل من جديد على النسخة الحالية.» with «ابدأ من جديد» (E31 with `planId`, P-14) | banner action | status |
| Active-plan race | E34 `409 active_plan_conflict` (G-13) | Warning banner «بدأت خطة أخرى للتو. حدّث الصفحة ثم أعد المحاولة.» with «تحديث» (E18, E33, then the dialog is asked again) | banner action | status |
| Plan not active | E34 or E31 `409 plan_not_active` (G-11) | Warning banner «هذه الخطة غير نشطة.» (completed: «اكتملت هذه الخطة؛ لا يمكن تعديلها أو استئنافها.»); dock read-only | banner | status |
| Closed or replaced (G-38); not found (G-36) | E32 `409 chat_closed`, or status `abandoned`/`confirmed`; E33 `404` | the closed or not-found state; thread read-only (composer, chips, c14 removed); the «متابعة المحادثة» entries lead to a newer open thread | its heading | status or alert |
| Session ended; wake-up | G-03; G-01 | S-01 with `next` = this path (E33 restores the thread after login); P-04 in Slot T, the shown thread stays | — | per pattern |
| Revision unchanged | proposal equals the plan in force | c14 `aria-disabled` with the second hint | c14 | none |
| Not applicable | `estimate_changed` (G-12 is not an E34 outcome in the package); offline, pending sync (option B, S-31); access denied (a foreign id is not-found); empty (the first message always exists); demo accounts' free text (disabled by design, see Demo account) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Focus order.** skip link, c1, [Slot T action], the disclosure of an earlier card c8 when present, the quick-reply group c12 (**one tab stop**, roving tabindex: arrows in the logical direction, Left is next in RTL, Home, End, Enter or Space), c14, c15, c16 (c15 and c16 stay in the order but are `aria-disabled` for demo). The thread is not a tab stop (messages take focus by script, `tabindex="-1"`). After E31, E33 or a route change focus goes to c2; dialogs return it to c14.
- **Keyboard.** In c15 **Enter sends, Shift+Enter inserts a newline**, never during IME composition; Esc closes a dialog and does nothing in c15; arrow keys in the thread are not captured.
- **Live regions.** The thread is `role="log"` (polite, additions): a new assistant message is read as added, a card as its six labelled sections; the learner's own message is not announced; c13 is a separate polite `role="status"`; banners per §6.8 (none uses an error tone); the counter is not live, the over-limit message is announced once. Scrolling to a card is instant.
- Labels in both languages; chips' names equal their labels; messages `dir="auto"` with `lang` of the conversation; no original religious text appears here, so no religious font (the D26 message is the app's own sentence). Targets: chips 44 px with 8 px gaps, send 44×44, buttons 48 px, disclosure 56 px. The thread mirrors in LTR; the send arrow mirrors.
- **Contrast pairs.** `--q-color-text` on `--q-color-surface` 11.76 (assistant bubble, card); on `--q-color-selection` 10.48 (learner bubble); `--q-color-text-secondary` on `--q-color-bg` 5.10 (Notice, author label, helper); `--q-color-text-accent` on `--q-color-selection` 7.75 (current chip); `--q-color-warning-text` on `--q-color-warning-bg` 5.79; `--q-color-error-text` on `--q-color-error-bg` 5.81; chip border on `--q-color-surface` 3.32; focus ring 8.27.

**6. Colour and typography**
- Page `--q-color-bg`; assistant bubble and card `--q-color-surface` with 1 px `--q-color-divider` (decorative; the author label, not colour, tells speakers apart); learner bubble `--q-color-selection`; current chip `--q-color-info-bg` with `--q-color-info-text` and the info icon; earlier chip `--q-color-disabled`; quick-reply chips `--q-color-surface` with `--q-color-border`, hover `--q-color-selection`; dock `--q-color-bg` with a `--q-color-divider` top edge; refusal, redirect and fallback use the assistant style with the info icon, no tint; banners §6.8 (Info, Warning); the send-failed line the Error recipe (§6.0). H1 `--q-text-title`; card labels `--q-text-section`; card text and bubbles `--q-text-body-compact`; text area `--q-text-body`; author label and chips `--q-text-caption`; helpers, counter, hints `--q-text-small`; buttons `--q-text-button`. UI fonts only.

## 3. Batch 3 — Games

appended by U2 part B.

## 4. Batch 4 — Session, progress, settings

### S-19 Memorization session — جلسة الحفظ

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** The daily session in the contract's order: **due reviews first** (overdue first), then the **new passage** (read, hide the text, drills until three correct answers in a row), then the **end test**; pause and resume; per-answer feedback with the original and its reference. The session is an immutable E20 snapshot; the server grades every answer. Learner and demo.
- **Entry.** The session button of S-11 (E20 `daily`); a reload of `/session/[id]` re-runs E20 `daily` (get-or-create returns the same open session; another id goes to `/today`, guard 8). **Exit.** Last question: E21 flush, E22, then S-20; pause: E21 flush, then S-11, where E20 returns the same session (UG-01); G-20 and G-11 to S-11.
- **Primary action.** One button whose label follows the step: «ابدأ التدريب», «تحقق» then «التالي», «إنهاء الجلسة». **References.** R04, R05, R06, R07, R12, R19, R20; NFR-09, 10, 11, 14; UX.md row «جلسة الحفظ», §§ «العودة والألعاب», «عرض الكتاب دون إضافات»; D31, D40, D50, D53, D64, D66, D68; E20, E21, E22; G-01 to G-03, G-09, G-11, G-19 to G-21, G-23, G-29, G-30; UG-01, UG-09, UA-09.

**2. Layout and hierarchy**
- Focus flow (P-11). Bar: back, H1 «جلسة الحفظ», the pause button at the end edge. Below, `--q-space-8` apart: the **daily line** (compact §6.10 daily bar, refreshed from `daily` in each E21 response, never per second) and the **stage indicator** («مراجعة»، «جديد»، «اختبار», not interactive). Then the step region (`--q-space-24` between blocks) and the sticky action bar.
- **Learn step:** H2 «مقطع جديد» with section title and reference; for a hadith a path chip; the **original-text block** (P-17, padding `--q-space-16` to `-24`, fill `--q-color-surface`, the whole unit shown with the `highlight` range marked); source line; for a hadith the record block and the D50 notice when `showD50Notice`; the hide toggle; the instruction. **Question step:** counter or streak line; prompt; context; piece; hint control; source line; feedback after an answer.
- 768 px: column 640 px, Quran text 28 px; from 1024 px column 720 px, no rail, Quran text 32 px from 1280 px. At 320×568 long passages scroll under the bar without hiding focus.
- Left out: a translation or «عرض الترجمة» (D49), a separate «عرض المصدر» button (the source line carries the link), remaining time, a skip (no operation records one), a score.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1–c3 | Back control (opens c19); H1; pause button (pause icon, opens c19) | رجوع إلى اليوم؛ جلسة الحفظ؛ إيقاف | Back to Today; Memorization session; Pause | P; F inventory; P (image 04) |
| c4 | Daily line (§6.10 daily, compact) | الإنجاز اليومي؛ ٣/١٠ دقائق | Daily progress; 3/10 minutes | F §6.10 |
| c5 | Stage indicator `ol` (`aria-current="step"`), name | مراحل الجلسة؛ مراجعة، جديد، اختبار | Session steps; Review, New, Test | P (image 04) |
| c6 | Step line | نبدأ بمراجعة ما حفظته. · نبدأ اليوم بمراجعة خفيفة. (G-30) · نبدأ من أول الجلسة؛ إجاباتك السابقة محفوظة. | We start by reviewing what you memorized. · Today we start with a light review. · We start from the beginning; your earlier answers are saved. | G-30 F; others P |
| c7 | H2; path chip (hadith) | مقطع جديد؛ متن، سند، الدرجة | New passage; Matn, Sanad, Grade | P; chips F Plan-conversation R26 |
| c8 | Original-text block (§6.12, P-17); legend when the highlight is part of a unit | المظلل هو مقطع اليوم. | The highlighted part is today's passage. | data; legend P |
| c9 | Source line (P-17) | {book} · {edition} · {reference} · {url or page} | same | data |
| c10 | Hadith record block (`--q-text-small`) | التخريج — من سجل HadeethEnc: {takhrij} أو غير مذكور في النسخة؛ الدرجة — من سجل HadeethEnc: {grade} أو غير مذكور في النسخة | Takhrij — from the HadeethEnc record: {…} or Not stated in the edition; Grade — … | labels P (G-29, UG-10); «غير مذكور في النسخة» F contract §2.3 |
| c11 | Notice (§6.12), only if `showD50Notice` | تنبيه: نُقل هذا النص حرفيًا عن الكتاب، ولم يُتحقق من صحة الحديث. | Note: this text was transcribed verbatim from the book, and the hadith's authenticity has not been verified. | F D50, D53; English P |
| c12–c14 | Toggle (`aria-pressed`); instruction; primary (sticky) | إخفاء النص ↔ إظهار النص؛ اقرأ المقطع، ثم جرّب الاسترجاع.؛ ابدأ التدريب | Hide the text ↔ Show the text; Read the passage, then try to recall it.; Start practice | toggle F UX.md; rest P (image 04) |
| c15 | Counter or streak line | سؤال {k} من {n} · متتالية صحيحة: {c} من ٣ | Question {k} of {n} · Correct in a row: {c} of 3 | P (O-35) |
| c16 | Prompt and piece (§6.16, §6.2) | as specified for S-15 to S-18 (part C); this screen adds only the wrapper | — | part C (O-37) |
| c17 | Hint control (§6.16), review-role helper, marker | تلميح؛ التلميح في المراجعة لا يُنجح الجولة.؛ بمساعدة | Hint; A hint in a review does not pass the round.; With help | P (O-35) |
| c18 | Primary (sticky), label changes in place | تحقق؛ التالي؛ إنهاء الجلسة | Check; Next; Finish the session | P |
| c19–c20 | Pause and leave sheet (P-12); feedback block (§6.17) | below | below | P, F UI-design §2.5 |
| c21 | Source line of the question (P-17) | {book} · {edition} · {reference} | same | data |

- **Learn step.** The passage is verbatim from the snapshot. A hadith's `takhrij` is **always displayed** with it and **never tested**; path chips are only متن, سند, الدرجة. The D50 notice shows only when `showD50Notice` is true (no Sahihayn attribution and no grade, D53); a recorded `grade` or an attribution replaces it, shown as recorded with no outside ruling. Source: a web edition shows the canonical URL (`pages` empty), a printed edition the printed page. The toggle **removes the text from the page and the accessibility tree** (§6.12 hidden state) and shows «النص مخفي للتسميع؛ اضغط «إظهار النص» لتراجعه.» / "The text is hidden for recall; press “Show the text” to see it again." (P).
- **Hints (c17).** One use per question (§6.16, contract §2.4): `word_recall` shows the first letter beside the input («أول حرف: {x}» / "First letter: {x}", `hintFirstLetter`); `word_choice` and `similar_distinction` remove one wrong option (announced «حُذف خيار خاطئ» / "A wrong option was removed"); `word_order` places the first token, locked with a lock icon. Then the control is disabled and «بمساعدة» stays; the answer is sent with `hintUsed: true`, is **assisted**, covers no part and cannot pass a review round (D64, D66).
- **Answer flow.** «تحقق» sends one E21 `answer` event and shows the feedback at once from the snapshot's `answerKey`; the server's `results` entry (`correct`, `assisted`, `expected`) is authoritative and, if it differs, replaces the block with a polite status. With nothing chosen: «اختر إجابة أولًا.» / "Choose an answer first." at the piece. Answers are final; no step back. Activity intervals run while the page is visible and the sheet is closed, and are flushed on pause, hide and finish.
- **Feedback (c20, §6.17)**, polite `role="status"`, focus not moved. Correct: success tokens, check-circle, «إجابة صحيحة.» / "Correct.". Needs review: warning tokens, refresh icon, «هذا الموضع يحتاج إلى مراجعة. الأصل:» / "This spot needs review. The original:", then the correct original (from `expected`: ordered tokens, option text or word) in original style with its source line; never an error tone or colour alone. Assisted: info chip «بمساعدة» and «الإجابة بمساعدة تُحتسب تدريبًا ولا تُعدّ دليلًا مستقلًا على الاسترجاع.» / "An answer with help counts as practice, not as independent proof of recall." Outcomes (G-21): «لم تُحتسب هذه الإجابة.» (rejected), «ما زالت هذه الإجابة قيد التحقق.» (pending); calm, not resent.
- **Dialog: pause and leave sheet (c19, P-12).** Opened by c1, c3, browser back, iOS edge swipe or Android back gesture (one history entry pushed on entry, UA-09); opening it flushes the activity interval so time stops. «الجلسة متوقفة مؤقتًا» / "Session paused"; «لا يُحتسب وقت التوقف. تستأنف من «اليوم» متى شئت.» / "Paused time does not count. Resume from Today whenever you like."; «متابعة الجلسة» / "Continue the session" (initial focus, Esc); «إيقاف مؤقت والخروج» / "Pause and leave" (goes to S-11, completes nothing).
- **Never shown.** A percentage of correct answers, a streak effect, typed recall text in any log, text of a revoked edition.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Loading snapshot; wake-up; offline | reload, E20 in flight; G-01; G-02 | skeleton of the step region after 300 ms; P-04; P-05 in a sticky banner under the bar; unsent answers wait in the page-memory queue and resend with the same `clientEventId`, the learner continues (queue lost on reload in option B) | c2 | status |
| Review first; light review (G-30) | snapshot starts with `review` questions; no learn step | c6 line; stage «مراجعة»; counter; no missed-day count | c15 | polite step title |
| Learn; text hidden | `learn` step; toggle | c7 to c14; hidden: text removed, placeholder line, toggle name flips | c7 heading; toggle | polite «تم إخفاء النص» |
| Drill; hint used | `training` question; c17 | streak line; hint effect and marker | the piece | polite |
| Answer checked | E21 answer | c20 correct, needs review, or assisted; c18 becomes «التالي» | c18 | polite |
| Event rejected or pending (G-21) | `rejected`, `pending` | the line under c20; `plan_not_active` or `session_closed` adds a Warning banner «هذه الخطة غير نشطة.» with «العودة إلى اليوم»; `daily` from the server replaces local figures | c18 or banner action | status |
| End test; finishing | `test` questions; last answer | stage «اختبار»; counter; «جارٍ إنهاء الجلسة…» (E21 flush, then E22) | c15; c18 | polite |
| Finish failed | G-02, 500, 503 on E22 | P-05 or P-07 with «إعادة المحاولة» on c18 (E22 is idempotent, safe) | c18 | per pattern |
| Day goal reached | `dailyCompleted` turns true | c4 shows check and «أكملت هدف اليوم» once; nothing closes | unchanged | polite, once |
| Paused (sheet); flush failed | c1, c3, back, swipe; G-02 in the sheet | c19; on failure «تعذّر حفظ آخر نشاطك. حاول مرة أخرى قبل الخروج.» with «إعادة المحاولة», leaving stays possible | «متابعة الجلسة» | dialog; status |
| Resumed | E20 returns the open session | same tab: continues at the stored step; after a reload restarts at the first step with the c6 line (a re-answer is a new attempt; a review round counts the first attempt, UG-01) | step heading | polite |
| Version conflict (G-09) | E20 `409 plan_version` on reload | Warning banner «عُدّلت خطتك في مكان آخر. حدّث الصفحة ثم أعد المحاولة.» with «تحديث»; an open session is never changed by a revision (D57) | banner action | status |
| Revoked content (G-20) | E20 `422 edition_not_available`; E21 `edition_mismatch` | text and question replaced by an Error banner with «غير متاح» and «هذه النسخة لم تعد متاحة. يمكنك بدء خطة على نسخة أخرى.»; «العودة إلى اليوم», «ابدأ خطة جديدة»; no text shown or guessed | first action | alert |
| Question not valid | a step cannot be rendered | Info line «تعذّر عرض هذا السؤال؛ ننتقل إلى التالي.» (P); no event, no credit; snapshot unchanged | next heading | polite |
| Payload too large; session ended | `413` (G-19); G-03 | client resends in smaller batches, no message; S-01 with `next=/today`, unsent answers lost | — | per S-01 |
| Not applicable | skip; offline run, pending sync (option B, G-22, S-32); no active plan (S-11 never opens a session then) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Focus order.** skip link, c1, c3, [banner action]; learn: c8's link, c12, c14; question: the piece (a group is **one tab stop**, roving; arrows in the logical direction, Home, End, Space or Enter; word-order chips are ordinary buttons, UI-tokens §7), c17, c18. Between steps focus goes to the step heading or prompt (`tabindex="-1"`); c18 keeps focus when it changes from «تحقق» to «التالي». **Keyboard.** Enter submits (also in the recall input); Esc opens the sheet and, inside it, continues; no trap.
- Feedback is a polite status without a focus move; the hint effect and the hide toggle announce politely; the daily bar announces only the 100 % milestone, once. Hidden text leaves the accessibility tree. `lang="ar"` `dir="rtl"` on all original text in both UI languages. Targets: tiles 56 px, chips and links 44 px, buttons 48 px. Reduced motion: no animated progress or feedback, static loader.
- **Contrast pairs.** `--q-color-text` on `--q-color-surface` 11.76; on success or warning tints at least 10.28 (original inside feedback); `--q-color-success-text` on `--q-color-success-bg` 6.16; `--q-color-warning-text` on `--q-color-warning-bg` 5.79; `--q-color-text-secondary` on `--q-color-bg` 5.10; `--q-color-text-accent` on `--q-color-selection` 7.75; progress 3.90; focus ring 7.65 (success tint), 7.95 (warning tint).

**6. Colour and typography**
- Page `--q-color-bg`; text block, tiles and answer area `--q-color-surface`; highlight `--q-color-selection` (with the legend, not colour alone); correct feedback success tokens; **needs-review feedback warning tokens, not error** (UI-tokens A4); assisted marker an info chip (`--q-color-info-bg`, `--q-color-info-text`); notices `--q-color-text-secondary` with an info icon. Original text: Quran `--q-text-quran` in `--q-font-quran`, hadith `--q-text-hadith` in `--q-font-hadith`, words in questions and feedback `--q-text-token`. UI text: H1 `--q-text-title`; step headings and the feedback phrase `--q-text-section`; prompts `--q-text-body`; counters, source, notices `--q-text-small`; stage labels, chips `--q-text-caption`; buttons `--q-text-button`.

### S-20 Session result — النتائج والتقدم (بعد الجلسة)

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** A calm end-of-session summary from the E22 `CompleteResponse` and the daily indicator; it adds no time and no completion (D40). Learner and demo.
- **Entry.** Only from S-19 after E22 succeeds (response held in memory). A reload or direct visit goes to S-21: S-20 never calls E22, so a session cannot be completed by URL. **Exit.** «العودة إلى اليوم» to S-11 (primary); «تدريب إضافي» to S-14 (O-34); «عرض تقدمك» to S-21. Back: S-11.
- **Primary action.** «العودة إلى اليوم». **References.** R04, R06, R19; UX.md row «النتائج والتقدم»; D40, D66; E22; G-23.

**2. Layout and hierarchy**
- App shell, tab «التقدم» active. `--q-space-24` apart: H1; the summary as a `dl` (rows of at least 56 px with dividers); the daily indicator (§6.10 daily, extra-time line); actions (primary full width, secondary, link). One column (640 px, 720 px from 1024). Left out: confetti, a score card, a share action.

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | H1 | انتهت الجلسة | The session is over | P (image 06 says «اكتملت جلسة اليوم»; completing the day is D40's, not the session's) |
| c2 | Row, always (counts, never a percentage) | الإجابات: {correct} من {answered} صحيحة | Answers: {correct} of {answered} correct | P |
| c3–c5 | Rows shown only when the count is above 0: new passages; reviews passed; reviews returning | مقاطع جديدة: {n}؛ مراجعات ناجحة: {n}؛ مراجعات تعود في يوم التعلم التالي: {n} | New passages: {n}; Reviews passed: {n}; Reviews coming back on the next learning day: {n} | P (D66: a failed review is due the next learning day; no blame) |
| c6 | Row, always, time in `<bdi dir="ltr">` | الوقت النشط: {m:ss} دقائق | Active time: {m:ss} minutes | P |
| c7 | Daily indicator (§6.10), extra-time line, completion line | الإنجاز اليومي؛ ٧/١٠ دقائق، ٧٠٪؛ + {m} دقيقة إضافية؛ أكملت هدف اليوم | Daily progress; 7/10 minutes, 70%; + {m} extra minutes; You reached today's goal | label F; others P |
| c8 | Primary; secondary; link | العودة إلى اليوم؛ تدريب إضافي؛ عرض تقدمك | Back to Today; Extra practice; View your progress | F image 06, UI-design §1.1; link P |

- `daily` is authoritative; extra time is separate and never a second completion («١٢/١٠ دقائق = ١٠٠٪ ودقيقتان إضافيتان»); the completion line shows only when `dailyCompleted` is true. **Dialogs.** None. **Never shown.** A certificate, a ranking, the partial-recall indicator of image 06.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Result | arrival from S-19 | c1 to c8; goal reached adds the completion line; extra time adds its line; c5 appears when reviews return | c1 | page title; polite once for the goal |
| No answers | `answered` = 0 | c2 becomes «لم تُسجَّل إجابات في هذه الجلسة.» | c1 | none |
| Reload or direct visit | no response in memory | redirect to S-21 | S-21 H1 | its title |
| Not applicable | loading and errors (E22 failures are handled on S-19); no plan; offline, pending sync (option B); field errors | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- Focus: skip link, c8 primary, secondary, link, tab bar or rail; arrival focuses c1. The bar fills from the start edge, `role="progressbar"` with `aria-valuetext`; numbers per P-16. Targets 56 px rows, 48 px buttons, 44 px link. **Contrast pairs.** `--q-color-text` on `--q-color-bg` 11.19; `--q-color-text-secondary` 5.10; `--q-color-success-text` on `--q-color-success-bg` 6.16; progress 3.90; focus ring 8.27.

**6. Colour and typography**
- Page `--q-color-bg`; rows divided by `--q-color-divider`; bar §6.10; completion line success tokens; the returning-reviews row `--q-color-text` with an info icon (a plan, not a fault). H1 `--q-text-title`; labels `--q-text-body`; values `--q-text-section`; helpers `--q-text-small`; buttons `--q-text-button`. UI fonts only.

### S-21 Results & progress — النتائج والتقدم

**1. Purpose, role, entry and exit, acceptance**
- **Purpose and role.** Two **independent** indicators and the state of the material: daily active time against the goal, and overall progress of confirmed material in the plan; what is confirmed, in progress and needing refresh; the next review date. It never certifies memorization (D66). Learner and demo.
- **Entry.** Tab «التقدم» (`/progress`); the S-20 link and redirect. **Exit.** «ابدأ خطتك» (G-24) to S-08; «الخطط السابقة» to S-12. Back: none (tab root). **Primary action.** None: read-only.
- **References.** R06, R19; UX.md row «النتائج والتقدم», § «العودة والألعاب»; D40, D66; E19, E18 (`streakDays`, O-28); G-01, G-02, G-16, G-17, G-20, G-23, G-24, G-31; UA-07.

**2. Layout and hierarchy**
- App shell, tab «التقدم». `--q-space-24` apart: H1; Slot T; **daily card**; **overall card**; next-review line; three native disclosures (needs refresh, in progress, confirmed). Cards are §6.7 (fill `--q-color-surface`, 1 px `--q-color-divider`, padding 16 px). «يحتاج تحديثًا» and «قيد التقدم» start open when not empty, «المؤكدة» closed, so 37 to 42 rows do not push the page.
- 768 px: cards stack. From 1280 px: the two cards side by side inside 960 px, groups below. At 320 px each label and value stack. Left out: a certificate, a ranking, «٧ من ١٠ استرجاع الكلمات» (image 06), accuracy percentages, a day history (no source requires E19 `history`), a streak calendar of empty circles (it counts missed days).

**3. Components, content, validation, dialogs**

| # | Element (component) | Arabic | English (proposed) | Src |
|---|---|---|---|---|
| c1 | H1 | النتائج والتقدم | Results and progress | F inventory |
| c2 | Daily indicator (§6.10 daily); extra and completion lines | الإنجاز اليومي؛ ٧/١٠ دقائق، ٧٠٪؛ + {m} دقيقة إضافية؛ أكملت هدف اليوم | Daily progress; 7/10 minutes, 70%; + {m} extra minutes; You reached today's goal | F §6.10; others P |
| c3 | Basis line | الوقت النشط مقابل هدفك اليومي. تُحسب القراءة واللعب، وإن كانت بعض الإجابات خاطئة. | Active time against your daily goal. Reading and play both count, even with some wrong answers. | P (D40) |
| c4 | Streak line (UA-07) | أيام متتالية بلغتَ فيها هدفك: {n}؛ at zero: لا توجد أيام متتالية بعد. | Days in a row you reached your goal: {n}; No days in a row yet. | P |
| c5 | Overall indicator (§6.10 overall) | الإنجاز الكلي للخطة؛ {overallPercent}٪ | Overall plan progress; {overallPercent}% | F §6.10 |
| c6 | Count lines; Notice | {confirmedWords} من {totalWords} كلمة مؤكدة؛ {confirmedSections} من {totalSections} {سورة/حديث} مؤكدة؛ هذه النسبة مؤشر تقدم في خطتك، وليست شهادة حفظ. | {confirmedWords} of {totalWords} words confirmed; {confirmedSections} of {totalSections} confirmed; This percentage is a progress indicator for your plan, not a memorization certificate. | P (D66) |
| c7 | Next review line | موعد المراجعة التالي: {date}؛ لا توجد مراجعة قادمة بعد. | Next review: {date}; No review is coming up yet. | label F §6.10; empty P |
| c8 | Disclosures (O-22), summary rows 56 px | المؤكدة ({n})، قيد التقدم ({n})، يحتاج تحديثًا ({n}) | Confirmed, In progress, Needs refresh | F D66 wording |
| c9 | Section rows (§6.7, not links): title, mastery badge (§6.11), percent | مؤكد، قيد التعلم، قيد التقدم، يحتاج تحديثًا؛ {p}٪ | Confirmed, Learning, In progress, Needs refresh | badges F §6.11 |
| c10 | Needs-refresh explanation, inside its group | هذه المقاطع احتاجت إلى مراجعة بعد تأكيدها، فخرجت مؤقتًا من الإنجاز الكلي حتى تجتاز مراجعاتها من جديد. | These passages needed a review after they were confirmed, so they are temporarily outside overall progress until they pass their reviews again. | P (D66) |
| c11 | Zero-progress line | يظهر التقدم هنا بعد أن تؤكد أول مقطع؛ التأكيد يأتي بعد مراجعات متباعدة. | Progress appears after you confirm your first passage; confirmation comes after spaced reviews. | P |
| c12 | Empty state (§6.14); link | لا توجد خطة نشطة بعد.؛ ابدأ خطتك؛ الخطط السابقة | No active plan yet.; Start your plan; Previous plans | F G-24; link P |

- **Rules.** The indicators are independent and never combined: daily is time (D40, capped at 100 %, no second completion); overall is `floor(100 × confirmedWords ÷ totalWords)` of the plan scope for the selected paths (D66; passages awaiting review or needing refresh are outside the numerator). Groups: «المؤكدة» = `confirmed`; «قيد التقدم» = `learning` and `reviewing` (the badge shows which); «يحتاج تحديثًا» = `needs_refresh`; sections with status `new` are in no group and c6 says how many are confirmed (O-27). Percent per section as received. The plan shown is the active one; with none active but a completed one, that plan with the G-31 banner «اكتملت هذه الخطة، وتستمر مراجعات الصيانة.»; with only paused plans, c12 with the link. **Dialogs.** None. **Never shown.** A certificate, a ranking, accuracy percentages, «يحتاج تحديثًا» in error colours.

**4. States**

| State | Trigger | What changes and copy | Focus | Announcement |
|---|---|---|---|---|
| Loading; wake-up; offline; service error | E19, E18 in flight; G-01; G-02; 500, 503 | two card and three group skeletons after 300 ms; P-04; P-05; P-07, each with «إعادة المحاولة» (reads); no stale numbers | c1 / retry | per pattern |
| Zero progress | no confirmed words | empty track and «٠٪»; c11; empty groups not shown | c1 | none |
| Populated; daily at 100 % | normal; `dailyPercent` 100 | cards, c7, groups; check and «أكملت هدف اليوم», extra minutes on their own line | c1 | none (announced on S-19) |
| Needs refresh | `counts.needsRefresh` > 0 | group open with c10; warning-token badges | c1 | none |
| Streak zero; next review empty | `streakDays` 0; `nextReviewDate` null | neutral c4; c7 empty line | c1 | none |
| Revoked content | G-20 | Error banner «غير متاح» + G-20 line with a path to S-08; numbers stay | banner action | alert |
| Completed plan; no plan | G-31; G-24 | banner, stored values; c12, tabs stay | c1; button | none |
| Not applicable | field errors and disabled inputs (read-only); plan switching and sync chip (S-12 lists other plans; none in option B, G-22, O-33); pending sync, offline (option B, S-32); access denied (guard 1) | — | — | — |

**5. Responsive, RTL/LTR, accessibility**
- **Focus order.** skip link, [banner action], disclosure summaries in order (needs refresh, in progress, confirmed), c12 button or link, tab bar or rail. Disclosure: Enter or Space; name «يحتاج تحديثًا (٢)» / "Needs refresh (2)"; rows are not interactive. Each card is a `section` with an `h2`; both bars are `role="progressbar"` (`aria-valuenow` capped at 100, `aria-valuetext` «٧ من ١٠ دقائق، ٧٠ بالمئة» and «٢٧ بالمئة من الكلمات مؤكدة»), values also visible; badges carry icon and text. Bars fill from the start edge; titles in `<bdi>`, English UI uses `titleEn` (`Surah 78`); numbers per P-16. Targets 56 px summary rows, 44 px links.
- **Contrast pairs.** `--q-color-text` on `--q-color-surface` 11.76; `--q-color-text-secondary` on `--q-color-surface` 5.36; progress 3.90; `--q-color-success-text` on `--q-color-success-bg` 6.16; `--q-color-warning-text` on `--q-color-warning-bg` 5.79; `--q-color-text-accent` on `--q-color-selection` 7.75; focus ring 8.69. Reduced motion: instant bars.

**6. Colour and typography**
- Page `--q-color-bg`; cards `--q-color-surface` with `--q-color-divider`; bars: track `--q-color-disabled`, fill `--q-color-primary`; badges §6.11 (confirmed success tokens, in progress and learning selection tokens, needs refresh warning tokens); the Notice `--q-color-text-secondary`. H1 `--q-text-title`; card labels `--q-text-section`; the overall figure `--q-text-display`; lines `--q-text-body-compact`; helpers and dates `--q-text-small`; badges `--q-text-caption`. UI fonts only.

*S-22…S-27: appended by U2 part C.*

## 5. Open points

Questions for the coordinator, not the owner. Each has an interim choice in the screens above, so nothing blocks review.

| ID | Point and interim choice | Needs |
|---|---|---|
| O-01 | UI-tokens §6.8 wants throttled as a Warning banner with static wording and no ticking countdown; UI-design G-15 and the brief want a visible countdown from `Retry-After`. P-06 keeps the banner static and shows the countdown in an `aria-hidden` line, announced only at start and end. | Confirm, or drop the visible countdown |
| O-02 | The G-02 sentence promises an automatic retry, but E03 to E07 are never retried without a user gesture; P-05 words the forms' banner without it. | Align G-02 |
| O-03 | UI-design UA-03 and §2.1 put the rail from 768 px; UI-tokens §5 (Q4) puts the bottom bar below 1024 px and the rail from 1024 px. This file follows UI-tokens. S-01 to S-07 have neither, so they are unaffected; later batches are. | Correct UI-design.md UA-03 |
| O-04 | At 320 px the public header cannot hold logo, switch, «إنشاء حساب» and «تسجيل الدخول» (UI-design §2.1). S-07 moves the actions under the intro below 768 px; S-01, S-02, S-05 have back and switch only; S-04 and S-06 have the brand only and no back control (UI-design §2.4 lists neither). | Confirm; update §2.1, §2.4 |
| O-05 | The header language switch uses segments of at least 44 px (§6.4 asks 88 px) to fit 320 px. | U3: header variant, or confirm |
| O-06 | Not in UI-tokens: a disclosure component (S-07 section list) and the 480 px form column. | U3: add or replace |
| O-07 | §6.2 gives the show/hide button both a changing label and `aria-pressed`; a toggle should use one. | U3: choose |
| O-08 | E14 lists editions only, so a category without an edition (G-27) cannot be derived; S-07 shows a page-level empty state only. | Architect: add categories to E14, or confirm a static list |
| O-09 | E03 and E05 need the current terms version, but E04 returns only `reconsentRequired`. Proposed: the frontend bundles the version with the S-03 text; a different `details.requiredVersion` shows the reload banner instead of sending an unseen version. | Architect: confirm how `TERMS_VERSION` reaches the client |
| O-10 | E06 reserves the code atomically (10 minutes). After a reload loses the grant, a new E06 with the same code may fail generically until the reservation lapses; S-05 states the 10 minutes in advance but cannot say "wait". | Architect: confirm; add a hint if it applies |
| O-11 | S-05 pre-checks the code format on the client (not 32 hexadecimal characters after normalization): nothing is sent, so no throttle count and no account information leaks. The brief asks for one generic error for invalid and used codes and expired grants; server answers stay generic. | Confirm the pre-check |
| O-12 | The sources give only the Arabic name «قطرة غيث»; "Qatra" in English titles is a placeholder. | English product name |
| O-13 | The English terms text does not exist (NFR-14), and the source's offline paragraph describes option C. S-06 has no "what changed" view because no source defines one. | Authoring; confirm scope |
| O-14 | How the visitor's language choice persists (cookie or local storage) is unspecified; P-02 fixes only the default and the E03 field. | Architect |
| O-15 | If a browser reports no IANA time zone, E03 answers `time_zone_invalid` and the learner cannot fix it. Proposed client fallback `UTC`, correctable in Settings (D57). | Confirm |
| O-16 | S-04 gates Continue, but leaving by back or reload cannot be prevented; the Leave dialog and guard-9 banner allow it, since a new code can be made later. | Confirm |
| O-17 | The downloaded code file omits the username on purpose (username plus code resets the password). | Confirm |
| O-18 | Path labels «النص القرآني»، «المتن»، «السند»، «الدرجة» and their English forms are proposed; no source fixes them (English religious terms await the Jamhara dictionary, D28). | Owner terminology |
| O-19 | Whether the English UI also shows the Arabic book title on a second line in S-07 (the book keeps its original language, UX.md). | Decide |
| O-20 | Catalog strings use the UI font, which lacks the six Uthmani marks; a title carrying one must switch to the Quran font. | Frontend note for F5 |

### Part B open points (continue the table of §5)

| ID | Point and interim choice | Needs |
|---|---|---|
| O-21 | E20 `placement` takes `selfRating` only at creation, so S-09 asks the optional self-rating **before** the questions, although UX.md and UI-design §1.1 say «then». | Confirm, or add a way to send it at the end |
| O-22 | Not in UI-tokens, used by part B: message bubble, multi-line text area, quick-reply chip row, plan card, bottom-sheet presentation of §6.9, steps variant of §6.10, three-step session indicator, passage highlight in §6.12, a banner-link on G-35; disclosure (part A O-06). | U3: add, or approve the compositions |
| O-23 | S-34, S-13: (a) a revision's «اعتماد الخطة» is enabled only when the proposal differs from the plan in force (E34 would meet `no_fields`); (b) S-13 sends the composed sentence of the plan as `goalText` (E31 requires it; not sent to the model for demo accounts); an empty `goalText` rule and character counting (code points assumed) are not stated. | Package: confirm |
| O-24 | No field gives a revision's effective date (G-32); screens use `Today.learningDate` plus one day. | Confirm, or expose it |
| O-25 | The G-30 trigger reaches the client in no field: S-19 uses «reviews and no learn step»; S-11 derives it from E19 `history`. | An E18 flag, or confirm |
| O-26 | Maintenance of a completed plan needs `currentVersion` (UG-04), absent from `PlanProgress`; S-11 shows only the G-31 banner meanwhile. | Architect: add the field |
| O-27 | The `sections[].status` roll-up is undefined (API-spec §4.6); S-12 and S-21 depend on it. Proposed: `confirmed` if all passages are, else `needs_refresh` if any, else `reviewing`, else `learning`, else `new`. `new` sections are in no S-21 group; S-21 shows a completed plan when none is active. | Architect: define; confirm |
| O-28 | S-11 also reads E19 and S-21 also reads E18 (`streakDays`); the inventory lists one operation each. | Confirm |
| O-29 | Server text (`PlanSections`, `QuickReply` labels) must follow the digit rule (P-16) and the S-34 labels; the reverse-order chip is «الترتيب العكسي للقرآن» (UI-design) while the fixed label elsewhere is «من الناس رجوعًا» (UX.md, D72). | Align; copy deck for templates |
| O-30 | The `confirm` quick reply duplicates «اعتماد الخطة» (same E34 call); kept as the last chip because UI-design §1.1 lists it. | Keep or drop |
| O-31 | No source names the entry for starting another plan (UX.md lists the state): S-12 gets «بدء خطة أخرى», and S-08 a close control to S-12 when a plan is active (UI-design §2.4 says none). | Confirm; update §2.4 |
| O-32 | UI-design §1.1 still says four path boxes and «صحة/الدرجة» in the S-08 paragraph and the S-13 row (UG-16 already says declined, Plan-conversation v1.1 says three paths and «الدرجة»); part B uses three boxes and «الدرجة». UI-design also still says the line is «pending D75». | Update UI-design |
| O-33 | G-22 lists S-11 and S-21 for the sync chip; in option B nothing is stored on the device, so no chip is rendered there. | Confirm |
| O-34 | «تدريب إضافي» goes to S-14; S-11 keeps «ابدأ جلسة اليوم» after the goal and relies on E20 get-or-create. | Confirm |
| O-35 | A hint fails a review round (contract §4.3), so S-19 says so; drills show «متتالية صحيحة: {c} من ٣» (D41). | Confirm both lines |
| O-36 | E32 and E34 have no idempotency key; the retry runs E33 first (P-14). | Architect: confirm |
| O-37 | S-19 reuses prompts, pieces and hints of S-15 to S-18 (part C owns them). | Keep consistent at merge |
