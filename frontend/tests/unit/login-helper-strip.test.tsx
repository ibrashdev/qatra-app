import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/login", useRouter: () => navigation.router }));

import { LoginForm } from "@/components/auth/LoginForm";
import { LoginHelperStrip } from "@/components/auth/LoginHelperStrip";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { ApiRuntimeProvider } from "@/lib/api/react";
import { createApiRuntime } from "@/lib/api/runtime";
import { createMockFetch } from "@/lib/api/mock";

function renderLogin(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
  const runtime = createApiRuntime({ mode: "live", fetch: createMockFetch({ latencyMs: 0, scenario: { signedIn: false } }) });
  return render(
    <LocaleProvider>
      <ApiRuntimeProvider runtime={runtime}>
        <LoginForm />
      </ApiRuntimeProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

describe("S-01 helper strip (FC-06, owner-approved wording of 5 October 2026)", () => {
  it("shows the Arabic heading and the three steps in reading order, as a list named by the heading", () => {
    renderLogin("ar");
    const list = screen.getByRole("list", { name: "حفظٌ بخطوات واضحة" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["تدرّب", "راجع", "ثبّت حفظك"]);
  });

  it("shows the English heading and the three steps in the same order", () => {
    renderLogin("en");
    const list = screen.getByRole("list", { name: "Memorize in clear steps" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Practise", "Review", "Secure your memorization"]);
  });

  it("comes after the help links, is static and announces nothing beyond the list", () => {
    renderLogin("en");
    const list = screen.getByRole("list", { name: "Memorize in clear steps" });
    const strip = list.parentElement as HTMLElement;
    const create = screen.getByRole("link", { name: "Create an account" });
    expect(Boolean(create.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(strip.querySelector("a, button, input, [role=status], [role=alert], [aria-live]")).toBeNull();
    expect(strip.textContent).not.toMatch(/[←→⟵⟶]/);
  });

  it("hides the glyphs from assistive technology, does not mirror them and shows the strip on phones only", () => {
    renderLogin("ar");
    const list = screen.getByRole("list", { name: "حفظٌ بخطوات واضحة" });
    const glyphs = list.querySelectorAll("svg");
    expect(glyphs).toHaveLength(3);
    for (const glyph of glyphs) {
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(glyph).not.toHaveClass("rtl:-scale-x-100");
    }
    const strip = list.parentElement as HTMLElement;
    expect(strip).toHaveClass("p-q12", "tablet:hidden");
    expect(list).toHaveClass("flex", "flex-wrap");
  });

  it("is a reusable static component that follows the order of the steps it is given", () => {
    render(
      <LoginHelperStrip
        heading="Heading"
        steps={[
          { icon: "check", label: "One" },
          { icon: "clock", label: "Two" },
        ]}
      />,
    );
    expect(within(screen.getByRole("list", { name: "Heading" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["One", "Two"]);
  });
});
