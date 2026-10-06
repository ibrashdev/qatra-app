"use client";

import { useEffect, useId, type ReactNode } from "react";
import { PlanHeader } from "@/components/plan-overview/PlanHeader";
import { useSessionEndedRedirect } from "@/components/plan-overview/use-plan-data";
import { BannerSlot } from "@/components/ui/FormBanners";
import { PageTitle } from "@/components/ui/PageTitle";
import { TextLink } from "@/components/ui/TextLink";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { isAlertFailure } from "./admin-failure";
import { AdminFailureBanner } from "./AdminFailureBanner";
import { AdminSkeleton } from "./AdminSkeleton";
import { NotManagerView } from "./NotManagerView";
import type { AdminResource } from "./use-admin-resource";
import { useHeadingFocus } from "./use-heading-focus";

export interface FrameControls<T> {
  // Reads again and puts the focus back on the heading: the button that asked for it is gone by then, so focus would otherwise fall to the page.
  reload: () => void;
  replace: AdminResource<T>["replace"];
}

export interface AdminFrameProps<T> {
  title: string; // the H1 and the document title: a fixed screen name, so it is there while the data loads
  back: { destination: string; href: string };
  next: string; // where sign-in returns to after a 401
  resource: AdminResource<T>;
  children: (data: T, controls: FrameControls<T>) => ReactNode;
}

// What every admin screen shares: the title, the back control, the failure banners of a read (a 403 is the NotManagerView, a 401 goes to sign-in),
// the skeleton, and the content once the read answered. The signed-in shell speaks for the wake-up (P-04), so the frame adds no line of its own.
export function AdminFrame<T>({ title, back, next, resource, children }: AdminFrameProps<T>) {
  const { locale, messages } = useLocale();
  const t = adminMessages(locale);
  const { state } = resource;
  const failure = state.status === "error" ? state.failure : null;
  const bannerId = useId();
  const focusHeading = useHeadingFocus();

  useSessionEndedRedirect(failure?.kind === "session_ended" ? "session_ended" : null, next);

  // A failed read puts the focus on the retry (UI-screens state tables). Offline and the throttle leave it where it is.
  const focusRetry = failure !== null && (failure.kind === "unavailable" || failure.kind === "internal" || (failure.kind === "connectivity" && resource.online && !resource.waking));
  useEffect(() => {
    if (focusRetry) document.getElementById(bannerId)?.querySelector("button")?.focus();
  }, [focusRetry, bannerId]);

  const { reload: reloadResource } = resource;
  const reload = () => {
    reloadResource();
    focusHeading();
  };

  const showBanner = failure !== null && failure.kind !== "forbidden" && failure.kind !== "session_ended" && failure.kind !== "aborted";
  const alert = failure !== null && isAlertFailure(failure);
  const banner = !showBanner ? null : <AdminFailureBanner failure={failure} id={bannerId} onRetry={failure.kind === "not_found" ? undefined : reload} />;

  let body: ReactNode = null;
  if (state.status === "loading" || (failure?.kind === "connectivity" && resource.waking)) {
    body = <AdminSkeleton loadingText={messages.server.busy} />;
  } else if (failure?.kind === "forbidden") {
    body = <NotManagerView />;
  } else if (failure?.kind === "not_found") {
    body = (
      <div className="mt-q16">
        <TextLink href={back.href}>{t.failures.backToList}</TextLink>
      </div>
    );
  } else if (state.status === "ready") {
    body = children(state.data, { reload, replace: resource.replace });
  }

  return (
    <div>
      <PageTitle screenName={title} />
      <PlanHeader title={title} backDestination={back.destination} backHref={back.href} />
      <BannerSlot
        polite={alert ? null : banner}
        alert={alert ? banner : null}
        announcement={resource.reconnected && resource.online ? <p>{messages.form.backOnline}</p> : null}
      />
      {body}
    </div>
  );
}
