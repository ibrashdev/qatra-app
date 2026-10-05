import { useId } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

export interface HelperStep {
  icon: IconName;
  label: string;
}

// FC-06: a static, explanatory strip. It holds no state, links nothing and announces nothing: a heading and an ordered list of steps in reading
// order, so the sequence runs from the start edge to the end edge in both languages with no arrow characters. The steps wrap instead of clipping
// when the text grows. Phones only: S-01 adds nothing to the single column on tablet and desktop.
export function LoginHelperStrip({ heading, steps, className }: { heading: string; steps: readonly HelperStep[]; className?: string }) {
  const headingId = useId();
  return (
    <div className={cx("rounded-md border border-edge bg-surface p-q12 tablet:hidden", className)}>
      <p id={headingId} className="text-body-compact text-ink">
        {heading}
      </p>
      <ol aria-labelledby={headingId} className="mt-q8 flex flex-wrap gap-x-q16 gap-y-q8">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-q8 text-body-compact text-ink-secondary">
            <Icon name={step.icon} size="md" className="text-primary" />
            {step.label}
          </li>
        ))}
      </ol>
    </div>
  );
}
