# Figma polish: code handoff

Version 1 · 2026-10-05 · Asia/Dubai · Status: **Draft / Needs Review**

## Purpose and authority

This handoff turns the recent Figma polish into a prioritized implementation backlog. It identifies code work and acceptance evidence; it does not approve or implement that work.

The source snapshot inspected was `main` at `821bedf`. D78 approves the written UI specification. Incremental Figma polish remains **Needs Review**. This document is authorized documentation only: it does not grant frontend implementation, change the UI approval gate, approve a screen, or grant G2/G4 or another phase gate.

The approved design references remain [UI-tokens.md](UI-tokens.md), [UI-screens.md](UI-screens.md), [Implementation-contract.md](Implementation-contract.md), [Programming-guide.md](Programming-guide.md), and [Readiness.tracker.md](Readiness.tracker.md). Figma is visual reference material; approved written requirements and decisions govern behavior, accessibility, source wording, status semantics, and business rules. Reconcile each polish detail with those sources before coding.

Priorities are delivery order within this polish backlog. **P1** means a high impact on navigation, feedback readability, or control reachability. **P2** means a medium impact on hierarchy, density, or learning clarity. These labels describe design impact; they are not verified runtime severity. No P0 finding is evidenced. The backlog priority does not reorder approved business delivery: finish the D82 basic journey and required phase pauses first; games and settings follow their applicable gates.

## Current code map

| Surface | Source status at the inspected snapshot |
|---|---|
| Shared navigation | `frontend/src/components/ui/MainNav.tsx` exists. Four destinations, responsive bottom tabs/desktop rail, active indication and accessible current-page state are implemented. |
| Shared icons and back control | `frontend/src/components/ui/Icon.tsx` is the existing Lucide adapter. `BackControl.tsx` provides the direction-aware back affordance. |
| Login (S-01) | `frontend/src/app/(public)/login/page.tsx` and `components/auth/LoginForm.tsx` exist. Current form, notifications, recovery link and registration link are implemented locally. |
| Recovery code (S-04) | `frontend/src/app/(flow)/recovery-code/page.tsx`, `RecoveryCodeScreen.tsx`, `RecoveryCodeSave.tsx`, and `RecoveryCodeBlock.tsx` exist. Source/readiness records it in progress; this handoff does not mark it complete. |
| Recovery, re-consent, Today, Games, Progress, Settings | Their current routes use placeholder surfaces. See `components/ui/PlaceholderRoute.tsx`, `PlaceholderPage.tsx`, and each route page. |
| Future requested surfaces | No route files were found in the inspected `frontend/src/app` tree for plan overview, plan revision, placement, session, individual games, feedback, or Source. These are proposed destinations governed by the approved route/screen plan, not existing code. |

### Existing visual seams to preserve

- `MainNav.tsx:10-20, 22-50` defines the four tabs, route matching, `aria-current`, and a 3px active top rule on mobile. `MainNav.tsx:54-85` defines the 1024px desktop rail and its 3px active start rule. Keep these indicators and routes while adding the approved glyphs.
- Mobile navigation already uses a 4rem tab bar plus the safe-area inset; see `MainNav.tsx:27-45`, `tokens.css:93-102`, and `globals.css:13-21`. Figma's 99px total includes the 64px bar, divider and 34px safe area in its reference frame. Do not encode 99px or the screenshot's device coordinates as a fixed height.
- `LoginForm.tsx:204-220, 223-253, 273-298` provides the logo/title, validation and arrival region, 16px field stack, full-width submit area, recovery link, and registration helper. Keep authentication flow and notification placement behavior intact while applying approved visual refinements.
- `RecoveryCodeScreen.tsx:19-33` provides the focused shell and page padding. `RecoveryCodeSave.tsx:142-185` uses a 24px vertical stack gap and 8px action gap. `RecoveryCodeBlock.tsx:5-16, 30-55` fixes the eight-group LTR code format and copy behavior. Preserve the one-time handoff, exact code, copy/download, confirmation and leave guard.
- `BackControl.tsx` already mirrors the back arrow for RTL/LTR. Do not mirror unrelated icons. Keep accessible control names on buttons and links.
- Current tokens in `styles/tokens.css` already define the blue identity, type scale, spacing, target sizes and radii. Prefer these and logical CSS properties; a Figma measurement refines local spacing and does not replace the approved token system.

