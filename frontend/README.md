# Qatra frontend

Next.js (App Router) with strict TypeScript and Tailwind. Package F0 is the foundation: shell, direction and language, design tokens, self-hosted fonts, the API client with the free-server wake-up state, API types and a mock layer. The screens of Batch 1 (account) are built on it one at a time, each approved by the owner before the next: S-01 login, S-02 register, S-03 terms and privacy and S-04 recovery-code save are built. The recovery, consent and start routes are placeholders that say so until their screens arrive.

Authority: `docs/UI-tokens.md`, `docs/UI-design.md`, `docs/UI-screens.md`, `docs/API-spec.md` and `docs/Implementation-contract.md` section 7. Read `AGENTS.md` first: it points to the Next.js documentation installed in `node_modules/next/dist/docs`.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | development server (mock API by default) |
| `pnpm build`, `pnpm start` | production build and server |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | route types, then `tsc --noEmit` |
| `pnpm test` | Vitest and Testing Library (`tests/unit`) |
| `pnpm e2e` | builds, starts the app and a stub backend, runs Playwright (`tests/e2e`) on the pre-installed Chromium |

Do not run `playwright install`: the browser comes from `PLAYWRIGHT_BROWSERS_PATH`.

## Environment

See `.env.example`. `BACKEND_ORIGIN` (server side) is where `/api/*` is forwarded; `NEXT_PUBLIC_API_MODE` is `mock` or `live` (mock in development, live otherwise); `NEXT_PUBLIC_TERMS_VERSION` must equal the backend `TERMS_VERSION`. No other public variable exists.

## Layout

| Path | Holds |
|---|---|
| `src/app` | routes: `(public)/login`, `register`, `recovery`, `terms`; `(flow)/consent`, `start`, `recovery-code`; `(app)/today`, `games`, `progress`, `settings`; `/` redirects to `/login` until the catalog ships |
| `src/components/auth` | the account screens (`LoginForm`, `RegisterForm` and `RegisterScreen`, its shell and back control) |
| `src/components/terms` | S-03: `TermsScreen`, `TermsBody` (the part S-26 shows again in the app shell), `TermsLoading`, `TermsError`, and `use-terms-return.ts` (back to the screen that opened it) |
| `src/components/ui` | shells (public, app, focus flow), navigation, language switch, wake-up status, and the form parts: `Icon` (the only import of the icon set), `BackControl`, `Banner`, `Button`, `Checkbox`, `Notice`, `Skeleton`, `TextField`, `PasswordField`, `ErrorSummary`, `FormBanners` |
| `src/lib/api` | client, error types, wake-up controller, endpoints, `types.ts` (contract DTOs), `mock/` |
| `src/lib/auth` | the safe return path, the login arrival banner and the return path kept for the consent gate (both in memory), the signed-in guard, the E04 and E03 error mappings, the username and password rules (`account-rules.ts`, the client side of the backend policy), the registration draft kept while S-03 is read and the recovery code on its way to S-04 (both in memory) |
| `src/lib/net`, `src/lib/dom` | connectivity, the press-safe layout change, and two small hooks (`use-after-delay`, `use-hydrated`) |
| `src/lib/nav` | the route history (the two latest routes of the visit, in memory, fed by `RouteTracker`), and which screens open S-03 |
| `src/i18n` | message catalogs (`messages.ts` with `auth-messages.ts`, `form-messages.ts` and `terms-messages.ts`), the text of S-03 (`terms-text.ts`, loaded with its route only), number formatting, locale storage and direction |
| `src/styles` | `tokens.css` (the `--q-*` tokens), `theme.css` (Tailwind mapping), `fonts.css` |

## Mock accounts (development, `NEXT_PUBLIC_API_MODE=mock`)

The mock starts as a visitor and answers E04 and E03 for these synthetic names. No real account exists behind any of them. The first three need the password `synthetic passphrase for docs only` (the example of API-spec 4.2); the failure names answer the same whatever the password is; any other name is a wrong username or password.

