"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { ResultSlot, SubmitRow } from "@/components/recovery/account-form";
import { Banner } from "@/components/ui/Banner";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/ErrorSummary";
import { Notice } from "@/components/ui/Notice";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextLink } from "@/components/ui/TextLink";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { accountSecurityMessages } from "@/i18n/account-security-messages";
import { changePassword } from "@/lib/api/security-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import { checkConfirmation, checkPassword, type ConfirmationRule, type PasswordRule } from "@/lib/auth/account-rules";
import { afterPress } from "@/lib/dom/after-press";
import { raiseSettingsArrival } from "@/lib/settings/arrival";
import { CurrentPasswordField } from "./CurrentPasswordField";
import { ScreenHeader } from "./ScreenHeader";
import { useAccountUsername, useReauthSubmit, useWipeOnLeave, wipePasswords } from "./use-reauth-submit";

const NEXT_PATH = "/settings/password";

// Errors are kept as the rule that failed, not as text, so a language switch rewrites them.
interface Errors {
  current?: "empty";
  password?: PasswordRule;
  confirmation?: ConfirmationRule;
}

interface Values {
  current: string;
  password: string;
  confirmation: string;
}

const FIELDS = ["current", "password", "confirmation"] as const;
type Field = (typeof FIELDS)[number];

// P-03: on blur a field with content (or one already in error) is checked again, and the confirmation is compared whenever the new password
// or the confirmation blurs. The current password has no rule but "not empty": it is re-read at its blur and the error leaves once it holds something.
function revalidated(current: Errors, field: Field, values: Values): Errors {
  const next = { ...current };
  if (field === "current") next.current = values.current === "" ? current.current : undefined;
  if (field === "password" && (values.password !== "" || current.password !== undefined)) next.password = checkPassword(values.password) ?? undefined;
  if (field !== "current" && (values.confirmation !== "" || current.confirmation !== undefined)) {
    next.confirmation = checkConfirmation(values.password, values.confirmation) ?? undefined;
  }
  return next;
}

// S-23 Change password (UI-screens, settings, part C): the current password, the new one and its confirmation, E09. A success wipes the fields,
// raises the arrival banner of S-22 and replaces this screen in the history, so back never returns to the filled form. The session stays signed in:
// the server sends a fresh cookie and the other sessions of the account end.
export function ChangePasswordScreen() {
  const { locale, messages } = useLocale();
  const { client } = useApiRuntime();
  const router = useRouter();
  const copy = accountSecurityMessages(locale);
  const text = copy.password;
  const username = useAccountUsername(NEXT_PATH);

  const currentId = useId();
  const passwordId = useId();
  const confirmationId = useId();
  const bannerId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const { state, rejected, press } = useReauthSubmit({ next: NEXT_PATH, currentRef });
  useWipeOnLeave(formRef);

  const [errors, setErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);

  const inputs: Record<Field, typeof currentRef> = { current: currentRef, password: passwordRef, confirmation: confirmationRef };
  const fieldIds: Record<Field, string> = { current: currentId, password: passwordId, confirmation: confirmationId };

  function valuesNow(): Values {
    return { current: currentRef.current?.value ?? "", password: passwordRef.current?.value ?? "", confirmation: confirmationRef.current?.value ?? "" };
  }

  function focusFirstInvalid(found: Errors) {
    const first = FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) inputs[first].current?.focus();
  }

  function messageFor(field: Field, found: Errors): string | undefined {
    switch (field) {
      case "current":
        return found.current === undefined ? undefined : copy.currentPassword.required;
      case "password":
        return found.password === undefined ? undefined : messages.form.passwordRules[found.password];
      case "confirmation":
        return found.confirmation === undefined ? undefined : messages.form.confirmationRules[found.confirmation];
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting || state.throttled) return;

    const { current, password, confirmation } = valuesNow();
    const found: Errors = {
      current: current === "" ? "empty" : undefined,
      password: checkPassword(password) ?? undefined,
      confirmation: checkConfirmation(password, confirmation) ?? undefined,
    };
    setErrors(found);
    setAttempted(true);
    if (FIELDS.some((field) => found[field] !== undefined)) {
      focusFirstInvalid(found);
      return;
    }

    await press({
      send: () => changePassword(client, { currentPassword: current, newPassword: password }),
      onSuccess: () => {
        wipePasswords(formRef.current);
        // The banner of S-22 is raised before the replace, so the screen that opens finds it.
        raiseSettingsArrival("password_changed");
        router.replace("/settings");
      },
      // A rule the client let through but the server refused: its message goes to the new password field.
      onRule: (rule) => {
        const refused: Errors = { password: rule };
        setErrors(refused);
        focusFirstInvalid(refused);
      },
    });
  }

  // P-03: the message appearing or leaving moves the button, so the check waits until a press that caused the blur is over (afterPress).
  function checkOnBlur(field: Field) {
    afterPress(() => {
      const values = valuesNow();
      setErrors((current) => revalidated(current, field, values));
    });
  }

  const summary: ErrorSummaryItem[] = FIELDS.flatMap((field) => {
    const message = messageFor(field, errors);
    return message === undefined ? [] : [{ fieldId: fieldIds[field], message }];
  });

  return (
    <div className="mx-auto w-full max-w-form">
      <ScreenHeader title={text.screenName} />

      {attempted && summary.length >= 2 ? (
        <div className="mt-q24">
          <ErrorSummary title={messages.form.errorSummary(summary.length, formatInteger(locale, summary.length))} items={summary} />
        </div>
      ) : null}

      <div className="mt-q24">
        <Notice>{text.notice}</Notice>
      </div>

      <form ref={formRef} noValidate method="post" onSubmit={submit} className="mt-q24">
        <div className="flex flex-col gap-q16">
          <CurrentPasswordField
            id={currentId}
            inputRef={currentRef}
            username={username}
            error={messageFor("current", errors)}
            onBlur={() => checkOnBlur("current")}
          />
          <PasswordField
            id={passwordId}
            inputRef={passwordRef}
            name="newPassword"
            label={text.newLabel}
            helper={text.newHelper}
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

        <ResultSlot
          state={state}
          bannerId={bannerId}
          submittingText={text.submittingStatus}
          uncertain={
            <>
              <p>{text.uncertain}</p>
              <TextLink href="/login">{copy.loginLink}</TextLink>
            </>
          }
          alert={
            rejected ? (
              <Banner variant="error" role="alert">
                {copy.currentPassword.invalid}
              </Banner>
            ) : null
          }
        />

        <SubmitRow state={state} bannerId={bannerId} label={text.submit} loadingLabel={text.submitting} />
      </form>
    </div>
  );
}