## Prioritized backlog

| ID | Priority and rationale | Current code scope | Status for this request |
|---|---|---|---|
| FC-01 | P1 · high: navigation reachability | Existing MainNav | Not implemented in this request |
| FC-02 | P1 · high: session/source controls | Future Session and Source | Not implemented in this request |
| FC-03 | P1 · high: settings reachability | Existing placeholder route; future screen | Not implemented in this request |
| FC-04 | P1 · high: feedback readability | Future shared feedback | Not implemented in this request |
| FC-05 | P1 · high: revision action reachability | Future Plan Revision | Not implemented in this request |
| FC-06 | P2 · medium: login density and learning cue | Existing Login | Not implemented in this request |
| FC-07 | P2 · medium: recovery-code density | Existing Recovery Code | Not implemented in this request |
| FC-08 | P2 · medium: account-flow density | Existing placeholders; approved future screens | Not implemented in this request |
| FC-09 | P2 · medium: placement clarity | Future Placement | Not implemented in this request |
| FC-10 | P2 · medium: Today hierarchy | Existing placeholder route; future screen | Not implemented in this request |
| FC-11 | P2 · medium: overview hierarchy | Future Plan Overview | Not implemented in this request |
| FC-12 | P2 · medium: game choice clarity | Existing Games placeholder; future screens | Not implemented in this request |
| FC-13 | P2 · medium: learning explanation | Future games and feedback | Not implemented in this request |
| FC-14 | P2 · medium: progress hierarchy | Existing Progress placeholder; future screen | Not implemented in this request |

Status means no implementation was performed in this documentation request; it is not a status claim about unrelated work.

### P1 — Navigation, answer feedback, and reachable controls

#### FC-01 — Add semantic icons to mobile navigation

**Destination:** `frontend/src/components/ui/MainNav.tsx` and existing `Icon.tsx` adapter.

Add one approved semantic icon to each existing destination: Today, Games, Progress, Settings. Retain the white tab cells, destination order, text labels, current 3px active indicator, `aria-current`, route matching, focus style, safe-area inset, and desktop rail behavior. Icons supplement labels; they do not replace them or carry state by color alone.

**Acceptance:** all four routes still resolve; active styling follows nested route rules; each link retains a visible accessible name and focus; tabs remain at least the approved 44px target; the bottom safe area is clear. Do not hardcode the 390×844 frame or its y positions.

#### FC-02 — Add the session pause affordance and source back control

**Destination:** approved future session and Source surfaces, reusing `BackControl.tsx` and `Icon.tsx`.

Use the existing direction-aware BackControl for back navigation. Add a pause glyph only where the approved session screen has a pause action. Preserve the specified pause, resume and leave behavior, including active-time accounting; do not assume every pause opens a leave dialog or add pause controls where there is no active session.

**Acceptance:** directional back behavior follows UI-tokens; pause glyph does not mirror; controls have at least 44px targets, visible focus and screen-reader names; pause, resume and leave follow the specified session flow, including a leave dialog only where specified, and active-time accounting stops or resumes as specified.

#### FC-03 — Keep all Settings actions reachable above navigation

**Destination:** future Settings screen; current `/settings` is a placeholder.

Arrange the approved settings cards, logout, local-data clear and account-deletion actions in normal document flow so each remains reachable above the bottom navigation. Treat the Figma viewport geometry as a reference, not a fixed y coordinate or height. Preserve each approved action, ordering requirements, confirmation and error state.

**Acceptance:** at 320px and 390px widths, at increased text size, and with the mobile keyboard open where fields exist, users can scroll to every action; no action is covered by the tab bar or safe area. Verify keyboard focus and dialogs.

#### FC-04 — Make the three answer feedback states readable

**Destination:** shared feedback component for the four future game screens and S-19 session, per `UI-screens.md` P-21.

Separate the correct/needs-review/assisted status from the original source by 16px. Keep canonical source text unchanged. Use the approved semantic status wording, status role and status icon; retain needs-review warning semantics and assisted wording. Do not overlap the status, source, hint, or continue action.

**Acceptance:** all three states remain distinct in Arabic and English, at narrow width and enlarged text; live announcement does not steal focus; the original source is present where required; the next/continue action keeps its approved meaning and behavior.

#### FC-05 — Place plan revision steps and primary action clearly

