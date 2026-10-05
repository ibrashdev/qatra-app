"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { LinkButton } from "@/components/progress/LinkButton";
import { ResultSlot } from "@/components/recovery/account-form";
import { Banner } from "@/components/ui/Banner";
import { Checkbox } from "@/components/ui/Checkbox";
import { Countdown } from "@/components/ui/Countdown";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/ErrorSummary";
import { TextLink } from "@/components/ui/TextLink";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { accountSecurityMessages } from "@/i18n/account-security-messages";
import { DELETE_CONFIRMATION, deleteAccount } from "@/lib/api/security-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import { raiseLoginArrival } from "@/lib/auth/flash";
import { wipeRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft } from "@/lib/auth/register-draft";
import { afterPress } from "@/lib/dom/after-press";
import { CurrentPasswordField } from "./CurrentPasswordField";
import { DestructiveButton } from "./DestructiveButton";
import { ScreenHeader } from "./ScreenHeader";
import { useAccountUsername, useReauthSubmit, useWipeOnLeave, wipePasswords } from "./use-reauth-submit";

const NEXT_PATH = "/settings/delete-account";

interface Errors {
  current?: "empty";
  acknowledgment?: "required";
}

const FIELDS = ["current", "acknowledgment"] as const;
type Field = (typeof FIELDS)[number];

// S-27 Delete account (UI-screens, settings, part C): what deletion means, the current password and an acknowledgment, E13. The page is the
// confirmation (O-51): no second dialog follows. With the box ticked the client sends the literal itself, so no Latin word is typed on an Arabic
// keyboard. Only a `204` is success; anything else leaves the account where it was, and a request that got no answer says so (P-10).
export function DeleteAccountScreen() {
  const { locale, messages } = useLocale();
  const { client } = useApiRuntime();
  const router = useRouter();
  const copy = accountSecurityMessages(locale);
  const text = copy.deleteAccount;
  const username = useAccountUsername(NEXT_PATH);

  const currentId = useId();
  const acknowledgmentId = useId();
  const bannerId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const acknowledgmentRef = useRef<HTMLInputElement>(null);
  const { state, rejected, notApplied, press } = useReauthSubmit({ next: NEXT_PATH, currentRef, unavailable: "intact" });
  useWipeOnLeave(formRef);

  const [errors, setErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);

  const inputs = { current: currentRef, acknowledgment: acknowledgmentRef };
  const fieldIds: Record<Field, string> = { current: currentId, acknowledgment: acknowledgmentId };

  function messageFor(field: Field, found: Errors): string | undefined {
    if (field === "current") return found.current === undefined ? undefined : copy.currentPassword.required;
    return found.acknowledgment === undefined ? undefined : text.acknowledgmentRequired;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting || state.throttled) return;

    const password = currentRef.current?.value ?? "";
    const found: Errors = {
      current: password === "" ? "empty" : undefined,
      acknowledgment: acknowledgmentRef.current?.checked === true ? undefined : "required",
    };
    setErrors(found);
    setAttempted(true);
    // An unticked box sends nothing: the acknowledgment is the confirmation.
    const first = FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) {
      inputs[first].current?.focus();
      return;
    }

    await press({
      send: () => deleteAccount(client, { password, confirm: DELETE_CONFIRMATION }),
      onSuccess: () => {
        wipePasswords(formRef.current);
        // The account is gone: nothing typed for it, and no code held for it, stays in memory.
        clearRegisterDraft();
        wipeRecoveryCode();
        raiseLoginArrival("account_deleted");
        router.replace("/login");
      },
    });
  }

  // P-03: the error of the password leaves at its next blur once it holds something (afterPress: the message leaving moves the button).
  function clearPasswordWhenFixed() {
    if (errors.current === undefined) return;
    afterPress(() => {
      if ((currentRef.current?.value ?? "") !== "") setErrors((current) => ({ ...current, current: undefined }));
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
        <Banner variant="warning">{text.warning}</Banner>
      </div>

      <div className="mt-q24">
        <h2 className="text-section text-ink">{text.effectsHeading}</h2>
        <ul className="mt-q12 list-disc ps-q24 text-body text-ink marker:text-ink-secondary">
          {text.effects.map((effect) => (
            <li key={effect} className="mt-q8 first:mt-0">
              {effect}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-q24">
        <h2 className="text-section text-ink">{text.knowHeading}</h2>
        <ul className="mt-q12 list-disc ps-q24 text-body text-ink marker:text-ink-secondary">
          {text.know.map((line) => (
            <li key={line} className="mt-q8 first:mt-0">
              {line}
            </li>
          ))}
        </ul>
        <div className="mt-q8">
          <TextLink href="/settings/privacy#privacy">{text.privacyLink}</TextLink>
        </div>
      </div>

      <form ref={formRef} noValidate method="post" onSubmit={submit} className="mt-q24">
        <div className="flex flex-col gap-q16">
          <CurrentPasswordField
            id={currentId}
            inputRef={currentRef}
            username={username}
            error={messageFor("current", errors)}
            readOnly={state.submitting}
            onBlur={clearPasswordWhenFixed}
          />
          <Checkbox
            id={acknowledgmentId}
            inputRef={acknowledgmentRef}
            label={text.acknowledgment}
            aria-required="true"
            // Form restoration after a reload must not hand back a ticked box: the acknowledgment is given afresh each time.
            autoComplete="off"
            disabled={state.submitting}
            error={messageFor("acknowledgment", errors)}
            onChange={(event) => {
              if (event.target.checked) setErrors((current) => ({ ...current, acknowledgment: undefined }));
            }}
          />
        </div>

        <ResultSlot
          state={state}
          bannerId={bannerId}
          submittingText={text.submittingStatus}
          uncertain={<p>{text.uncertain}</p>}
          alert={
            notApplied ? (
              <Banner variant="warning">
                <p>{messages.form.unavailable}</p>
                <p className="mt-q4">{text.notDeleted}</p>
              </Banner>
            ) : rejected ? (
              <Banner variant="error" role="alert">
                {copy.currentPassword.invalid}
              </Banner>
            ) : null
          }
          announcement={
            notApplied ? (
              <p>
                {messages.form.unavailable} {text.notDeleted}
              </p>
            ) : null
          }
        />

        <div className="mt-q24">
          <DestructiveButton
            type="submit"
            loading={state.submitting}
            aria-disabled={state.throttled || undefined}
            aria-describedby={state.throttled ? bannerId : undefined}
          >
            {state.submitting ? text.submitting : text.submit}
          </DestructiveButton>
          {state.result?.kind === "throttled" ? (
            <div className="mt-q8">
              <Countdown endsAt={state.result.endsAt} totalSeconds={state.result.retryAfterSec} onDone={state.endThrottle} />
            </div>
          ) : null}
        </div>

        {/* Inert while the request is in flight, as the fields are; a link has no disabled state of its own. */}
        <div inert={state.submitting} className="mt-q8">
          <LinkButton href="/settings" variant="secondary" fullWidth>
            {text.cancel}
          </LinkButton>
        </div>
      </form>
    </div>
  );
}
