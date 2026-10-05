"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { ResultSlot, SubmitRow } from "@/components/recovery/account-form";
import { Banner } from "@/components/ui/Banner";
import { Notice } from "@/components/ui/Notice";
import { useLocale } from "@/i18n/LocaleProvider";
import { accountSecurityMessages } from "@/i18n/account-security-messages";
import { rotateRecoveryCode } from "@/lib/api/security-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import { holdRecoveryCode } from "@/lib/auth/recovery-handoff";
import { afterPress } from "@/lib/dom/after-press";
import { CurrentPasswordField } from "./CurrentPasswordField";
import { ScreenHeader } from "./ScreenHeader";
import { useAccountUsername, useReauthSubmit, useWipeOnLeave, wipePasswords } from "./use-reauth-submit";

const NEXT_PATH = "/settings/recovery-code";

// S-24 Rotate recovery code (UI-screens, settings, part C): the current password, E08. The old code stops working at once and is never shown; the
// new one reaches S-04 in memory only (never the URL, storage, history state, a log or a live region), and this screen is replaced in the history.
// S-04 hosts the settings flow: its continue action returns to S-22. Sessions and the password do not change.
export function RotateRecoveryCodeScreen() {
  const { locale } = useLocale();
  const { client } = useApiRuntime();
  const router = useRouter();
  const copy = accountSecurityMessages(locale);
  const text = copy.recoveryCode;
  const username = useAccountUsername(NEXT_PATH);

  const currentId = useId();
  const bannerId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const { state, rejected, press } = useReauthSubmit({ next: NEXT_PATH, currentRef });
  useWipeOnLeave(formRef);

  // The one rule is "not empty". One error needs no summary: the field is announced through its description (P-03).
  const [empty, setEmpty] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting || state.throttled) return;

    const password = currentRef.current?.value ?? "";
    setEmpty(password === "");
    if (password === "") {
      currentRef.current?.focus();
      return;
    }

    await press({
      send: () => rotateRecoveryCode(client, { password }),
      onSuccess: ({ recoveryCode }) => {
        wipePasswords(formRef.current);
        // S-04 shows the replacement code once; it is handed over in memory and this screen is replaced in the history.
        holdRecoveryCode(recoveryCode, "settings");
        router.replace("/recovery-code");
      },
    });
  }

  // P-03: the error leaves at the field's next blur once it holds something. The message leaving moves the button, so it waits for afterPress.
  function clearWhenFixed() {
    if (!empty) return;
    afterPress(() => {
      if ((currentRef.current?.value ?? "") !== "") setEmpty(false);
    });
  }

  return (
    <div className="mx-auto w-full max-w-form">
      <ScreenHeader title={text.screenName} />

      <div className="mt-q24">
        <Notice>{text.notice}</Notice>
      </div>

      <form ref={formRef} noValidate method="post" onSubmit={submit} className="mt-q24">
        <CurrentPasswordField
          id={currentId}
          inputRef={currentRef}
          username={username}
          error={empty ? copy.currentPassword.required : undefined}
          onBlur={clearWhenFixed}
        />

        <ResultSlot
          state={state}
          bannerId={bannerId}
          submittingText={text.submittingStatus}
          uncertain={<p>{text.uncertain}</p>}
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
