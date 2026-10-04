# Qatra backend

FastAPI service (Python 3.11+, managed with [uv](https://docs.astral.sh/uv/)). Contract:
`docs/Implementation-contract.md` (§1, §8, §9) and `docs/API-spec.md`.
This package (B0) provides configuration, the error envelope, the Origin and session
dependencies, and the health endpoints `GET /api/health` and `GET /api/health/ready`.

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

## Privacy and logging

Access logs are one JSON line per request with method, route template, status, latency and
error code only. Bodies, cookies, tokens, usernames, query strings and IP addresses are never
logged. uvicorn's own access log (raw IPs and paths) is switched off by the application.
Unhandled exceptions are answered with `500 internal` and only the exception type is
logged (no traceback, because messages can contain submitted values).

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

## Never commit

Credentials, real personal data, `.env`, or `.content-build/` output.
