# Qatra — UI design tokens and component specification

> Version 1.3 · 5 October 2026 (Asia/Dubai) · Status: Approved — D78 (owner, gate G1, 4 October 2026, about 19:12 Asia/Dubai); version 1.2 adds component 6.26 for the owner's S-08 adjustment (cascading select lists) and changes no token value; version 1.3 (D88) updates 6.26 and also changes no token value. Prepared by the Senior Product Designer role (Role 4); extends Design-system.md v10 without changing its approved identity; nothing here is implemented.

## 1. Authority and how to use

This file fixes the design system the frontend will implement and the Figma file will mirror (work package U3 of [Qatra-build-plan.md](Qatra-build-plan.md)). It specifies tokens and components, not screens (U1/U2), and contains no application code.

| Source | What it fixes | Status |
|---|---|---|
| [Design-system.md](Design-system.md) v10 | Identity (primary #1D78B5), ten colours, D35 contrast rule, D31, direction rule, D50 notice styling, 24 px phone margins, 8 px rhythm, 8–12 px radii, 44 px touch | Approved (1 and 3 Oct 2026) |
| D67 in [Decision-register.md](Decision-register.md), [UX.md](UX.md) «الإتاحة» | Device and browser matrix, 320 px floor, WCAG 2.2 AA, reduced motion, text plus icon for correction | Approved (4 Oct 2026) |
| D69, [Implementation-contract.md](Implementation-contract.md) §1, §9 | Self-hosted SIL OFL fonts, Uthmani-mark check, Playwright and axe baseline | Approved (D74) |
| This file | Everything else: scales, semantic colours, component states, motion, checklists | **Approved — D78 (G1)**; values marked proposed are approved with the file |

- A value absent from an approved document is **proposed**; a token name is always a proposal, even for an approved hex. No approved hex is changed; changing one reopens the contrast tables (2.3) and needs owner approval. Since D78 (G1) every value in this file, proposed or not, is approved as part of the design: the word marks where a value came from, and changing one later needs owner approval.
- Naming: CSS custom properties use `--q-`. The Figma variable is the CSS name without `--q-`, first hyphen after the group becoming `/` (`--q-color-text-secondary` is `color/text-secondary`, `--q-space-16` is `space/16`). Figma collections: Color (one mode, Light), Space, Size, Radius, Typography (modes Arabic UI, English UI), Motion.
- A row that lists several names and several values pairs them in order. Components read semantic tokens only; hex values live in the token file. Mapping into Tailwind is the frontend engineer's choice.
- Fixed Arabic copy is quoted verbatim from [UX.md](UX.md); every other label is a **proposed** placeholder, and English counterparts belong to the copy deck.
- Version 1.1 (4 October 2026) adds 6.18–6.25, the 480 px form column, the header language switch exception and the coordinator decisions in section 10, for the open points O-05, O-06 and O-22 of [UI-screens.md](UI-screens.md).
- Version 1.2 (4 October 2026, D78) adds 6.26, the cascading selection with a multi-select list, for the owner's adjustment at G1 on screen S-08 of [UI-screens.md](UI-screens.md); it adds no token and changes no value.
- Version 1.3 (5 October 2026, D88) updates 6.26 for the owner's S-08 amendment: juz' then surah for the Quran, groups of 10 with «تخصيص» for books; it adds no token and changes no value.
- No decoration: no patterns, 3D water effects, certificates, leaderboards, translation toggle or AI toggle (D49, D51).

## 2. Colour tokens

### 2.1 Approved palette and role aliases

| Token | Value | Role (Design-system.md v10) | Status |
|---|---|---|---|
| `--q-color-primary` | #1D78B5 | Logo, buttons, selections, indicators | approved |
| `--q-color-primary-deep` | #174F76 | App name | approved |
| `--q-color-text` | #183B52 | Main text | approved |
| `--q-color-text-secondary` | #536E82 | Secondary text, D50 notice | approved |
| `--q-color-text-accent` | #174F76 | Small blue text on #E6F4FD | approved |
| `--q-color-bg` | #F5FAFE | Page background | approved |
| `--q-color-surface` | #FFFFFF | Reading and input area | approved |
| `--q-color-selection` | #E6F4FD | Selection and hint background | approved |
| `--q-color-border` | #7890A3 | Field and outlined-button borders | approved |
| `--q-color-divider` | #D7E6F0 | Decorative separators only, never a functional border | approved |
| `--q-color-disabled` | #DFEAF2 | Inactive elements (outside the contrast rule) | approved |
| `--q-color-on-primary` | #FFFFFF | Label on primary and destructive fills | alias |
| `--q-color-border-selected` | #1D78B5 | Border of a selected item on #E6F4FD (D35) | alias |
| `--q-color-link` | #174F76 | Text links (underlined in running text) | alias |
| `--q-color-focus` | #174F76 | Focus ring | alias |

Aliases reuse approved values; their names and roles are **proposed**.

### 2.2 Proposed derived and semantic tokens

The approved palette has no success, error, warning or pressed colour. These are for status only, never the brand (no green or mint brand base), always with icon and phrase. Info reuses approved blues. Light theme only: dark mode is not approved (A1); set `color-scheme: light` on the root so native controls and scrollbars do not turn dark under an OS dark setting. Forced-colors mode must work: focus uses `outline`, state changes keep a transparent border.

| Token | Value | Use |
|---|---|---|
| `--q-color-primary-pressed` | #123F5E | Pressed primary button |
| `--q-color-success-text` | #14654E | Success text, confirmed badge |
| `--q-color-success-border` | #1F7A5C | Success icon and border |
| `--q-color-success-bg` | #E4F4EE | Success tint |
| `--q-color-error-text` | #A8322D | Error text, destructive button fill |
| `--q-color-error-border` | #C0362C | Error icon, input error border |
| `--q-color-error-bg` | #FDECEA | Error tint |
| `--q-color-error-pressed` | #8C241F | Destructive hover and pressed |
| `--q-color-warning-text` | #8A5300 | Warning text, needs-review text |
| `--q-color-warning-border` | #A15C00 | Warning icon and border |
| `--q-color-warning-bg` | #FFF4DB | Warning tint |
| `--q-color-info-text` | #174F76 | Alias of primary-deep |
| `--q-color-info-border` | #1D78B5 | Alias of primary (icon and border only) |
| `--q-color-info-bg` | #E6F4FD | Alias of selection |
| `--q-color-scrim` | rgba(24, 59, 82, 0.5) | Dialog backdrop |
| `--q-color-inverse-bg` | #183B52 | Toast surface (alias of text) |

### 2.3 Contrast results

Method: WCAG 2.x relative luminance (sRGB threshold 0.03928) and ratio (L1 + 0.05) / (L2 + 0.05), computed on 4 October 2026 with a script kept outside the repository. Pass or fail uses the unrounded ratio; values are shown to two decimals, as in Design-system.md.

**Table 1. Approved colours on the three backgrounds** (`pass`/`FAIL` against the stated threshold)

| Pairing | Needs | on #FFFFFF | on #F5FAFE | on #E6F4FD |
|---|---|---|---|---|
| Main text #183B52 | 4.5:1 | 11.76 pass | 11.19 pass | 10.48 pass |
| Secondary text #536E82 | 4.5:1 | 5.36 pass | 5.10 pass | 4.78 pass |
| Deep blue #174F76 as text | 4.5:1 | 8.69 pass | 8.27 pass | 7.75 pass |
| Primary #1D78B5 as text | 4.5:1 | 4.77 pass | 4.54 pass | 4.25 FAIL |
| Primary #1D78B5 as icon or border | 3:1 | 4.77 pass | 4.54 pass | 4.25 pass |
| Border #7890A3 as functional border | 3:1 | 3.32 pass | 3.16 pass | 2.96 FAIL |

**Table 2. Fills, graphics and decorative colours**

| Pairing | Ratio | Needs | Result |
|---|---|---|---|
| White label on primary #1D78B5 (button) | 4.77 | 4.5:1 | pass |
| White label on #174F76 (primary hover) | 8.69 | 4.5:1 | pass |
| White label on #123F5E (primary pressed, proposed) | 11.06 | 4.5:1 | pass |
| White label on #A8322D (destructive, proposed) | 6.65 | 4.5:1 | pass |
| White label on #8C241F (destructive pressed, proposed) | 8.80 | 4.5:1 | pass |
| Progress fill #1D78B5 on track #DFEAF2 | 3.90 | 3:1 | pass |
| Main text #183B52 on #DFEAF2 (new badge) | 9.62 | 4.5:1 | pass |
| White text on #183B52 (toast) | 11.76 | 4.5:1 | pass |
| Disabled label #536E82 on #DFEAF2 | 4.38 | 4.5:1 | FAIL (inactive controls are exempt from 1.4.3) |
| Divider #D7E6F0 on #FFFFFF | 1.28 | none | n/a (decorative) |
| Track #DFEAF2 on #FFFFFF | 1.22 | none | n/a (decorative) |

**Table 3. Proposed semantic tokens** (text needs 4.5:1; border and icon need 3:1)

| Token | Value | on #FFFFFF | on #F5FAFE | on #E6F4FD | on own tint | Needs |
|---|---|---|---|---|---|---|
| `--q-color-success-text` | #14654E | 7.00 pass | 6.66 pass | 6.24 pass | 6.16 pass | 4.5:1 |
| `--q-color-success-border` | #1F7A5C | 5.25 pass | 5.00 pass | 4.68 pass | 4.62 pass | 3:1 |
| `--q-color-error-text` | #A8322D | 6.65 pass | 6.33 pass | 5.93 pass | 5.81 pass | 4.5:1 |
| `--q-color-error-border` | #C0362C | 5.52 pass | 5.25 pass | 4.92 pass | 4.83 pass | 3:1 |
| `--q-color-warning-text` | #8A5300 | 6.33 pass | 6.02 pass | 5.64 pass | 5.79 pass | 4.5:1 |
| `--q-color-warning-border` | #A15C00 | 5.19 pass | 4.94 pass | 4.63 pass | 4.75 pass | 3:1 |

**Table 4. Focus ring #174F76** (needs 3:1 against every colour it can touch)

| surface | bg | selection | success-bg | error-bg | warning-bg | disabled |
|---|---|---|---|---|---|---|
| 8.69 pass | 8.27 pass | 7.75 pass | 7.65 pass | 7.60 pass | 7.95 pass | 7.11 pass |

Self-check: the script reproduces 8 of 8 ratios stated in Design-system.md v10 (5.10, 5.36, 4.78, 7.75, 3.16, 3.32, 4.25, 2.96).

Findings:

- #1D78B5 passes as small text only on #FFFFFF (4.77) and #F5FAFE (4.54, narrow margin) and fails on #E6F4FD (4.25, as approved): use #174F76 for small blue text and keep #1D78B5 for fills, icons, borders and large text. White on #1D78B5 is 4.77, so the primary button passes at 16 px / 600.
- #7890A3 passes 3:1 as a border on #FFFFFF and #F5FAFE and fails on #E6F4FD (2.96), so selected items use #1D78B5 (4.25). The disabled label (4.38) is below 4.5:1 but inactive controls are exempt (1.4.3) and it exceeds 3:1.
- Every proposed status text token passes 4.5:1 on all three backgrounds and its own tint, every border token passes 3:1, main text on any status tint is at least 10.28:1, and the focus ring passes 3:1 everywhere.

## 3. Typography

### 3.1 Families and packages

| Token | Stack | Use |
|---|---|---|
| `--q-font-ui-ar` | "Cairo", "Noto Sans Arabic", "Segoe UI", Tahoma, system-ui, sans-serif | Arabic UI (Cairo approved) |
| `--q-font-ui-en` | "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, "Cairo", sans-serif | English UI (Inter approved) |
| `--q-font-quran` | "Amiri Quran", "Amiri", "Noto Naskh Arabic", "Traditional Arabic", serif | Quran text (approved) |
| `--q-font-hadith` | "Amiri", "Noto Naskh Arabic", "Traditional Arabic", serif | Hadith text (approved) |
| `--q-font-mono` | ui-monospace, "SF Mono", Menlo, Consolas, monospace | Recovery code only (**proposed**) |

Packages (D69, SIL OFL-1.1, self-hosted from npm, no font CDN), version 5.3.0 on 4 October 2026: `@fontsource/cairo` 400, 600, 700 (Arabic about 14 KB per weight), `@fontsource/inter` 400, 600, 700 latin (about 24 KB), `@fontsource/amiri-quran` 400 only (about 46 KB), `@fontsource/amiri` 400 (about 109 KB). Import only the arabic and latin subset entry files (`arabic-400.css`, `latin-400.css`). Weights (**proposed**): 400 body, 600 labels and buttons, 700 titles.

### 3.2 Original-text rules

The original-text font never alters letters (contract §1). Rules are **proposed** unless stated.

- Coverage (cmap lookup in the Fontsource arabic-subset files, 4 October 2026): Amiri Quran and Amiri contain all six required marks, U+06E1, U+06E5, U+06E6, U+06E2, U+06ED and U+06DF; Cairo contains none. Cairo is therefore never used for original text and is absent from the religious stacks. This proves coverage only; shaping is checked by the screenshot test below.
- `dir="rtl" lang="ar"` always, also in the English UI (NFR-14). Show the stored NFC text exactly; never apply grading normalisation to display.
- `letter-spacing: 0`, `word-spacing: normal`, no `text-transform`, no justify (`text-align: start`), no shadow or stroke, `font-synthesis: none` (Amiri Quran has one weight), font features at defaults.
- Never truncate (no ellipsis, line clamp or fixed-height clipping; D03/D20/D25). Containers use `overflow: visible` with at least 8 px vertical padding so marks are not clipped, chips included.
- Test: Playwright screenshot of a synthetic string (a neutral letter carrying each of the six marks; no source text) at 360×780, 390×844 and 1280×800 in both UI languages, reviewed for missing or colliding marks.

### 3.3 Type scale

Each row defines `-size`, `-lh` (line height) and `-weight` (for example `--q-text-body-size`). Sizes are rem against the browser default 16 px; never fix the root size in px, so zoom works. Arabic line heights are larger because Cairo has tall ascenders and descenders; `-lh` resolves per UI language. Nothing is below 13 px.

| Token | px / rem | Line height ar / en | Weight | Use |
|---|---|---|---|---|
| `--q-text-display` | 28 / 1.75 | 1.35 / 1.25 | 700 | Welcome heading, large numerals |
| `--q-text-title` | 22 / 1.375 | 1.4 / 1.3 | 700 | H1 (large text: bold above 18.66 px) |
| `--q-text-section` | 18 / 1.125 | 1.5 / 1.4 | 600 | H2, dialog title (not large text; 4.5:1 applies) |
| `--q-text-body` | 16 / 1.0 | 1.7 / 1.5 | 400 | UI text and inputs (approved 15–16; 16 stops iOS input zoom) |
| `--q-text-body-compact` | 15 / 0.9375 | 1.65 / 1.5 | 400 | Dense rows, banners, labels |
| `--q-text-small` | 14 / 0.875 | 1.6 / 1.45 | 400 | Helper text, field errors, source line |
| `--q-text-caption` | 13 / 0.8125 | 1.5 / 1.4 | 600 | Tab and badge labels (minimum size) |
| `--q-text-button` | 16 / 1.0 | 1.25 / 1.25 | 600 | Buttons |
| `--q-text-quran` | 26 / 1.625; 28 from 768; 32 from 1280 | 2.2 | 400 | Quran text, `--q-font-quran` |
| `--q-text-hadith` | 24 / 1.5; 26 from 768; 28 from 1280 | 2.1 | 400 | Hadith text, `--q-font-hadith` |
| `--q-text-token` | 22 / 1.375; 24 from 768 | 1.9 | 400 | Original words in chips, tiles, recall input |

Religious text is larger than UI body with generous line height (approved direction); the three religious rows are **proposed**.

### 3.4 Numerals and font loading

- Numerals (decided, see section 10): the Arabic UI shows Arabic-Indic digits (٠–٩), matching the approved examples («٧/١٠ دقائق = ٧٠٪»); the English UI shows Western digits. One formatter serves both and must request the digit system explicitly (`ar-u-nu-arab`), since a bare `ar-AE` locale does not guarantee it. Username, password, recovery code and URLs always use Western digits, left to right; ayah and hadith numbers are shown as stored.
- Cairo and Inter: `font-display: swap`, preload the active language's 400 file.
- Amiri Quran and Amiri: `font-display: block`, preload the arabic file on routes that show original text; declare `@font-face` in our CSS pointing at the package files (Fontsource defaults to `swap`). Original text never renders in a fallback lacking the marks.
- Font files belong to the offline shell ([PWA-design.md](PWA-design.md)); no network font requests.

## 4. Spacing, sizing, shape, elevation

Space scale (multiples of 4, mostly 8): `--q-space-4`, `-8`, `-12`, `-16`, `-24`, `-32`, `-40`, `-48` (px). Use: 4 only for icon-to-text gaps inside a component; 8 base rhythm and minimum gap between adjacent targets; 16 card and row padding, phone gutter; 24 phone page margin (approved) and gap between regions; 32 tablet margin; 40 desktop margin. Regions are separated by space first, then a divider.

| Token | Value | Use |
|---|---|---|
| `--q-size-target` | 44 px | Minimum touch target, width and height (approved) |
| `--q-size-button`, `--q-size-input` | 48 px | Button and input height |
| `--q-size-input-recall`, `--q-size-tile`, `--q-size-row`, `--q-size-appbar` | 56 px | Recall input; option tile; list row; top bar (minimums) |
| `--q-size-tabbar`, `--q-size-rail` | 64 px, 240 px | Bottom bar (plus safe area); side rail |
| `--q-size-checkbox`, `--q-size-progress`, `--q-size-badge` | 24, 8, 28 px | Checkbox box (in a 44 px target); track; chip |
| `--q-size-form` | 480 px | Maximum width of a single-column form, centred; fluid below 560 px (1.1) |
| `--q-size-textarea-min`, `--q-size-textarea-max` | 96, 168 px | Text area minimum and auto-grow maximum (6.19, 1.1) |
| `--q-size-step-marker` | 24 px | Stage indicator marker (6.23, 1.1) |
| `--q-icon-sm`, `-md`, `-lg`, `-xl` | 16, 20, 24, 32 px | Inline; buttons and banners; default and navigation; empty state |
| `--q-border-width`, `--q-border-width-strong` | 1, 2 px | Default; selected, error, focus-within |
| `--q-radius-sm`, `--q-radius-md` | 8, 12 px | Buttons, inputs, chips, tiles, badges, track; cards, banners, dialogs, toast |
| `--q-radius-xs` | 4 px | Checkbox box only (**proposed** exception to the 8–12 px band) |
| `--q-shadow-raised` | 0 2px 8px rgba(24, 59, 82, 0.16) | Toast and dialog only; cards, bars and rows have no shadow |

Sizes other than target and the 8/12 px radii are **proposed**. Icons: simple line icons on a 24 px grid, 1.5 px stroke (2 px active or selected), `currentColor`, bundled locally; the icon set is left to the frontend plan. Z-order: sticky bars 10, toast 40, dialog 50, skip link 60. Content widths: reading column 640 px below 1024, 720 px from 1024; wide pages 960 px from 1280; forms use `--q-size-form`. Message bubbles are at most 85 % of the column (80 % from 768).

## 5. Breakpoints and layout grid (D67)

| Name | Width | Grid and margin | Navigation |
|---|---|---|---|
| floor | 320 px | Minimum, no horizontal scroll; 4 columns, 16 px gutter, 24 px margin | Bottom tab bar |
| phone | 360–430 px | Primary, portrait first (design at 390×844); as floor | Bottom tab bar |
| phone-large | 431–767 px | Single column, max 560 px, centred, 24 px margin | Bottom tab bar |
| tablet | 768–1023 px | 8 columns, 24 px gutter, 32 px margin, reading column 640 px | Bottom tab bar |
| rail | 1024 px and up | Rail 240 px plus 12 columns, 24 px gutter, 40 px margin | Side rail (accepted by the coordinator, section 10) |
| desktop | 1280 px and up | Content max 960 px, reading column 720 px | Side rail |

Breakpoint tokens (**proposed**): `--q-bp-tablet` 768, `--q-bp-rail` 1024, `--q-bp-desktop` 1280 px, in `min-width` queries only. The 24 px phone margin is kept at 320 px (272 px content) and every component fits it. Do not lock orientation or disable zoom; use `100dvh`, `viewport-fit=cover` and `env(safe-area-inset-*)` on bottom and sticky bars.

Direction rules:

- The language setting sets `<html lang dir>`: `ar`/`rtl` by default, `en`/`ltr` for English (D12, UX.md). Opposite-direction fragments (English terms, usernames, codes, URLs) sit in `<bdi>`.
- Logical properties only (`margin-inline`, `padding-inline`, `inset-inline-start`, `border-inline-start`, `text-align: start`); no `left`, `right` or `margin-left`. Do not reorder with `row-reverse` or `order`: DOM order equals visual order. Directional transforms flip for RTL.
- Progress fills from the start edge; the back control sits at and points to the start edge; forward and list-row chevrons point to the end edge (Design-system.md). Tab bar and rail follow DOM order «اليوم»، «الألعاب»، «التقدم»، «الإعدادات», so «اليوم» is at the right in RTL.
- Icons that mirror in RTL: back and forward arrows and chevrons, list-row chevron, undo and redo, send or share. Icons that do not: check, close, info, warning, error, search, copy, download, eye, clock, refresh, lock, lightbulb, external link, tab icons, droplet logo.

## 6. Components

All interactive components: focus ring per section 7, target at least 44×44 px with at least 8 px between neighbours, accessible name in the UI language, hover only inside `@media (hover: hover)`. "Disabled" means the action is impossible and the reason is visible nearby; a required-input error appears after submit and the submit button stays enabled, as UX.md requires for the consent box. A state not listed for a component does not apply to it (for example loading or success on a checkbox).

### 6.0 Shared state recipes

| State | Recipe |
|---|---|
| Default | fill surface, 1 px `--q-color-border`, text `--q-color-text` |
| Hover | fill selection |
| Focus-visible | focus ring (section 7) |
| Pressed | fill selection, border primary-deep |
| Selected | fill selection, 2 px border-selected, text-accent, check icon at the start edge (not colour alone) |
| Disabled | fill disabled, no border, text text-secondary |
| Error | 2 px error-border (inset), message below with icon in error-text, `aria-invalid` |
| Loading | skeleton (6.14); spinner at the start edge with `aria-busy` on buttons |

### 6.1 Buttons

Height 48 px, minimum width 88 px, padding-inline 24 px, radius sm, `--q-text-button`; the primary form action is full width on phone. Icon button 44×44 px, 24 px icon, always an `aria-label`. States: default, hover, focus-visible, active, disabled, loading; error and success are shown by the field, banner or feedback block.

| State | Primary | Secondary (outline) | Tertiary (text) | Destructive | Icon button |
|---|---|---|---|---|---|
| Default | fill primary, on-primary label | fill surface, 1 px border, primary-deep label | no fill, primary-deep label | fill error-text, on-primary label | no fill, text-secondary icon |
| Hover | fill primary-deep | fill selection, border-selected | fill selection | fill error-pressed | fill selection, primary-deep icon |
| Active | fill primary-pressed | fill selection, primary-deep border | fill selection | fill error-pressed | fill selection |
| Disabled | fill disabled, text-secondary label | same | text-secondary label | same | border-colour icon |
| Loading | label kept (e.g. «جارٍ…»), spinner at start, width fixed, clicks ignored | same | same | same | spinner replaces icon |

Destructive is only for account deletion; replacing the active plan is a consequential primary action. Text buttons in running text are links (underlined, `--q-color-link`).

### 6.2 Text inputs

Visible label above (never placeholder-only), field, helper text, error message with icon. Height 48 px, padding-inline 16 px, radius sm, `--q-text-body`, placeholder text-secondary, `aria-describedby` for helper and error. States: default, hover (border text-secondary), focus-visible (border primary-deep plus ring), filled, error, disabled. Loading and success are not used: uniqueness is answered at submit (`username_taken`) and correctness appears in the feedback block (6.17).

- Username: `dir="auto"` (Arabic or English letters, digits, underscore; 3–24), `autocomplete="username"`, `autocapitalize="none"`, `autocorrect="off"`, `spellcheck="false"`.
- Password and confirm: `dir="auto"`, `autocomplete` `current-password` or `new-password`, helper text states the 15-character minimum; show or hide icon button at the end edge inside the field (44×44, `aria-pressed`, «إظهار كلمة المرور» / «إخفاء كلمة المرور», **proposed**); the confirm field has its own label and mismatch error. Paste and password managers are never blocked (3.3.8).
- Recovery-code entry: `dir="ltr"`, `--q-font-mono`, accepts pasted text with or without `-`.
- Recall input (single word): 56 px high, `--q-text-token` in the original font, `dir="rtl" lang="ar"`, `inputmode="text"`, `autocomplete="off"`, `autocorrect="off"`, `autocapitalize="off"`, `spellcheck="false"` so the keyboard offers no completions. A page cannot switch keyboard layout, so a short instruction «اكتب الكلمة بالعربية» (**proposed**) is shown; vowel marks are not required (grading normalises, contract §2.5); more than one word shows «اكتب كلمة واحدة» (**proposed**).

### 6.3 Checkbox (mandatory consent box, D52)

Box 24×24 px (radius xs, 2 px border) in a row at least 44 px high; the label is part of the target. Label, verbatim: «قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها». The links «شروط الاستخدام» and «بيان الخصوصية» each get their own 44 px line below (inline links cannot reach 44 px). Always unchecked when first shown. States: default, hover, focus-visible (ring around the row), checked (fill primary, white check, `aria-checked`), disabled, error. Error (submitted unchecked): recipe Error at the field, focus moved there, no account created. The same pattern serves «حفظت الرمز» in 6.15 (**proposed** label).

### 6.4 Radio group and segmented control

For session minutes (5, 10, 15), plan order («ترتيب الكتاب» default, «من الناس رجوعًا»; Quran edition only, D72) and the optional self-rating («لم أحفظ» / «بعضه» / «أغلبه»). Native radios in `role="radiogroup"` with a visible group label; equal-width segments at least 44 px high and 88 px wide (three fit in 272 px; longer labels stack). States by recipe: default, hover, focus-visible, selected, disabled, error (group message below). Arrow keys move the selection in the logical direction (Left is next in RTL); test both directions.

Header language switch (exception, 1.1): two segments «العربية» and «EN» in a `radiogroup`, each at least 44×44 px instead of 88 px wide, so the switch fits beside the back control and the app name at 320 px; every other rule and state is as above. Each label carries its own `lang`; switching flips `lang` and `dir`, keeps the values entered and leaves focus on the switch.

### 6.5 Single-choice list and select (category, book, edition)

Up to 5 options (the challenge sample) are a vertical list of radio rows, 56 px high, states by recipe; six or more use a native `<select>` styled as 6.2 (native pickers, RTL and screen-reader support). A category without material stays visible as a disabled row with visible text saying so (UX.md; copy owned by U1). Loading shows skeleton rows; errors show a message below.

### 6.6 Navigation: tab bar, side rail, top app bar

Tab bar (below 1024 px): fixed bottom, 64 px plus `env(safe-area-inset-bottom)`, fill surface, 1 px divider on its top edge, four equal items (target at least 44 px, 80 px wide at 320 px): «اليوم»، «الألعاب»، «التقدم»، «الإعدادات» (English **proposed**: Today, Games, Progress, Settings), 24 px icon above a `--q-text-caption` label. Item states: default (icon stroke 1.5, label text-secondary), hover (fill selection), focus-visible (ring inside the item, negative offset), active (icon stroke 2, icon and label primary-deep, 3 px top indicator in primary, `aria-current="page"`); never disabled, the missing-plan state is explained inside the screen.

Side rail (1024 px and up): same items and labelled `nav`, vertical, 240 px at the start edge, 48 px items, app name and droplet mark on top, active item fill selection with a 3 px indicator at the start edge. Top app bar: 56 px plus top safe area in standalone mode, fill bg, no shadow, a 1 px divider when content scrolls; back control (icon button) at the start edge pointing to it; title `--q-text-title` start-aligned, wrapping to two lines rather than clipping; actions at the end edge.

### 6.7 Card and list row

Card (sparingly): fill surface on bg, 1 px divider border (decorative, not a control), radius md, padding 16 px, no shadow, no whole-card links. List row (settings): at least 56 px, padding-inline 16 px, label at the start, value or status in text-secondary and a chevron at the end edge (mirrors in RTL), 1 px divider between rows. Row states: default, hover (selection), focus-visible (ring, offset -2 px so it is not clipped), active (selection, primary-deep label), disabled (text-secondary, no chevron), loading (skeleton row).

### 6.8 Banner and toast

Banner: icon 20 px at the start edge, optional title (`--q-text-section`), message (`--q-text-body-compact`), optional action button, optional dismiss icon button; tint fill, 1 px border, radius md, padding 16 px; inline at the top of the content region, never an overlay; at most one error banner per screen.

| Variant | Icon | Text | Icon and border | Fill | Live region | Dismiss |
|---|---|---|---|---|---|---|
| Info | info | info-text | info-border | info-bg | `role="status"` | Yes (not for fixed transparency lines) |
| Success | check-circle | success-text | success-border | success-bg | `role="status"` | Yes, no auto-hide |
| Warning | alert-triangle | warning-text | warning-border | warning-bg | `role="status"` | Yes when non-blocking |
| Error | alert-circle | error-text | error-border | error-bg | `role="alert"` | Not while blocking |
| Notice (D50, D53, D51) | info | text-secondary | text-secondary icon | none | none | Never |

Meaning is carried by icon and phrase, never colour alone. Submit errors go to a banner or an error summary with links to the fields, and focus moves to the first invalid field. Messages never echo submitted values and come from the copy deck keyed on `error.code`, not from the API `message`.

Toast: neutral inverse surface (`--q-color-inverse-bg`, white text), radius md, `--q-shadow-raised`, icon plus short text, one at a time, 16 px above the tab bar and safe area, `role="status"`, `aria-live="polite"`, `aria-atomic="true"`; for brief confirmations such as «تم النسخ» (**proposed**). Auto-dismiss after 6 s (**proposed**), paused on hover or focus; a toast with an action or an error never auto-dismisses; Escape closes; it never carries the only copy of important information.

Error codes a banner or field must express ([API-spec.md](API-spec.md) §1.5; clients branch on `error.code`, not status). Presentations are **proposed**.

| Code | Presentation |
|---|---|
| `terms_required` | Field error at the consent box |
| `unauthenticated` | Warning banner on login: the session ended; local queue kept (D59) |
| `invalid_credentials` | Error banner above the submit button, generic wording, no field named |
| `forbidden_origin`, `internal`, `payload_too_large` | Error banner, generic, with retry |
| `forbidden` | Error banner; actions not allowed for the account type are hidden or disabled with a reason |
| `not_found` | Not-found empty state (6.14) |
| `username_taken` | Field error at the username |
| `version_conflict` | Warning banner with refresh; wording by `details.reason` (`plan_version`, `idempotency_input`, `plan_not_active`, `estimate_changed`, `active_plan_conflict`) |
| `validation_error` | Field errors from `details.fields`, plus an error summary when two or more |
| `throttled` | Warning banner with static wording from `details.retryAfterSec`, no ticking countdown |
| `unavailable` | Warning banner with retry; local plan stays usable |
| Gateway, timeout, offline (outside the envelope) | Wake-up status (6.13) or an info banner for offline; never an error tone |

### 6.9 Dialog

Native `<dialog>` with `showModal()` (focus containment, inert background), `aria-labelledby`, `aria-describedby`; destructive confirmations use `role="alertdialog"`. Fill surface, radius md, padding 24 px, `--q-shadow-raised`, `--q-color-scrim` backdrop, width up to 400 px and at most viewport minus 48 px, internal scroll above `100dvh` minus 48 px, title `--q-text-section`. Buttons stack on phone (primary first, full width) and form a row from 768 px with the primary at the start edge. Escape cancels; backdrop click closes only non-destructive dialogs; focus returns to the opener; page scroll locks. States: open, submitting (primary loading, others inert), error (banner inside the dialog, which stays open). Initial focus is Cancel in all three variants.

| Variant | Content |
|---|---|
| Logout | What happens; a line with the unsynced-event count when any (UX.md); confirm «تسجيل الخروج» (**proposed**) and cancel; skipped when nothing is unsynced (**proposed**) |
| Delete account | Permanent-deletion statement, current-password field, checkbox acknowledging permanence (the client sends `confirm: "DELETE"` itself, so no Latin word is typed on an Arabic keyboard; **proposed**, A5), destructive button, cancel |
| Replace active plan | What changes (previous plan paused, history kept), primary confirm, cancel |

### 6.10 Progress: daily bar and overall indicator

Label at the start edge, value at the end edge, track below: 8 px, fill `--q-color-disabled`, radius sm; fill `--q-color-primary` growing from `inset-inline-start: 0`, capped at 100 %. `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow` capped at 100, `aria-valuetext` in words; the value is always also visible as text. States: default, zero (empty track), complete (daily), loading (skeleton), offline (local value plus the sync chip).

| Variant | Label (verbatim) | Value | Rules |
|---|---|---|---|
| Daily | «الإنجاز اليومي» | Active minutes against the goal and percent, e.g. «٧/١٠ دقائق»، «٧٠٪» | Time-based (D40): elapsed time rising to the goal, never remaining time or a ticking countdown; updates when an event is recorded, not every second; at 100 % a check icon and a completion phrase (copy deck), staying at 100 % |
| Overall | «الإنجاز الكلي للخطة» | `floor(100 × confirmed words ÷ total words)` as an integer percent (D66) | Word-weighted over the active plan scope; passages awaiting review are not counted; separate counts below as chips (6.11) and «موعد المراجعة التالي» |

### 6.11 Status chip and mastery badge

Non-interactive chip: 28 px high, padding-inline 12 px, radius sm, 16 px icon at the start edge plus `--q-text-caption` label; always icon plus label; an interactive chip grows to a 44 px target. Mastery values follow D66 (shown separately: confirmed, in progress, needs refresh, next review date); Arabic labels for confirmed, in progress and needs refresh follow D66 wording («المؤكدة»، «قيد التقدم»، «يحتاج تحديثًا») in the singular form a badge needs; the rest are **proposed**.

| `status` | Label ar / en | Icon | Text and icon | Fill |
|---|---|---|---|---|
| `new` | «جديد» / New | circle outline | text | disabled |
| `learning` | «قيد التعلم» / Learning | circle half | text-accent | selection |
| `reviewing` | «قيد التقدم» / In progress | clock | text-accent | selection |
| `confirmed` | «مؤكد» / Confirmed | check-circle | success-text | success-bg |
| `needs_refresh` | «يحتاج تحديثًا» / Needs refresh | refresh | warning-text | warning-bg |

The sync indicator uses the same chip: «متزامن» (check-circle, success tokens), «محفوظ على الجهاز، بانتظار المزامنة» (clock, info tokens), failed save (alert-triangle, warning tokens), in a polite `role="status"` region that announces changes debounced.

### 6.12 Original-text block, source line and notices

Original-text block: fill surface (reading area), padding 16–24 px, radius md, font and size from 3.3, `--q-color-text`, `dir="rtl" lang="ar"`. States: visible; hidden (practice mode: removed from the DOM and accessibility tree, not just blurred); loading (skeleton lines); error (banner above; text never partly shown).

Source line: `--q-text-small`, text-secondary, parts separated by « · » in `<bdi>`: book, edition, reference (surah and ayah, or hadith number), then the printed page number for printed editions or, for the electronic editions (D68), the canonical URL as a text link with an external-link icon (`rel="noopener noreferrer"`, new tab announced). HadeethEnc `Narrator` and `Grade` appear as labelled values tagged as taken from that record («من سجل HadeethEnc», **proposed**).

Notices (variant Notice in 6.8): `--q-text-small`, text-secondary, info icon at the start edge, no fill, never dismissible. Fixed copy:

- D50/D53, beside a hadith whose edition gives no Sahihayn attribution and no grade: «تنبيه: نُقل هذا النص حرفيًا عن الكتاب، ولم يُتحقق من صحة الحديث.»
- Sources and edition data: «يعرض التطبيق الكتاب كما هو في نسخته الموثقة للحفظ، دون إضافة أو شرح.»
- AI transparency (goal and settings; no switch or checkbox, D51): «تُبنى خطتك أثناء التحدي بمحرك قواعد داخل التطبيق دون إرسال بياناتك إلى نموذج خارجي؛ وكيل التعليم يعمل في حساب العرض على حالات اصطناعية.»

The slogan «قليلٌ دائم» is plain text with no attribution (D50).

### 6.13 Free-server wake-up status

Fixed copy: «جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.» Info-variant banner with a loader icon, `role="status"`, non-error tone, not dismissible. It appears within one second of the first slow or failed request; the client polls `/api/health` with 1, 2, 4, 8 s back-off capped at 10 s for up to 90 s (NFR-02), then a secondary button «إعادة المحاولة» (**proposed**) is added and the message stays. No elapsed-time counter and no animation promising a finish time; under reduced motion the loader is a static icon. The local plan snapshot stays usable (D46, D48). The hint «افتح في المتصفح» appears only in in-app browsers (D67).

### 6.14 Skeleton, loading and empty state

Skeleton: `--q-color-disabled` blocks, radius sm, the height of the content they stand for, no shimmer under reduced motion; region `aria-busy="true"`, children `aria-hidden`, plus visually hidden loading text; shown only after 300 ms (**proposed**). Empty state: 32 px line icon, title `--q-text-section`, one body sentence, at most one button, no illustration. Variants: no active plan, plan not downloaded for offline use, category without material, not found. Copy is owned by U1.

### 6.15 Recovery-code display block

Shown once after registration or regeneration (UX.md). Block: fill surface, 1 px border, radius md, padding 16 px, `dir="ltr"`, `--q-font-mono` 20 px, line height 1.8; 32 hex characters in eight groups of four separated by `-`, as two lines of four groups (about 230 px, fits 272 px); selectable (`user-select: all`); accessible name for the code plus a "shown once" explanation. Secondary buttons of at least 44 px: «نسخ» (clipboard; confirmed by toast and live region) and «تنزيل» (small text file); labels **proposed**. A confirm-saved checkbox (6.3) is required before continuing; continuing without it shows the field error instead of a disabled button. States: default, copied, downloaded, copy unavailable (instruction to select and copy by hand), unconfirmed error. The code is never logged and never shown again.

### 6.16 Game pieces

Four games only (D31, D64): word order, word choice, word recall, similar-passage distinction. Screen layout and the submit model belong to the screen specifications. Original text in every piece uses the original font at `--q-text-token`.

Token chip (word order): a button, at least 44 px high and wide, padding-inline 16 px, radius sm, `overflow: visible`. The answer line is an ordered list with `dir="rtl"` filling from the right. Tapping a pool chip places it, tapping a placed chip removes it, an undo icon button removes the last one. Dragging is not specified (UX.md: tap with remove or undo); if added, the tap path must remain (2.5.7). States: in pool (recipe Default), hover, focus-visible, pressed; placed (recipe Selected; accessible name gives the word, its position and that activating removes it); used (fill disabled, `aria-disabled`, slot kept so layout does not move); placed by hint (as placed plus a lock icon, not removable, marked assisted).

Option tile (word choice, similar distinction): `role="radiogroup"` of radio tiles, at least 56 px high; single words in two columns when each tile is at least 128 px wide, segments of two to four words stacked; two options for similar distinction. One tab stop per group; arrows move (logical direction in RTL), Home and End jump, Space selects. States by recipe (default, hover, focus-visible, selected, disabled) plus, after checking:

| State | Tile |
|---|---|
| Correct | success-bg, success-border, check-circle icon and a phrase |
| Wrong choice | warning-bg, warning-border, icon and a phrase marking a memorisation error (D31: never colour alone), shown with the original and its reference |
| Removed by hint | taken out of the layout and announced politely |

Hint control: tertiary button with a lightbulb icon («تلميح», **proposed**), one use per question. Hints are fixed by the contract (§2.4): recall reveals the first letter, choice and similar distinction remove one wrong option, order places the first token. After use the control is disabled and an «بمساعدة» marker (**proposed**, info chip) stays on the question: the answer is assisted and is not independent recall evidence (D64).

### 6.17 Question-feedback block

Appears after an answer as a polite `role="status"` region without moving focus; the next-step button follows it. Icon, phrase (`--q-text-section`), then for needs-review the correct original (6.12 style) and its source line.

| State | Tokens |
|---|---|
| Correct | success tokens, check-circle, phrase from the copy deck |
| Needs review | warning tokens, a gentle phrase with a refresh or book icon, never an error tone (UX.md: shown gently), the correct original and its reference |
| Skipped | info tokens, original and reference shown |

Original text inside the block is `--q-color-text` on the tint (at least 10.28:1). Correctness is never colour alone.

### 6.18 Message bubble (plan conversation)

Added in 1.1 for [UI-screens.md](UI-screens.md) S-34. Anatomy: author label (icon and name, `--q-text-caption`, text-secondary), then the bubble; body `--q-text-body`, padding 12 px 16 px, radius md. Assistant bubbles sit at the start edge, learner bubbles at the end edge (logical, so they mirror in LTR); at most 85 % of the column (80 % from 768 px); the plan card (6.21) is full width. The thread is `role="log"`; a new assistant message is announced politely. Bubbles are not interactive (no hover, active or disabled states); the script may focus one (`tabindex="-1"`) and then the focus ring applies. Never shown: timestamps, avatars, typing animation, reactions, an assistant switch, a model name.

| Variant (`kind`) | Fill and border | Icon | Notes |
|---|---|---|---|
| Learner message | fill selection, no border | none | `dir="auto"`; a quick reply shows its label |
| Assistant text | fill surface, 1 px divider, text `--q-color-text` | none | Server text as received |
| `refusal` | as assistant text | info, `--q-color-info-border`, start edge | Fixed copy from UI-screens c9; neutral, never an error tone |
| `redirect` | as assistant text | info | Fixed copy (UI-screens c10) |
| `fallback` | as assistant text | info | Calm message once per conversation (UI-screens c11); never an error and never a banner |

| State | Appearance |
|---|---|
| Sending | the learner bubble shows at once; below it a status line (loader icon, `role="status"`) in text-secondary; the loader is a static icon under reduced motion |
| Send failed | the learner bubble stays; below it an error line (alert-circle, error-text) and a tertiary retry button of at least 44 px; the text is kept |
| Loading, success | not used |

Contrast: `--q-color-text` on surface 11.76 and on selection 10.48; error-text on page and surface at least 5.93 (Table 3).

### 6.19 Text area with counter

Added in 1.1 (UI-screens S-08 goal box, S-34 composer). Extends 6.2: visible label above, field, then one line with the helper at the start edge and the counter at the end edge. Field: minimum height 96 px (`--q-size-textarea-min`), grows with its content up to 168 px (`--q-size-textarea-max`) and then scrolls inside; the composer variant starts at one line (48 px) and may grow to the same maximum. Padding 12 px 16 px, radius sm, `--q-text-body`, `dir="auto"`, `autocomplete="off"`; no `maxlength` (pasting is never blocked and text is never truncated). Counter `{n}/500` in `<bdi>`, `--q-text-small`, tabular figures, digits per 3.4; limit 500 characters, counted as the server counts. The counter and helper are in `aria-describedby`; the counter itself is not a live region. A hidden polite region announces only at 450 and at 500.

| State | Appearance |
|---|---|
| Default, hover, focus-visible, filled | as 6.2; counter text-secondary |
| Near the limit (450 to 500) | counter in warning-text with an alert-triangle icon (6.33 on surface, 6.02 on page); field unchanged |
| Over the limit (above 500) | recipe Error on the field; counter in error-text with an alert-circle icon; an error message states the limit; nothing is cut |
| Disabled (demo accounts) | fill disabled, text-secondary, `aria-disabled` and still in tab order, with a Notice under the label stating why |
| Sending (composer) | field kept, send button `aria-disabled` and Loading |

Send button (composer): icon button 44×44 px at the end edge inside the composer, send arrow that mirrors in RTL, `aria-label` in the UI language (**proposed** «إرسال»). The restore action («استعادة الجملة المقترحة», UI-screens) is a tertiary button of at least 44 px under the field, shown only after a manual edit.

### 6.20 Quick-reply chip row

Added in 1.1 (UI-screens c12). Interactive chips: the 6.11 chip grown to a 44 px target (minimum 44 px high and wide), padding-inline 16 px, radius sm, label `--q-text-body-compact` weight 600; the label wraps to two lines rather than being cut. The row wraps with 8 px gaps in both directions and sits in a `role="group"` named by the screen (UI-screens c12 «اختصارات التعديل»). Chips are shown exactly as received and in the received order. **One tab stop** (roving tabindex): arrow keys move along DOM order in the logical direction (Left is next in RTL), Home and End jump, Enter or Space activates. A chip is an action, not a toggle, so it has no selected state.

| State | Chip |
|---|---|
| Default | recipe Default |
| Hover, pressed | recipes Hover and Pressed |
| Focus-visible | focus ring around the chip (offset 2 px, not clipped by the row) |
| Disabled (assistant replying, demo limits) | fill disabled, text-secondary, `aria-disabled` and still reachable by arrows |
| Loading, error, success | not used; the reply and its failure appear in the thread (6.18) |

### 6.21 Plan card with six labelled sections

Added in 1.1 (UI-screens P-13, S-11, S-12, S-13, S-34). It is the 6.7 card (fill surface, 1 px divider, radius md, padding 16 px, no shadow). Anatomy: a header row with the proposal label («الاقتراح {n}») and a status chip, then six pairs, always in this order with these exact labels: «الهدف الكلي»، «الزمن الكلي»، «الزمن اليومي»، «المراحل»، «المراجعات»، «الخطوة التالية». Pair label `--q-text-section`, text `--q-text-body-compact`, `--q-space-12` between pairs, dates and numbers printed as received in the digits of 3.4 (durations such as «٩:٠٠» in `<bdi dir="ltr">`). Hosts: in the conversation one `dl` (`dt` label, `dd` text, `dd` margin-inline-start 0); on the plan screens a `section` with an `h2` per pair. A screen may omit a pair (S-11 has no «الزمن الكلي») but never reorders or renames. No percentage, remaining time or celebration is shown.

| State | Card |
|---|---|
| Current | chip «الحالي» (status chip, text-accent on selection) |
| Earlier | collapsed disclosure (6.25), chip «سابق» (text on disabled), no actions |
| Loading | six skeleton pairs after 300 ms (6.14), `aria-busy` |
| Stale | the card is replaced by the newer one; a Warning banner (6.8) outside the card says so |
| Hover, active, disabled, error | not used (the card is not a control; errors appear in banners) |

### 6.22 Bottom-sheet presentation of the dialog

Added in 1.1 (UI-screens P-12, leave and pause sheets). The 6.9 `<dialog>` below 768 px: docked to the bottom edge, full viewport width, margin 0, top corners `--q-radius-md` and square bottom corners, fill surface, padding 24 px with `env(safe-area-inset-bottom)` added below, maximum height `100dvh` minus 48 px with internal scroll, `--q-shadow-raised`, `--q-color-scrim` backdrop. From 768 px it is the centred dialog of 6.9 (up to 400 px). No drag handle and no swipe is required; if a swipe-to-dismiss is added later, the buttons remain (2.5.7). Buttons stack, full width, primary first.

| Rule | Leave or pause sheet |
|---|---|
| Initial focus and Escape | the safe action («continue» or «cancel»), which is the primary button on top; leaving is the secondary button, not destructive in style |
| Backdrop click | acts as the safe action (it loses nothing) |
| Focus on close | returns to the opener |
| Motion | slides up over `--q-duration-slow` with `--q-ease-standard`; instant under reduced motion |

States: closed, open, submitting (the leaving action in Loading, the rest inert), error (banner inside the sheet, which stays open).

### 6.23 Steps progress variants

Added in 1.1 (UI-screens S-09, S-19). Both are progress of steps, never time, and are never mixed with the daily indicator (6.10); no countdown and no percent figure.

Question count («السؤال {k} من {n}»): the 6.10 track (8 px, fill disabled, radius sm) with the fill in primary growing from the start edge, equal to answered questions divided by n (so the last question shows (n−1)/n and the done step shows full; **proposed**). `role="progressbar"`, `aria-valuemin="0"`, `aria-valuemax` n, `aria-valuenow` answered, `aria-valuetext` the visible text, which is always shown above the track in `--q-text-small`. Fill changes over `--q-duration-slow`, instant under reduced motion.

Stage indicator (session: «مراجعة»، «جديد»، «اختبار»; the drills belong to «جديد», so there are three stages, not four): a non-interactive `ol` of equal items, each a 24 px marker with a `--q-text-caption` label beneath, joined by 2 px connectors; it renders the stages the screen passes (two or three). Never focusable.

| State | Marker and label |
|---|---|
| Done | fill primary with a white check icon (4.77), label text, connector primary; hidden text «مكتملة» (**proposed**) |
| Current | `aria-current="step"`, fill selection, 2 px border-selected, step number in text-accent, label primary-deep weight 600 |
| Upcoming | fill surface, 1 px border (3.16 on page), step number in text-secondary, label text-secondary, connector divider |

### 6.24 Passage highlight in the original-text block

Added in 1.1 (UI-screens S-19 learn step). Inside the 6.12 block the whole unit is shown and the range of today's passage is wrapped in `<mark>`: background `--q-color-selection`, text colour unchanged (`--q-color-text`, 10.48 on selection), no bold, underline, padding or border that could move or cover letters or marks, `box-decoration-break: clone`. Line height stays at the religious-text value so the fill is continuous. Because the fill is only 1.12:1 against the reading surface, the highlight is never the only cue: a legend line («المظلل هو مقطع اليوم.», `--q-text-small`, text-secondary) sits with the block, and the screen spec names the passage by its reference. Assistive-technology exposure of `<mark>` varies, so it is checked manually with screen readers.

| State | Appearance |
|---|---|
| No highlight | block as 6.12, no legend |
| Highlighted | the range filled, legend shown |
| Hidden (practice mode) | the whole block, highlight included, removed from the DOM and accessibility tree |
| Loading, error | as 6.12 |

### 6.25 Disclosure row (accordion)

Added in 1.1 (UI-screens S-07 section lists, S-34 earlier proposals). Native `<details>` and `<summary>`; the summary is the 6.7 list row: at least 56 px, padding-inline 16 px, label at the start edge in `--q-text-body` with its count in the label («الأقسام (٣٧)»), the chevron at the end edge, 1 px divider between rows. The chevron is vertical (down when closed, up when open) and does not mirror in RTL. Enter or Space toggles; the expanded state is the native one. Content rows inside are text and are not focusable. No height animation (instant), the open state is not remembered between visits.

| State | Summary row |
|---|---|
| Default | fill surface |
| Hover | fill selection |
| Focus-visible | focus ring inset (offset -2 px) |
| Active | fill selection, label primary-deep |
| Expanded | chevron up, content shown below with the same divider rule |
| Loading | skeleton row (6.14) |
| Disabled, error, success | not used |

### 6.26 Cascading selection with a multi-select list

Added in 1.2 (D78, the owner's adjustment at G1; updated in 1.3 by D88) for [UI-screens.md](UI-screens.md) S-08. It composes components that already exist into a cascade of labelled groups and adds one new part, the multi-select list. A level appears only after the level above it is chosen, in the page flow (not a wizard, no step button); a level with one option is preselected and still shown; choosing a higher level clears the levels below it.

| Level | Component | Content |
|---|---|---|
| 1 | single-choice list (6.5): radio rows up to five options, a native `<select>` from six | the categories of the catalog (E14 `category`): «القرآن الكريم» and «الحديث» in this build, later «الفقه» and others with no design change |
| 2, Quran | single-choice list (6.5) of the edition's juz' | «الجزء ٣٠» only in this build, preselected and shown (only when the category is the Quran, `contentFormat` quran) |
| 2, hadith and every other category | single-choice list (6.5), one row per edition: title and author, the edition label as a second line | the books of the category (the Forty alone in this build) |
| 3 | multi-select list (below), with its tools and its chips | the surahs of the chosen juz', or a book's sections; shown as groups of 10 consecutive sections when the book has more than 10 sections (D88) |

**Group semantics.** Each level is its own labelled group: levels 1 and 2 are a `radiogroup` (or a native select with a visible label) and level 3 is a `<fieldset>` with a visible `<legend>` that names the noun («السور»، «الأحاديث»، «الأقسام»). Legends and labels are never placeholders, and the visible text is the accessible name (2.5.3).

**Multi-select list anatomy.** Inside the fieldset, in this DOM and visual order: the tools row, the chips row (only when it applies), then the rows.

- *Tools row.* The count line at the start edge (`--q-text-small`, text-secondary) and two tertiary buttons (6.1; at least 44 px high and 88 px wide, 8 px apart) «تحديد الكل» and «مسح الاختيار»; the buttons wrap under the count on a narrow screen. Count line: «لم تختر شيئًا بعد» (nothing checked), «تم اختيار {n} من {m}» (some), «تم اختيار الكل ({m})» (all), digits per 3.4. The count is always of sections, the units of the plan's scope, also when the rows are groups. The count line is part of the fieldset's `aria-describedby` and is not a live region itself; one hidden polite region announces the same text, debounced by 500 ms, so a select-all is announced once and not once per row.
- *Chips row.* Removable chips (below) while 1 to 6 rows of the list on screen are checked (a row is a surah, a hadith, a section or a group; a fully checked group counts as one chip, and the checked sections of a partly checked group are chips individually), in the book's order, wrapping with 8 px gaps in a `role="group"` named «الأقسام المختارة» / "Selected sections". From 7 checked rows the row of chips is not shown (the count line and the checked rows are the summary), so it never exceeds two lines at 320 px.
- *Rows.* Native checkboxes (6.3 anatomy: 24×24 px box, radius xs, 2 px border), each row at least 48 px high with the whole row as the target, a 1 px divider between rows, padding-inline 16 px. Row text: the title in `--q-text-body` and, after it, the reference in `--q-text-small` text-secondary inside `<bdi>`. The list stays in the page flow with no inner scroll area (no nested scrolling; the browser's find and zoom behave); from 768 px it runs in two CSS columns, so reading and tab order stay the DOM order (first column down, then the second).
- *Group rows (D88).* Shown only for a book of more than 10 sections: each row stands for 10 consecutive sections (the last may be shorter). Same row anatomy, at least 48 px high with the whole row as the target, and tri-state: checked when all its sections are checked, mixed (`aria-checked="mixed"`, dash icon) when only some are, and a press checks all of its sections (or unchecks all of them when it was checked). A second line shows the count. A tertiary «تخصيص» / "Customize" disclosure button (6.1; at least 44×44 px, 8 px from the checkbox target) has `aria-expanded` and `aria-controls`, the accessible name «تخصيص {label}», and is collapsed by default; once revealed, the section rows are indented under the group row by `--q-space-24` (start edge). The selection stays one set of section ordinals, whatever is shown. A fully checked group counts as one chip; the checked sections of a partly checked group are chips individually.
- *Limit.* At most 60 items can be checked (UG-13: the Forty's 42 and Juz' Amma's 37 fit). In a longer future list the unchecked rows take `aria-disabled` once 60 are checked, with the helper «يمكن اختيار ٦٠ قسمًا على الأكثر.» / "You can choose at most 60 sections.", and «تحديد الكل» is hidden; this is not reachable in this build.

**Removable chip.** The 6.11 interactive chip grown to 44 px: fill `--q-color-selection`, 1 px `--q-color-border-selected`, radius sm, label `--q-text-body-compact` weight 600 in `--q-color-text-accent`, padding-inline-start 12 px, then a remove button: an icon button of 44×44 px with a 20 px x icon in text-accent and the name «إزالة {label}» / "Remove {label}". Each remove button is an ordinary button in tab order (at most six). Removing a chip unchecks its row; focus moves to the next chip's remove button, else the previous one, else the first row, and a polite status says «أُزيل {label}. {count line}». The x icon does not mirror; chips flow from the start edge.

| State | Appearance |
|---|---|
| Row: default | recipe Default (fill surface), unchecked box |
| Row: hover, pressed | recipes Hover and Pressed (fill selection) |
| Row: focus-visible | focus ring inset (offset -2 px so the group does not clip it) |
| Row: checked | fill selection, box filled `--q-color-primary` with a white check (never colour alone), label `--q-color-text-accent` |
| Row: mixed (group rows only) | as checked with a dash icon in place of the check |
| Row: disabled | fill disabled, text-secondary, `aria-disabled`; used only at the limit |
| List: nothing checked | count «لم تختر شيئًا بعد»; no chips; «مسح الاختيار» `aria-disabled` |
| List: some checked | count «تم اختيار {n} من {m}»; chips when six or fewer rows are checked; both tools enabled |
| List: all checked | count «تم اختيار الكل ({m})»; «تحديد الكل» `aria-disabled`; no chips except one chip per fully checked group |
| List: loading | skeleton rows (6.14) after 300 ms, `aria-busy` |
| Tool with nothing to do | `aria-disabled`; it keeps focus when it was just pressed, and the count line shows the reason |
| Error, success | not used at group level; the screen explains why its primary action is disabled |

**Keyboard and screen reader.** Rows are native checkboxes: Tab reaches every row (the group is not one widget, so there is no roving tabindex) and Space toggles. The tools and the chips come before the rows, so select all and clear are reached first, and a group row is a single row (its «تخصيص» button is the next tab stop, then the revealed sections). Pressing «تحديد الكل» or «مسح الاختيار» keeps focus on that button. Levels 1 and 2 follow 6.5 (one tab stop, arrows in the logical direction, Space selects). A level that appears is announced once, politely, as «ظهرت قائمة: {legend}» / "A list appeared: {legend}", and focus does not move.

**Right to left.** The box sits at the start edge (the right in RTL) and the reference follows the title; the tools row, the chips and the second column mirror with `dir`; digits follow 3.4; arrow keys move in the logical direction.

**Contrast and motion.** Row text `--q-color-text` on `--q-color-surface` 11.76 and on `--q-color-selection` 10.48; chip and checked-row label `--q-color-text-accent` on selection 7.75; chip border `--q-color-border-selected` on selection 4.25; white check on `--q-color-primary` 4.77; count text `--q-color-text-secondary` on `--q-color-bg` 5.10; focus ring 8.27 on the page background. Nothing animates (levels, counts and chips change instantly), so reduced motion needs no variant.

## 7. Focus, keyboard and screen reader

- Focus ring: `outline: 2px solid var(--q-color-focus); outline-offset: 2px` on `:focus-visible` for every focusable element (3:1 or better on every background, Table 4); `outline` survives forced-colors mode; flush elements (rows, tab items) use a negative offset so the ring is not clipped. Never remove the outline without an equivalent.
- Focus order equals DOM order equals visual order in both directions. Landmarks: `header`, labelled `nav`, `main`, `footer` where present.
- Skip link: first focusable element, visible on focus, «انتقل إلى المحتوى» (**proposed**), target `main` with `tabindex="-1"`. After a route change focus moves to the page `h1` and the document title updates.
- No keyboard traps; dialogs contain focus natively, Escape cancels, focus returns to the opener.
- Focus not obscured (2.4.11): sticky app bar, tab bar and action bars are reflected in `scroll-padding-block-start` and `-end` so a focused control is never fully hidden; test at 320×568 and at 200 % zoom.
- `aria-live`: errors `role="alert"`; success, info, warning, wake-up, sync and feedback `role="status"` (polite); toast polite and atomic. Do not announce progress on every event; announce milestones, such as reaching 100 % of the daily goal, once.
- Labels in the UI language (Arabic and English) on every control, icon button, progress bar and status; names are never hard-coded; visible label text is contained in the accessible name (2.5.3). `lang` on the root and `lang="ar"` on original text.
- Roving tabindex only where a group is one widget (radio groups, option tiles, the quick-reply row); word-order chips are ordinary buttons in tab order, and so are the checkbox rows and the removable chips of 6.26. Hidden practice text is removed from the accessibility tree (6.12).

## 8. Motion

| Token | Value | Use |
|---|---|---|
| `--q-duration-fast` | 120 ms | Hover, press, toggle |
| `--q-duration-base` | 200 ms | Banner and toast enter and exit, chip placement |
| `--q-duration-slow` | 320 ms | Progress fill change, dialog open |
| `--q-ease-standard` / `--q-ease-exit` | cubic-bezier(0.2, 0, 0, 1) / cubic-bezier(0.4, 0, 1, 1) | Enter and move / exit |

All values **proposed**. Motion only clarifies a change; nothing animates continuously except a loader.

- `@media (prefers-reduced-motion: reduce)` (the system setting is the only control; no in-app toggle): durations become 0, transforms and smooth scrolling are removed, loader rotation and skeleton shimmer become static icons and text, state changes are instant. Essential information is never conveyed by motion alone.
- No countdown animation, per-second ticking, confetti, celebration or streak effect: session duration is an estimate (UX.md) and the daily bar shows elapsed time only. Nothing flashes or auto-plays.

## 9. WCAG 2.2 AA checklist

Criteria mapped to components; applies to the D67 matrix only, and support is claimed only for combinations actually tested.

| Criterion | Rule here | Where |
|---|---|---|
| 1.4.1 Use of colour | Status always icon plus phrase | 6.8, 6.11, 6.16, 6.17 |
| 1.4.3 Contrast (minimum) | Text at least 4.5:1, large text at least 3:1 | 2.3 |
| 1.4.4, 1.4.10, 1.4.12 Resize, reflow, text spacing | rem units, zoom enabled; no horizontal scroll at 320 px; containers grow, no fixed heights on text | 3.3, 5, 6.16 |
| 1.4.11 Non-text contrast | Borders, icons, focus ring, progress fill at least 3:1; #7890A3 never alone on #E6F4FD | 2.3, 6.2–6.4, 6.10 |
| 2.1.1, 2.1.2 Keyboard, no trap | Every function by keyboard | 6.9, 7 |
| 2.4.7 Focus visible | 2 px ring, offset 2 px | 7 |
| 2.4.11 Focus not obscured (minimum) | Scroll padding for sticky bars | 6.6, 7 |
| 2.5.7 Dragging movements | No drag-only action; tap path always present | 6.16 |
| 2.5.8 Target size (minimum) | 44×44 px approved (stricter than 24 px), 8 px spacing; consent links get 44 px lines | 6.1–6.6, 6.19–6.22, 6.25, 6.26 |
| 3.2.6 Consistent help | No help mechanism specified; if one is added keep its place fixed | open |
| 3.3.1, 3.3.2, 3.3.3 Errors and labels | Visible labels, error at the field with icon, no values echoed | 6.2, 6.3, 6.8 |
| 3.3.7 Redundant entry | Never ask again for data given in the same flow; password confirmation is allowed (security exception) | 6.2, 6.15 |
| 3.3.8 Accessible authentication (minimum) | Paste and password managers allowed, no cognitive test; recovery code copy, paste and download allowed | 6.2, 6.15 |
| 4.1.3 Status messages | `role="status"` and `role="alert"` | 6.8, 6.11, 6.13, 6.17, 6.18, 6.19, 6.26 |
| 1.3.4, 1.3.5, 3.1.2 | No orientation lock; `autocomplete` tokens; `lang="ar"` on original text | 3.2, 5, 6.2 |

Automated (axe-core, Playwright) can check: contrast on rendered screens (re-run the token script after any hex change), names, roles, labels, landmarks and `lang` (NFR-09: 0 serious or critical on core screens), 44×44 bounding boxes, `scrollWidth` at 360×780, 390×844 and 1280×800 (**proposed** additions 320×640 and 768×1024, because contract §9 lists three viewports), keyboard tab order and Escape, computed outline on `:focus-visible`, `emulateMedia({ reducedMotion: 'reduce' })`, and screenshots of both directions and of the Uthmani mark string. Manual testing is needed for: screen readers in Arabic and English, 200 % zoom and text-spacing override, ring not clipped or hidden, mirrored icons and progress direction, mark rendering, real devices and browsers beyond Chromium (Safari iOS 17+, Samsung Internet, Firefox, Safari macOS), each labelled manual. Automated checks do not prove full WCAG compliance (NFR-09).

## 10. Open questions and assumptions for the owner at G1

**Status (D78, 4 October 2026):** G1 was granted, so the owner approved this file with the decisions, questions and assumptions below as recorded: Q3, Q4 and Q1 stand, Q2 is answered by the approval (light theme only), and nothing in this section is still open. The owner's only adjustment at G1 concerns screen S-08 and is specified in 6.26.

Decisions recorded from the coordinator on 4 October 2026 (accepted by the coordinator and approved by the owner with G1, D78):

- **Q3 Numerals, decided:** Arabic-Indic digits in the Arabic UI and Western digits in the English UI (3.4).
- **Q4 Desktop navigation, decided:** side rail from 1024 px, bottom tab bar below (5, 6.6).
- **Q1 Semantic colours, standing:** the proposed success, error and warning colours stand (2.2); approved with G1 (D78).

Questions that were open at G1 (answered by the approval, D78: the defaults stand):

1. **Q2 Dark mode.** Only the light theme is in scope (A1), as approved with G1.
2. **Q1 at G1.** The semantic colours (success deep teal-green #14654E, error crimson #A8322D, warning amber #8A5300, status only) stand as proposed; the owner did not adjust them or ask for a blue-only treatment for success.

Assumptions (confirmed by the owner's approval of G1, D78):

- A1 Light theme only; no dark mode and no theme toggle.
- A2 The type scale, religious text sizes, weights, spacing, sizes, content widths, intermediate breakpoints and motion values are proposals.
- A3 `--q-radius-xs` 4 px for the 24 px checkbox box is a small-control exception to the 8–12 px band.
- A4 Needs-review feedback and a wrong option use warning tokens (gentle), not error tokens, following UX.md («بلطف»).
- A5 Delete-account confirmation uses a checkbox and the client sends the literal the API requires, leaving the API contract unchanged.
- A6 Religious fonts load with `block` and preload; UI fonts with `swap`.
- A7 English counterparts of fixed Arabic copy, and every label marked proposed, come from the copy deck and are not sourced here.
- A8 The icon set is chosen by the frontend plan and must be line icons bundled for the offline shell.
