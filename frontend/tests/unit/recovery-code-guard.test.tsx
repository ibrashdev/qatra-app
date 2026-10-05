import { act, fireEvent, render } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecoveryCodeLeaveGuard, type LeaveGuard } from "@/components/auth/RecoveryCodeLeaveGuard";

// The guard against jsdom's own history. `router` stands for the listener of the App Router: it must not see a pop that belongs to the guard.
let guard: LeaveGuard;
let attempts: number;
let routerPops: number;
let removeWatch: () => void;
const waiters: Array<() => void> = [];

function Probe({ active, onAttempt }: { active: boolean; onAttempt: () => void }) {
  const current = useRecoveryCodeLeaveGuard({ active, onAttempt });
  useEffect(() => {
    guard = current;
  });
  return (
    <div>
      <a href="/settings">inside</a>
      <a href="/recovery-code#note">same page</a>
      <a href="/recovery-code?x=1">same path, other query</a>
      <a href="https://elsewhere.example/page">outside</a>
      <a href="/settings" target="_blank">
        new tab
      </a>
      <a href="/settings" download="file.txt">
        file
      </a>
      <a href="blob:http://localhost:3000/abc">blob</a>
      <a href="mailto:someone@example.test">mail</a>
      <a>no address</a>
      <a href="/settings">
        <span>nested</span>
      </a>
      <p>not a link</p>
    </div>
  );
}

function renderProbe(active = true, strict = false) {
  const element = <Probe active={active} onAttempt={() => (attempts += 1)} />;
  const view = render(strict ? <StrictMode>{element}</StrictMode> : element);
  return {
    ...view,
    setActive: (next: boolean) => view.rerender(strict ? <StrictMode><Probe active={next} onAttempt={() => (attempts += 1)} /></StrictMode> : <Probe active={next} onAttempt={() => (attempts += 1)} />),
  };
}

// The next pop the browser reports, seen before the guard can swallow it.
const nextPop = () => new Promise<void>((resolve) => void waiters.push(resolve));

async function back() {
  const done = nextPop();
  act(() => window.history.back());
  await done;
  // Let the guard's own listener and any follow-up run.
  await act(async () => undefined);
}

const stateOf = () => window.history.state as Record<string, unknown> | null;

beforeEach(() => {
  attempts = 0;
  routerPops = 0;
  window.history.replaceState({ origin: true }, "", "/recovery-code");
  const watch = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  const router = () => {
    routerPops += 1;
  };
  window.addEventListener("popstate", watch, true);
  window.addEventListener("popstate", router);
  removeWatch = () => {
    window.removeEventListener("popstate", watch, true);
    window.removeEventListener("popstate", router);
  };
});

afterEach(() => {
  removeWatch();
});

describe("the entry the guard adds (S-04 section 3, leave dialog)", () => {
  it("is one entry on top of the screen's own, holding a marker and nothing else", () => {
    const before = window.history.length;
    renderProbe();
    expect(window.history.length).toBe(before + 1);
    expect(stateOf()).toEqual({ qatraRecoveryCodeGuard: true });
    expect(window.location.pathname).toBe("/recovery-code");
    expect(window.location.search + window.location.hash).toBe("");
  });

  it("is added once even when development runs the effect twice", () => {
    const before = window.history.length;
    renderProbe(true, true);
    expect(window.history.length).toBe(before + 1);
  });

  it("does not add the entry again when only the box changes", () => {
    const { setActive } = renderProbe(true);
    const length = window.history.length;
    setActive(false);
    setActive(true);
    expect(window.history.length).toBe(length);
  });
});

