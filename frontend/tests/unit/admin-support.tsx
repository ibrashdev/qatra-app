import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { accountMockHandlers } from "@/lib/api/mock/account-handlers";
import { adminMockHandlers } from "@/lib/api/mock/admin-handlers";
import { mockHandlers, type MockHandler, type MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import { settingsMockHandlers } from "@/lib/api/mock/settings-handlers";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";

// Shared by the tests of the content manager screens: the screen is rendered over the real mock layer (the admin handlers keep their data per
// instance), every request is recorded, and a test may replace any handler to make one answer fail. The test file mocks next/navigation itself.

export interface AdminRender {
  calls: { key: string; body: unknown }[];
  sent: (key: string) => { key: string; body: unknown }[];
  count: (key: string) => number;
  runtime: ApiRuntime;
  unmount: () => void;
}

export interface AdminRenderOptions {
  language?: "ar" | "en";
  handlers?: Record<string, MockHandler>;
  scenario?: Partial<MockScenario>;
  // Holds the answer of one request (a key such as "GET /admin/access") until the promise settles.
  hold?: { key: string; until: Promise<void> };
}

export function renderAdmin(ui: ReactElement, { language = "ar", handlers = {}, scenario = {}, hold }: AdminRenderOptions = {}): AdminRender {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const mock = createMockFetch({
    latencyMs: 0,
    handlers: { ...mockHandlers, ...accountMockHandlers, ...settingsMockHandlers, ...adminMockHandlers, ...handlers },
    scenario: { signedIn: true, hasPlan: true, ...scenario },
  });
  const calls: { key: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://qatra.test");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname.replace(/^\/api/, "")}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (hold !== undefined && key === hold.key) await hold.until;
    return mock(input, init);
  });
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  const view = render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
  const sent = (key: string) => calls.filter((call) => call.key === key);
  return { calls, sent, count: (key: string) => sent(key).length, runtime, unmount: view.unmount };
}

export function cleanupAdmin(rendered: AdminRender | undefined) {
  rendered?.runtime.wakeUp.dispose();
  localStorage.clear();
  resetLocaleStoreForTests();
  document.documentElement.lang = "ar";
  document.documentElement.dir = "rtl";
}
