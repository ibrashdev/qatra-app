import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/today", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ replace: navigation.replace, push: navigation.push }) }));

// The offline plan has its own suites (offline-ui-*.test.tsx). Here it is a stand-in that shows what the signed-in shell hands it.
vi.mock("@/components/pwa/OfflineShell", async () => {
  const React = await import("react");
  return {
    OfflineShell: ({ embedded }: { embedded?: { onReconnected: () => void; onReturn?: () => void } }) =>
      React.createElement(
        "section",
        { "data-testid": "offline-shell" },
        React.createElement("h1", null, "Offline plan stand-in"),
        embedded?.onReturn === undefined ? null : React.createElement("button", { type: "button", onClick: embedded.onReturn }, "Back to the page"),
        React.createElement("button", { type: "button", onClick: embedded?.onReconnected }, "check passed"),
      ),
  };
});

import { OfflineNotice } from "@/components/pwa/OfflineNotice";
import { AppShell } from "@/components/ui/AppShell";
import { FocusShell } from "@/components/ui/FocusShell";
import { WakeUpStatus } from "@/components/ui/WakeUpStatus";
import { resetRouteFocusForTests } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { offlineAr, offlineEn } from "@/i18n/offline-messages";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";

const healthy = () => new Response(JSON.stringify({ status: "ok", version: "t", time: "2026-10-06T00:00:00Z" }), { status: 200 });

let runtime: ApiRuntime;
let pageMounts = 0;
let onLine = true;

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

// What the browser does: it flips the flag and then fires the event.
function browserGoes(next: "online" | "offline") {
  onLine = next === "online";
  act(() => {
    window.dispatchEvent(new Event(next));
  });
}

function failRequest(outcome: "network" | "gateway" | "answer") {
  act(() => {
    const id = runtime.monitor.start();
    if (outcome === "answer") runtime.monitor.settle(id, "api_error");
    else runtime.monitor.settle(id, "connectivity", outcome);
  });
}

// A page with something typed into it, to show whether it was kept or started over.
function Page({ label = "Draft" }: { label?: string }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    pageMounts += 1;
  }, []);
  return (
    <div>
      <h1 data-page-heading tabIndex={-1}>
        Page heading
      </h1>
      <label>
        {label}
        <input value={value} onChange={(event) => setValue(event.target.value)} />
      </label>
    </div>
  );
}

function renderWithApp(ui: ReactNode, { fetchImpl = vi.fn<typeof fetch>(async () => healthy()) } = {}) {
  runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  return render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
}

const shellStandIn = () => screen.queryByTestId("offline-shell");
const draft = () => screen.queryByLabelText("Draft") as HTMLInputElement | null;

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  navigation.pathname = "/today";
  navigation.replace.mockReset();
  navigation.push.mockReset();
  pageMounts = 0;
  onLine = true;
  vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => onLine);
  setLanguage("en");
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AppShell: a page that only reads gives way to the downloaded plan when the connection drops", () => {
  it("swaps the open page for the plan with no navigation, and brings the page back fresh once the plan's own check passed", async () => {
    const user = userEvent.setup();
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
    );
    await user.type(draft() as HTMLInputElement, "abc");
    expect(draft()).toHaveValue("abc");
    expect(pageMounts).toBe(1);

    browserGoes("offline");
    expect(shellStandIn()).toBeInTheDocument();
    // The page and its chrome are gone, not hidden; the address did not change and nothing was navigated.
    expect(draft()).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(navigation.pathname).toBe("/today");
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    // The stand-in was handed no way back to the page: this swap is the automatic one.
    expect(screen.queryByRole("button", { name: "Back to the page" })).toBeNull();

    browserGoes("online");
    // The browser's word alone does not bring the page back: the plan's own check does.
    expect(shellStandIn()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "check passed" }));

    expect(shellStandIn()).toBeNull();
    expect(draft()).toHaveValue("");
    expect(pageMounts).toBe(2);
    // The shell that had focus is gone, so the heading of the page takes it.
    expect(screen.getByRole("heading", { level: 1, name: "Page heading" })).toHaveFocus();
    expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
    expect(runtime.connectivity.getState().status).toBe("online");
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("does not swap again for the same offline episode, so the two cannot loop, and swaps again for a new one", async () => {
    const user = userEvent.setup();
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
    );
    browserGoes("offline");
    expect(shellStandIn()).toBeInTheDocument();
    // The plan's check passes while the browser still says offline (a hint that is wrong): the page returns and stays.
    await user.click(screen.getByRole("button", { name: "check passed" }));
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBeInTheDocument();
    // A new episode swaps again.
    browserGoes("online");
    browserGoes("offline");
    expect(shellStandIn()).toBeInTheDocument();
  });

  it("swaps when a request failed before any answer even though the browser says online, and counts the page's data as fresh afterwards", async () => {
    const user = userEvent.setup();
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
    );
    failRequest("network");
    expect(shellStandIn()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "check passed" }));
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBeInTheDocument();
    expect(pageMounts).toBe(2);
    expect(runtime.connectivity.getState().status).not.toBe("offline");
  });

  it("never swaps for an answer of the server, a 401 among them, or for a gateway answer that only says the free server is asleep", () => {
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
    );
    failRequest("answer");
    failRequest("gateway");
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBeInTheDocument();
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
    expect(pageMounts).toBe(1);
  });

  it("swaps for a page that is opened while the device is already offline", () => {
    onLine = false;
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
    );
    expect(shellStandIn()).toBeInTheDocument();
    expect(draft()).toBeNull();
  });

  it.each(["/plan", "/progress", "/games", "/lessons", "/settings/sources"])("swaps on %s", (path) => {
    navigation.pathname = path;
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
    );
    browserGoes("offline");
    expect(shellStandIn()).toBeInTheDocument();
  });
});

