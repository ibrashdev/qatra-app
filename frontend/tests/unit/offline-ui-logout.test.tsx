import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => navigation.router }));

import { UnsyncedLogoutDialog, confirmUnsyncedLogout, resetLogoutGuardForTests } from "@/components/pwa/logout-guard";
import { AccountSyncChip, OfflineAccountRows } from "@/components/pwa/OfflineSettings";
import { useLogout } from "@/components/settings/use-logout";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime } from "@/lib/api/runtime";
import { enqueueEvent, listPendingEvents } from "@/lib/offline/outbox";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { readOwnerState } from "@/lib/offline/owner";
import { installDialogPolyfill } from "./dialog-polyfill";
import { USERNAME, activityAt, makeSnapshot, resetOfflineEnvironment } from "./offline-support";

const snapshot = makeSnapshot();
const RUN = "99999999-9999-4999-8999-999999999993";

function Harness() {
  const logout = useLogout();
  return (
    <>
      <button type="button" onClick={() => void logout.press()}>
        logout
      </button>
      <p role="status">{logout.failed ? "failed" : logout.loggingOut ? "busy" : "idle"}</p>
      <UnsyncedLogoutDialog />
    </>
  );
}

function renderHarness(fetchImpl: typeof fetch, language: "ar" | "en" = "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const runtime = createApiRuntime({ mode: "live", fetch: fetchImpl });
  return render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <Harness />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
}

const noContent = () => new Response(null, { status: 204 });

async function seed(unsynced: number) {
  await cacheActivePlan(snapshot, { username: USERNAME });
  const owner = await readOwnerState();
  for (let index = 0; index < unsynced; index += 1) await enqueueEvent(owner!.ownerId!, snapshot.preparedSessions[0]!.sessionId, activityAt(snapshot, RUN, index, index * 10_000, 5000));
}

const logoutCalls = (fetchImpl: ReturnType<typeof vi.fn>) => fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/api/auth/logout")).length;

beforeEach(() => {
  resetOfflineEnvironment();
  resetLogoutGuardForTests();
  resetLocaleStoreForTests();
  navigation.router.push.mockReset();
  navigation.router.replace.mockReset();
  installDialogPolyfill();
  document.documentElement.style.overflow = "";
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the logout dialog of unsynced answers (S-22 section 6.9, deferred to option C)", () => {
  it("asks first with the fixed words, keeps everything on «إلغاء» and makes no server call", async () => {
    await seed(2);
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => noContent());
    renderHarness(fetchImpl, "ar");
    await user.click(screen.getByRole("button", { name: "logout" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "تسجيل الخروج؟" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("لديك ٢ إجابات لم تُزامن بعد. إن خرجت الآن فستُحذف من هذا الجهاز.");
    // «إلغاء» takes the initial focus, so Enter alone never deletes anything.
    expect(within(dialog).getByRole("button", { name: "إلغاء" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "إلغاء" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("idle"));
    expect(logoutCalls(fetchImpl)).toBe(0);
    expect(await listPendingEvents((await readOwnerState())!.ownerId!)).toHaveLength(2);
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("logs out on the server, then wipes the copy and the answers, bumps the generation and goes to the login screen", async () => {
    await seed(2);
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => noContent());
    renderHarness(fetchImpl);
    const before = (await readOwnerState())!;
    await user.click(screen.getByRole("button", { name: "logout" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("2 answers have not synced yet");
    await user.click(within(dialog).getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(logoutCalls(fetchImpl)).toBe(1);
    const after = (await readOwnerState())!;
    expect(after.ownerId).toBeNull();
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(after.logoutPending).toBe(false);
    expect(await listPendingEvents(before.ownerId!)).toHaveLength(0);
  });

  it("does not ask when nothing is unsynced, but still wipes the plan copy with the session", async () => {
    await seed(0);
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => noContent());
    renderHarness(fetchImpl);
    await user.click(screen.getByRole("button", { name: "logout" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect((await readOwnerState())!.ownerId).toBeNull();
  });

  it("a logout pressed with no connection wipes the copy at once and records that the server logout is still owed", async () => {
    await seed(1);
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    renderHarness(fetchImpl);
    await user.click(screen.getByRole("button", { name: "logout" }));
    await user.click(await within(await screen.findByRole("alertdialog")).findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    const owner = (await readOwnerState())!;
    expect(owner.ownerId).toBeNull();
    expect(owner.logoutPending).toBe(true);
  });

  it("keeps the copy, and says so, when the server could not be asked while the device was online", async () => {
    await seed(1);
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: "unavailable", message: "m", details: {} } }), { status: 503, headers: { "Content-Type": "application/json" } }));
    renderHarness(fetchImpl);
    await user.click(screen.getByRole("button", { name: "logout" }));
    await user.click(await within(await screen.findByRole("alertdialog")).findByRole("button", { name: "Log out" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("failed"));
    expect(navigation.router.replace).not.toHaveBeenCalled();
    expect((await readOwnerState())!.ownerId).not.toBeNull();
    expect(await listPendingEvents((await readOwnerState())!.ownerId!)).toHaveLength(1);
  });

  it("refuses, rather than waiting for ever, when no dialog is on screen to ask", async () => {
    await expect(confirmUnsyncedLogout(3)).resolves.toBe(false);
  });
});

describe("the offline rows of the settings screen", () => {
  function renderRows(language: "ar" | "en" = "en") {
    localStorage.setItem(LOCALE_STORAGE_KEY, language);
    resetLocaleStoreForTests();
    return render(
      <LocaleProvider>
        <AccountSyncChip />
        <OfflineAccountRows />
      </LocaleProvider>,
    );
  }

  it("shows «متزامن» and no extra row when nothing is on the device, exactly as before the offline plan", async () => {
    const { container } = renderRows("ar");
    expect(await screen.findByText("متزامن")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/الخطة على هذا الجهاز/)).toBeNull());
    expect(container.querySelector("button")).toBeNull();
  });

  it("shows «محفوظ على الجهاز، بانتظار المزامنة» while answers wait, the plan row and the clear control", async () => {
    await seed(1);
    renderRows("ar");
    expect(await screen.findByText("محفوظ على الجهاز، بانتظار المزامنة")).toBeInTheDocument();
    expect(await screen.findByText(/الخطة على هذا الجهاز:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "احذف النسخة المحلية" })).toBeInTheDocument();
  });
});
