import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "./Icon";

export type BannerVariant = "info" | "success" | "warning" | "error";

// UI-tokens 6.8: tint fill, 1 px border, the text token on its own tint (at least 5.8:1), the border token for the glyph (at least 4.2:1).
const STYLES: Record<BannerVariant, { box: string; glyph: string }> = {
  info: { box: "border-info-edge bg-info-tint text-info-ink", glyph: "text-info-edge" },
  success: { box: "border-success-edge bg-success-tint text-success-ink", glyph: "text-success-edge" },
  warning: { box: "border-warning-edge bg-warning-tint text-warning-ink", glyph: "text-warning-edge" },
  error: { box: "border-error-edge bg-error-tint text-error-ink", glyph: "text-error-edge" },
};

export interface BannerProps {
  variant: BannerVariant;
  children: ReactNode;
  title?: string;
  // Replaces the glyph of the variant, for the loader of the wake-up banner.
  icon?: ReactNode;
  action?: ReactNode;
  dismiss?: { label: string; onDismiss: () => void };
  // The live-region role is the caller's choice. An error raised by a press passes "alert"; a polite banner sits inside a status region
  // that was already in the page, and an arrival banner has no role at all, because it is read after the heading (P-09).
  role?: "alert";
  id?: string;
}

export function Banner({ variant, children, title, icon, action, dismiss, role, id }: BannerProps) {
  const style = STYLES[variant];
  return (
    <div id={id} role={role} className={cx("flex items-start gap-q12 rounded-md border p-q16", style.box)}>
      <span className={cx("mt-0.5 flex shrink-0", style.glyph)}>{icon ?? <Icon name={variant} size="md" />}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className="mb-q4 text-section">{title}</p> : null}
        <div className="text-body-compact">{children}</div>
        {action ? <div className="mt-q12">{action}</div> : null}
      </div>
      {dismiss ? (
        <button
          type="button"
          aria-label={dismiss.label}
          onClick={dismiss.onDismiss}
          className="-m-q12 flex size-target shrink-0 items-center justify-center rounded-sm transition-[color,background-color] duration-(--q-duration-fast) hover:bg-selection focus-visible:outline-offset-[-2px]"
        >
          <Icon name="close" size="lg" />
        </button>
      ) : null}
    </div>
  );
}