**Destination:** future S-13 Plan revision surface, not currently present in the route tree.

Place the approved 48px primary action in the 80px action area directly above mobile navigation, with 16px vertical and 24px inline reference insets. Show steps in RTL order: step 1 right, step 2 center, step 3 left. Use normal reflow when content grows; do not pin the action to a screenshot y coordinate or alter plan proposal, approval, or revision rules.

**Acceptance:** primary action remains visible and reachable above the safe-area-aware tab bar; RTL order and LTR order are correct; keyboard focus remains visible; longer translated labels or 200% text cause reflow rather than overlap.

### P2 — Screen density, hierarchy, and learning explanation

#### FC-06 — Refine Login spacing and add the static helper strip

**Destination:** existing `components/auth/LoginForm.tsx` plus a reusable static helper component and approved Arabic/English message entries.

Apply 16px local content-region spacing at the current `mt-q24` seams as well as keeping the 16px field-stack gap. Place login help links adjacent to the submit region and the helper strip after the links. Add the 342×104px reference strip with 12px padding; its 318px inner heading is right-aligned, 14px, «حفظٌ بخطوات واضحة». Show RTL sequence «تدرّب ← راجع ← ثبّت حفظك» with order/clock/check icons. Localize approved English wording. Preserve dynamic notification growth and existing auth requests, errors and password handling; this is a local refinement, not a global replacement of 24px tokens.

**Acceptance:** strip reflows without clipping; order is correct in RTL and LTR; links remain distinct keyboard targets; form validation, loading, error, wake-up and offline messages retain their current behavior.

#### FC-07 — Match Recovery-code content density

**Destination:** existing `RecoveryCodeScreen.tsx`, `RecoveryCodeSave.tsx`, and `RecoveryCodeBlock.tsx`.

Match the reference brand bar height of 56px, followed by a 24px separation before content with 24px content padding. Use 24px vertical and 16px inline padding for the code block; retain an 8px actions gap. Keep the approved 48px primary action and 44px checkbox target. The existing implementation uses `p-q16` on the code block and a 24px stack gap; adjust only after reviewing the reference and approved token rules. Preserve the current monospace font.

**Acceptance:** recovery code remains byte-exact, monospace and LTR-isolated; it is shown once; copy/download, confirmation, absent-code routing and leave guard continue to work; no persistence is introduced. S-04 remains in progress until the coordinator records the applicable review and status.

#### FC-08 — Apply density refinements to Recovery and Re-consent

**Destination:** current placeholder routes `/recovery` and `/consent`; implement their written, D78-approved screen specifications.

Use 24px region spacing, 16px form spacing and 12px consent action spacing as local layout refinements. Preserve approved terms/privacy/security text, consent recording and recovery requirements. Existing placeholder status is evidence only that these screens are not built; it is not evidence of a functional defect.

**Acceptance:** complete approved copy is present; Arabic/English layout, keyboard order and focus work; long text scrolls naturally; no fixed-height container hides content. Implement only after the screen's implementation gate is satisfied.

#### FC-09 — Build Placement with flexible source and answer layout

**Destination:** future placement screen; no placement route exists in the inspected app tree.

Use the 132px source-block reference with 24px padding. Arrange four answer options in two columns with 8px gaps, followed by the lower action area. Preserve normal scrolling, keyboard use, and approved source typefaces (Amiri/Amiri Quran as applicable). Do not use a fixed source height or change the approved placement contract.

**Acceptance:** source and all four options remain visible/reachable on small viewports and with larger text; columns reflow where necessary; all options are keyboard operable and clearly selected; source text is not clipped.

#### FC-10 — Clarify Today’s daily target hierarchy

**Destination:** current `/today` placeholder, future S-11 implementation.

Use 16px content-region spacing, separate the 20px semibold daily value from whole-plan mastery, and keep the primary session action above the mobile navigation. Figma's 7/10 and 70% are synthetic examples; production display must use authorized DTO values and keep daily completion distinct from whole-plan mastery.

**Acceptance:** daily progress and plan mastery have separate labels and values; no synthetic example is hardcoded as learner data; the primary action stays reachable with safe-area padding; the status is understandable in Arabic and English.

#### FC-11 — Preserve all Plan Overview sections in natural scroll

**Destination:** future Plan overview screen; no overview route exists in the inspected app tree.

