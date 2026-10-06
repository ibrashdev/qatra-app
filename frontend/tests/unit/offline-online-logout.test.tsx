import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/settings", useRouter: () => navigation.router }));

import { UnsyncedLogoutDialog, resetLogoutGuardForTests } from "@/components/pwa/logout-guard";
import { useLogout } from "@/components/settings/use-logout";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime } from "@/lib/api/runtime";
import { bindOnlineAccount, countOnlineEvents, recordOnlineEvents } from "@/lib/offline/online-journal";
import { enqueueEvent } from "@/lib/offline/outbox";
import { readOwnerState } from "@/lib/offline/owner";
import { cacheActivePlan } from "@/lib/offline/plan-cache";
import { installDialogPolyfill } from "./dialog-polyfill";
import { USERNAME, activityAt, makeSnapshot, resetOfflineEnvironment } from "./offline-support";
import { ONLINE_SESSION, onlineAnswerAt } from "./offline-online-support";

// The logout dialog counts the unsent answers of the online journal too (an ordinary online session keeps its events there until the server has them).

const RUN = "99999999-9999-4999-8999-999999999994";

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

function renderHarness(fetchImpl: typeof fetch) {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
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

describe("logout with answers that were only played online", () => {
  it("asks first when only the online journal holds unsent answers, keeps them on cancel and makes no server call", async () => {
    const binding = await bindOnlineAccount(USERNAME);
    await recordOnlineEvents(binding, ONLINE_SESSION, "daily", [onlineAnswerAt(0), onlineAnswerAt(1000)]);
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => noContent());
    renderHarness(fetchImpl);

    await user.click(screen.getByRole("button", { name: "logout" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("2 answers have not synced yet");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("idle"));
    expect(logoutCalls(fetchImpl)).toBe(0);
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ total: 2 });
  });

  it("adds them to the offline answers of a downloaded copy, and deletes both with the session once the learner agrees", async () => {
    const snapshot = makeSnapshot();
    await cacheActivePlan(snapshot, { username: USERNAME });
    const owner = (await readOwnerState())!;
    await enqueueEvent(owner.ownerId!, snapshot.preparedSessions[0]!.sessionId, activityAt(snapshot, RUN, 0, 0, 5000));
    const binding = await bindOnlineAccount(USERNAME);
    await recordOnlineEvents(binding, ONLINE_SESSION, "game", [onlineAnswerAt(0), onlineAnswerAt(1000)]);
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => noContent());
    renderHarness(fetchImpl);

    await user.click(screen.getByRole("button", { name: "logout" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("3 answers have not synced yet");
    await user.click(within(dialog).getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(logoutCalls(fetchImpl)).toBe(1);
    expect(await countOnlineEvents(binding.accountKey)).toMatchObject({ total: 0 });
    expect((await readOwnerState())!).toMatchObject({ ownerId: null, username: null });
  });

  it("does not ask when the journal is empty", async () => {
    await bindOnlineAccount(USERNAME);
    const user = userEvent.setup();
    const fetchImpl = vi.fn<typeof fetch>(async () => noContent());
    renderHarness(fetchImpl);
    await user.click(screen.getByRole("button", { name: "logout" }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
