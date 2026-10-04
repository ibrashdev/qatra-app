import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterPress } from "@/lib/dom/after-press";

const press = (type: "pointerdown" | "pointerup" | "pointercancel") => window.dispatchEvent(new Event(type));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  press("pointerup");
  vi.useRealTimers();
});

describe("afterPress: layout changes wait for a press to end", () => {
  it("runs the action after a timeout of zero when nothing is pressed, not at once", () => {
    const action = vi.fn();
    afterPress(action);
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("waits for the pointer to be released when a press is in progress, then runs after the click", () => {
    const action = vi.fn();
    press("pointerdown");
    afterPress(action);
    vi.advanceTimersByTime(5_000);
    expect(action).not.toHaveBeenCalled();

    press("pointerup");
    expect(action).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("treats a cancelled press as over", () => {
    const action = vi.fn();
    press("pointerdown");
    afterPress(action);
    press("pointercancel");
    vi.advanceTimersByTime(0);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("runs each action once, even if the pointer is pressed and released again", () => {
    const action = vi.fn();
    press("pointerdown");
    afterPress(action);
    press("pointerup");
    vi.advanceTimersByTime(0);
    press("pointerdown");
    press("pointerup");
    vi.advanceTimersByTime(1_000);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("runs actions queued during one press together, in order, after the release", () => {
    const order: number[] = [];
    press("pointerdown");
    afterPress(() => order.push(1));
    afterPress(() => order.push(2));
    expect(order).toEqual([]);
    press("pointerup");
    vi.advanceTimersByTime(0);
    expect(order).toEqual([1, 2]);
  });
});
