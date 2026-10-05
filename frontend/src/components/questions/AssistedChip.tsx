"use client";

import { Icon } from "@/components/ui/Icon";
import { useLocale } from "@/i18n/LocaleProvider";
import { questionMessages } from "@/i18n/question-messages";

// The marker «بمساعدة» (UI-tokens 6.11 and 6.16): an info chip, icon plus text, never colour alone. It stays on the question after a hint
// and in the feedback, because an assisted answer is practice and not independent recall evidence (D64).
export function AssistedChip() {
  const { locale } = useLocale();
  return (
    <span className="inline-flex min-h-badge items-center gap-q8 rounded-sm bg-info-tint px-q12 text-caption text-info-ink">
      <Icon name="info" size="sm" />
      {questionMessages(locale).hint.assisted}
    </span>
  );
}
