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

S-08…S-13 and S-34: appended by U2 part B.

## 3. Batch 3 — Games

appended by U2 part B.

## 4. Batch 4 — Session, progress, settings

appended by U2 part B.

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
