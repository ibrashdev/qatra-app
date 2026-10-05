import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, vi } from "vitest";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { createMockFetch, type MockScenario } from "@/lib/api/mock";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";
import { clearLoginArrival } from "@/lib/auth/flash";
import { wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft } from "@/lib/auth/register-draft";
import { clearSettingsArrival } from "@/lib/settings/arrival";

// Shared by the tests of S-23, S-24 and S-27: the mock layer answers every operation (the security handlers answer E08, E09 and E13), a test
// overrides single ones, and every call is recorded with its body. Synthetic data only: the passwords below belong to no account.

export const NEW_PASSWORD = "another synthetic passphrase for docs";
export const E08 = "POST /api/auth/recovery/rotate";
export const E09 = "POST /api/auth/password";
export const E13 = "POST /api/account/delete";
export const E11 = "GET /api/me";

// Current passwords that make the mock security handlers answer each failure (src/lib/api/mock/security-handlers.ts).
export const TRIGGER = {
  throttled: "mock outcome: throttled",
  locked: "mock outcome: locked",
  unavailable: "mock outcome: unavailable",
  internal: "mock outcome: internal",
  origin: "mock outcome: origin",
  silent: "mock outcome: silent",
} as const;

// The en dash and the em dash, written as code points so this file holds neither (owner decision D80: no dash in new text).
export const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

export type Handler = () => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const apiError = (status: number, code: string, details: Record<string, unknown> = {}): Response => jsonResponse({ error: { code, message: "x", details } }, status);

export function makeSecurityBackend(overrides: Record<string, Handler> = {}, scenario: Partial<MockScenario> = { signedIn: true }) {
  const mock = createMockFetch({ latencyMs: 0, scenario });
  const calls: { key: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const override = overrides[key];
    return override ? override() : mock(input, init);
  });
  return {
    fetchImpl,
    calls,
    count: (key: string) => calls.filter((call) => call.key === key).length,
    bodies: (key: string) => calls.filter((call) => call.key === key).map((call) => call.body),
  };
}
export type SecurityBackend = ReturnType<typeof makeSecurityBackend>;

export function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

export function renderSecurity(ui: ReactElement, { language = "ar", backend = makeSecurityBackend() }: { language?: "ar" | "en"; backend?: SecurityBackend } = {}) {
  setLanguage(language);
  const runtime: ApiRuntime = createApiRuntime({ mode: "live", fetch: backend.fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
  return { backend, runtime, ...view };
}

// Everything these screens read or leave in memory, so a test starts from the same place.
export function resetSecurityState() {
  localStorage.clear();
  sessionStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  clearLoginArrival();
  clearSettingsArrival();
  wipeRecoveryCode();
  clearRegisterDraft();
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("jest", { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
}

export async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

export const follows = (before: Element, after: Element): boolean => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

export function politeRegion(text: string): HTMLElement {
  const region = screen.getByText(text).closest("[role=status]");
  expect(region, `a status region around "${text}"`).not.toBeNull();
  return region as HTMLElement;
}
