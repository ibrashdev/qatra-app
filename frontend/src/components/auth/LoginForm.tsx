"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Banner, type BannerVariant } from "@/components/ui/Banner";
import { BrandMark } from "@/components/ui/BrandMark";
import { Button } from "@/components/ui/Button";
import { Countdown } from "@/components/ui/Countdown";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/ErrorSummary";
import { BannerSlot, OfflineBanner, ServiceAlert, ThrottleBanner, UnavailableBanner, WakeUpBanner } from "@/components/ui/FormBanners";
import { PageTitle } from "@/components/ui/PageTitle";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextField } from "@/components/ui/TextField";
import { TextLink } from "@/components/ui/TextLink";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatInteger } from "@/i18n/format";
import type { LoginMessages } from "@/i18n/auth-messages";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { homeDestination } from "@/lib/auth/destination";
import { clearLoginArrival, peekLoginArrival, type LoginArrival } from "@/lib/auth/flash";
import { classifyLoginError, type LoginFailure } from "@/lib/auth/login-failure";
import { clearRegisterDraft } from "@/lib/auth/register-draft";
import { setReturnPath } from "@/lib/auth/return-path";
import { safeNextPath } from "@/lib/auth/safe-path";
import { useSignedInRedirect } from "@/lib/auth/use-signed-in-redirect";
import { reloadPage } from "@/lib/browser";
import { afterPress } from "@/lib/dom/after-press";
import { useConnectivity } from "@/lib/net/use-connectivity";

// P-06: a request that waits longer than this (the server holds the answer after the fifth failure) says it is still working.
const SLOW_REQUEST_MS = 5_000;

// A null message is the note of S-04 about a code that was left unconfirmed or is gone: its words are in the S-04 catalog.
const ARRIVALS = {
  session_ended: { variant: "warning", message: "sessionEnded" },
  reset_done: { variant: "success", message: "resetDone" },
  account_deleted: { variant: "info", message: "accountDeleted" },
  code_unavailable: { variant: "info", message: null },
} as const satisfies Record<LoginArrival, { variant: BannerVariant; message: keyof LoginMessages["arrival"] | null }>;

// What the last press left behind, shown above the submit button. Connectivity is not here: the wake-up and offline banners speak for it.
type Result =
  | { kind: "credentials" }
  | { kind: "internal" }
  | { kind: "unavailable" }
  | { kind: "origin" }
  | { kind: "throttled"; retryAfterSec: number; endsAt: number }; // endsAt is a performance.now() value

interface Invalid {
  username: boolean;
  password: boolean;
}

const VALID: Invalid = { username: false, password: false };

