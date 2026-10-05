"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/ErrorSummary";
import { Notice } from "@/components/ui/Notice";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextLink } from "@/components/ui/TextLink";
import { recoveryMessages } from "@/i18n/recovery-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatInteger } from "@/i18n/format";
import { resetPassword } from "@/lib/api/account-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import { checkConfirmation, checkPassword, type ConfirmationRule, type PasswordRule } from "@/lib/auth/account-rules";
import { holdRecoveryCode } from "@/lib/auth/recovery-handoff";
import { afterPress } from "@/lib/dom/after-press";
import { ResultSlot, SubmitRow, useSubmitState } from "./account-form";
import { classifyResetError, grantExpired, type ResetGrant, type RestartNotice } from "./recovery-model";

// Errors are kept as the rule that failed, not as text, so a language switch rewrites them.
interface Errors {
  password?: PasswordRule;
  confirmation?: ConfirmationRule;
}

const FIELDS = ["password", "confirmation"] as const;
type Field = (typeof FIELDS)[number];

// P-03: on blur a field with content (or one already in error) is checked again, and the confirmation is compared whenever either field blurs.
function revalidated(current: Errors, field: Field, password: string, confirmation: string): Errors {
  const next = { ...current };
  if (field === "password" && (password !== "" || current.password !== undefined)) next.password = checkPassword(password) ?? undefined;
  if (confirmation !== "" || current.confirmation !== undefined) next.confirmation = checkConfirmation(password, confirmation) ?? undefined;
  return next;
}

// S-05 step 2 (UI-screens Batch 1): the new password and its confirmation, E07. The grant is held by the screen above, in memory only. A success
// hands the replacement code to S-04 in memory and replaces this screen, so back never returns to it; E07 creates no session.
export function RecoveryResetStep({
  username,
  grant,
  onRestart,
}: {
  username: string;
  grant: ResetGrant;
  onRestart: (notice: RestartNotice) => void;
}) {
  const { locale, messages } = useLocale();
  const { client } = useApiRuntime();
  const router = useRouter();
  const copy = recoveryMessages(locale);
  const text = copy.step2;
  const state = useSubmitState();

  const passwordId = useId();
  const confirmationId = useId();
  const bannerId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  // Whether the last attempt ended without any answer: a refusal on the next one then carries the hint of P-10.
  const uncertain = useRef(false);

  const [errors, setErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    // The step change moves focus to the heading, so the step is announced (the heading names it).
    headingRef.current?.focus();
  }, []);

  function inputFor(field: Field): HTMLInputElement | null {
    return field === "password" ? passwordRef.current : confirmationRef.current;
  }

  function focusFirstInvalid(found: Errors) {
    const first = FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) inputFor(first)?.focus();
  }

  function messageFor(field: Field, found: Errors): string | undefined {
    if (field === "password") return found.password === undefined ? undefined : messages.form.passwordRules[found.password];
    return found.confirmation === undefined ? undefined : messages.form.confirmationRules[found.confirmation];
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting || state.throttled) return;

    const newPassword = passwordRef.current?.value ?? "";
    const confirmation = confirmationRef.current?.value ?? "";
    const found: Errors = { password: checkPassword(newPassword) ?? undefined, confirmation: checkConfirmation(newPassword, confirmation) ?? undefined };
    setErrors(found);
    setAttempted(true);
    if (FIELDS.some((field) => found[field] !== undefined)) {
      focusFirstInvalid(found);
      return;
    }

    const afterUncertain = uncertain.current;
    uncertain.current = false;
    // The 600 s are counted from the E06 answer. A lapsed grant sends nothing: the generic refusal and a fresh step 1.
    if (grantExpired(grant, performance.now())) {
      onRestart({ afterUncertain });
      return;
    }

    const end = state.begin();
    let leaving = false;
    try {
      const { recoveryCode } = await resetPassword(client, { resetGrant: grant.value, newPassword });
      if (!state.mounted.current) return;
      for (const field of FIELDS) {
        const input = inputFor(field);
        if (input) input.value = "";
      }
      // S-04 shows the replacement code once; it is handed over in memory and this screen is replaced in the history.
      holdRecoveryCode(recoveryCode, "recovery");
      leaving = true;
      router.replace("/recovery-code");
    } catch (error) {
      if (!state.mounted.current) return;
      const failure = classifyResetError(error);
      switch (failure.kind) {
        case "invalid":
          // G-04: the grant is expired, used or lost. Step 1 opens again; leaving this step wipes both password fields.
          onRestart({ afterUncertain });
          break;
        case "password": {
          const found: Errors = { password: failure.rule };
          setErrors(found);
          focusFirstInvalid(found);
          break;
        }
        case "uncertain":
          uncertain.current = true;
          state.markUncertain();
          break;
        default:
          state.report(failure);
      }
    } finally {
      end(leaving);
    }
  }

  // P-03: the message appearing or leaving moves the button, so the check waits until a press that caused the blur is over (afterPress).
  function checkOnBlur(field: Field) {
    afterPress(() => {
      const password = passwordRef.current?.value ?? "";
      const confirmation = confirmationRef.current?.value ?? "";
      setErrors((current) => revalidated(current, field, password, confirmation));
    });
  }

  const fieldIds: Record<Field, string> = { password: passwordId, confirmation: confirmationId };
  const summary: ErrorSummaryItem[] = FIELDS.flatMap((field) => {
    const message = messageFor(field, errors);
    return message === undefined ? [] : [{ fieldId: fieldIds[field], message }];
  });

  return (
    <>
      <h2 ref={headingRef} tabIndex={-1} className="mt-q24 text-section text-ink">
        {text.heading}
      </h2>

      {attempted && summary.length >= 2 ? (
        <div className="mt-q24">
          <ErrorSummary title={messages.form.errorSummary(summary.length, formatInteger(locale, summary.length))} items={summary} />
        </div>
      ) : null}

      <p className="mt-q24 text-body text-ink">{text.lead}</p>

      <form noValidate method="post" onSubmit={submit} className="mt-q24">
        {/* A field the visitor never sees, so a password manager saves the new password under the right name (S-05 "Field rules"). */}
        <input type="text" name="username" value={username} readOnly autoComplete="username" tabIndex={-1} aria-hidden="true" className="sr-only" />
        <div className="flex flex-col gap-q16">
          <PasswordField
            id={passwordId}
            inputRef={passwordRef}
            name="newPassword"
            label={text.passwordLabel}
            error={messageFor("password", errors)}
            showLabel={messages.form.showPassword}
            hideLabel={messages.form.hidePassword}
            autoComplete="new-password"
            enterKeyHint="next"
            onBlur={() => checkOnBlur("password")}
          />
          <PasswordField
            id={confirmationId}
            inputRef={confirmationRef}
            name="confirmation"
            label={text.confirmationLabel}
            error={messageFor("confirmation", errors)}
            showLabel={messages.form.showPassword}
            hideLabel={messages.form.hidePassword}
            autoComplete="new-password"
            enterKeyHint="go"
            onBlur={() => checkOnBlur("confirmation")}
          />
        </div>

        <div className="mt-q24">
          <Notice>{text.notice}</Notice>
        </div>

        <ResultSlot
          state={state}
          bannerId={bannerId}
          submittingText={text.submittingStatus}
          uncertain={
            <>
              <p>{copy.uncertain}</p>
              <TextLink href="/login">{copy.loginLink}</TextLink>
            </>
          }
        />

        <SubmitRow state={state} bannerId={bannerId} label={text.submit} loadingLabel={text.submitting} />
      </form>
    </>
  );
}