Use 16px spacing between regions and retain every approved section and action. Let longer plans scroll naturally; do not remove content to match a single-frame screenshot or collapse required actions into an unapproved interaction.

**Acceptance:** all six approved plan sections, other-plan actions, revision and start-another-plan actions remain available as specified; long content scrolls; status and mastery wording follows approved contracts.

#### FC-12 — Build a four-game hub with distinct, labeled choices

**Destination:** current `/games` placeholder and future four game routes.

Show exactly the four approved game types with distinct icons, descriptions and consistent cards. Preserve approved order and choice behavior. The instruction «اختر الأجزاء بالترتيب الصحيح.» does not require drag-only input; retain keyboard-accessible alternative behavior from the screen specification.

**Acceptance:** no additional game type is introduced; each card has a text label and description; icon is supplemental; selection and launch work by keyboard and touch; order/choice interaction follows its approved screen contract.

#### FC-13 — Add a reusable explanatory learning-cycle cue

**Destination:** future four games and three feedback states; shared static component.

Use the 342×136px reference, 12px padding, 8px gaps, 14px heading/labels and 13px caption. Heading: «مسار الإتقان · خطوات عامة». Show RTL sequence: training and coverage → successful reviews on days 1/3/7 → confirmed mastery. Caption: «التدريب والمراجعة يساعدانك على تثبيت حفظك.»

This cue is explanatory only and does not show or award a current earned state. D66 and the contract govern exact confirmation: an initial streak of at least three consecutive correct answers, unassisted whole-passage coverage, and successful scheduled reviews on days 1, 3 and 7. Do not encode new mastery rules from the diagram.

**Acceptance:** all stages and caption appear in the correct direction and order, remain readable at narrow width, and are announced as explanatory content; no progress value changes because the cue is shown.

#### FC-14 — Strengthen Progress hierarchy without inventing metrics

**Destination:** current `/progress` placeholder, future S-21 implementation.

Strengthen the displayed values for both daily progress (70% reference) and whole-plan progress (20% reference), while keeping their labels and bars distinct. Those numbers are Figma examples only; use actual authorized response data. Do not add XP, leaderboards, certificates or new decorative achievement badges; preserve approved status chips.

**Acceptance:** daily and plan progress are separately labeled and sourced; display follows the progress contract and approved denominator/weighting decisions; no example number is hardcoded; the screen remains readable with assistive technology and in both directions.

## Figma reference inventory

Verified file: [Qatra • قطرة غيث — Draft Screen Prototype](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW). Page `4:2` is the main screen page; `4:3` contains states. Archive node `151:560` is excluded. Node links below identify reference frames; frame names are legacy numeric names and do not replace UI-screens IDs.

