"use client";

import { useState } from "react";
import { useLocale } from "@/i18n/LocaleProvider";
import { getMessages, type Locale } from "@/i18n/messages";
import { cx } from "@/lib/cx";

// «العربية | EN» (UA-11, UI-tokens 6.4): native radios, so arrow keys move in the logical direction and focus stays on the switch.
export function LanguageSwitch() {
  const { locale, messages, setLocale } = useLocale();
  const [announcement, setAnnouncement] = useState("");

  const segments: { value: Locale; label: string; name: string }[] = [
    { value: "ar", label: messages.language.arabicLabel, name: messages.language.arabicLabel },
    { value: "en", label: messages.language.englishLabel, name: messages.language.englishName },
  ];

  function choose(next: Locale) {
    if (next === locale) return;
    setLocale(next);
    // Announced in the new language: that is the one the reader just asked for.
    setAnnouncement(getMessages(next).language.changed);
  }

  return (
    <div>
      <fieldset role="radiogroup" className="flex gap-q8">
        <legend className="sr-only">{messages.language.groupLabel}</legend>
        {segments.map(({ value, label, name }) => {
          const checked = locale === value;
          return (
            <label
              key={value}
              lang={value}
              className={cx(
                "relative inline-flex min-h-target min-w-target cursor-pointer items-center justify-center rounded-sm text-body-compact font-semibold transition-[color,background-color,border-color] duration-(--q-duration-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                // The selected segment gets a 2 px border, so the unselected one pads by 1 px to keep both the same width.
                checked
                  ? "border-2 border-edge-selected bg-selection px-q12 text-ink-accent"
                  : "border border-edge bg-surface px-[calc(var(--q-space-12)+1px)] py-px text-ink hover:bg-selection",
              )}
            >
              <input
                type="radio"
                name="ui-language"
                value={value}
                checked={checked}
                aria-label={name}
                onChange={() => choose(value)}
                className="absolute -inset-0.5 m-0 size-[calc(100%+4px)] cursor-pointer opacity-0"
              />
              {label}
            </label>
          );
        })}
      </fieldset>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
