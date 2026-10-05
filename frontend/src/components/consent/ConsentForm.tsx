"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ResultSlot, SubmitRow, useSubmitState } from "@/components/recovery/account-form";
import { Banner } from "@/components/ui/Banner";
import { Checkbox } from "@/components/ui/Checkbox";
import { TermsUpdatedAlert } from "@/components/ui/FormBanners";
import { Spinner } from "@/components/ui/Spinner";
import { TextButton } from "@/components/ui/TextButton";
import { TextLink } from "@/components/ui/TextLink";
import { consentMessages } from "@/i18n/consent-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { renderTemplate } from "@/i18n/template";
import { acceptTerms, logout } from "@/lib/api/account-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import { homeDestination } from "@/lib/auth/destination";
import { raiseLoginArrival } from "@/lib/auth/flash";
import { clearRegisterDraft } from "@/lib/auth/register-draft";
import { reloadPage } from "@/lib/browser";
import { TERMS_VERSION } from "@/lib/config";
import { classifyConsentError, logoutAlreadyDone } from "./consent-failure";
import { claimReturnPath, endConsentVisit, readConsentDraft, saveConsentDraft } from "./consent-state";

// S-06 with the account known (UI-screens Batch 1): the unchecked box of S-02, Continue (E05) and the way out (E10). Only the terms version and
// the date are recorded server side; nothing about the box is sent. Phone order, 24 px between regions: lead, version and account lines, the
// terms link, the consent block, Slot B, Continue, then 12 px to the logout button (FC-08).
export function ConsentForm({ username }: { username: string }) {
  const { locale } = useLocale();
  const { api, client } = useApiRuntime();
  const router = useRouter();
  const copy = consentMessages(locale);
  const state = useSubmitState();

  const consentId = useId();
  const bannerId = useId();
  const consentRef = useRef<HTMLInputElement>(null);
  const outdatedRef = useRef<HTMLDivElement>(null);

  const [boxError, setBoxError] = useState(false);
  // E05 `terms_required`: the server holds a version this build has not shown (O-09).
  const [outdated, setOutdated] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);

  useEffect(() => {
    // The reload button is where focus belongs when the versions differ (S-06 "States").
    if (outdated) outdatedRef.current?.querySelector("button")?.focus();
  }, [outdated]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting || state.throttled || loggingOut) return;

    // No request without the box: the error stands in for a disabled button (S-06 "Validation").
    if (!consentRef.current?.checked) {
      setBoxError(true);
      consentRef.current?.focus();
      return;
    }
    setBoxError(false);
    setOutdated(false);
    setLogoutFailed(false);
    // A version this build has not shown is never sent (O-09): a build made without one cannot ask.
    if (TERMS_VERSION === null) {
      state.report({ kind: "internal" });
      return;
    }

    const end = state.begin();
    let leaving = false;
    try {
      await acceptTerms(client, { termsVersion: TERMS_VERSION });
      // The visit ends with the answer, whether or not the learner is still here.
      const kept = claimReturnPath();
      endConsentVisit();
      const target = kept ?? (await homeDestination(api));
      if (!state.mounted.current) return;
      leaving = true;
      router.replace(target);
    } catch (error) {
      if (!state.mounted.current) return;
      const failure = classifyConsentError(error);
      switch (failure.kind) {
        case "terms_outdated":
          setOutdated(true);
          break;
        case "session_ended":
          // G-03: S-01 with the session-ended banner, and the gate again after the login.
          raiseLoginArrival("session_ended");
          leaving = true;
          router.replace(`/login?next=${encodeURIComponent("/consent")}`);
          break;
        default:
          state.report(failure);
      }
    } finally {
      end(leaving);
    }
  }

  // E10: no dialog (nothing is unsynced in option B). A 401 means the session is already gone; anything else keeps the learner here.
  async function leave() {
    if (loggingOut || state.submitting) return;
    setLogoutFailed(false);
    setOutdated(false);
    state.clearResult();
    setLoggingOut(true);
    let done = false;
    try {
      await logout(client);
      done = true;
    } catch (error) {
      done = logoutAlreadyDone(error);
    }
    if (!done) {
      if (state.mounted.current) {
        setLogoutFailed(true);
        setLoggingOut(false);
      }
      return;
    }
    // Nothing kept for the learner outlives the session.
    endConsentVisit();
    clearRegisterDraft();
    if (state.mounted.current) router.replace("/login");
  }

  const versionLine =
    TERMS_VERSION === null
      ? renderTemplate(copy.accountOnly, { username: <bdi dir="auto">{username}</bdi> })
      : renderTemplate(copy.versionAndAccount, { version: <bdi dir="ltr">{TERMS_VERSION}</bdi>, username: <bdi dir="auto">{username}</bdi> });

  return (
    <>
      <p className="mt-q24 text-body text-ink">{copy.lead}</p>
      <p className="mt-q24 text-small text-ink-secondary">{versionLine}</p>
      <div className="mt-q24">
        <TextLink href="/terms" prefetch>
          {copy.termsLink}
        </TextLink>
      </div>

      <form noValidate method="post" onSubmit={submit} className="mt-q24">
        <div className="flex flex-col gap-q8">
          <Checkbox
            id={consentId}
            inputRef={consentRef}
            name="consent"
            label={copy.consentLabel}
            aria-required="true"
            defaultChecked={readConsentDraft()}
            error={boxError ? copy.consentRequired : undefined}
            onChange={(event) => {
              saveConsentDraft(event.target.checked);
              if (event.target.checked) setBoxError(false);
            }}
          />
          <div className="flex flex-col items-start gap-q8">
            <TextLink href="/terms#terms" prefetch>
              {copy.termsOfUse}
            </TextLink>
            <TextLink href="/terms#privacy" prefetch>
              {copy.privacyStatement}
            </TextLink>
          </div>
        </div>

        <ResultSlot
          state={state}
          bannerId={bannerId}
          submittingText={copy.submittingStatus}
          announcement={loggingOut ? <p>{copy.loggingOutStatus}</p> : null}
          alert={
            outdated ? (
              <div ref={outdatedRef}>
                <TermsUpdatedAlert onReload={reloadPage} />
              </div>
            ) : logoutFailed ? (
              <Banner variant="error" role="alert">
                {copy.logoutFailed}
              </Banner>
            ) : null
          }
        />

        <SubmitRow state={state} bannerId={bannerId} label={copy.submit} loadingLabel={copy.submitting} inert={loggingOut} />
      </form>

      <div className="mt-q12 flex justify-center">
        <TextButton aria-disabled={state.submitting || loggingOut || undefined} aria-busy={loggingOut || undefined} onClick={() => void leave()}>
          {loggingOut ? <Spinner /> : null}
          {loggingOut ? copy.loggingOut : copy.logout}
        </TextButton>
      </div>
    </>
  );
}