describe("Back or an edge swipe with the box unchecked", () => {
  it("uses the entry up, asks once, and keeps the pop from the router", async () => {
    renderProbe(true);
    await back();
    expect(attempts).toBe(1);
    expect(routerPops).toBe(0);
    expect(stateOf()).toEqual({ origin: true });
    expect(window.location.pathname).toBe("/recovery-code");
  });

  it("does not ask again for a later pop: the entry is used up until the guard adds it again", async () => {
    renderProbe(true);
    await back();
    expect(attempts).toBe(1);
    // A second Back while the dialog is open is a plain navigation: the router gets it.
    window.history.pushState({ other: true }, "", "/recovery-code");
    await back();
    expect(attempts).toBe(1);
    expect(routerPops).toBe(1);
  });

  it("adds the entry again after Stay, so the next Back asks again", async () => {
    renderProbe(true);
    await back();
    act(() => guard.rearm());
    expect(stateOf()).toEqual({ qatraRecoveryCodeGuard: true });
    await back();
    expect(attempts).toBe(2);
    expect(routerPops).toBe(0);
  });

  it("adds the entry only once however often it is asked to", async () => {
    renderProbe(true);
    const length = window.history.length;
    act(() => guard.rearm());
    expect(window.history.length).toBe(length);
    await back();
    act(() => guard.rearm());
    const afterOne = window.history.length;
    act(() => guard.rearm());
    expect(window.history.length).toBe(afterOne);
  });

  it("asks nothing for a jump within the page (the skip link): the browser reports it with no state, and the router is left to see it", () => {
    renderProbe(true);
    act(() => window.history.pushState(null, "", "/recovery-code#main"));
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    expect(attempts).toBe(0);
    expect(routerPops).toBe(1);
    expect(stateOf()).toBeNull();
  });

  it("is still on top after Back from an in-page jump, and asks on the Back after that", async () => {
    renderProbe(true);
    act(() => window.history.pushState(null, "", "/recovery-code#main"));
    await back();
    expect(attempts).toBe(0);
    expect(stateOf()).toEqual({ qatraRecoveryCodeGuard: true });
    await back();
    expect(attempts).toBe(1);
  });
});

describe("Back with the box checked", () => {
  it("asks nothing, steps aside and lets the Back press go on to the page before", async () => {
    renderProbe(false);
    const goBack = vi.spyOn(window.history, "back");
    await back();
    expect(attempts).toBe(0);
    expect(goBack).toHaveBeenCalledTimes(2);
    expect(routerPops).toBe(0);
  });

  it("gives the router every pop after it has stepped aside", async () => {
    renderProbe(false);
    await back();
    await act(async () => undefined);
    window.history.pushState({ other: true }, "", "/recovery-code");
    await back();
    expect(routerPops).toBeGreaterThanOrEqual(1);
    expect(attempts).toBe(0);
  });

  it("asks when the box is unchecked again before the Back press", async () => {
    const { setActive } = renderProbe(false);
    setActive(true);
    await back();
    expect(attempts).toBe(1);
  });
});