| Username | E04 answer |
|---|---|
| `sample_user_01` | signed in, an active plan: the page goes to `/today` |
| `new_user_01` | signed in, no plan: the page goes to `/start` |
| `reconsent_user_01` | signed in, `reconsentRequired`: the page goes to `/consent` |
| `throttled_user_01` | 429, wait 20 s |
| `locked_user_01` | 429, wait 900 s (the 15-minute lock) |
| `unavailable_user_01` | 503 |
| `internal_user_01` | 500 |
| `origin_user_01` | 403 `forbidden_origin` |

E03 (register) judges the username and password with the same rules as the screen, then answers by name. The first four are accounts that exist already, so registering them gives `username_taken`; any other well-formed name registers (201, the example recovery code `0123-4567-89ab-cdef-0123-4567-89ab-cdef`, signed in without a plan). The build needs `NEXT_PUBLIC_TERMS_VERSION=2026-10-04` (see `.env.example`), or the mock asks for a reload.

| Username | E03 answer |
|---|---|
| `sample_user_01`, `new_user_01`, `reconsent_user_01`, `taken_user_01` | 409 `username_taken` |
| `terms_user_01` | 400 `terms_required` for a version the build has not shown: the reload banner |
| `silent_user_01` | no answer at all (the connection fails): the uncertain outcome of P-10 |
| `throttled_user_01`, `locked_user_01` | 429, wait 20 s, wait 900 s |
| `unavailable_user_01`, `internal_user_01`, `origin_user_01` | 503, 500, 403 `forbidden_origin` |

## Rules this package keeps

- Same origin only: the browser calls `/api/*`, Next.js rewrites it, there is no CORS and no route handler or Server Action with API logic. The client never stores or reads a token.
- A request that fails outside the error envelope (gateway, timeout, network) is connectivity, never a logout. Only `401` with the code `unauthenticated` ends a session.
- Non-idempotent requests are never retried automatically.
- Light theme only, logical CSS properties only, no service worker, no PWA (deferred).
- Icons come from one set (Lucide, ISC licence, pinned to an exact version), imported by name in `src/components/ui/Icon.tsx` only. Each glyph is decorative; the accessible name lives on the control or in the phrase beside it.
- A form keeps what the visitor typed, shows no value back, and keeps nothing in the browser: the screens store nothing but the language choice. What S-02 keeps while S-03 is read, and the recovery code on its way to S-04, live in module memory only: a reload, a successful registration or a login wipes them.
- The text of S-03 is the words of `docs/Authentication-and-privacy.md`, with only the codes and table names taken out; `tests/unit/terms-text.test.ts` compares it with that document (and lists the few clauses that join two phrases). The page calls no API, so it shows no wake-up line, has no session probe, and a signed-in visitor stays on it.
- A link to an anchor (`/terms#privacy`) gets the scroll and the focus once the page is settled (the saved language applied), with the heading below the app bar. A reading page uses `PublicShell reading`: the reading column of UI-tokens 5 is its text measure.
- The selected segment of the language switch shows a check at the start edge, so the choice is never colour alone; at large text the segments wrap rather than leave the page.
- A top bar is sticky while it is one row and static once it has wrapped, that is taller than one row plus half a rem, the room that the page's scroll padding keeps clear (`use-wrapped-bar.ts` sets `data-wrapped` on the header; at 200 % text on 320 px the public bar was 305 px of 568 px). While a static bar is on the page, `globals.css` keeps only the notch and 8 px above a focused control. A title of two lines keeps its bar sticky, one of three does not.
- The root error page calls Next 16's `retry` (fetch the route again and render it), not `reset`.
- The back arrow is the only glyph that mirrors in right-to-left. The password toggle names its action and has no pressed state (O-07).
- `THIRD_PARTY_NOTICES.md` reproduces the licence text of the icon set; update it with the version when `lucide-react` changes.
- Mock data is synthetic: placeholders and fake ids, no religious text.
