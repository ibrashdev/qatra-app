"use client";

import { LinkButton } from "@/components/progress/LinkButton";
import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { sourcesMessages } from "@/i18n/sources-messages";
import { editionTitle, type PlanEdition } from "@/lib/catalog/catalog-model";

// S-25 c8 (O-49): the card of the learner's plan book when E14 no longer lists it. E14 has no row for it, so the title comes from E18. The chip is
// icon plus label on the warning tokens (UI-tokens 6.11), and «ابدأ خطتك» is the only way out of S-25 to S-08.
export function UnavailableCard({ plan }: { plan: PlanEdition }) {
  const { locale } = useLocale();
  const t = sourcesMessages(locale).unavailable;
  return (
    <li className="rounded-md border border-divider bg-surface p-q16">
      <h2 className="text-body font-semibold text-ink">
        <bdi dir="auto">{editionTitle(locale, plan)}</bdi>
      </h2>
      <p className="mt-q8">
        <span className="inline-flex h-badge items-center gap-q4 rounded-sm bg-warning-tint px-q12 text-caption text-warning-ink">
          <Icon name="warning" size="sm" />
          {t.chip}
        </span>
      </p>
      <p className="mt-q8 text-body-compact text-ink">{t.text}</p>
      <div className="mt-q12">
        <LinkButton href="/start" variant="secondary">
          {t.start}
        </LinkButton>
      </div>
    </li>
  );
}
