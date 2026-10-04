# Qatra frontend

Next.js (App Router) with strict TypeScript and Tailwind. Package F0 is the foundation: shell, direction and language, design tokens, self-hosted fonts, the API client with the free-server wake-up state, API types and a mock layer. The screens of Batch 1 (account) are built on it one at a time, each approved by the owner before the next: S-01 login is built. The register, recovery, consent and start routes are placeholders that say so until their screens arrive.

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
| `src/app` | routes: `(public)/login`, `register`, `recovery`; `(flow)/consent`, `start`; `(app)/today`, `games`, `progress`, `settings`; `/` redirects to `/login` until the catalog ships |
| `src/components/auth` | the account screens (`LoginForm`) |
| `src/components/ui` | shells (public, app, focus flow), navigation, language switch, wake-up status, and the form parts: `Icon` (the only import of the icon set), `Banner`, `Button`, `TextField`, `PasswordField`, `ErrorSummary`, `FormBanners` |
| `src/lib/api` | client, error types, wake-up controller, endpoints, `types.ts` (contract DTOs), `mock/` |
| `src/lib/auth` | the safe return path, the login arrival banner and the return path kept for the consent gate (both in memory), the signed-in guard, the E04 error mapping |
| `src/lib/net`, `src/lib/dom` | connectivity, and the press-safe layout change |
| `src/i18n` | message catalogs (`messages.ts` with `auth-messages.ts` and `form-messages.ts`), number formatting, locale storage and direction |
| `src/styles` | `tokens.css` (the `--q-*` tokens), `theme.css` (Tailwind mapping), `fonts.css` |

## Mock accounts (development, `NEXT_PUBLIC_API_MODE=mock`)

The mock starts as a visitor and answers E04 for these synthetic names. No real account exists behind any of them. The first three need the password `synthetic passphrase for docs only` (the example of API-spec 4.2); the failure names answer the same whatever the password is; any other name is a wrong username or password.

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

## Rules this package keeps

- Same origin only: the browser calls `/api/*`, Next.js rewrites it, there is no CORS and no route handler or Server Action with API logic. The client never stores or reads a token.
- A request that fails outside the error envelope (gateway, timeout, network) is connectivity, never a logout. Only `401` with the code `unauthenticated` ends a session.
- Non-idempotent requests are never retried automatically.
- Light theme only, logical CSS properties only, no service worker, no PWA (deferred).
- Icons come from one set (Lucide, ISC licence, pinned to an exact version), imported by name in `src/components/ui/Icon.tsx` only. Each glyph is decorative; the accessible name lives on the control or in the phrase beside it.
- A form keeps what the visitor typed, shows no value back, and keeps nothing in the browser: the screens store nothing but the language choice.
- Mock data is synthetic: placeholders and fake ids, no religious text.
