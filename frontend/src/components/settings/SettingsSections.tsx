"use client";

import { useId } from "react";
import { OfflineAccountRows, AccountSyncChip } from "@/components/pwa/OfflineSettings";
import { UnsyncedLogoutDialog } from "@/components/pwa/logout-guard";
import { Notice } from "@/components/ui/Notice";
import { useLocale } from "@/i18n/LocaleProvider";
import { planChatMessages } from "@/i18n/plan-chat-messages";
import { settingsMessages } from "@/i18n/settings-messages";
import type { Profile } from "@/lib/api/types";
import { LinkRow, ReadOnlyRow, RowList } from "./SettingsRows";

// c2 to c7. Without the profile (E11 failed) the two read-only rows are left out, and the rows to the account screens stay.
export function AccountSection({ profile }: { profile: Profile | null }) {
  const { locale } = useLocale();
  const t = settingsMessages(locale).account;
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-section text-ink">
        {t.heading}
      </h2>
      <div className="mt-q12">
        <RowList>
          {profile === null ? null : (
            <>
              <ReadOnlyRow label={t.nameLabel}>
                <bdi dir="ltr">{profile.username}</bdi>
              </ReadOnlyRow>
              <ReadOnlyRow label={t.syncLabel}>
                <AccountSyncChip />
              </ReadOnlyRow>
            </>
          )}
          <LinkRow href="/settings/password">{t.password}</LinkRow>
          <LinkRow href="/settings/recovery-code">{t.recoveryCode}</LinkRow>
          <LinkRow href="/settings/delete-account" tone="danger">
            {t.deleteAccount}
          </LinkRow>
        </RowList>
      </div>
      <div className="mt-q12 empty:hidden">
        <OfflineAccountRows />
      </div>
      <UnsyncedLogoutDialog />
    </section>
  );
}

// c16 to c18: the rows to S-26 and S-25, then the fixed transparency line. The line is the P-15 wording of the plan screens, never dismissible.
export function PrivacySection() {
  const { locale } = useLocale();
  const t = settingsMessages(locale).privacy;
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-section text-ink">
        {t.heading}
      </h2>
      <div className="mt-q12">
        <RowList>
          <LinkRow href="/settings/privacy">{t.privacyRow}</LinkRow>
          <LinkRow href="/settings/sources">{t.sourcesRow}</LinkRow>
        </RowList>
      </div>
      <div className="mt-q16">
        <Notice>{planChatMessages(locale).transparency}</Notice>
      </div>
    </section>
  );
}
