"use client";

import { LinkRow, RowList } from "@/components/settings/SettingsRows";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { useAdminAccess } from "./use-admin-access";

// AD-00: the row of settings that leads to the content manager screens (docs/Content-admin.md section 6). It is in the page only after
// GET /api/admin/access answered 200 with `contentManager: true`. Every other answer, and no answer, leaves it out and shows nothing else: no banner,
// no error, no hint.
export function ContentAdminRow() {
  const { locale } = useLocale();
  const allowed = useAdminAccess();
  if (!allowed) return null;
  return (
    <RowList>
      <LinkRow href="/admin">{adminMessages(locale).screenName}</LinkRow>
    </RowList>
  );
}
