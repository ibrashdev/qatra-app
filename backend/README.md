# Qatra backend

FastAPI service (Python 3.11+, managed with [uv](https://docs.astral.sh/uv/)). Contract:
`docs/Implementation-contract.md` (§1, §8, §9) and `docs/API-spec.md`.
This package (B0) provides configuration, the error envelope, the Origin and session
dependencies, and the health endpoints `GET /api/health` and `GET /api/health/ready`. `create_app`
also serves authentication and account (E03-E13), the catalog, plans, sessions and the plan
conversation (E31-E34).

## Run the checks

```bash
cd backend
uv sync
uv run ruff check .
uv run ruff format --check .
uv run pytest -q
```

Tests run in memory mode (`QATRA_DATA_BACKEND=memory`); they need no database and no secrets.

## Run the dev server

```bash
cd backend
cp .env.example .env        # .env is gitignored; fill values locally, never commit them
APP_ENV=development QATRA_DATA_BACKEND=memory \
FRONTEND_ORIGIN=http://localhost:3000 TERMS_VERSION=2026-10-04 \
  uv run uvicorn app.main:app --port 8000
```

- **Memory mode** (`QATRA_DATA_BACKEND=memory`) uses no database; the readiness probe
  succeeds without one. It is refused when `APP_ENV=production`.
- Configuration is validated at startup by variable **name** only; errors list names and
  never values. In production every secret and key is required and no `.env` file is read.
  In development and test only `FRONTEND_ORIGIN` and `TERMS_VERSION` are required.
- **Interactive docs** (`/docs`, `/redoc`, `/openapi.json`) are available in development and
  test and are disabled when `APP_ENV=production`.
- There is no CORS middleware: the browser calls the frontend origin and Vercel rewrites
  forward `/api/*` (same origin).

## Keys

Production needs four independent keys, each base64 of random bytes. Generate each one with:

```bash
python -c "import base64,secrets;print(base64.b64encode(secrets.token_bytes(32)).decode())"
```

Run it once per variable: `QATRA_SESSION_KEY` (AES-256-GCM, exactly 32 bytes),
`QATRA_SESSION_HMAC_KEY`, `QATRA_RECOVERY_HMAC_KEY` and `QATRA_THROTTLE_HMAC_KEY` (HMAC, at least
32 bytes). No two may be equal. Set them in the Render environment; never write a value into the
repository, `.env.example` or a log. A key that is set but invalid stops startup, naming the
variable and never the value.

## Authentication wiring

- `create_app` calls `install_auth(app, settings, clock=clock)` after the learning core. It builds
  the services, stores the resolver on `app.state.session_resolver`, adds the handler that clears
  the cookie on a `401`, and includes E03-E13. `require_session` then resolves the cookie.
- Memory mode uses an in-memory account store and a fake identity provider, with throwaway keys
  when none is configured (sessions then end with the process). Plans and sessions are keyed by
  the `user_id` of the session, so one account is one identity everywhere. The memory plan service
  gives every account the default time zone, not the one chosen at registration.
- Supabase mode in development and test without its configuration still starts: the auth routes
  answer `503` and `require_session` denies, with one log line naming the missing variables. In
  production all of it is required.
- A second `install_auth` call replaces the services and keeps the routes (one set of routes).

## Test seams of `create_app`

- `clock`: a `Callable[[], datetime]` that replaces the current time for plans, sessions and
  authentication (session expiry, learning date).
- `transport`: an `httpx.BaseTransport` for the PostgREST client of plans and sessions in
  supabase mode. Tests pass a fake project; no test uses the network.
- A fixed identity without a login: override `require_session` (TEST ONLY, never in production
  code), as `tests/plans/plans_support.py` does. For the real session, register through E03 and
  keep the cookie: `tests/integration/test_full_journey.py`.
- Your own auth components (store, provider, throttle clock, limits): call
  `install_auth(app, settings, repository=..., profiles=..., provider=..., clock=...,
  monotonic=..., rate_limits=...)` after `create_app`, as `tests/auth/auth_support.py` does.

## Client address and rate limits

Every per-IP limiter and the throttle prefix (IPv4 /24, IPv6 /48) use one function, `client_key`
in `app/routers/health.py`. `QATRA_TRUSTED_XFF_DEPTH` (default 0) sets how many proxies append to
`X-Forwarded-For` in front of the app: 0 uses the peer address; N >= 1 uses the N-th entry from
the right (1 is the last). A header with fewer entries, or an entry that is not an IP address,
falls back to the peer address. The production value is confirmed on the deployed stack (Vercel
to Render, expected 2); a value larger than the real chain lets a client pick its own address.

Limits are requests per client address per minute, each at least 1 (a value below 1 stops startup):

| Setting | Default | Class |
| --- | --- | --- |
| `QATRA_READY_RATE_PER_MIN` | 6 | readiness (E02) |
| `QATRA_RATE_PUBLIC_READ_PER_MIN` | 60 | public read (E14) |
| `QATRA_RATE_ANONYMOUS_ENTRY_PER_MIN` | 10 | anonymous entry (E03) |
| `QATRA_RATE_SESSION_READ_PER_MIN` | 120 | session read (E11, E15) |
| `QATRA_RATE_SESSION_WRITE_PER_MIN` | 60 | session write (E05, E08-E10, E12, E13, E16, E17, E20, E30) |
| `QATRA_RATE_CHAT_WRITE_PER_MIN` | 20 | chat write (E31, E32, E34) |

The auth routes and the plan and session routes keep separate windows for the session write and
session read classes.

## Plan conversation (E31-E34)

`create_app` installs the conversation through `app.wiring.install_plan_chat`: a `PlanChatGateway`
on `app.state.plan_chat_service` that builds one `PlanChatService` per request, from
`PlanService.ports_for(ctx)` (the learner's token travels with the context), a repository and the
learning adapter. Without the plan service (supabase mode without `SUPABASE_URL` and
`SUPABASE_ANON_KEY`) the four endpoints answer `503`.

- **Memory mode**: conversations and usage counters live in process memory.
- **Supabase mode**: conversations are read and written through PostgREST with the learner's own
  token and the three functions of migration 0006 (`app_plan_chat_open`, `app_plan_chat_append`,
  `app_plan_chat_confirm`). E31 stores its whole first turn in one call; E34 writes the plan and
  closes the conversation in one database transaction. Model usage rows go through
  `srv_record_ai_usage` over `QATRA_SERVER_DB`. No database function reads `ai_usage` back, so
  the cap counters (50 per day and 20 per minute for the deployment, 10 per account per day) live
  in process memory and a restart resets them; a failed usage write is logged by event name only
  and never fails the learner's turn. Production never falls back to process memory.
- **`QATRA_CHAT_MODEL_FOR_LEARNERS`** defaults to `false` (D76): a real account's conversation is
  rules-only, with no provider call and no "assistant unavailable" notice, even when
  `OPENROUTER_API_KEY` and `OPENROUTER_MODELS` are set. Set it to `true` only when conversation
  text may reach the model. The guard and the quick replies run before any provider call in
  both settings, and the model payload never holds the account, the username or the session.
- **Tests**: `install_plan_chat(app, settings, provider=..., ledger=..., repository=..., clock=...)`
  replaces the conversation after `create_app` (as `install_auth` does); pass an
  `OpenRouterProvider` over `httpx.MockTransport`. No test calls a live provider.

## Privacy and logging

Access logs are one JSON line per request with method, route template, status, latency, error
code and two proxy-chain measures: `xff_entries`, the number of `X-Forwarded-For` entries that
arrived (0 when the header is absent), and `via_vercel`, whether an `x-vercel-id` header was
present. They help choose `QATRA_TRUSTED_XFF_DEPTH` (see "Client address and rate limits"). Both
are a count or a flag only: no header value, address or hash of one is logged. Bodies, cookies,
tokens, usernames, query strings and IP addresses are never logged. uvicorn's own access log
(raw IPs and paths) is switched off by the application. Unhandled exceptions are answered with
`500 internal` and only the exception type is logged (no traceback, because messages can contain
submitted values).

## Conventions for later packages

- Errors: raise `AppError(ErrorCode.<code>)`; never build error bodies by hand. A `throttled`
  error needs `retry_after`.
- Every POST/PUT/PATCH/DELETE route lists `Depends(require_valid_origin)` before
  `Depends(require_session)`; `tests/test_origin.py` fails when a mutation skips the check.
  The ASGI `OriginGuardMiddleware` runs first (before the body cap, routing and
  authentication); the dependency documents the rule and double-checks it.
- A router declares its full prefix itself (`APIRouter(prefix="/api")`) so the access log
  records the complete route template.
- `app/domain/` is pure: no FastAPI, Starlette or database-client imports (tested).
- Time zones come from the `tzdata` package (IANA data for `zoneinfo`, PEP 615), so they do not
  depend on the operating system.

## Content workflow CLI

The operator CLI (`backend/scripts/content_tools.py`, package B7) and its exit codes are documented in
[`scripts/README.md`](scripts/README.md). It never runs inside the API process.

## Never commit

Credentials, real personal data, `.env`, or `.content-build/` output.
