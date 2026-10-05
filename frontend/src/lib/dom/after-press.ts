// A message that disappears when a field loses focus moves everything below it. If the focus left because the visitor pressed the submit
// button, that shift lands between mouse-down and mouse-up, the button slides out from under the pointer, and the press is lost.
// afterPress waits for a press in progress to end, and for its click to be delivered, before it changes the layout.

let pressed = false;

function track(): void {
  const down = () => {
    pressed = true;
  };
  const up = () => {
    pressed = false;
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}

// Installed when the module loads, so a press that is already down when a blur comes in has been seen.
if (typeof window !== "undefined") track();

export function afterPress(action: () => void): void {
  // A timeout of zero runs after the click that follows the release, and after the compatibility mouse events of a tap.
  const run = () => void setTimeout(action, 0);
  if (!pressed) {
    run();
    return;
  }
  const release = () => {
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", release, true);
    run();
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
}
