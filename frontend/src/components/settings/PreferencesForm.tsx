"use client";

import { useId, useMemo, type KeyboardEvent, type ReactNode } from "react";
import { useSessionEndedRedirect } from "@/components/plan-overview/use-plan-data";
import { MINUTE_CHOICES } from "@/components/start/start-model";
import { formatLearningDate } from "@/components/today/today-model";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { BannerSlot, OfflineBanner, ServiceAlert } from "@/components/ui/FormBanners";
import { Icon } from "@/components/ui/Icon";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TextLink } from "@/components/ui/TextLink";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import type { Locale } from "@/i18n/messages";
import { settingsMessages } from "@/i18n/settings-messages";
import { getStartMessages } from "@/i18n/start-messages";
import { renderTemplate } from "@/i18n/template";
import type { Profile } from "@/lib/api/types";
import { browserTimeZone, reloadPage } from "@/lib/browser";
import { pendingMinutes, pendingTimeZone } from "@/lib/settings/settings-model";
import { timeZoneOptionLabel, timeZoneOptions } from "@/lib/settings/time-zones";
import { SelectField } from "./SelectField";
import { usePreferences } from "./use-preferences";

// c13: the wait of one pending field, under the control it belongs to. The value in force is named, then the day the change starts.
function PendingLine({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-q8 flex items-start gap-q8 text-small text-info-ink">
      <Icon name="clock" size="sm" className="mt-1" />
      <span>{children}</span>
    </p>
  );
}

// Enter in a select, a checkbox or a radio must not send the form (UI-screens S-22 section 5): only the Save button does. A link keeps its Enter.
function blockImplicitSubmit(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key !== "Enter") return;
  const { target } = event;
  const isChoice = target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio"));
  if (isChoice) event.preventDefault();
}

function minutesLabel(locale: Locale, minutes: number): string {
  return getStartMessages(locale).minutes.label(formatInteger(locale, minutes), minutes);
}

export interface PreferencesFormProps {
  profile: Profile;
  hasPlan: boolean;
  replaceProfile: (profile: Profile) => void;
  online: boolean;
  // A logout is in flight (c19): the form is inert, so nothing in it can be changed or sent.
  inert: boolean;
}

// c8 to c15 and c20 of S-22: the language, the daily time for new plans, the time zone and the in-app reminder, with one Save. The form is a
// `<form novalidate>`: every value comes from a fixed list, so there is nothing for the learner to fix and no field error.
export function PreferencesForm({ profile, hasPlan, replaceProfile, online, inert }: PreferencesFormProps) {
  const { locale, messages } = useLocale();
  const t = settingsMessages(locale).preferences;
  const prefs = usePreferences(profile, replaceProfile);
  const { values, failure } = prefs;
  const headingId = useId();
  const helperId = useId();
  const minutesPendingId = useId();
  const zoneId = useId();
  const zonePendingId = useId();
  const reminderId = useId();

  // G-03: the session ended while saving. S-01 shows its banner once and brings the learner back here.
  useSessionEndedRedirect(failure?.kind === "session_ended" ? "session_ended" : null, "/settings");

  const minutesPending = pendingMinutes(profile);
  const zonePending = pendingTimeZone(profile);

  // The list is long (about 400 names), so it is built once for the zones that must be in it, not on every choice.
  const pendingZone = profile.pendingSettings?.timeZone;
  const browserZone = useMemo(() => browserTimeZone(), []);
  const zones = useMemo(
    () => timeZoneOptions({ profileZone: profile.timeZone, also: pendingZone === undefined ? [] : [pendingZone], browserZone }),
    [profile.timeZone, pendingZone, browserZone],
  );
  const zoneChoices = zones.map((option) => ({ value: option.value, label: timeZoneOptionLabel(locale, option, t.timeZone.fromBrowser) }));

  // Slot B, directly above Save: offline (P-05) speaks before any press and stands in for a failed press, otherwise the answer of the last press.
  const polite = [
    !online ? (
      <OfflineBanner key="offline" />
    ) : failure?.kind === "unavailable" ? (
      <Banner key="unavailable" variant="warning">
        {messages.form.unavailable}
      </Banner>
    ) : null,
    prefs.nothingToSave ? (
      <p key="nothing" className="text-body-compact text-ink-secondary">
        {t.nothingToSave}
      </p>
    ) : null,
  ].filter((node) => node !== null);
  const alert =
    !online || failure === null ? null : failure.kind === "failed" ? (
      <Banner variant="error" role="alert">
        {t.saveFailed}
      </Banner>
    ) : failure.kind === "origin" ? (
      <ServiceAlert kind="origin" onReload={reloadPage} />
    ) : null;

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-section text-ink">
        {t.heading}
      </h2>
      <form
        noValidate
        method="post"
        inert={inert}
        onKeyDown={blockImplicitSubmit}
        onSubmit={(event) => {
          event.preventDefault();
          void prefs.save();
        }}
        className="mt-q12 max-w-form"
      >
        <div className="flex flex-col gap-q24">
          <SegmentedControl
            legend={t.language.legend}
            value={values.language}
            onChange={(value) => prefs.set("language", value)}
            options={[
              { value: "ar" as const, label: t.language.arabic, lang: "ar" },
              { value: "en" as const, label: t.language.english, lang: "en" },
            ]}
          />

          <div>
            <SegmentedControl
              legend={t.minutes.legend}
              value={values.sessionMinutes}
              onChange={(value) => prefs.set("sessionMinutes", value)}
              describedBy={minutesPending === null ? helperId : `${minutesPendingId} ${helperId}`}
              options={MINUTE_CHOICES.map((value) => ({ value, label: minutesLabel(locale, value) }))}
            />
            {minutesPending === null ? null : (
              <PendingLine id={minutesPendingId}>
                {renderTemplate(t.pending, { value: minutesLabel(locale, minutesPending.inForce), date: formatLearningDate(locale, minutesPending.effectiveDate) })}
              </PendingLine>
            )}
            <p id={helperId} className="mt-q8 text-small text-ink-secondary">
              {t.minutes.helper}
            </p>
            {hasPlan ? (
              <div className="mt-q4">
                <TextLink href="/plan/revise">{t.reviseLink}</TextLink>
              </div>
            ) : null}
          </div>

          <div>
            <SelectField
              id={zoneId}
              label={t.timeZone.label}
              value={values.timeZone}
              onChange={(event) => prefs.set("timeZone", event.target.value)}
              aria-describedby={zonePending === null ? undefined : zonePendingId}
              options={zoneChoices}
            />
            {zonePending === null ? null : (
              <PendingLine id={zonePendingId}>
                {renderTemplate(t.pending, {
                  value: <bdi dir="ltr">{zonePending.inForce}</bdi>,
                  date: formatLearningDate(locale, zonePending.effectiveDate),
                })}
              </PendingLine>
            )}
          </div>

          <Checkbox
            id={reminderId}
            label={t.reminder.label}
            description={t.reminder.helper}
            checked={values.inApp}
            onChange={(event) => prefs.set("inApp", event.target.checked)}
          />
        </div>

        <BannerSlot
          polite={polite.length === 0 ? null : <div className="flex flex-col gap-q16">{polite}</div>}
          alert={alert}
          announcement={
            <>
              {prefs.saving ? <p>{t.saving}</p> : null}
              {prefs.languageNote === null ? null : <p>{prefs.languageNote}</p>}
            </>
          }
        />

        <div className="mt-q24">
          <Button type="submit" fullWidth loading={prefs.saving}>
            {prefs.saving ? t.saving : t.save}
          </Button>
        </div>
      </form>
    </section>
  );
}