describe("AppShell: every other page keeps itself and what was typed in it", () => {
  async function typeOnForm() {
    navigation.pathname = "/settings/password";
    const user = userEvent.setup();
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
    );
    const input = draft() as HTMLInputElement;
    await user.type(input, "kept text");
    return { user, input };
  }

  it("keeps the page and its input, and says in a polite region what is true and what is not saved", async () => {
    const { input } = await typeOnForm();
    browserGoes("offline");
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBe(input);
    expect(input).toHaveValue("kept text");
    expect(pageMounts).toBe(1);

    const notice = screen.getByText(offlineEn.notice.title);
    expect(screen.getByText(offlineEn.notice.body)).toBeInTheDocument();
    const region = notice.closest('[role="status"]') as HTMLElement;
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("button", { name: offlineEn.notice.open })).toBeInTheDocument();
    // The notice never claims the entries are safe on the device.
    expect(screen.getByText(offlineEn.notice.body).textContent).toMatch(/not saved yet/);
  });

  it("opens the downloaded plan on request, keeps the page mounted and hidden behind it, and returns to the page with the input intact", async () => {
    const { user, input } = await typeOnForm();
    browserGoes("offline");
    await user.click(screen.getByRole("button", { name: offlineEn.notice.open }));

    expect(shellStandIn()).toBeInTheDocument();
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue("kept text");
    expect(input).not.toBeVisible();
    expect(pageMounts).toBe(1);
    // The plan comes first in the document, so its main region and skip link are the ones in use.
    const shellNode = shellStandIn() as HTMLElement;
    const hiddenPage = input.closest("[hidden]") as HTMLElement;
    expect(hiddenPage).not.toBeNull();
    expect(shellNode.compareDocumentPosition(hiddenPage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back to the page" }));
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBe(input);
    expect(input).toBeVisible();
    expect(input).toHaveValue("kept text");
    expect(pageMounts).toBe(1);
    // The control that had focus is gone, so the heading of the page takes it.
    expect(screen.getByRole("heading", { level: 1, name: "Page heading" })).toHaveFocus();
    // Still offline: the notice is still there, and the page was not swapped by the learner's own choice to return.
    expect(screen.getByText(offlineEn.notice.title)).toBeInTheDocument();
    expect(shellStandIn()).toBeNull();
  });

  it("returns to the same mounted page when the plan's check passes after a manual opening", async () => {
    const { user, input } = await typeOnForm();
    browserGoes("offline");
    await user.click(screen.getByRole("button", { name: offlineEn.notice.open }));
    browserGoes("online");
    await user.click(screen.getByRole("button", { name: "check passed" }));
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBe(input);
    expect(input).toHaveValue("kept text");
    expect(pageMounts).toBe(1);
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
  });

  it("leaves the notice when the connection is back, with no reload", async () => {
    await typeOnForm();
    browserGoes("offline");
    expect(screen.getByText(offlineEn.notice.title)).toBeInTheDocument();
    browserGoes("online");
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
    expect(draft()).toHaveValue("kept text");
  });

  it.each(["/admin", "/session/abc/result", "/plan/revise", "/demo/simulations", "/settings", "/settings/privacy"])("keeps the page on %s", (path) => {
    navigation.pathname = path;
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
    );
    browserGoes("offline");
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBeInTheDocument();
    expect(screen.getByText(offlineEn.notice.title)).toBeInTheDocument();
  });

  it("speaks the notice in Arabic in the Arabic interface", async () => {
    setLanguage("ar");
    navigation.pathname = "/settings/password";
    renderWithApp(
      <AppShell>
        <Page label="مسودة" />
      </AppShell>,
    );
    browserGoes("offline");
    expect(screen.getByText("أنت غير متصل بالإنترنت")).toBeInTheDocument();
    expect(screen.getByText(offlineAr.notice.body)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "افتح الخطة المحمّلة" })).toBeInTheDocument();
  });
});