// S-01 (UI-screens Batch 1): username and password, E04. The inputs are read from the page when the form is sent, not from state,
// so a password manager that fills them without a change event still works.
export function LoginForm() {
  const { locale, messages, setLocale } = useLocale();
  const { api } = useApiRuntime();
  const router = useRouter();
  const wake = useWakeUpState();
  const { online, reconnected } = useConnectivity();
  useSignedInRedirect();

  const text = messages.auth.login;
  const usernameId = useId();
  const passwordId = useId();
  const bannerId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);

  const [invalid, setInvalid] = useState<Invalid>(VALID);
  const [submitting, setSubmitting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [throttleOver, setThrottleOver] = useState(false);
  // True when the last press was sent, or failed, while the server was waking: only then does «the server is ready» need announcing.
  const [pressedWhileWaking, setPressedWhileWaking] = useState(false);
  const [arrival, setArrival] = useState<LoginArrival | null>(() => peekLoginArrival());

  useEffect(() => {
    mounted.current = true;
    // The arrival banner is shown once: it is in state now, so the in-memory flag has done its job.
    clearLoginArrival();
    return () => {
      mounted.current = false;
    };
  }, []);

  const throttled = result?.kind === "throttled";

  function fail(failure: LoginFailure) {
    switch (failure.kind) {
      case "credentials": {
        // G-04: one generic message, no field marked, the password cleared and focused.
        if (passwordRef.current) passwordRef.current.value = "";
        setResult({ kind: "credentials" });
        passwordRef.current?.focus();
        break;
      }
      case "throttled":
        setResult({ kind: "throttled", retryAfterSec: failure.retryAfterSec, endsAt: performance.now() + failure.retryAfterSec * 1000 });
        break;
      case "unavailable":
      case "origin":
      case "internal":
        setResult({ kind: failure.kind });
        break;
      case "connectivity":
        setPressedWhileWaking(true);
        break;
      case "aborted":
        break;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || throttled) return;

    const username = usernameRef.current?.value.trim() ?? "";
    const password = passwordRef.current?.value ?? "";
    const missing: Invalid = { username: username === "", password: password === "" };
    setInvalid(missing);
    if (missing.username || missing.password) {
      (missing.username ? usernameRef : passwordRef).current?.focus();
      return;
    }

    setResult(null);
    setThrottleOver(false);
    setPressedWhileWaking(wake.phase === "waking" || wake.phase === "timed_out");
    setSubmitting(true);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_REQUEST_MS);
    let leaving = false;
    try {
      const { profile, reconsentRequired } = await api.login({ username, password });
      // A session exists now, so a registration draft with a password in it must not outlive it.
      clearRegisterDraft();
      if (!mounted.current) return;
      if (passwordRef.current) passwordRef.current.value = "";
      // After login the profile language prevails (P-02).
      if (profile.language !== locale) setLocale(profile.language);
      const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
      if (reconsentRequired) setReturnPath(next);
      const destination = reconsentRequired ? "/consent" : (next ?? (await homeDestination(api)));
      // E18 may have taken a while: if the visitor has gone elsewhere meanwhile, the page does not pull them back.
      if (!mounted.current) return;
      leaving = true;
      router.replace(destination);
    } catch (error) {
      if (mounted.current) fail(classifyLoginError(error));
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      // On success the button keeps its loading state while the next screen opens.
      if (!leaving) setSubmitting(false);
    }
  }

  // P-03: an error clears at the field's next blur once the field holds something. The message leaving moves the button, so the clearing
  // waits until a press that caused the blur is over (afterPress); the value is read when it runs, not when the blur came in.
  function clearWhenFixed(field: keyof Invalid) {
    if (!invalid[field]) return;
    afterPress(() => {
      const value = field === "username" ? usernameRef.current?.value.trim() : passwordRef.current?.value;
      if (value) setInvalid((current) => ({ ...current, [field]: false }));
    });
  }

  function dismissArrival() {
    setArrival(null);
    headingRef.current?.focus();
  }

  const summary: ErrorSummaryItem[] = [
    ...(invalid.username ? [{ fieldId: usernameId, message: text.usernameRequired }] : []),
    ...(invalid.password ? [{ fieldId: passwordId, message: text.passwordRequired }] : []),
  ];

  const offline = !online;
  const waking = !offline && (wake.phase === "waking" || wake.phase === "timed_out");
  const politeBanner = offline ? (
    <OfflineBanner />
  ) : waking ? (
    <WakeUpBanner timedOut={wake.phase === "timed_out"} />
  ) : result?.kind === "throttled" ? (
    <ThrottleBanner id={bannerId} retryAfterSec={result.retryAfterSec} />
  ) : result?.kind === "unavailable" ? (
    <UnavailableBanner />
  ) : null;
  const alertBanner =
    offline || waking ? null : result?.kind === "credentials" ? (
      <Banner variant="error" role="alert">
        {text.invalidCredentials}
      </Banner>
    ) : result?.kind === "internal" || result?.kind === "origin" ? (
      <ServiceAlert kind={result.kind} onReload={reloadPage} />
    ) : null;

  return (
    <div className="mx-auto w-full max-w-form">
      <PageTitle screenName={messages.screens.login} />
      <BrandMark />
      <h1 ref={headingRef} data-page-heading tabIndex={-1} className="mt-q16 text-title text-ink">
        {messages.screens.login}
      </h1>

      {arrival !== null || summary.length >= 2 ? (
        <div className="mt-q16 flex flex-col gap-q16">
          {arrival !== null ? (
            <Banner variant={ARRIVALS[arrival].variant} dismiss={{ label: messages.form.dismiss, onDismiss: dismissArrival }}>
              {ARRIVALS[arrival].message === null ? messages.recoveryCode.unavailableRecovery : text.arrival[ARRIVALS[arrival].message]}
            </Banner>
          ) : null}
          {summary.length >= 2 ? <ErrorSummary title={messages.form.errorSummary(summary.length, formatInteger(locale, summary.length))} items={summary} /> : null}
        </div>
      ) : null}

      <form noValidate method="post" onSubmit={submit} className="mt-q16">
        <div className="flex flex-col gap-q16">
          <TextField
            id={usernameId}
            inputRef={usernameRef}
            name="username"
            label={text.usernameLabel}
            error={invalid.username ? text.usernameRequired : undefined}
            type="text"
            dir="auto"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="next"
            onBlur={() => clearWhenFixed("username")}
          />
          <PasswordField
            id={passwordId}
            inputRef={passwordRef}
            name="password"
            label={text.passwordLabel}
            error={invalid.password ? text.passwordRequired : undefined}
            showLabel={messages.form.showPassword}
            hideLabel={messages.form.hidePassword}
            autoComplete="current-password"
            enterKeyHint="go"
            onBlur={() => clearWhenFixed("password")}
          />
        </div>

        <BannerSlot
          polite={
            <>
              {politeBanner}
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

        <div className="mt-q16">
          <Button type="submit" fullWidth loading={submitting} aria-disabled={throttled || undefined} aria-describedby={throttled ? bannerId : undefined}>
            {submitting ? text.submitting : text.submit}
          </Button>
          {result?.kind === "throttled" ? (
            <div className="mt-q8">
              <Countdown
                endsAt={result.endsAt}
                totalSeconds={result.retryAfterSec}
                onDone={() => {
                  setResult(null);
                  setThrottleOver(true);
                }}
              />
            </div>
          ) : null}
        </div>
      </form>

      <div className="mt-q16 flex flex-col gap-q8">
        <TextLink href="/recovery">{text.forgotPassword}</TextLink>
        <p className="flex min-h-target flex-wrap items-center gap-x-q8 text-body text-ink">
          {text.noAccount}
          <TextLink href="/register">{text.createAccount}</TextLink>
        </p>
      </div>
    </div>
  );
}
