"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Icon } from "@/components/ui/Icon";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TextField } from "@/components/ui/TextField";
import { MINUTE_CHOICES, type HadithPath } from "@/components/start/start-model";
import { formatLearningDate } from "@/components/today/today-model";
import { dailyAmountText } from "@/i18n/daily-amount";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import { daysPhrase, planOverviewMessages } from "@/i18n/plan-overview-messages";
import type { PlanReviseMessages } from "@/i18n/plan-revise-messages";
import { getStartMessages } from "@/i18n/start-messages";
import type { Plan, PlanOrder } from "@/lib/api/types";
import { isQuranPlan, hadithPathsOf, type ReviseField } from "./revise-model";
import type { Revise } from "./use-revise";

interface Props {
  locale: Locale;
  t: PlanReviseMessages;
  plan: Plan;
  revise: Revise;
  availablePaths: readonly HadithPath[];
  today: string; // the `min` of the date control: today in the account time zone
  banner: ReactNode; // the banner of a failed E15 or E17, in a polite area that stays in the page while empty
}

const RULE_TEXT: Record<string, keyof PlanReviseMessages["errors"]> = {
  session_minutes_invalid: "minutesInvalid",
  date_invalid: "dateInvalid",
  paths_invalid: "pathsInvalid",
  path_not_available: "pathsInvalid",
  order_not_available: "orderNotAvailable",
};

function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="mt-q8 flex items-start gap-q8 text-small text-error-ink">
      <Icon name="error" size="sm" className="mt-1" />
      {children}
    </p>
  );
}

