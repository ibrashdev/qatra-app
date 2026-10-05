"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type RefObject } from "react";
import { redirectToLogin } from "@/components/plan-chat/session-ended";
import { useSubmitState, type SubmitState } from "@/components/recovery/account-form";
import { isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import type { PasswordViolation } from "@/lib/auth/account-rules";
import { classifySecurityError } from "./security-failure";

// Every password input of a screen here: the current one and the new ones.
const PASSWORD_INPUTS = "input[autocomplete$='password']";

export function wipePasswords(form: HTMLFormElement | null): void {
  form?.querySelectorAll<HTMLInputElement>(PASSWORD_INPUTS).forEach((input) => {
    input.value = "";
  });
}

// P-27: nothing typed outlives the screen. The values go on leaving, and when the page is hidden (a page kept for the back button would
// otherwise show them again).
export function useWipeOnLeave(formRef: RefObject<HTMLFormElement | null>): void {
  useEffect(() => {
    const form = formRef.current;
    const wipe = () => wipePasswords(form);
    window.addEventListener("pagehide", wipe);
    return () => {
      window.removeEventListener("pagehide", wipe);
      wipe();
    };
  }, [formRef]);
}

// P-27: the hidden username field takes its value from E11, read once in the background. A failed read leaves it empty and blocks nothing;
// only a session that has ended matters (G-03), and it sends the visitor to S-01 with `next` set to this screen.
export function useAccountUsername(next: string): string {
  const { api } = useApiRuntime();
  const router = useRouter();
  const [username, setUsername] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    api.me({ signal: controller.signal }).then(
      (profile) => setUsername(profile.username),
      (error: unknown) => {
        if (!controller.signal.aborted && isSessionEnded(error)) redirectToLogin(router, next);
      },
    );
    return () => controller.abort();
  }, [api, next, router]);

  return username;
}

export interface ReauthPress<T> {
  send: () => Promise<T>;
  // Runs on a success: the screen wipes its fields and starts the navigation. The button then keeps its loading state while the next screen opens.
  onSuccess: (answer: T) => void;
  // E09 only: a rule of the new password that the server refused and the learner can fix.
  onRule?: (rule: PasswordViolation) => void;
}

// "intact": E13 `503` says the account was not deleted (S-27), so the screen words it itself instead of the generic banner of P-07.
export interface ReauthOptions {
  next: string;
  currentRef: RefObject<HTMLInputElement | null>;
  unavailable?: "banner" | "intact";
}

// The press of S-23, S-24 and S-27: one request per gesture, never resent on its own, and the same answer to every way it can fail (P-27).
export function useReauthSubmit({ next, currentRef, unavailable = "banner" }: ReauthOptions): {
  state: SubmitState;
  rejected: boolean;
  notApplied: boolean;
  press: <T>(options: ReauthPress<T>) => Promise<void>;
} {
  const router = useRouter();
  const state = useSubmitState();
  // G-04: the current password was wrong. It is a banner of the screen's own, not a field error.
  const [rejected, setRejected] = useState(false);
  // E13 `503`, when `unavailable` is "intact".
  const [notApplied, setNotApplied] = useState(false);

  async function press<T>({ send, onSuccess, onRule }: ReauthPress<T>): Promise<void> {
    setRejected(false);
    setNotApplied(false);
    const end = state.begin();
    let leaving = false;
    try {
      const answer = await send();
      if (!state.mounted.current) return;
      onSuccess(answer);
      leaving = true;
    } catch (error) {
      if (!state.mounted.current) return;
      const failure = classifySecurityError(error, { newPassword: onRule !== undefined });
      switch (failure.kind) {
        case "session_ended":
          leaving = true;
          redirectToLogin(router, next);
          break;
        case "credentials":
          // G-04: one generic message, no field marked, the password cleared and focused.
          if (currentRef.current) currentRef.current.value = "";
          setRejected(true);
          currentRef.current?.focus();
          break;
        case "password":
          onRule?.(failure.rule);
          break;
        case "uncertain":
          state.markUncertain();
          break;
        case "unavailable":
          if (unavailable === "intact") setNotApplied(true);
          else state.report(failure);
          break;
        default:
          state.report(failure);
      }
    } finally {
      end(leaving);
    }
  }

  return { state, rejected, notApplied, press };
}
