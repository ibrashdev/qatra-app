# Qatra frontend

Next.js (App Router) with strict TypeScript and Tailwind. This is package F0, the foundation: shell, direction and language, design tokens, self-hosted fonts, the API client with the free-server wake-up state, API types and a mock layer. It contains no real screen; every route is a placeholder that says so.

Authority: `docs/UI-tokens.md`, `docs/UI-design.md`, `docs/API-spec.md` and `docs/Implementation-contract.md` section 7. Read `AGENTS.md` first: it points to the Next.js documentation installed in `node_modules/next/dist/docs`.

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
| `src/app` | routes: `(public)/login`, `(app)/today`, `games`, `progress`, `settings`; `/` redirects to `/login` until the catalog ships |
| `src/components/ui` | shells (public, app, focus flow), navigation, language switch, wake-up status |
| `src/lib/api` | client, error types, wake-up controller, endpoints, `types.ts` (contract DTOs), `mock/` |
| `src/i18n` | message catalog (shell strings only), locale storage and direction |
| `src/styles` | `tokens.css` (the `--q-*` tokens), `theme.css` (Tailwind mapping), `fonts.css` |

## Rules this package keeps

- Same origin only: the browser calls `/api/*`, Next.js rewrites it, there is no CORS and no route handler or Server Action with API logic. The client never stores or reads a token.
- A request that fails outside the error envelope (gateway, timeout, network) is connectivity, never a logout. Only `401` with the code `unauthenticated` ends a session.
- Non-idempotent requests are never retried automatically.
- Light theme only, logical CSS properties only, no service worker, no PWA (deferred).
- Mock data is synthetic: placeholders and fake ids, no religious text.
