import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { MOCK_PLAN_ID } from "@/lib/api/mock/fixtures";
import { withGameMock, type GameMockOptions } from "@/lib/api/mock/game-handlers";
import { mockHandlers, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { createApiRuntime } from "@/lib/api/runtime";
import type { SessionEvent } from "@/lib/api/types";

// Shared by the games tests: the mock layer answers every operation (E18, E14, E20 `game`, E21, E22) and a test overrides single ones. Every call is
// recorded with its body. Synthetic data only.

export const UUID = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;

export type Real = () => Promise<Response>;
export type Override = (real: Real, call: number) => Response | Promise<Response>;

export const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const apiError = (status: number, code: string, details: Record<string, unknown> = {}): Response => jsonResponse({ error: { code, message: "m", details } }, status);

export const E18 = "GET /api/today";
export const E20 = "POST /api/sessions";
export const E21 = "POST /api/sessions/:id/events";
export const E22 = "POST /api/sessions/:id/complete";

export function makeGamesBackend(overrides: Record<string, Override> = {}, scenario: Partial<MockScenario> = {}, options: GameMockOptions = {}) {
  const mock = createMockFetch({ latencyMs: 0, handlers: withGameMock(mockHandlers, options), scenario: { signedIn: true, hasPlan: true, ...scenario } });
  const calls: { key: string; body: unknown }[] = [];
  const seen = new Map<string, number>();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(UUID, ":id")}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const call = (seen.get(key) ?? 0) + 1;
    seen.set(key, call);
    const override = overrides[key];
    const real: Real = () => mock(input, init);
    return override ? override(real, call) : real();
  });
  const bodies = (key: string) => calls.filter((entry) => entry.key === key).map((entry) => entry.body);
  const events = (): SessionEvent[] => bodies(E21).flatMap((body) => (body as { events: SessionEvent[] }).events);
  return { fetchImpl, calls, count: (key: string) => bodies(key).length, bodies, events };
}
export type GamesBackend = ReturnType<typeof makeGamesBackend>;

export function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

export function renderWithBackend(ui: ReactElement, { language = "en", backend = makeGamesBackend() }: { language?: "ar" | "en"; backend?: GamesBackend } = {}) {
  setLanguage(language);
  const runtime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, runtime, ...view };
}

export const PLAN = { planId: MOCK_PLAN_ID, planVersion: 1 } as const;
