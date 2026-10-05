"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Banner } from "@/components/ui/Banner";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/ErrorSummary";
import { Notice } from "@/components/ui/Notice";
import { TextField } from "@/components/ui/TextField";
import { TextLink } from "@/components/ui/TextLink";
import { recoveryMessages } from "@/i18n/recovery-messages";
import { useLocale } from "@/i18n/LocaleProvider";
import { formatInteger } from "@/i18n/format";
import { normalizeRecoveryCode, verifyRecovery } from "@/lib/api/account-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import { afterPress } from "@/lib/dom/after-press";
import { ResultSlot, SubmitRow, useSubmitState } from "./account-form";
import { checkRecoveryCode, classifyVerifyError, makeResetGrant, type CodeRule, type RestartNotice, type ResetGrant } from "./recovery-model";

// Errors are kept as the rule that failed, not as text, so a language switch rewrites them.
interface Errors {
  username?: "empty";
  code?: CodeRule;
}

const FIELDS = ["username", "code"] as const;
type Field = (typeof FIELDS)[number];

// The code is shown as typed, left to right, in the mono face (S-05 "Field rules"). TextField takes no class name, so the face is set here.
const CODE_FACE = { fontFamily: "var(--q-font-mono)" } as const;

// S-05 step 1 (UI-screens Batch 1): username and recovery code, E06. The inputs are read from the page when the form is sent, so a password
// manager that fills them without a change event still works. A restart (the grant of step 2 was refused, or lapsed) opens it again with the
// generic refusal in Slot B and focus on the step heading.
export function RecoveryVerifyStep({
  username: keptUsername,
  restart,
  onVerified,
}: {
  username: string;
  restart: RestartNotice | null;
  onVerified: (username: string, grant: ResetGrant) => void;
}) {
  const { locale, messages } = useLocale();
  const { client } = useApiRuntime();
  const copy = recoveryMessages(locale);
  const text = copy.step1;
  const state = useSubmitState();

  const usernameId = useId();
  const codeId = useId();
  const bannerId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const [errors, setErrors] = useState<Errors>({});
  const [attempted, setAttempted] = useState(false);
  // The generic refusal of G-04, with the extra line of P-10 when it follows an uncertain attempt of step 2.
  const [refusal, setRefusal] = useState<RestartNotice | null>(restart);

  useEffect(() => {
    // A step change moves focus to its heading, so the step is announced. The first visit of the screen does not steal focus.
    if (restart !== null) headingRef.current?.focus();
  }, [restart]);

  function inputFor(field: Field): HTMLInputElement | null {
    return field === "username" ? usernameRef.current : codeRef.current;
  }

  function focusFirstInvalid(found: Errors) {
    const first = FIELDS.find((field) => found[field] !== undefined);
    if (first !== undefined) inputFor(first)?.focus();
  }

  function messageFor(field: Field, found: Errors): string | undefined {
    if (field === "username") return found.username === undefined ? undefined : text.usernameRequired;
    if (found.code === undefined) return undefined;
    return found.code === "empty" ? text.codeRequired : text.codeFormat;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.submitting || state.throttled) return;

    const username = usernameRef.current?.value.trim() ?? "";
    const rawCode = codeRef.current?.value ?? "";
    const found: Errors = { username: username === "" ? "empty" : undefined, code: checkRecoveryCode(rawCode) ?? undefined };
    setErrors(found);
    setAttempted(true);
    if (FIELDS.some((field) => found[field] !== undefined)) {
      focusFirstInvalid(found);
      return;
    }
    // The format check above guarantees a code; the normalised form is what the server compares.
    const recoveryCode = normalizeRecoveryCode(rawCode);
    if (recoveryCode === null) return;

    setRefusal(null);
    const end = state.begin();
    let leaving = false;
    try {
      const answer = await verifyRecovery(client, { username, recoveryCode });
      if (!state.mounted.current) return;
      leaving = true;
      onVerified(username, makeResetGrant(answer, performance.now()));
    } catch (error) {
      if (!state.mounted.current) return;
      const failure = classifyVerifyError(error);
      if (failure.kind === "invalid") {
        // G-04: one generic message, the code cleared and focused, the username kept.
        if (codeRef.current) codeRef.current.value = "";
        setRefusal({ afterUncertain: false });
        codeRef.current?.focus();
      } else {
        state.report(failure);
      }
    } finally {
      end(leaving);
    }
  }

  // P-03: a blur re-checks a field with content, or one already in error. The message appearing or leaving moves the button, so the check
  // waits until a press that caused the blur is over (afterPress); the value is read when it runs, not when the blur came in.
  function checkOnBlur(field: Field) {
    afterPress(() => {
      const value = inputFor(field)?.value ?? "";
      setErrors((current) => {
        if (current[field] === undefined && value === "") return current;
        if (field === "username") return { ...current, username: value.trim() === "" ? "empty" : undefined };
        return { ...current, code: checkRecoveryCode(value) ?? undefined };
      });
    });
  }

  const summary: ErrorSummaryItem[] = FIELDS.flatMap((field) => {
    const message = messageFor(field, errors);
    return message === undefined ? [] : [{ fieldId: field === "username" ? usernameId : codeId, message }];
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
        <div className="flex flex-col gap-q16">
          <TextField
            id={usernameId}
            inputRef={usernameRef}
            name="username"
            label={text.usernameLabel}
            error={messageFor("username", errors)}
            type="text"
            dir="auto"
            defaultValue={keptUsername}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="next"
            onBlur={() => checkOnBlur("username")}
          />
          <TextField
            id={codeId}
            inputRef={codeRef}
            name="recoveryCode"
            label={text.codeLabel}
            helper={text.codeHelper}
            error={messageFor("code", errors)}
            type="text"
            dir="ltr"
            style={CODE_FACE}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="go"
            onBlur={() => checkOnBlur("code")}
          />
        </div>

        <div className="mt-q24">
          <Notice>{text.notice}</Notice>
        </div>

        <ResultSlot
          state={state}
          bannerId={bannerId}
          submittingText={text.submittingStatus}
          alert={
            refusal !== null ? (
              <Banner variant="error" role="alert">
                <p>{copy.invalid}</p>
                {refusal.afterUncertain ? (
                  <>
                    <p className="mt-q8">{copy.invalidHint}</p>
                    <TextLink href="/login">{copy.loginLink}</TextLink>
                  </>
                ) : null}
              </Banner>
            ) : null
          }
        />

        <SubmitRow state={state} bannerId={bannerId} label={text.submit} loadingLabel={text.submitting} />
      </form>

      <p className="mt-q24 flex min-h-target flex-wrap items-center gap-x-q8 text-body text-ink">
        {text.remembered}
        <TextLink href="/login">{text.loginLink}</TextLink>
      </p>
    </>
  );
}