| Surface / spec ID | Figma node | Reference W×H | Backlog |
|---|---|---:|---|
| Login · S-01 | [125:750](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=125-750) | 390×844 | FC-06 |
| Recovery code · S-04 | [128:842](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=128-842) | 390×844 | FC-07 |
| Recovery · S-05 | [128:902](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=128-902) | 390×844 | FC-08 |
| Re-consent · S-06 | [128:973](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=128-973) | 390×844 | FC-08 |
| Placement · S-09 | [132:1044](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=132-1044) | 390×886 | FC-09 |
| Today · S-11 | [132:1099](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=132-1099) | 390×944 | FC-10 |
| Plan overview · S-12 | [137:1138](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=137-1138) | 390×1359 | FC-11 |
| Plan revision · S-13 | [137:1249](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=137-1249) | 390×844 | FC-05 |
| Session · S-19 | [6:87](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-87) | 390×844 | FC-02, FC-04 |
| Games hub · S-14 | [6:109](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-109) | 390×844 | FC-12 |
| Word order · S-15 | [6:136](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-136) | 390×844 | FC-12, FC-13 |
| Word choice · S-16 | [6:164](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-164) | 390×844 | FC-12, FC-13 |
| Similar words · S-17 | [6:189](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-189) | 390×844 | FC-12, FC-13 |
| Word recall · S-18 | [6:212](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-212) | 390×844 | FC-12, FC-13 |
| Progress · S-21 | [6:235](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-235) | 390×844 | FC-14 |
| Correct feedback · embedded state | [7:59](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=7-59) | 390×844 | FC-04, FC-13 |
| Needs-review feedback · embedded state | [7:70](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=7-70) | 390×844 | FC-04, FC-13 |
| Assisted feedback · embedded state | [7:78](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=7-78) | 390×844 | FC-04, FC-13 |
| Settings · S-22 | [6:263](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-263) | 390×844 | FC-03 |
| Source · S-25 | [6:318](https://www.figma.com/design/xkKTXYmXM41jGo7dGWxhKW?node-id=6-318) | 390×844 | FC-02 |

Figma's legacy numeric frame names are identifiers only; the table maps them to current spec IDs where known. Feedback frames are embedded states, not S-20. Useful component references: Login helper `200:8522`, revision steps `202:1668`, learning cue `203:2124`, settings scroll `197:1518`, action area `208:9482`.

The correct-feedback reference ends at y=272 and the Source reference begins at y=288, a 16px separation. This is a spacing reference only; it does not override the approved feedback/source layout or canonical source content.

## Shared implementation constraints

- Use approved blue `#1D78B5`, Cairo/Inter UI fonts, and approved Quran/Hadith source fonts. Keep logical CSS properties and existing spacing/size tokens; use local 16px refinements only where the approved design specifies them.
- The current recovery-code block uses the approved monospace system stack. Figma's Roboto Mono sample does not by itself authorize a font dependency.
- Keep Arabic RTL and English LTR, and preserve explicit `dir="ltr"` for recovery codes and other fixed-direction values. Follow UI-tokens directional back/forward/chevron/flow-arrow mirroring where specified; pause, clock, check and tab icons do not mirror.
- Preserve canonical source text exactly. Legacy Figma settings transparency text and «نموذج غير وظيفي» are mock annotations, not production copy. Use approved D60/D75 and UI-screens wording rather than stale prototype text.
- Approved contrast and status semantics outrank legacy blue-only feedback visuals. Correct is success; needs-review is warning, not error; assisted status must include its explanatory text/icon and must not claim independent recall.
- Do not hardcode frame widths, heights, safe-area totals or absolute y positions. Frames are 390px references; responsive behavior and tokenized layout govern implementation.

## Verification plan for later code work

No application tests or runtime visual checks were run for this documentation task. The evidence here is static source inspection and the supplied live-Figma frame/component inventory. Prior structural extraction reported 20 main frames, 353 editable text nodes, no missing fonts, no root-child overflow, and 30 original action nodes unchanged; this does not prove that app screens match visually or that their prototypes work. It is not accessibility or runtime verification.

When a code change is separately authorized, compare the implemented screen with its linked frame and run only checks appropriate to the changed behavior:

- Viewport widths: 320px, 390px, tablet and desktop; Arabic RTL and English LTR.
- Text and navigation: 200% text size, keyboard-only operation, visible focus, semantic names, current route indication, and safe-area handling.
- Interaction states: mobile keyboard where relevant, loading, validation, error, offline, dialogs, correct/needs-review/assisted feedback, and recovery-code absent/leave states as applicable.
- Content: exact canonical source text and approved Arabic/English wording; synthetic Figma examples must not become hardcoded production data.
- After behavior changes, run the focused unit and browser tests for that screen and record exact commands/results. A screenshot comparison supplements those checks; it does not replace them.

## Execution order and open items

1. Reconcile each visual refinement with D78-approved written UI content and resolve any mismatch before implementation.
2. Within the separately approved scope, complete shared P1 navigation/control and feedback work that supports the basic journey.
3. Review existing S-01 and S-04 code for only their assigned polish; preserve each screen's gate and record status accurately.
4. Continue the D82 basic journey and its required per-screen reviews and G2 pause; do not use this backlog to skip a screen pause or change delivery scope.
5. Schedule Games and Settings work when their screens and applicable gates are next. P1 polish impact does not make deferred business-scope screens eligible ahead of the core journey.

**Open review items:** owner review of the incremental polish scope and evidence; confirmation that each detail matches the relevant approved screen specification; coordinator determination of which future screen is next after required gates. No requirement question is invented or resolved by this handoff.

**Record:** documentation owner/source: user request to list code changes and define priority; implementation and publishing owner: root coordinator. After the authorized documentation synchronization, the next implementation-review step is to reconcile the assigned deltas with the approved screen specifications and define a scoped code task under the applicable gates. This file records no implementation, screen approval, deployment, or test result.