// The structured fallback of S-13 (UI-screens S-13 c8 to c15): shown only when the conversation is unavailable. Four fields, the estimate
// preview and the confirm button. Scope and edition cannot be changed here, and no field takes free text.
export function PlanReviseForm({ locale, t, plan, revise, availablePaths, today, banner }: Props) {
  const start = getStartMessages(locale);
  const overview = planOverviewMessages(locale);
  const { form, fieldErrors, estimate } = revise;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previewRef = useRef<HTMLHeadingElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dateId = useId();
  const unchangedId = useId();
  const pathsHelperId = useId();
  const pathBoxId = useId();
  const quran = isQuranPlan(plan);

  // The form takes focus at its heading when it is revealed, the preview at its heading when the estimate appears, and the first invalid field
  // when a check fails (UI-screens S-13 section 5).
  const { formHeadingTick, previewTick, firstInvalid } = revise;
  useEffect(() => {
    if (formHeadingTick > 0) headingRef.current?.focus();
  }, [formHeadingTick]);
  useEffect(() => {
    if (previewTick > 0) previewRef.current?.focus();
  }, [previewTick]);
  useEffect(() => {
    if (firstInvalid === null) return;
    const root = rootRef.current;
    const target = root?.querySelector<HTMLElement>(`[data-field="${firstInvalid}"] input:checked`) ?? root?.querySelector<HTMLElement>(`[data-field="${firstInvalid}"] input`);
    target?.focus();
  }, [firstInvalid]);

  if (form === null) return null;

  const messageOf = (field: ReviseField): string | undefined => {
    const rule = fieldErrors[field];
    const key = rule === undefined ? undefined : RULE_TEXT[rule];
    return key === undefined ? undefined : t.errors[key];
  };
  const errorId = (field: ReviseField) => `${dateId}-${field}-error`;

  const paths = form.paths;
  const onlyOnePath = paths.length === 1;
  const fmt = (value: number) => formatInteger(locale, value);

  function togglePath(path: HadithPath) {
    if (paths.includes(path)) {
      if (paths.length === 1) return;
      revise.setField("paths", paths.filter((entry) => entry !== path));
      return;
    }
    revise.setField("paths", hadithPathsOf([...paths, path]));
  }

  const disabledReason = !revise.changed ? t.form.unchanged : undefined;
  const orders: PlanOrder[] = ["book", "reverse"];

  return (
    <div ref={rootRef} className="mt-q24 border-t border-divider pt-q24">
      <h2 ref={headingRef} tabIndex={-1} className="text-section text-ink">
        {t.form.heading}
      </h2>
      <p className="mt-q8 text-body-compact text-ink-secondary">{t.form.intro}</p>
      <div role="status" aria-live="polite" className="mt-q16 empty:hidden">
        {banner}
      </div>

      <div className="mt-q24 flex flex-col gap-q24">
        <div className="flex flex-col gap-q24 tablet:grid tablet:grid-cols-2 tablet:items-start">
          <div data-field="minutes">
            <SegmentedControl
              legend={t.form.minutes}
              value={form.minutes}
              onChange={(value) => revise.setField("minutes", value)}
              describedBy={messageOf("minutes") === undefined ? undefined : errorId("minutes")}
              options={MINUTE_CHOICES.map((value) => ({ value, label: start.minutes.label(fmt(value), value) }))}
            />
            {messageOf("minutes") !== undefined ? <FieldError id={errorId("minutes")}>{messageOf("minutes") ?? ""}</FieldError> : null}
          </div>

          <div data-field="date">
            <TextField
              id={dateId}
              type="date"
              dir="auto"
              label={t.form.date}
              helper={t.form.dateHelper}
              error={messageOf("date")}
              min={today}
              value={form.date}
              onChange={(event) => revise.setField("date", event.target.value)}
            />
          </div>
        </div>

        {!quran && availablePaths.length > 0 ? (
          <fieldset data-field="paths" aria-describedby={pathsHelperId} className="min-w-0">
            <legend className="mb-q8 text-body-compact font-semibold text-ink">{t.form.paths}</legend>
            {availablePaths.map((path) => {
              const checked = paths.includes(path);
              return (
                <Checkbox
                  key={path}
                  id={`${pathBoxId}-${path}`}
                  label={start.paths[path]}
                  checked={checked}
                  aria-disabled={checked && onlyOnePath ? true : undefined}
                  onChange={() => togglePath(path)}
                />
              );
            })}
            <p id={pathsHelperId} className="mt-q8 text-small text-ink-secondary">
              {t.form.pathsHelper}
            </p>
            {messageOf("paths") !== undefined ? <FieldError id={errorId("paths")}>{messageOf("paths") ?? ""}</FieldError> : null}
          </fieldset>
        ) : null}

        {quran ? (
          <div data-field="order">
            <SegmentedControl
              legend={t.form.order}
              value={form.order}
              onChange={(value) => revise.setField("order", value)}
              segmentWidth="wide"
              describedBy={messageOf("order") === undefined ? undefined : errorId("order")}
              options={orders.map((value) => ({ value, label: overview.goal.order[value] }))}
            />
            {messageOf("order") !== undefined ? <FieldError id={errorId("order")}>{messageOf("order") ?? ""}</FieldError> : null}
          </div>
        ) : null}

        <div>
          <Button
            variant="secondary"
            fullWidth
            loading={revise.calculating}
            aria-disabled={!revise.changed || undefined}
            aria-describedby={disabledReason === undefined ? undefined : unchangedId}
            onClick={() => void revise.calculate()}
          >
            {revise.calculating ? t.form.calculating : t.form.calculate}
          </Button>
          {disabledReason !== undefined ? (
            <p id={unchangedId} className="mt-q8 text-small text-ink-secondary">
              {disabledReason}
            </p>
          ) : null}
        </div>
      </div>

      {estimate !== null ? (
        <section aria-labelledby={`${dateId}-preview`} className="mt-q24">
          <h2 id={`${dateId}-preview`} ref={previewRef} tabIndex={-1} className="text-section text-ink">
            {t.preview.heading}
          </h2>
          <dl className="mt-q12 flex flex-col gap-q12 text-body-compact text-ink">
            <div>
              <dt className="font-semibold">{overview.sections.totalTime}</dt>
              <dd>{t.preview.total(daysPhrase(locale, estimate.estimate.days, fmt(estimate.estimate.days)), formatLearningDate(locale, estimate.estimate.endDate))}</dd>
            </div>
            <div>
              <dt className="font-semibold">{overview.sections.dailyTime}</dt>
              <dd>{t.preview.daily(fmt(estimate.estimate.sessionMinutes), estimate.estimate.sessionMinutes, dailyAmountText(locale, estimate.estimate))}</dd>
            </div>
            <div>
              <dt className="font-semibold">{overview.sections.nextStep}</dt>
              <dd>{t.preview.next}</dd>
            </div>
          </dl>
          {estimate.reason === "no_preferred_date" ? null : (
            <p className="mt-q12 text-body-compact text-ink">{estimate.reason === "exceeds_preferred_date" ? t.preview.exceeds : t.preview.fits}</p>
          )}
          <div className="mt-q24">
            <Button fullWidth loading={revise.confirming} onClick={revise.openDialog}>
              {revise.confirming ? t.form.confirming : t.form.confirm}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
