"use client";

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

// UI-tokens 6.8: a brief confirmation, 6 s on screen.
const TOAST_MS = 6_000;

interface ToastApi {
  show: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

// UI-tokens 6.8 toast: the inverse surface with white text, a glyph and a short phrase, one at a time, 16 px above the bottom edge and its safe area.
// The polite live region is always in the page, so the phrase that appears in it is announced, once per press. The toast holds no control:
// it ignores the pointer, so it can never cover a button it happens to lie over, and it holds no information that is found nowhere else.
// Escape closes it. The 6 s timer is not paused by hover or focus, because the toast cannot take either.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const count = useRef(0);

  const dismiss = useCallback(() => {
    clearTimeout(timer.current);
    setToast(null);
  }, []);

  const show = useCallback((message: string) => {
    clearTimeout(timer.current);
    count.current += 1;
    // A new id remounts the phrase, so the same words pressed twice are announced twice.
    setToast({ id: count.current, message });
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const visible = toast !== null;
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [visible, dismiss]);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-q16 bottom-[calc(var(--q-space-16)+env(safe-area-inset-bottom))] z-(--q-z-toast) flex justify-center"
      >
        {toast ? (
          <div
            key={toast.id}
            // The slide-in is skipped under reduced motion, where the tokens turn the duration to zero as well.
            className="flex max-w-full items-center gap-q8 rounded-md bg-inverse px-q16 py-q12 text-body-compact text-on-primary shadow-raised transition-[opacity,translate] duration-(--q-duration-base) ease-standard starting:opacity-0 motion-safe:starting:translate-y-q8"
          >
            <Icon name="check" size="md" />
            <span>{toast.message}</span>
          </div>
        ) : null}
      </div>
    </ToastContext>
  );
}

export function useToast(): ToastApi {
  const value = use(ToastContext);
  if (value === null) throw new Error("useToast must be used inside ToastProvider.");
  return value;
}
