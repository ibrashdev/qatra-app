"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { raiseCodeUnavailable, raiseLoginArrival } from "@/lib/auth/flash";
import { nextScreen, RECOVERY_CODE_FILE_NAME, recoveryCodeFileText, wipeRecoveryCode, type RecoveryHost } from "@/lib/auth/recovery-handoff";
import { reloadPage } from "@/lib/browser";
import { RecoveryCodeBlock } from "./RecoveryCodeBlock";
import { useRecoveryCodeLeaveGuard } from "./RecoveryCodeLeaveGuard";

// The blob URL lives a moment after the click, so every browser has started the download before it is released.
const BLOB_LIFETIME_MS = 1_000;

// S-04 (UI-screens Batch 1) with the code in hand: shown once, copied or downloaded, and a confirmation that gates the continue action.
// It calls no API. The code is in this component's state and in recovery-handoff for as long as the screen is open, and nowhere else.
export function RecoveryCodeSave({ code, groups, host }: { code: string; groups: readonly string[]; host: RecoveryHost }) {
  const { messages } = useLocale();
  const router = useRouter();
  const toast = useToast();
  const text = messages.recoveryCode;
  const leadId = useId();
  const confirmId = useId();
  const blockRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const leaving = useRef(false);

  const [confirmed, setConfirmed] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [asking, setAsking] = useState(false);

  const guard = useRecoveryCodeLeaveGuard({ active: !confirmed, onAttempt: () => setAsking(true) });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Wiped when the screen goes away, whichever way it goes.
      wipeRecoveryCode();
    };
  }, []);

  useEffect(() => {
    // A page that returns from the back-forward cache comes back with the code still drawn on it. It is not shown again: the page loads anew
    // and meets guard 9.
    function onPageShow(event: PageTransitionEvent) {
      if (!event.persisted) return;
      wipeRecoveryCode();
      reloadPage();
    }
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("pagehide", wipeRecoveryCode);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", wipeRecoveryCode);
    };
  }, []);

  // The next screen: the memory is wiped first, the guard gives its history entry back, and the screen is replaced, so back never returns here.
  const finish = useCallback(
    async (kind: "continue" | "leave") => {
      if (leaving.current) return;
      leaving.current = true;
      const next = nextScreen(host);
      wipeRecoveryCode();
      await guard.release();
      if (!mounted.current) return;
      if (kind === "continue") {
        if (host === "recovery") raiseLoginArrival("reset_done");
      } else if (next === "/login") {
        raiseLoginArrival("code_unavailable");
      } else {
        raiseCodeUnavailable();
      }
      router.replace(next);
    },
    [guard, host, router],
  );

  function selectCode() {
    const block = blockRef.current;
    const selection = window.getSelection();
    if (!block || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(block);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // Copy: the code with its dashes. Where the clipboard cannot be written the notice says so and the text is selected for a copy by hand.
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopyFailed(false);
      toast.show(text.copied);
    } catch {
      setCopyFailed(true);
      selectCode();
    }
  }

  // Download: a text file made here, in the language of the page. The username is never in it (UI-screens O-17).
  function download() {
    const file = recoveryCodeFileText({ title: text.fileTitle, code, warning: text.fileWarning });
    const url = URL.createObjectURL(new Blob([file], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = RECOVERY_CODE_FILE_NAME;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), BLOB_LIFETIME_MS);
    toast.show(text.downloaded);
  }

  // The error stands in for a disabled button (UI-tokens 6.15): nothing is sent and focus goes to the box.
  function continueClicked() {
    if (!confirmed) {
      setUnconfirmed(true);
      confirmRef.current?.focus();
      return;
    }
    void finish("continue");
  }

  function stay() {
    setAsking(false);
    guard.rearm();
  }

  const lead = host === "register" ? text.lead : `${text.lead} ${text.oldCodeInvalid}`;

  return (
    <>
      <div className="flex flex-col gap-q24">
        {host === "recovery" ? <p className="text-small text-ink-secondary">{text.step}</p> : null}
        <h1 data-page-heading tabIndex={-1} aria-describedby={leadId} className="text-title text-ink">
          {messages.screens.recoveryCode}
        </h1>
        <p id={leadId} className="text-body text-ink">
          {lead}
        </p>
        <Banner variant="warning">{text.warning}</Banner>
        <RecoveryCodeBlock groups={groups} name={text.blockName} description={text.blockDescription} blockRef={blockRef} />
        <div>
          <div className="flex flex-wrap gap-q8">
            <Button variant="secondary" onClick={() => void copy()}>
              <Icon name="copy" size="md" />
              {text.copy}
            </Button>
            <Button variant="secondary" onClick={download}>
              <Icon name="download" size="md" />
              {text.download}
            </Button>
          </div>
          <div role="status" aria-live="polite" className="has-[*]:mt-q8">
            {copyFailed ? <Notice>{text.copyUnavailable}</Notice> : null}
          </div>
        </div>
        <Checkbox
          id={confirmId}
          inputRef={confirmRef}
          name="confirmed"
          label={text.confirmLabel}
          aria-required="true"
          checked={confirmed}
          error={unconfirmed ? text.confirmRequired : undefined}
          onChange={(event) => {
            setConfirmed(event.target.checked);
            if (event.target.checked) setUnconfirmed(false);
          }}
        />
        <Button fullWidth onClick={continueClicked}>
          {text.continueLabel}
        </Button>
      </div>
      <Dialog
        open={asking}
        role="alertdialog"
        title={text.leave.title}
        primary={{ label: text.leave.stay, onPress: stay }}
        secondary={{ label: text.leave.leave, onPress: () => void finish("leave") }}
        onCancel={stay}
      >
        {host === "recovery" ? text.leave.bodyRecovery : text.leave.body}
      </Dialog>
    </>
  );
}
