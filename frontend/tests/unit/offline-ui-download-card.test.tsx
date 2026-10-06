import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/today", useRouter: () => navigation.router }));

const shell = vi.hoisted(() => ({ ready: true }));
vi.mock("@/lib/pwa/register", () => ({
  getShellStatus: async () => ({ supported: true, registered: true, controlled: true, shellReady: shell.ready, buildId: "b", missing: 0 }),
  subscribeShellReady: () => () => undefined,
}));

// The install controller is the browser's; here it is a stand-in whose state a test sets.
const install = vi.hoisted(() => ({
  state: { kind: "unsupported", inAppBrowser: null } as import("@/lib/offline/types").InstallState,
  prompt: vi.fn(async () => "accepted" as const),
  listeners: new Set<() => void>(),
}));
vi.mock("@/lib/pwa/install", () => ({
  getInstallController: () => ({
    getState: () => install.state,
    subscribe: (listener: () => void) => {
      install.listeners.add(listener);
      return () => install.listeners.delete(listener);
    },
    prompt: install.prompt,
  }),
}));

const environment = vi.hoisted(() => ({ inApp: null as string | null }));
vi.mock("@/lib/pwa/environment", () => ({
  detectEnvironment: () => ({ isIOS: false, isStandalone: false, inAppBrowser: environment.inApp, isSecureContext: true, supportsServiceWorker: true, supportsIndexedDB: true }),
}));

import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { DownloadCard, cardStatus } from "@/components/pwa/DownloadCard";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import * as planCache from "@/lib/offline/plan-cache";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { readOwnerState } from "@/lib/offline/owner";
import type { DownloadPhase, DownloadResult, LocalPlanInspection } from "@/lib/offline/types";
import { installDialogPolyfill } from "./dialog-polyfill";
import { PLAN_ID, USERNAME, makeSnapshot, resetOfflineEnvironment } from "./offline-support";

const snapshot = makeSnapshot();

function renderCard(planVersion = 1, language: "ar" | "en" = "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  return render(
    <LocaleProvider>
      <DownloadCard planId={PLAN_ID} planVersion={planVersion} />
    </LocaleProvider>,
  );
}

function download(result: DownloadResult | Error, during?: (phase: (name: DownloadPhase) => void) => Promise<void>) {
  return vi.spyOn(planCache, "downloadPlanForOffline").mockImplementation(async (_request, deps) => {
    await during?.((name) => deps?.onPhase?.(name));
    if (result instanceof Error) throw result;
    return result;
  });
}

