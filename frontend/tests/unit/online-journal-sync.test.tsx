import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONLINE_SYNC_MIN_GAP_MS, OnlineJournalSync } from "@/components/pwa/OnlineJournalSync";
import { ApiRuntimeProvider } from "@/lib/api/react";
import type { ApiRuntime } from "@/lib/api/runtime";
import type { WakeUpPhase } from "@/lib/api/wakeup";

// The trigger of the online journal: when the app opens, when the free server finishes waking up, and when the connection returns, and only when the
// journal holds something. Every seam is a fake; nothing here touches IndexedDB or the network.

function fakeRuntime() {
  let current: { phase: WakeUpPhase } = { phase: "idle" };
  const listeners = new Set<() => void>();
  const wakeUp = {
    getState: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const runtime = { wakeUp, boot: () => undefined } as unknown as ApiRuntime;
  return {
    runtime,
    setPhase(next: WakeUpPhase) {
      // A new object, as the real controller does, so the store notices.
      current = { phase: next };
      listeners.forEach((listener) => listener());
    },
  };
}

function mount({ work = true, now = () => 1_000_000 }: { work?: boolean | (() => boolean); now?: () => number } = {}) {
  const harness = fakeRuntime();
  const hasWork = vi.fn(async () => (typeof work === "function" ? work() : work));
  const run = vi.fn(async (trigger: string) => ({ trigger }));
  const view = render(
    <ApiRuntimeProvider runtime={harness.runtime}>
      <OnlineJournalSync hasWork={hasWork} run={run} now={now} />
    </ApiRuntimeProvider>,
  );
  return { ...harness, hasWork, run, ...view };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

let onLine = true;
beforeEach(() => {
  onLine = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => onLine);
});
afterEach(() => vi.restoreAllMocks());

describe("OnlineJournalSync", () => {
  it("renders nothing", async () => {
    const view = mount();
    await flush();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("runs the sync once when the app opens with something to send", async () => {
    const view = mount();
    await flush();
    expect(view.hasWork).toHaveBeenCalledTimes(1);
    expect(view.run).toHaveBeenCalledTimes(1);
    expect(view.run).toHaveBeenCalledWith("app_open");
  });

  it("starts nothing when the journal holds nothing", async () => {
    const view = mount({ work: false });
    await flush();
    expect(view.hasWork).toHaveBeenCalledTimes(1);
    expect(view.run).not.toHaveBeenCalled();
  });

  it("does not even look while the browser says it is offline", async () => {
    onLine = false;
    const view = mount();
    await flush();
    expect(view.hasWork).not.toHaveBeenCalled();
    expect(view.run).not.toHaveBeenCalled();
  });

  it("runs when the connection returns, at once, as a reconnect, even inside the quiet window", async () => {
    const view = mount();
    await flush();
    expect(view.run).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await flush();
    expect(view.run).toHaveBeenCalledTimes(2);
    expect(view.run).toHaveBeenLastCalledWith("reconnect");
  });

  it("runs when the free server finishes waking up, but never more than once in 20 seconds", async () => {
    let clock = 1_000_000;
    const view = mount({ now: () => clock });
    await flush();
    expect(view.run).toHaveBeenCalledTimes(1);
    // Ten seconds later the server becomes ready: inside the window, so no second run.
    clock += 10_000;
    act(() => view.setPhase("ready"));
    await flush();
    expect(view.run).toHaveBeenCalledTimes(1);
    // After the window another wake-up counts.
    act(() => view.setPhase("waking"));
    clock += ONLINE_SYNC_MIN_GAP_MS;
    act(() => view.setPhase("ready"));
    await flush();
    expect(view.run).toHaveBeenCalledTimes(2);
    expect(view.run).toHaveBeenLastCalledWith("app_open");
  });

  it("does not count a look that found nothing as a run, so work that appears a moment later is not held back", async () => {
    let work = false;
    const view = mount({ work: () => work });
    await flush();
    expect(view.run).not.toHaveBeenCalled();
    work = true;
    act(() => view.setPhase("ready"));
    await flush();
    expect(view.run).toHaveBeenCalledTimes(1);
  });

  it("survives a check or a sync that throws", async () => {
    const harness = fakeRuntime();
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    render(
      <ApiRuntimeProvider runtime={harness.runtime}>
        <OnlineJournalSync hasWork={async () => true} run={run} />
      </ApiRuntimeProvider>,
    );
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops listening when it unmounts", async () => {
    const view = mount();
    await flush();
    view.unmount();
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await flush();
    expect(view.run).toHaveBeenCalledTimes(1);
  });
});
