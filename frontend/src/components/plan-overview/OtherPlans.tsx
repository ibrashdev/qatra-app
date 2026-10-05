"use client";

import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import type { PlanOverviewMessages } from "@/i18n/plan-overview-messages";
import type { PlanProgress } from "@/lib/api/types";
import { cx } from "@/lib/cx";

interface Props {
  locale: Locale;
  t: PlanOverviewMessages;
  plans: readonly PlanProgress[];
  // False for a demo account (and while that is unknown): «استئناف» is never offered then (E30 `403`, G-06).
  canResume: boolean;
  resumingId: string | null;
  onResume: (plan: PlanProgress) => void;
}

// UI-tokens 6.11: a non-interactive chip, always icon plus label. Paused and completed have no mastery colour of their own, so the plan chips
// use the info and the success tints.
function StatusChip({ status, label }: { status: "paused" | "completed"; label: string }) {
  return (
    <span className={cx("inline-flex h-badge items-center gap-q4 rounded-sm px-q12 text-caption", status === "paused" ? "bg-info-tint text-info-ink" : "bg-success-tint text-success-ink")}>
      <Icon name={status === "paused" ? "info" : "success"} size="sm" />
      {label}
    </span>
  );
}

function PlanRow({ locale, t, plan, canResume, resumingId, onResume }: Omit<Props, "plans"> & { plan: PlanProgress }) {
  const titleId = useId();
  const title = locale === "ar" ? plan.titleAr : plan.titleEn;
  const paused = plan.status === "paused";
  const resuming = resumingId === plan.planId;
  return (
    <li className="rounded-md border border-divider bg-surface p-q16">
      <div className="flex flex-wrap items-center justify-between gap-x-q12 gap-y-q8">
        <p id={titleId} className="min-w-0 flex-1 text-body-compact text-ink">
          <bdi lang={locale} dir="auto">
            {title}
          </bdi>
        </p>
        <span className="flex items-center gap-q12 text-body-compact text-ink">
          <StatusChip status={paused ? "paused" : "completed"} label={paused ? t.others.paused : t.others.completed} />
          {t.others.percent(formatInteger(locale, Math.min(100, Math.max(0, Math.trunc(plan.overallPercent)))))}
        </span>
      </div>
      <p className="mt-q8 text-small text-ink-secondary">{paused ? t.others.pausedLine : t.others.completedLine}</p>
      {paused && canResume ? (
        <div className="mt-q12">
          <Button variant="secondary" loading={resuming} aria-disabled={(resumingId !== null && !resuming) || undefined} aria-describedby={titleId} onClick={() => onResume(plan)}>
            {resuming ? t.others.resuming : t.others.resume}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// c10: «خطط أخرى», one row per paused or completed plan (UI-tokens 6.7). A completed plan has no action: it can be neither revised nor resumed.
export function OtherPlans(props: Props) {
  const { t, plans } = props;
  const headingId = useId();
  if (plans.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="mt-q24">
      <h2 id={headingId} className="text-section text-ink">
        {t.others.heading}
      </h2>
      <ul className="mt-q12 flex flex-col gap-q8">
        {plans.map((plan) => (
          <PlanRow key={plan.planId} {...props} plan={plan} />
        ))}
      </ul>
    </section>
  );
}
