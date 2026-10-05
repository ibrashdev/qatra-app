import { vi } from "vitest";

// jsdom has the <dialog> element and its `open` attribute, but not showModal() or close(). This adds the two in the way a browser behaves
// as far as the screens need: showModal() sets `open` (and throws when it is already set), and close() removes it and reports the `close`
// event a moment later, after the call has returned, as browsers do. A closed dialog is display: none in jsdom, so it is not in the
// accessibility tree, as in a browser.
export function installDialogPolyfill(): { showModal: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    if (this.hasAttribute("open")) throw new DOMException("The dialog is already open.", "InvalidStateError");
    this.setAttribute("open", "");
  });
  const close = vi.fn(function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, writable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, writable: true, value: close });
  return { showModal, close };
}
