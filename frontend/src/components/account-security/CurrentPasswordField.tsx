"use client";

import type { RefObject } from "react";
import { PasswordField } from "@/components/ui/PasswordField";
import { useLocale } from "@/i18n/LocaleProvider";
import { accountSecurityMessages } from "@/i18n/account-security-messages";

// P-27: «كلمة المرور الحالية» as P-08 describes a password field, without length checks, for the browser's saved password; and a username field
// that nobody sees, so a password manager fills (and, on S-23, updates) the right account. Its value comes from E11 (use-reauth-submit.ts);
// it is empty when that read failed.
export function CurrentPasswordField({
  id,
  inputRef,
  username,
  error,
  readOnly,
  onBlur,
}: {
  id: string;
  inputRef: RefObject<HTMLInputElement | null>;
  username: string;
  error?: string;
  // The field is inert while a deletion is in flight (S-27), but it keeps the focus it has.
  readOnly?: boolean;
  onBlur: () => void;
}) {
  const { locale, messages } = useLocale();
  const text = accountSecurityMessages(locale).currentPassword;
  return (
    <>
      <input type="text" name="username" value={username} readOnly autoComplete="username" tabIndex={-1} aria-hidden="true" className="sr-only" />
      <PasswordField
        id={id}
        inputRef={inputRef}
        name="currentPassword"
        label={text.label}
        error={error}
        showLabel={messages.form.showPassword}
        hideLabel={messages.form.hidePassword}
        autoComplete="current-password"
        enterKeyHint="go"
        readOnly={readOnly}
        onBlur={onBlur}
      />
    </>
  );
}
