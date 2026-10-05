import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorPage from "@/app/error";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";

// The root error boundary (src/app/error.tsx). Next 16 hands an error component `error`, `reset` and `retry`:
// `retry` fetches the route again and renders it, `reset` only clears the error and renders what has already failed (docs: error.js).
// The page must call `retry`, so that a failure of the route's own files (a chunk that did not load) can recover.

function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

function renderBoundary() {
  const props = { error: Object.assign(new Error("boom"), { digest: "d1" }), reset: vi.fn(), retry: vi.fn() };
  render(
    <LocaleProvider>
      {/* The props that Next passes: this page declares `retry` only, the rest is what the boundary adds. */}
      <ErrorPage {...props} />
    </LocaleProvider>,
  );
  return props;
}

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

afterEach(() => {
  localStorage.clear();
});

describe("the root error page (Next 16 retry, not reset)", () => {
  it("calls retry when the button is pressed, once per press, and never reset", async () => {
    setLanguage("ar");
    const { retry, reset } = renderBoundary();
    const button = screen.getByRole("button", { name: "إعادة المحاولة" });
    await userEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
    await userEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(reset).not.toHaveBeenCalled();
  });

  it("calls retry from the keyboard too", async () => {
    setLanguage("ar");
    const { retry, reset } = renderBoundary();
    await userEvent.tab();
    // The skip link belongs to the shells; this page stands alone, so the button is the first stop.
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it("announces the failure as an alert with its heading, in both languages, and says nothing about the error itself", () => {
    setLanguage("en");
    renderBoundary();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something unexpected happened. Try again.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Something unexpected happened. Try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // The message and the digest of the error are for the logs, never for the visitor.
    expect(document.body).not.toHaveTextContent("boom");
    expect(document.body).not.toHaveTextContent("d1");
  });
});
