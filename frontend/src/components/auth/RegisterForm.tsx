"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Countdown } from "@/components/ui/Countdown";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/ErrorSummary";
import { BannerSlot, OfflineBanner, ServiceAlert, TermsUpdatedAlert, ThrottleBanner, UnavailableBanner, WakeUpBanner } from "@/components/ui/FormBanners";
import { Notice } from "@/components/ui/Notice";
import { PageTitle } from "@/components/ui/PageTitle";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextField } from "@/components/ui/TextField";
import { TextLink } from "@/components/ui/TextLink";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatInteger } from "@/i18n/format";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { checkConfirmation, checkPassword, checkUsername, type ConfirmationRule, type PasswordRule, type UsernameRule } from "@/lib/auth/account-rules";
import { holdRecoveryCode } from "@/lib/auth/recovery-handoff";
import { clearRegisterDraft, readRegisterDraft, saveRegisterDraft } from "@/lib/auth/register-draft";
import { classifyRegisterError, type RegisterFailure } from "@/lib/auth/register-failure";
import { useSignedInRedirect } from "@/lib/auth/use-signed-in-redirect";
import { browserTimeZone, reloadPage } from "@/lib/browser";
import { TERMS_VERSION } from "@/lib/config";
import { afterPress } from "@/lib/dom/after-press";
import { useConnectivity } from "@/lib/net/use-connectivity";

// P-06: a request that waits longer than this says it is still working.
const SLOW_REQUEST_MS = 5_000;

// The fields in the order of the page, which is also the order focus goes to the first invalid one.
const FIELDS = ["username", "password", "confirmation", "consent"] as const;
type Field = (typeof FIELDS)[number];

// Errors are kept as the rule that failed, not as text, so a language switch rewrites them.
interface Errors {
  username?: UsernameRule | "taken";
  password?: PasswordRule;
  confirmation?: ConfirmationRule;
  consent?: true;
}

interface Values {
  username: string;
  password: string;
  confirmation: string;
  consent: boolean;
}

// What the last press left behind in Slot B. Connectivity speaks through its own banners, except the uncertain outcome of P-10.
type Result =
  | { kind: "internal" }
  | { kind: "unavailable" }
  | { kind: "origin" }
  | { kind: "terms_outdated" }
  | { kind: "uncertain" }
  | { kind: "throttled"; retryAfterSec: number; endsAt: number }; // endsAt is a performance.now() value

// P-03: on submit every rule runs.
function validateAll(values: Values): Errors {
  return {
    username: checkUsername(values.username) ?? undefined,
    password: checkPassword(values.password) ?? undefined,
    confirmation: checkConfirmation(values.password, values.confirmation) ?? undefined,
    consent: values.consent ? undefined : true,
  };
}

// P-03: on blur, a field with content (or one already in error) is checked again. A taken name is not a format error and stays until the
// name is edited. The confirmation is compared whenever either password field blurs.
function revalidated(current: Errors, field: "username" | "password" | "confirmation", values: Values): Errors {
  if (field === "username") {
    if (current.username === "taken" || (values.username === "" && current.username === undefined)) return current;
    return { ...current, username: checkUsername(values.username) ?? undefined };
  }
  const next = { ...current };
  if (field === "password" && (values.password !== "" || current.password !== undefined)) {
    next.password = checkPassword(values.password) ?? undefined;
  }
  if (values.confirmation !== "" || current.confirmation !== undefined) {
    next.confirmation = checkConfirmation(values.password, values.confirmation) ?? undefined;
  }
  return next;
}

