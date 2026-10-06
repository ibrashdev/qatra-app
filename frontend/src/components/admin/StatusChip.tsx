"use client";

import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import type { EditionStatus } from "@/lib/api/admin-types";
import { cx } from "@/lib/cx";
import { statusLabel, statusTone, type ChipTone } from "./admin-model";

// The status tints of the banners (UI-tokens 6.8), as a small chip: the words carry the meaning, the tint only supports them.
const TONES: Record<ChipTone, string> = {
  success: "bg-success-tint text-success-ink",
  info: "bg-info-tint text-info-ink",
  warning: "bg-warning-tint text-warning-ink",
  error: "bg-error-tint text-error-ink",
  neutral: "bg-disabled text-ink",
};

const CHIP = "inline-flex h-badge items-center gap-q4 rounded-sm px-q12 text-caption";

export function StatusChip({ status }: { status: EditionStatus }) {
  const { locale } = useLocale();
  return <span className={cx(CHIP, TONES[statusTone(status)])}>{statusLabel(adminMessages(locale), status)}</span>;
}

// A published edition that the manager hid from the catalog (reversible). The glyph and the words say it; learners cannot see the edition.
export function HiddenMark() {
  const { locale } = useLocale();
  return (
    <span className={cx(CHIP, "border border-edge bg-surface text-ink")}>
      <Icon name="eye-off" size="sm" />
      {adminMessages(locale).hiddenMark}
    </span>
  );
}
