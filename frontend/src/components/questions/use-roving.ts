"use client";

import { useRef, useState, type KeyboardEvent } from "react";

export type RovingMove = "next" | "previous" | "first" | "last";

const EMPTY: ReadonlySet<string> = new Set<string>();

// Roving tabindex for a group that is one widget (UI-tokens 7, UI-screens S-15 5): one tab stop, arrows move focus, skipped ids are never reached.
// The group owns no selection; `preferredId` only decides which item holds the tab stop before the learner has moved.
export function useRoving(ids: readonly string[], options: { skipped?: ReadonlySet<string>; preferredId?: string | null } = {}) {
  const { skipped = EMPTY, preferredId = null } = options;
  const elements = useRef(new Map<string, HTMLElement>());
  const [activeId, setActiveId] = useState<string | null>(null);

  const focusable = ids.filter((id) => !skipped.has(id));
  const tabStopId =
    activeId !== null && focusable.includes(activeId)
      ? activeId
      : preferredId !== null && focusable.includes(preferredId)
        ? preferredId
        : (focusable[0] ?? null);

  function register(id: string): (element: HTMLElement | null) => void {
    return (element) => {
      if (element === null) elements.current.delete(id);
      else elements.current.set(id, element);
    };
  }

  function focusItem(id: string): void {
    setActiveId(id);
    elements.current.get(id)?.focus();
  }

  function move(fromId: string, step: RovingMove): void {
    if (focusable.length === 0) return;
    const index = focusable.indexOf(fromId);
    let target: string | undefined;
    if (step === "first") target = focusable[0];
    else if (step === "last") target = focusable[focusable.length - 1];
    else if (step === "next") target = focusable[(index + 1) % focusable.length];
    else target = focusable[(index - 1 + focusable.length) % focusable.length];
    if (target !== undefined) focusItem(target);
  }

  // `direction` is the group's own: the original text is right to left in both interface languages, so Left is the next item there (S-15 5).
  function handleArrowKey(event: KeyboardEvent<HTMLElement>, fromId: string, direction: "rtl" | "ltr", extra: { vertical?: boolean } = {}): boolean {
    const forward = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = direction === "rtl" ? "ArrowRight" : "ArrowLeft";
    let step: RovingMove | null = null;
    if (event.key === forward || (extra.vertical === true && event.key === "ArrowDown")) step = "next";
    else if (event.key === backward || (extra.vertical === true && event.key === "ArrowUp")) step = "previous";
    else if (event.key === "Home") step = "first";
    else if (event.key === "End") step = "last";
    if (step === null) return false;
    event.preventDefault();
    move(fromId, step);
    return true;
  }

  return { tabStopId, register, focusItem, handleArrowKey, setActiveId, focusable };
}
