import { Icon, type IconName } from "@/components/ui/Icon";
import type { SectionStatus } from "@/i18n/progress-messages";
import { cx } from "@/lib/cx";

// UI-tokens 6.11: a non-interactive chip, 28 px high, always icon plus label. Learning is the half circle, reviewing the clock. `new` never shows
// in S-21 (no group); its circle outline is not in the kit, so the droplet stands in.
const STYLES: Record<SectionStatus, { icon: IconName; box: string }> = {
  new: { icon: "droplet", box: "bg-disabled text-ink" },
  learning: { icon: "half", box: "bg-selection text-ink-accent" },
  reviewing: { icon: "clock", box: "bg-selection text-ink-accent" },
  confirmed: { icon: "success", box: "bg-success-tint text-success-ink" },
  needs_refresh: { icon: "refresh", box: "bg-warning-tint text-warning-ink" },
};

export function MasteryBadge({ status, label }: { status: SectionStatus; label: string }) {
  const style = STYLES[status];
  return (
    <span className={cx("inline-flex h-badge items-center gap-q4 rounded-sm px-q12 text-caption", style.box)}>
      <Icon name={style.icon} size="sm" />
      {label}
    </span>
  );
}
