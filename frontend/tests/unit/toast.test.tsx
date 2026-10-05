import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "@/components/ui/Toast";

function Opener({ message = "Copied", label = "Press" }: { message?: string; label?: string }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show(message)}>
      {label}
    </button>
  );
}

function renderToast(ui = <Opener />) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

const region = () => screen.getByRole("status");
const press = (label = "Press") => fireEvent.click(screen.getByRole("button", { name: label }));
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Toast (UI-tokens 6.8)", () => {
  it("keeps one empty polite status region in the page before anything is shown, so the first message is announced", () => {
    renderToast();
    expect(region()).toBeEmptyDOMElement();
    expect(region()).toHaveAttribute("aria-live", "polite");
    expect(region()).toHaveAttribute("aria-atomic", "true");
  });

  it("shows the phrase inside the live region with a glyph that assistive technology skips", () => {
    renderToast();
    press();
    expect(region()).toHaveTextContent("Copied");
    const glyph = region().querySelector("svg");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(region().querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
  });

  it("is the inverse surface with white text, the medium radius and the raised shadow", () => {
    renderToast();
    press();
    const toast = screen.getByText("Copied").parentElement;
    expect(toast).toHaveClass("bg-inverse", "text-on-primary", "rounded-md", "shadow-raised");
  });

  it("lies 16 px above the bottom edge and its safe area, above the page and below a dialog, and never takes the pointer", () => {
    renderToast();
    expect(region()).toHaveClass("fixed", "pointer-events-none", "z-(--q-z-toast)");
    expect(region().className).toContain("bottom-[calc(var(--q-space-16)+env(safe-area-inset-bottom))]");
  });

  it("slides in only when motion is allowed, and its duration is the token that turns to zero under reduced motion", () => {
    renderToast();
    press();
    const toast = screen.getByText("Copied").parentElement as HTMLElement;
    expect(toast.className).toContain("duration-(--q-duration-base)");
    expect(toast).toHaveClass("starting:opacity-0", "motion-safe:starting:translate-y-q8");
  });

  it("goes after 6 seconds, and not before", () => {
    renderToast();
    press();
    advance(5_999);
    expect(screen.getByText("Copied")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    expect(region()).toBeEmptyDOMElement();
  });

  it("shows one at a time: a second message replaces the first and starts its own 6 seconds", () => {
    renderToast(
      <>
        <Opener message="First" label="One" />
        <Opener message="Second" label="Two" />
      </>,
    );
    press("One");
    advance(4_000);
    press("Two");
    expect(screen.queryByText("First")).not.toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    // The first message's timer would have ended here.
    advance(4_000);
    expect(screen.getByText("Second")).toBeInTheDocument();
    advance(2_000);
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
  });

  it("announces the same words pressed twice twice: the phrase is a new node each time", () => {
    renderToast();
    press();
    const first = screen.getByText("Copied").parentElement;
    advance(1_000);
    press();
    const second = screen.getByText("Copied").parentElement;
    expect(second).not.toBe(first);
    expect(region().querySelectorAll("span")).toHaveLength(1);
  });

  it("closes on Escape and on no other key, and stops listening once it is closed", () => {
    renderToast();
    press();
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "a" });
    expect(screen.getByText("Copied")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    const remove = vi.spyOn(document, "removeEventListener");
    press();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("does not move focus: the button that asked for it keeps it", () => {
    renderToast();
    const button = screen.getByRole("button", { name: "Press" });
    button.focus();
    press();
    expect(document.activeElement).toBe(button);
  });

  it("leaves no timer behind when the page goes while a toast is showing", () => {
    const { unmount } = renderToast();
    press();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a clear error to ask for a toast outside the provider", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Opener />)).toThrow("useToast must be used inside ToastProvider.");
    quiet.mockRestore();
  });
});
