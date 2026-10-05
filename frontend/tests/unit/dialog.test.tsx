import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/Dialog";
import { installDialogPolyfill } from "./dialog-polyfill";

let browser: ReturnType<typeof installDialogPolyfill>;

beforeEach(() => {
  browser = installDialogPolyfill();
  document.documentElement.style.overflow = "";
});

interface Props {
  open?: boolean;
  role?: "dialog" | "alertdialog";
  onCancel?: () => void;
  onPrimary?: () => void;
  onSecondary?: () => void;
}

function Subject({ open = true, role, onCancel = () => undefined, onPrimary = () => undefined, onSecondary = () => undefined }: Props) {
  return (
    <Dialog open={open} role={role} title="Title" primary={{ label: "Stay", onPress: onPrimary }} secondary={{ label: "Leave", onPress: onSecondary }} onCancel={onCancel}>
      Body sentence.
    </Dialog>
  );
}

const dialog = () => document.querySelector("dialog") as HTMLDialogElement;

describe("Dialog (UI-tokens 6.9 and 6.22, UI-screens P-12)", () => {
  it("is a native dialog that stays closed, and out of the accessibility tree, until it is opened", () => {
    render(<Subject open={false} />);
    expect(dialog()).not.toHaveAttribute("open");
    expect(browser.showModal).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens with showModal() when `open` is true, once", () => {
    render(<Subject />);
    expect(browser.showModal).toHaveBeenCalledTimes(1);
    expect(dialog()).toHaveAttribute("open");
  });

  it("is labelled by its title and described by its sentence, as a dialog or as an alert dialog", () => {
    const { unmount } = render(<Subject />);
    expect(screen.getByRole("dialog", { name: "Title", description: "Body sentence." })).toBe(dialog());
    unmount();
    render(<Subject role="alertdialog" />);
    expect(screen.getByRole("alertdialog", { name: "Title", description: "Body sentence." })).toBe(dialog());
    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeInTheDocument();
  });

  it("gives the first focus to the primary button, the safe action", () => {
    render(<Subject />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay" }));
  });

  it("puts the primary button first and the secondary second, in the primary and the outline recipes", () => {
    render(<Subject />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Stay", "Leave"]);
    expect(buttons[0]).toHaveClass("bg-primary", "text-on-primary", "w-full");
    expect(buttons[1]).toHaveClass("border", "border-edge", "bg-surface", "w-full");
  });

  it("calls the handler of the button that was pressed, and only that one", async () => {
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    const onCancel = vi.fn();
    render(<Subject onPrimary={onPrimary} onSecondary={onSecondary} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("is a bottom sheet below 768 px and a centred dialog of at most 400 px from 768 px, with the scrim on the backdrop and the raised shadow", () => {
    render(<Subject />);
    expect(dialog()).toHaveClass("mt-auto", "w-full", "max-w-full", "rounded-b-none", "tablet:m-auto", "tablet:max-w-[25rem]", "tablet:rounded-b-md");
    expect(dialog()).toHaveClass("bg-surface", "rounded-md", "shadow-raised", "backdrop:bg-scrim", "overflow-y-auto");
    expect(dialog().className).toContain("max-h-[calc(100dvh-3rem)]");
    // The sheet slides up over the slow duration, and only when motion is allowed.
    expect(dialog().className).toContain("motion-safe:max-tablet:open:starting:translate-y-full");
    expect(dialog().className).toContain("motion-safe:max-tablet:open:duration-(--q-duration-slow)");
  });

  it("stacks the buttons with the primary first on a phone and makes a row of them from 768 px, in DOM order", () => {
    render(<Subject />);
    const row = screen.getByRole("button", { name: "Stay" }).parentElement?.parentElement;
    expect(row).toHaveClass("flex", "flex-col", "tablet:flex-row", "tablet:flex-wrap");
    expect(row?.firstElementChild?.textContent).toBe("Stay");
  });

  it("pads the content 24 px, with the bottom safe area added on the sheet", () => {
    render(<Subject />);
    const text = dialog().firstElementChild as HTMLElement;
    expect(text).toHaveClass("px-q24", "pt-q24");
    expect(text).toContainElement(screen.getByRole("heading", { level: 2, name: "Title" }));
    const footer = dialog().lastElementChild as HTMLElement;
    expect(footer).toHaveClass("px-q24", "pt-q24", "tablet:pb-q24");
    expect(footer.className).toContain("pb-[calc(var(--q-space-24)+env(safe-area-inset-bottom))]");
  });

  it("keeps the buttons docked at the bottom of the dialog, over a fill of its own, so they stay in view when the text is enlarged until the dialog scrolls", () => {
    render(<Subject />);
    const footer = dialog().lastElementChild as HTMLElement;
    expect(footer).toHaveClass("sticky", "bottom-0", "bg-surface");
    expect(footer).toContainElement(screen.getByRole("button", { name: "Stay" }));
    expect(footer).toContainElement(screen.getByRole("button", { name: "Leave" }));
    expect(footer).not.toContainElement(screen.getByRole("heading", { level: 2, name: "Title" }));
    expect(dialog()).toHaveClass("overflow-y-auto");
  });

  describe("Escape", () => {
    it("asks to cancel, keeps the browser from closing the dialog, and leaves the closing to the caller", () => {
      const onCancel = vi.fn();
      const { rerender } = render(<Subject onCancel={onCancel} />);
      const event = new Event("cancel", { cancelable: true });
      fireEvent(dialog(), event);
      expect(event.defaultPrevented).toBe(true);
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(dialog()).toHaveAttribute("open");
      expect(browser.close).not.toHaveBeenCalled();
      rerender(<Subject open={false} onCancel={onCancel} />);
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(dialog()).not.toHaveAttribute("open");
    });
  });

  describe("a press on the backdrop", () => {
    it("cancels when it lands on the dialog element itself, which is only the backdrop around the content", () => {
      const onCancel = vi.fn();
      render(<Subject onCancel={onCancel} />);
      fireEvent.click(dialog());
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("does nothing when it lands on the content: the title, the sentence, the padding or a button", async () => {
      const onCancel = vi.fn();
      render(<Subject onCancel={onCancel} />);
      fireEvent.click(screen.getByText("Title"));
      fireEvent.click(screen.getByText("Body sentence."));
      fireEvent.click(dialog().firstElementChild as HTMLElement);
      fireEvent.click(dialog().lastElementChild as HTMLElement);
      await userEvent.click(screen.getByRole("button", { name: "Stay" }));
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  describe("focus stays inside", () => {
    it("goes from the last button to the first on Tab, and from the first to the last on Shift+Tab", async () => {
      const user = userEvent.setup();
      render(<Subject />);
      const stay = screen.getByRole("button", { name: "Stay" });
      const leave = screen.getByRole("button", { name: "Leave" });
      expect(document.activeElement).toBe(stay);
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(leave);
      await user.tab();
      expect(document.activeElement).toBe(stay);
    });

    it("leaves Tab between the two buttons to the browser", () => {
      render(<Subject />);
      const stay = screen.getByRole("button", { name: "Stay" });
      const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      stay.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("ignores every other key", () => {
      render(<Subject />);
      const stay = screen.getByRole("button", { name: "Stay" });
      for (const key of ["Enter", " ", "ArrowDown", "Escape"]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        stay.dispatchEvent(event);
        expect(event.defaultPrevented, key).toBe(false);
      }
    });
  });

  describe("focus goes back", () => {
    // "Leave" closes the dialog and takes the opener out of the page, as a screen that has been left would.
    function Page() {
      const [open, setOpen] = useState(false);
      const [gone, setGone] = useState(false);
      return (
        <>
          {gone ? null : (
            <button type="button" onClick={() => setOpen(true)}>
              Opener
            </button>
          )}
          <Dialog
            open={open}
            title="Title"
            primary={{ label: "Stay", onPress: () => setOpen(false) }}
            secondary={{
              label: "Leave",
              onPress: () => {
                setGone(true);
                setOpen(false);
              },
            }}
            onCancel={() => setOpen(false)}
          >
            Body sentence.
          </Dialog>
        </>
      );
    }

    it("to the element that held it when the dialog opened, after Stay", async () => {
      render(<Page />);
      const opener = screen.getByRole("button", { name: "Opener" });
      opener.focus();
      await userEvent.click(opener);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay" }));
      await userEvent.click(screen.getByRole("button", { name: "Stay" }));
      await waitFor(() => expect(dialog()).not.toHaveAttribute("open"));
      expect(document.activeElement).toBe(opener);
    });

    it("to the element that held it, after Escape", async () => {
      render(<Page />);
      const opener = screen.getByRole("button", { name: "Opener" });
      opener.focus();
      await userEvent.click(opener);
      fireEvent(dialog(), new Event("cancel", { cancelable: true }));
      await waitFor(() => expect(dialog()).not.toHaveAttribute("open"));
      expect(document.activeElement).toBe(opener);
    });

    it("to nothing when nothing held it: the dialog does not choose a place of its own", () => {
      const { rerender } = render(<Subject open={false} />);
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      rerender(<Subject open />);
      expect(focus).toHaveBeenCalledTimes(1);
      focus.mockClear();
      rerender(<Subject open={false} />);
      expect(focus).not.toHaveBeenCalled();
    });

    it("to no one when the opener has left the page meanwhile, without failing", async () => {
      render(<Page />);
      const opener = screen.getByRole("button", { name: "Opener" });
      opener.focus();
      const focus = vi.spyOn(opener, "focus");
      await userEvent.click(opener);
      await userEvent.click(screen.getByRole("button", { name: "Leave" }));
      await waitFor(() => expect(dialog()).not.toHaveAttribute("open"));
      expect(screen.queryByRole("button", { name: "Opener" })).not.toBeInTheDocument();
      expect(focus).not.toHaveBeenCalled();
    });
  });

  describe("the page does not scroll while it is open", () => {
    it("hides the overflow of the page, and restores what was there when it closes", () => {
      document.documentElement.style.overflow = "scroll";
      const { rerender } = render(<Subject open={false} />);
      expect(document.documentElement.style.overflow).toBe("scroll");
      rerender(<Subject open />);
      expect(document.documentElement.style.overflow).toBe("hidden");
      rerender(<Subject open={false} />);
      expect(document.documentElement.style.overflow).toBe("scroll");
    });

    it("restores it when the dialog goes away while open", () => {
      const { unmount } = render(<Subject open />);
      expect(document.documentElement.style.overflow).toBe("hidden");
      unmount();
      expect(document.documentElement.style.overflow).toBe("");
    });
  });

  describe("a browser that closes the dialog on its own", () => {
    it("is reported to the caller as a cancel, because the caller still thinks the dialog is open", () => {
      const onCancel = vi.fn();
      render(<Subject onCancel={onCancel} />);
      dialog().removeAttribute("open");
      fireEvent(dialog(), new Event("close"));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("is not reported when the caller closed it", async () => {
      const onCancel = vi.fn();
      const { rerender } = render(<Subject onCancel={onCancel} />);
      rerender(<Subject open={false} onCancel={onCancel} />);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("is not reported when the dialog has been opened again since the event was queued", () => {
      const onCancel = vi.fn();
      render(<Subject onCancel={onCancel} />);
      fireEvent(dialog(), new Event("close"));
      expect(dialog()).toHaveAttribute("open");
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  it("opens again after it was closed", () => {
    const { rerender } = render(<Subject open={false} />);
    rerender(<Subject open />);
    rerender(<Subject open={false} />);
    rerender(<Subject open />);
    expect(browser.showModal).toHaveBeenCalledTimes(2);
    expect(dialog()).toHaveAttribute("open");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Stay" }));
  });
});
