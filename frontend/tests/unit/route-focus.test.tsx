import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/today" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

import { PublicShell } from "@/components/ui/PublicShell";
import { resetRouteFocusForTests, useRouteFocus } from "@/components/ui/use-page-chrome";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime, type ApiRuntime } from "@/lib/api/runtime";

const healthy = () => new Response(JSON.stringify({ status: "ok", version: "t", time: "2026-10-05T00:00:00Z" }), { status: 200 });

let runtime: ApiRuntime;
// jsdom does not scroll and has no scrollIntoView: the calls are recorded, by the id of the element that was scrolled to.
let scrolledTo: string[] = [];
const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;

function renderWithApp(ui: ReactNode) {
  runtime = createApiRuntime({ mode: "live", fetch: vi.fn<typeof fetch>(async () => healthy()) });
  return render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>{ui}</ApiRuntimeProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  resetLocaleStoreForTests();
  resetRouteFocusForTests();
  navigation.pathname = "/today";
  scrolledTo = [];
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    scrolledTo.push(this.id);
  };
});

afterEach(() => {
  runtime?.wakeUp.dispose();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

// A page with a heading and two anchored headings, like S-03 (UI-screens P-01: a route that opens on an anchor focuses that heading).
const page = (
  <>
    <h1 data-page-heading tabIndex={-1}>
      Page
    </h1>
    <h2 id="terms" tabIndex={-1}>
      Terms
    </h2>
    <h2 id="privacy" tabIndex={-1}>
      Privacy
    </h2>
    <h2 id="plain">Not focusable</h2>
  </>
);

function arrive(path: string, hash: string, props: { moveFocus?: boolean } = {}) {
  navigation.pathname = path;
  window.history.replaceState(null, "", `${path}${hash}`);
  return renderWithApp(<PublicShell {...props}>{page}</PublicShell>);
}

describe("route focus with anchors and with a loading view (UI-screens P-01, S-03 states)", () => {
  it("moves focus to the heading an anchor names, not to the page heading, when a new route opens with it", () => {
    arrive("/register", "").unmount();
    arrive("/terms", "#privacy");
    expect(screen.getByRole("heading", { level: 2, name: "Privacy" })).toHaveFocus();
  });

  it("scrolls the anchor to the top of the page as well, since a late route or a changed text has moved it", () => {
    arrive("/register", "").unmount();
    arrive("/terms", "#privacy");
    expect(scrolledTo).toEqual(["privacy"]);
  });

  it("gives focus to the anchor on the first load too, because the address asks for that place", () => {
    arrive("/terms", "#terms");
    expect(screen.getByRole("heading", { level: 2, name: "Terms" })).toHaveFocus();
    expect(scrolledTo).toEqual(["terms"]);
  });

  it("reads an anchor written with escapes", () => {
    arrive("/register", "").unmount();
    arrive("/terms", "#%70rivacy");
    expect(screen.getByRole("heading", { level: 2, name: "Privacy" })).toHaveFocus();
  });

  it("ignores an anchor that is malformed, missing or not focusable, and moves to the page heading instead, without scrolling", () => {
    for (const hash of ["#%E0%A4%A", "#nowhere", "#plain"]) {
      resetRouteFocusForTests();
      arrive("/register", "").unmount();
      arrive("/terms", hash);
      expect(screen.getByRole("heading", { level: 1, name: "Page" }), hash).toHaveFocus();
      cleanup();
    }
    expect(scrolledTo).toEqual([]);
  });

  it("leaves focus alone, and the scroll too, on the first load when there is no anchor", () => {
    arrive("/terms", "");
    expect(document.body).toHaveFocus();
    expect(scrolledTo).toEqual([]);
  });

  it("does not use up the route change when it is told not to move focus, so the next screen still focuses its heading", () => {
    arrive("/register", "").unmount();
    const loading = arrive("/terms", "", { moveFocus: false });
    expect(document.body).toHaveFocus();
    loading.unmount();
    arrive("/terms", "");
    expect(screen.getByRole("heading", { level: 1, name: "Page" })).toHaveFocus();
  });
});

describe("route focus waits for the page to be settled", () => {
  function Probe() {
    useRouteFocus();
    return page;
  }

  it("acts once, after hydration, not on the server markup in the server's language: a text that changes length would leave the anchor out of place", async () => {
    navigation.pathname = "/terms";
    window.history.replaceState(null, "", "/terms#privacy");
    const markup = renderToString(<Probe />);
    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.append(container);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <Probe />);
    });
    expect(container.querySelector("#privacy")).toHaveFocus();
    // One scroll, from the settled page: the pass that hydrates the markup does nothing.
    expect(scrolledTo).toEqual(["privacy"]);
    act(() => root?.unmount());
    container.remove();
  });
});
