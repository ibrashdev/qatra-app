"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { Icon } from "./Icon";

// The lockup of UI-screens S-01: the droplet glyph at 32 px in the primary colour beside the product name in the deep blue.
// The glyph is decorative; the name is the text.
export function BrandMark() {
  const { messages } = useLocale();
  return (
    <span className="inline-flex items-center gap-q8 text-section text-primary-deep">
      <Icon name="droplet" size="xl" className="text-primary" />
      {messages.appName}
    </span>
  );
}