describe("release: before the screen leaves by itself", () => {
  it("takes the guard's entry out of the history, waits for the browser to report it, and keeps the pop from the router", async () => {
    renderProbe(true);
    let resolved = false;
    const done = guard.release().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await act(async () => {
      await done;
    });
    expect(resolved).toBe(true);
    expect(stateOf()).toEqual({ origin: true });
    expect(routerPops).toBe(0);
    expect(attempts).toBe(0);
  });

  it.each([1, 2])("takes out the jumps within the page that were made above its entry too (%s of them), so the screen's own entry is current again", async (jumps) => {
    renderProbe(true);
    for (let jump = 0; jump < jumps; jump += 1) act(() => window.history.pushState(null, "", `/recovery-code#jump-${jump}`));
    await act(async () => {
      await guard.release();
    });
    expect(stateOf()).toEqual({ origin: true });
    expect(window.location.hash).toBe("");
    expect(routerPops).toBe(0);
    expect(attempts).toBe(0);
  });

  it("is already done when Back has used the entry up", async () => {
    renderProbe(true);
    await back();
    const goBack = vi.spyOn(window.history, "back");
    await guard.release();
    expect(goBack).not.toHaveBeenCalled();
  });

  it("gives up waiting after a second when the browser never reports the pop, and then lets the next pop through", async () => {
    vi.useFakeTimers();
    try {
      renderProbe(true);
      vi.spyOn(window.history, "back").mockImplementation(() => undefined);
      let resolved = false;
      void guard.release().then(() => {
        resolved = true;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(999);
      });
      expect(resolved).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(resolved).toBe(true);
      // A pop that arrives later is nobody's but the router's.
      window.dispatchEvent(new PopStateEvent("popstate", { state: { other: true } }));
      expect(routerPops).toBe(1);
      expect(attempts).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a click on a link inside the app, with the box unchecked", () => {
  // The listener of the router sits after the guard's, in the bubble phase, and stops jsdom from trying to navigate.
  let reached: boolean[];
  let stopNavigation: (event: Event) => void;

  beforeEach(() => {
    reached = [];
    stopNavigation = (event) => {
      reached.push(event.defaultPrevented);
      event.preventDefault();
    };
    document.addEventListener("click", stopNavigation);
  });

  afterEach(() => {
    document.removeEventListener("click", stopNavigation);
  });

  const link = (name: string) => document.evaluate(`//a[normalize-space(.)='${name}']`, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE).singleNodeValue as HTMLElement;

  it("is stopped before the router sees it, and asks", () => {
    renderProbe(true);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link("inside").dispatchEvent(event);
    expect(attempts).toBe(1);
    expect(event.defaultPrevented).toBe(true);
    expect(reached).toEqual([]);
  });

  it("is stopped from a glyph or text inside the link too", () => {
    renderProbe(true);
    fireEvent.click(document.querySelector("a > span") as HTMLElement);
    expect(attempts).toBe(1);
    expect(reached).toEqual([]);
  });

  it("is stopped when only the query differs: that is another address of the app", () => {
    renderProbe(true);
    fireEvent.click(link("same path, other query"));
    expect(attempts).toBe(1);
    expect(reached).toEqual([]);
  });

  it.each([
    ["a link out of the app (beforeunload covers it)", "outside"],
    ["a link that opens a new tab", "new tab"],
    ["a file download", "file"],
    ["a blob address", "blob"],
    ["a mail address", "mail"],
    ["a jump within this page", "same page"],
    ["an anchor without an address", "no address"],
  ])("is left alone: %s", (_name, text) => {
    renderProbe(true);
    fireEvent.click(link(text));
    expect(attempts).toBe(0);
    expect(reached).toEqual([false]);
  });

  it.each([
    ["with Ctrl", { ctrlKey: true }],
    ["with Meta", { metaKey: true }],
    ["with Shift", { shiftKey: true }],
    ["with Alt", { altKey: true }],
    ["with the middle button", { button: 1 }],
    ["with the right button", { button: 2 }],
  ])("is left alone when pressed %s: the browser opens another place", (_name, init) => {
    renderProbe(true);
    fireEvent.click(link("inside"), init);
    expect(attempts).toBe(0);
  });

  it("is left alone when something earlier already handled it, and when it is not on a link", () => {
    renderProbe(true);
    const handled = (event: Event) => event.preventDefault();
    window.addEventListener("click", handled, true);
    fireEvent.click(link("inside"));
    window.removeEventListener("click", handled, true);
    expect(attempts).toBe(0);
    fireEvent.click(document.querySelector("p") as HTMLElement);
    expect(attempts).toBe(0);
  });

  it("is left alone once the box is checked: nothing is lost then", () => {
    const { setActive } = renderProbe(true);
    setActive(false);
    fireEvent.click(link("inside"));
    expect(attempts).toBe(0);
    expect(reached).toEqual([false]);
  });
});

describe("closing the tab, reloading or leaving the app (beforeunload)", () => {
  // A plain event stands in for the browser's; its legacy return value is recorded, because a plain event would turn it into a cancel.
  let returnValue: unknown;

  function unload(): Event {
    returnValue = "not set";
    const event = new Event("beforeunload", { cancelable: true });
    Object.defineProperty(event, "returnValue", {
      configurable: true,
      get: () => returnValue,
      set: (value: unknown) => {
        returnValue = value;
      },
    });
    window.dispatchEvent(event);
    return event;
  }

  it("asks the browser for its own prompt while the box is unchecked, by cancelling the event and by the legacy return value", () => {
    renderProbe(true);
    const event = unload();
    expect(event.defaultPrevented).toBe(true);
    expect(returnValue).toBe("");
  });

  it("does not ask once the box is checked, and asks again if it is unchecked", () => {
    const { setActive } = renderProbe(true);
    setActive(false);
    expect(unload().defaultPrevented).toBe(false);
    expect(returnValue).toBe("not set");
    setActive(true);
    expect(unload().defaultPrevented).toBe(true);
  });

  it("does not ask in a checked screen from the start", () => {
    renderProbe(false);
    expect(unload().defaultPrevented).toBe(false);
    expect(returnValue).toBe("not set");
  });
});

describe("when the screen goes away", () => {
  it("stops watching: Back, links and unloading are left to the browser", async () => {
    const { unmount } = renderProbe(true);
    unmount();
    const unloadEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloadEvent);
    expect(unloadEvent.defaultPrevented).toBe(false);
    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const anchor = document.body.appendChild(document.createElement("a"));
    anchor.href = "/settings";
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener("click", stop);
    anchor.dispatchEvent(clickEvent);
    document.removeEventListener("click", stop);
    anchor.remove();
    expect(attempts).toBe(0);
    window.dispatchEvent(new PopStateEvent("popstate", { state: { other: true } }));
    expect(attempts).toBe(0);
    expect(routerPops).toBe(1);
  });
});