describe("AppShell: a server that does not answer is not an offline device", () => {
  it("shows no offline notice and no swap while the free server is waking, and a notice with the plan's door after the wait is over", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<html>asleep</html>", { status: 502 }));
    renderWithApp(
      <AppShell>
        <Page />
      </AppShell>,
      { fetchImpl },
    );
    await act(async () => {
      failRequest("gateway");
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByText(offlineEn.shell.serverWaking)).toBeInTheDocument();
    expect(screen.queryByText(offlineEn.notice.server)).toBeNull();
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
    expect(shellStandIn()).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(runtime.wakeUp.getState().phase).toBe("timed_out");
    expect(screen.getByText(offlineEn.notice.server)).toBeInTheDocument();
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
    // The page stayed: a server that is not answering does not swap the page, whatever the route.
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: offlineEn.notice.open })).toBeInTheDocument();
  });
});

describe("WakeUpStatus: the free server is not starting while the device is offline", () => {
  const WAKING = offlineEn.shell.serverWaking;

  it("shows no waking line for a request that failed to leave the device, and keeps the live region in the page", async () => {
    renderWithApp(<WakeUpStatus />);
    failRequest("network");
    expect(runtime.wakeUp.getState().phase).toBe("waking");
    expect(screen.queryByText(WAKING)).toBeNull();
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
  });

  it("shows no waking line while the browser says offline, and shows it again when only the server is the problem", () => {
    renderWithApp(<WakeUpStatus />);
    failRequest("gateway");
    expect(screen.getByText(WAKING)).toBeInTheDocument();
    browserGoes("offline");
    expect(screen.queryByText(WAKING)).toBeNull();
    browserGoes("online");
    expect(screen.getByText(WAKING)).toBeInTheDocument();
  });

  it("carries a notice a shell hands it in the same region", () => {
    renderWithApp(<WakeUpStatus>{<p>handed in</p>}</WakeUpStatus>);
    expect(within(screen.getByRole("status")).getByText("handed in")).toBeInTheDocument();
  });
});

describe("FocusShell: a flow that is open keeps its state and is told what is true", () => {
  it("shows the notice, with no switch to the plan, while the device is offline", () => {
    renderWithApp(
      <FocusShell title="Flow">
        <Page />
      </FocusShell>,
    );
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
    browserGoes("offline");
    expect(screen.getByText(offlineEn.notice.title)).toBeInTheDocument();
    expect(screen.getByText(offlineEn.notice.body)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: offlineEn.notice.open })).toBeNull();
    expect(shellStandIn()).toBeNull();
    expect(draft()).toBeInTheDocument();
    browserGoes("online");
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
  });

  it("stays quiet when the screen speaks for the connection itself", () => {
    renderWithApp(
      <FocusShell title="Flow" offlineNotice={false}>
        <Page />
      </FocusShell>,
    );
    browserGoes("offline");
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
  });
});

describe("OfflineNotice", () => {
  it("has the offline text with its title, or the server text without one, and an action only when asked for", () => {
    const { rerender } = renderWithApp(<OfflineNotice kind="offline" />);
    expect(screen.getByText(offlineEn.notice.title)).toBeInTheDocument();
    expect(screen.getByText(offlineEn.notice.body)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <LocaleProvider>
        <ApiRuntimeProvider runtime={runtime}>
          <OfflineNotice kind="server" onOpenOffline={() => undefined} />
        </ApiRuntimeProvider>
      </LocaleProvider>,
    );
    expect(screen.getByText(offlineEn.notice.server)).toBeInTheDocument();
    expect(screen.queryByText(offlineEn.notice.title)).toBeNull();
    expect(screen.getByRole("button", { name: offlineEn.notice.open })).toBeInTheDocument();
  });

  it("has no em dash in the new text, in either language", () => {
    for (const text of Object.values(offlineAr.notice).concat(Object.values(offlineEn.notice))) expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