beforeEach(() => {
  resetOfflineEnvironment();
  resetLocaleStoreForTests();
  shell.ready = true;
  environment.inApp = null;
  install.state = { kind: "unsupported", inAppBrowser: null };
  install.prompt.mockClear();
  installDialogPolyfill();
  document.documentElement.style.overflow = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("which state the card is in", () => {
  const base: LocalPlanInspection = { status: "none", owner: null, snapshot: null, record: null, revalidation: null, counts: { queued: 0, pending: 0, blocked: 0, total: 0 } };
  const record = { ...({} as LocalPlanInspection["record"] & object), planId: PLAN_ID, planVersion: 1 } as NonNullable<LocalPlanInspection["record"]>;

  it("is ready only for the plan and version of the screen; another version is an update to offer", () => {
    expect(cardStatus({ ...base, status: "ready", record }, PLAN_ID, 1)).toBe("ready");
    expect(cardStatus({ ...base, status: "ready", record }, PLAN_ID, 2)).toBe("update");
    expect(cardStatus({ ...base, status: "ready", record }, "another-plan", 1)).toBe("update");
    expect(cardStatus({ ...base, status: "stale", record }, PLAN_ID, 1)).toBe("update");
  });

  it("maps every other local status", () => {
    expect(cardStatus(base, PLAN_ID, 1)).toBe("download");
    expect(cardStatus({ ...base, status: "incomplete" }, PLAN_ID, 1)).toBe("download");
    expect(cardStatus({ ...base, status: "revoked" }, PLAN_ID, 1)).toBe("unavailable");
    expect(cardStatus({ ...base, status: "expired" }, PLAN_ID, 1)).toBe("unavailable");
    expect(cardStatus({ ...base, status: "locked" }, PLAN_ID, 1)).toBe("locked");
    expect(cardStatus({ ...base, status: "schema_incompatible" }, PLAN_ID, 1)).toBe("schema");
    expect(cardStatus({ ...base, status: "storage_error" }, PLAN_ID, 1)).toBe("storage");
  });
});

describe("S-32 the download card", () => {
  it("offers the download with the note about the device holder, and shows no ready state before anything is saved", async () => {
    renderCard();
    const heading = await screen.findByRole("heading", { level: 2, name: "Learning offline" });
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download the plan for offline use" })).toBeInTheDocument();
    expect(screen.getByText(/without encryption and without a lock/)).toBeInTheDocument();
    expect(screen.queryByText("Plan ready offline")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete the local copy" })).toBeNull();
  });

  it("speaks the fixed and the proposed Arabic in the Arabic interface", async () => {
    renderCard(1, "ar");
    expect(await screen.findByRole("button", { name: "نزّل الخطة للاستخدام دون اتصال" })).toBeInTheDocument();
    expect(screen.getByText(/دون تشفير ودون قفل/)).toBeInTheDocument();
  });

  it("omits the target passages (the server chooses them) and shows the phases while it runs, then the ready state", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const spy = download({ ready: true, snapshotId: snapshot.snapshotId }, async (phase) => {
      phase("preparing");
      await held;
      // What the real download leaves behind: the plan saved and ready.
      await cacheActivePlan(snapshot, { username: USERNAME });
    });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Download the plan for offline use" }));
    expect(await screen.findByText("Preparing the plan on the server")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download the plan for offline use" })).toHaveAttribute("aria-busy", "true");
    expect(spy.mock.calls[0]?.[0]).toEqual({ planId: PLAN_ID, expectedPlanVersion: 1 });
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("targetRefs");
    await act(async () => {
      finish();
    });
    expect(await screen.findByText("Plan ready offline")).toBeInTheDocument();
    expect(screen.getByText(/You can open the app and learn it offline/)).toBeInTheDocument();
    // Ready: the download button and the privacy note give way to the clear control.
    expect(screen.queryByRole("button", { name: "Download the plan for offline use" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete the local copy" })).toBeInTheDocument();
  });

  it("never claims ready while the app files are not cached, even with the plan saved", async () => {
    shell.ready = false;
    await cacheActivePlan(snapshot, { username: USERNAME });
    renderCard();
    expect(await screen.findByText(/app files are not ready to work offline yet/)).toBeInTheDocument();
    expect(screen.queryByText("Plan ready offline")).toBeNull();
  });

  it("offers the update when the plan moved on after the download", async () => {
    await cacheActivePlan(snapshot, { username: USERNAME });
    renderCard(2);
    expect(await screen.findByText(/Your plan changed after the download/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update the download" })).toBeInTheDocument();
    expect(screen.queryByText("Plan ready offline")).toBeNull();
  });

  it.each([
    [{ ready: false, snapshotId: null, failureCode: "storage_quota" }, /not enough space/],
    [{ ready: false, snapshotId: null, failureCode: "storage_insufficient" }, /not enough space/],
    [{ ready: false, snapshotId: null, failureCode: "storage_failed" }, /Saving on this device failed/],
    [{ ready: false, snapshotId: null, failureCode: "unsupported" }, /cannot save on the device/],
    [{ ready: false, snapshotId: null, failureCode: "offline" }, /needs an internet connection/],
    [{ ready: false, snapshotId: null, failureCode: "throttled" }, /Too many attempts/],
    [{ ready: false, snapshotId: null, failureCode: "unauthenticated" }, /session has ended/],
    [{ ready: false, snapshotId: null, failureCode: "owner_mismatch" }, /local copy of another account/],
    [{ ready: false, snapshotId: null, failureCode: "connectivity" }, /could not be completed/],
    [{ ready: false, snapshotId: null, failureCode: "server_unreachable" }, /could not be completed/],
    [{ ready: false, snapshotId: null, failureCode: "invalid_snapshot" }, /could not be completed/],
  ] as const)("says why a download failed (%j) and keeps the retry", async (result, text) => {
    const user = userEvent.setup();
    download(result as unknown as DownloadResult);
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Download the plan for offline use" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.getByRole("button", { name: "Download the plan for offline use" })).not.toHaveAttribute("aria-busy");
    expect(screen.queryByText("Plan ready offline")).toBeNull();
  });

  it("asks for a refresh when the plan version or state moved, and calls the book unavailable when it cannot be downloaded", async () => {
    const user = userEvent.setup();
    const spy = download({ ready: false, snapshotId: null, failureCode: "plan_version" });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Download the plan for offline use" }));
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument();
    spy.mockResolvedValue({ ready: false, snapshotId: null, failureCode: "edition_not_downloadable" });
    await user.click(screen.getByRole("button", { name: "Download the plan for offline use" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Unavailable"));
    expect(screen.getByRole("alert")).toHaveTextContent("not available to download right now");
  });

  it("treats a thrown error as a failed download", async () => {
    const user = userEvent.setup();
    download(new Error("boom"));
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Download the plan for offline use" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be completed");
  });

  it("shows nothing in a browser that cannot keep data on the device", async () => {
    vi.spyOn(planCache, "inspectLocalPlan").mockResolvedValue({ status: "none", owner: null, snapshot: null, record: null, revalidation: null, counts: { queued: 0, pending: 0, blocked: 0, total: 0 }, failureCode: "unsupported" });
    const { container } = renderCard();
    await waitFor(() => expect(planCache.inspectLocalPlan).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("gives an in-app browser only the open-in-browser hint, and no download", async () => {
    environment.inApp = "Instagram";
    install.state = { kind: "in_app_browser", inAppBrowser: "Instagram" };
    renderCard();
    expect(await screen.findByText("Open in the browser")).toBeInTheDocument();
    expect(screen.getByText(/cannot install the app or run it offline/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download the plan for offline use" })).toBeNull();
  });

  it("clears the local copy after a confirmation that says the account is not deleted and unsent answers are lost", async () => {
    const user = userEvent.setup();
    await cacheActivePlan(snapshot, { username: USERNAME });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Delete the local copy" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/not your account/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete the local copy" }));
    expect(await screen.findByText("The local copy was deleted")).toBeInTheDocument();
    expect((await readOwnerState())?.ownerId ?? null).toBeNull();
    // The card goes back to offering the download.
    expect(await screen.findByRole("button", { name: "Download the plan for offline use" })).toBeInTheDocument();
  });

  it("keeps the copy when the learner cancels the confirmation", async () => {
    const user = userEvent.setup();
    await cacheActivePlan(snapshot, { username: USERNAME });
    renderCard();
    await user.click(await screen.findByRole("button", { name: "Delete the local copy" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect((await readOwnerState())?.ownerId).not.toBeNull();
  });
});

describe("S-33 install help", () => {
  it("shows the browser's install button only when it was captured, and says an install alone proves nothing", async () => {
    const user = userEvent.setup();
    install.state = { kind: "available", inAppBrowser: null };
    render(
      <LocaleProvider>
        <InstallPrompt />
      </LocaleProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Install the app" }));
    expect(install.prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Installing alone does not mean the plan is ready offline/)).toBeInTheDocument();
  });

  it("shows the Share steps on iOS Safari, the browser hint in an in-app browser, and nothing when installed or unsupported", () => {
    const view = render(
      <LocaleProvider>
        <InstallPrompt />
      </LocaleProvider>,
    );
    expect(view.container).toBeEmptyDOMElement();
    for (const [kind, text] of [
      ["ios_instructions", /tap the Share button/],
      ["in_app_browser", /Open in the browser/],
    ] as const) {
      install.state = { kind, inAppBrowser: kind === "in_app_browser" ? "Facebook" : null };
      const next = render(
        <LocaleProvider>
          <InstallPrompt />
        </LocaleProvider>,
      );
      expect(next.container).toHaveTextContent(text);
      next.unmount();
    }
    install.state = { kind: "installed", inAppBrowser: null };
    expect(render(<LocaleProvider><InstallPrompt /></LocaleProvider>).container).toBeEmptyDOMElement();
  });
});