// S-02 (UI-screens Batch 1): username, password and its confirmation, the recovery-code notice and the mandatory consent box, E03.
// Like S-01 the inputs are read from the page, so a password manager that fills them without a change event still works.
export function RegisterForm() {
  const { locale, messages } = useLocale();
  const { api } = useApiRuntime();
  const router = useRouter();
  const wake = useWakeUpState();
  const { online, reconnected } = useConnectivity();
  useSignedInRedirect();

  const text = messages.auth.register;
  const usernameId = useId();
  const passwordId = useId();
  const confirmationId = useId();
  const consentId = useId();
  const bannerId = useId();
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  // Whether the last attempt ended without any answer: a taken name on the next one then carries the hint of P-10.
  const uncertain = useRef(false);

  // What the visitor typed before opening S-03, when they come back from it (kept in memory only).
  const [draft] = useState(readRegisterDraft);
  const [errors, setErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);
  const [takenHint, setTakenHint] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [throttleOver, setThrottleOver] = useState(false);
  // True when the last press was sent, or failed, while the server was waking: only then does «the server is ready» need announcing.
  const [pressedWhileWaking, setPressedWhileWaking] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const throttled = result?.kind === "throttled";

  function inputFor(field: Field): HTMLInputElement | null {
    switch (field) {
      case "username":
        return usernameRef.current;
      case "password":
        return passwordRef.current;
      case "confirmation":
        return confirmationRef.current;
      case "consent":
        return consentRef.current;
    }
  }

  function readValues(): Values {
    return {
      username: usernameRef.current?.value ?? "",
      password: passwordRef.current?.value ?? "",
      confirmation: confirmationRef.current?.value ?? "",
      consent: consentRef.current?.checked ?? false,
    };
  }

  // Opening S-03 must not lose the form: the values wait in memory until the visitor is back, or until the account exists.
  function keepDraft() {
    saveRegisterDraft(readValues());
  }

  function focusFirstInvalid(found: Errors) {
    const first = FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) inputFor(first)?.focus();
  }

  // The message that goes with an error, in the language of the moment.
  function messageFor(field: Field, found: Errors): string | undefined {
    switch (field) {
      case "username":
        return found.username === undefined ? undefined : text.usernameErrors[found.username];
      case "password":
        return found.password === undefined ? undefined : messages.form.passwordRules[found.password];
      case "confirmation":
        return found.confirmation === undefined ? undefined : messages.form.confirmationRules[found.confirmation];
      case "consent":
        return found.consent === undefined ? undefined : text.consentRequired;
    }
  }

  function fail(failure: RegisterFailure, afterUncertain: boolean) {
    switch (failure.kind) {
      case "username_taken":
        // G-08: the values stay, the name field takes focus; after an uncertain attempt it also says the account may be the visitor's own.
        setErrors({ username: "taken" });
        setTakenHint(afterUncertain);
        usernameRef.current?.focus();
        break;
      case "terms_missing": {
        const found: Errors = { consent: true };
        setErrors(found);
        focusFirstInvalid(found);
        break;
      }
      case "fields": {
        const found: Errors = { username: failure.username ?? undefined, password: failure.password ?? undefined };
        setErrors(found);
        focusFirstInvalid(found);
        break;
      }
      case "throttled":
        setResult({ kind: "throttled", retryAfterSec: failure.retryAfterSec, endsAt: performance.now() + failure.retryAfterSec * 1000 });
        break;
      case "terms_outdated":
      case "unavailable":
      case "origin":
      case "internal":
        setResult({ kind: failure.kind });
        break;
      case "uncertain":
        uncertain.current = true;
        setPressedWhileWaking(true);
        setResult({ kind: "uncertain" });
        break;
      case "aborted":
        break;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || throttled) return;

    const values = readValues();
    const found = validateAll(values);
    setErrors(found);
    setAttempted(true);
    setTakenHint(false);
    if (FIELDS.some((field) => found[field] !== undefined)) {
      focusFirstInvalid(found);
      return;
    }

    const afterUncertain = uncertain.current;
    uncertain.current = false;
    setResult(null);
    setThrottleOver(false);
    setPressedWhileWaking(wake.phase === "waking" || wake.phase === "timed_out");
    setSubmitting(true);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_REQUEST_MS);
    let leaving = false;
    try {
      const { recoveryCode } = await api.register({
        username: values.username,
        password: values.password,
        timeZone: browserTimeZone(),
        language: locale,
        termsAccepted: true,
        termsVersion: TERMS_VERSION ?? "",
      });
      // The account exists, so nothing typed is kept, whether or not the visitor is still on this page.
      clearRegisterDraft();
      if (!mounted.current) return;
      for (const field of ["username", "password", "confirmation"] as const) {
        const input = inputFor(field);
        if (input) input.value = "";
      }
      // S-04 shows the code once; it is handed over in memory and the form is replaced in the history, so back never returns to it.
      holdRecoveryCode(recoveryCode, "register");
      leaving = true;
      router.replace("/recovery-code");
    } catch (error) {
      if (mounted.current) fail(classifyRegisterError(error, TERMS_VERSION), afterUncertain);
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      // On success the button keeps its loading state while the next screen opens.
      if (!leaving) setSubmitting(false);
    }
  }

  // P-03: a blur re-checks the field. The messages appearing or leaving move the button, so the check waits until a press that caused
  // the blur is over (afterPress); the value is read when it runs, not when the blur came in.
  function checkOnBlur(field: "username" | "password" | "confirmation") {
    afterPress(() => {
      const values = readValues();
      setErrors((current) => revalidated(current, field, values));
    });
  }

  // G-08: a taken name is answered again for the same name, so the message goes as soon as the name is edited.
  function nameEdited() {
    if (errors.username !== "taken") return;
    setErrors((current) => (current.username === "taken" ? { ...current, username: undefined } : current));
    setTakenHint(false);
  }

  function consentToggled() {
    if (errors.consent !== undefined && consentRef.current?.checked) setErrors((current) => ({ ...current, consent: undefined }));
  }

  const fieldIds: Record<Field, string> = { username: usernameId, password: passwordId, confirmation: confirmationId, consent: consentId };
  const summary: ErrorSummaryItem[] = FIELDS.flatMap((field) => {
    const message = messageFor(field, errors);
    return message === undefined ? [] : [{ fieldId: fieldIds[field], message }];
  });

  const offline = !online;
  const waking = !offline && (wake.phase === "waking" || wake.phase === "timed_out");
  // While the browser is offline or the server is waking, an earlier answer is stale; only the uncertain outcome belongs beside those banners.
  const shown = result !== null && (result.kind === "uncertain" || !(offline || waking)) ? result : null;
  const politeBanners = [
    offline ? <OfflineBanner key="offline" /> : waking ? <WakeUpBanner key="waking" timedOut={wake.phase === "timed_out"} /> : null,
    shown?.kind === "uncertain" ? (
      <Banner key="uncertain" variant="warning">
        {text.uncertain}
      </Banner>
    ) : null,
    shown?.kind === "throttled" ? <ThrottleBanner key="throttled" id={bannerId} retryAfterSec={shown.retryAfterSec} /> : null,
    shown?.kind === "unavailable" ? <UnavailableBanner key="unavailable" /> : null,
  ].filter((banner) => banner !== null);
  const alertBanner =
    shown?.kind === "internal" || shown?.kind === "origin" ? (
      <ServiceAlert kind={shown.kind} onReload={reloadPage} />
    ) : shown?.kind === "terms_outdated" ? (
      <TermsUpdatedAlert onReload={reloadPage} />
    ) : null;

  return (
    <div className="mx-auto w-full max-w-form">
      <PageTitle screenName={messages.screens.register} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {messages.screens.register}
      </h1>

      {attempted && summary.length >= 2 ? (
        <div className="mt-q24">
          <ErrorSummary title={messages.form.errorSummary(summary.length, formatInteger(locale, summary.length))} items={summary} />
        </div>
      ) : null}

      <div className="mt-q24">
        <p className="text-body text-ink">{text.lead}</p>
        <TextLink href="/terms" prefetch onClick={keepDraft}>
          {text.termsLink}
        </TextLink>
      </div>

      <form noValidate method="post" onSubmit={submit} className="mt-q24">
        <div className="flex flex-col gap-q16">
          <TextField
            id={usernameId}
            inputRef={usernameRef}
            name="username"
            label={text.usernameLabel}
            helper={text.usernameHelper}
            error={messageFor("username", errors)}
            errorHint={
              takenHint ? (
                <>
                  <p className="mt-q4 text-small text-ink-secondary">{text.takenHint}</p>
                  <TextLink href="/login">{text.loginLink}</TextLink>
                </>
              ) : undefined
            }
            type="text"
            dir="auto"
            defaultValue={draft?.username}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="next"
            onChange={nameEdited}
            onBlur={() => checkOnBlur("username")}
          />
          <PasswordField
            id={passwordId}
            inputRef={passwordRef}
            name="password"
            label={text.passwordLabel}
            helper={text.passwordHelper}
            error={messageFor("password", errors)}
            showLabel={messages.form.showPassword}
            hideLabel={messages.form.hidePassword}
            defaultValue={draft?.password}
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
            defaultValue={draft?.confirmation}
            autoComplete="new-password"
            enterKeyHint="go"
            onBlur={() => checkOnBlur("confirmation")}
          />
        </div>

        <div className="mt-q24">
          <Notice>{text.recoveryNotice}</Notice>
        </div>

        <div className="mt-q24 flex flex-col gap-q8">
          <Checkbox
            id={consentId}
            inputRef={consentRef}
            name="consent"
            label={text.consentLabel}
            aria-required="true"
            defaultChecked={draft?.consent}
            error={messageFor("consent", errors)}
            onChange={consentToggled}
          />
          <div className="flex flex-col items-start gap-q8">
            <TextLink href="/terms#terms" prefetch onClick={keepDraft}>
              {text.termsOfUse}
            </TextLink>
            <TextLink href="/terms#privacy" prefetch onClick={keepDraft}>
              {text.privacyStatement}
            </TextLink>
          </div>
        </div>

        <BannerSlot
          polite={
            <>
              {politeBanners.length > 0 ? <div className="flex flex-col gap-q16">{politeBanners}</div> : null}
              {slow ? <p className="mt-q8 text-small text-ink-secondary">{messages.form.stillProcessing}</p> : null}
            </>
          }
          alert={alertBanner}
          announcement={
            <>
              {submitting ? <p>{text.submittingStatus}</p> : null}
              {wake.phase === "ready" && pressedWhileWaking ? <p>{messages.server.ready}</p> : null}
              {reconnected && online ? <p>{messages.form.backOnline}</p> : null}
              {throttleOver ? <p>{messages.form.throttleOver}</p> : null}
            </>
          }
        />

        <div className="mt-q24">
          <Button type="submit" fullWidth loading={submitting} aria-disabled={throttled || undefined} aria-describedby={throttled ? bannerId : undefined}>
            {submitting ? text.submitting : text.submit}
          </Button>
          {shown?.kind === "throttled" ? (
            <div className="mt-q8">
              <Countdown
                endsAt={shown.endsAt}
                totalSeconds={shown.retryAfterSec}
                onDone={() => {
                  setResult(null);
                  setThrottleOver(true);
                }}
              />
            </div>
          ) : null}
        </div>
      </form>

      <p className="mt-q24 flex min-h-target flex-wrap items-center gap-x-q8 text-body text-ink">
        {text.haveAccount}
        <TextLink href="/login">{text.loginLink}</TextLink>
      </p>
    </div>
  );
}
