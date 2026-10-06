"use client";

import { useEffect, useId } from "react";
import { ContentAdminRow } from "@/components/admin/ContentAdminRow";
import { useSessionEndedRedirect } from "@/components/plan-overview/use-plan-data";
import { FailureBanner } from "@/components/today/FailureBanner";
import { isAlertFailure } from "@/components/today/today-failure";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { BannerSlot } from "@/components/ui/FormBanners";
import { PageTitle } from "@/components/ui/PageTitle";
import { ToastProvider } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { settingsMessages } from "@/i18n/settings-messages";
import { todayMessages } from "@/i18n/today-messages";
import { ArrivalBanner } from "./ArrivalBanner";
import { PreferencesForm } from "./PreferencesForm";
import { SettingsSkeleton } from "./SettingsSkeleton";
import { AccountSection, PrivacySection } from "./SettingsSections";
import { useLogout } from "./use-logout";
import { useSettingsData } from "./use-settings-data";

// S-22 Settings (UI-screens Batch 4, package F11): the account rows, the preferences form, the privacy and sources rows with the transparency line,
// and logout. E11 and E18 load in parallel; E12 runs once per press with only the changed fields; E10 runs once per press.
// The toast needs a provider that the app shell does not have, so the screen carries its own.
export function SettingsScreen() {
  return (
    <ToastProvider>
      <SettingsContent />
    </ToastProvider>
  );
}

function SettingsContent() {
  const { locale, messages } = useLocale();
  const t = settingsMessages(locale);
  const today = todayMessages(locale);
  const data = useSettingsData();
  const logout = useLogout();
  const bannerId = useId();
  const { state } = data;

  const failure = state.status === "error" ? state.failure : null;
  const profile = state.status === "ready" ? state.profile : null;

  // G-03: the session ended. S-01 shows its banner once and brings the learner back here.
  useSessionEndedRedirect(failure?.kind === "session_ended" ? "session_ended" : null, "/settings");

  // E11 failed: focus goes to the banner action, which is the retry (UI-screens S-22 section 4).
  useEffect(() => {
    if (failure !== null) document.getElementById(bannerId)?.querySelector("button")?.focus();
  }, [failure, bannerId]);

  const failureNode =
    failure === null ? null : <FailureBanner failure={failure} t={today} online={data.online} waking={data.waking} id={bannerId} onRetry={data.reload} onRefresh={data.reload} />;
  const alertFailure = failure !== null && isAlertFailure(failure);

  let body = null;
  if (state.status === "loading") {
    body = <SettingsSkeleton loadingText={messages.server.busy} />;
  } else if (failure?.kind !== "session_ended") {
    // With E11 failed the form is hidden, and the rows and logout stay.
    body = (
      <div className="mt-q24 flex flex-col gap-q24">
        <AccountSection profile={profile} />
        {state.status === "ready" ? (
          <PreferencesForm profile={state.profile} hasPlan={state.hasPlan} replaceProfile={data.replaceProfile} online={data.online} inert={logout.loggingOut} />
        ) : null}
        <PrivacySection />
        {/* AD-00: the row to the content manager screens, in the page only for a content manager (D91). */}
        <ContentAdminRow />
        <div className="max-w-form">
          <BannerSlot
            alert={
              logout.failed ? (
                <Banner variant="error" role="alert">
                  {t.logout.failed}
                </Banner>
              ) : null
            }
            announcement={logout.loggingOut ? <p>{t.logout.loggingOut}</p> : null}
          />
          <div className={logout.failed ? "mt-q16" : undefined}>
            <Button variant="secondary" fullWidth loading={logout.loggingOut} onClick={() => void logout.press()}>
              {logout.loggingOut ? t.logout.loggingOut : t.logout.button}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageTitle screenName={t.screenName} />
      <h1 data-page-heading tabIndex={-1} className="text-title text-ink">
        {t.screenName}
      </h1>

      <div className="mt-q24 flex flex-col gap-q16 empty:hidden">
        <ArrivalBanner />
      </div>
      <BannerSlot
        polite={alertFailure ? null : failureNode}
        alert={alertFailure ? failureNode : null}
        announcement={data.reconnected && data.online ? <p>{messages.form.backOnline}</p> : null}
      />

      {body}
    </div>
  );
}
