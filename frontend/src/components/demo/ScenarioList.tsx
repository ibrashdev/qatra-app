"use client";

import { useId } from "react";
import { Icon } from "@/components/ui/Icon";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import type { DemoScenario } from "@/lib/api/demo-endpoints";
import { cx } from "@/lib/cx";
import { scenarioTitle } from "./demo-model";

// The radio rows of ChoiceList (UI-tokens 6.5), kept as rows at any count: the scenario list has up to ten of them, and a native select would hide
// the second line that tells them apart. Native radios in one labelled group: the arrow keys come from the platform and follow the reading direction.
// While a plan is being built the group ignores changes, but stays in the tab order (nothing is disabled, so focus is never lost).
export function ScenarioList({
  legend,
  locale,
  scenarios,
  selected,
  onSelect,
  busy,
  sectionCount,
}: {
  legend: string;
  locale: Locale;
  scenarios: readonly DemoScenario[];
  selected: string | null;
  onSelect: (scenarioId: string) => void;
  busy: boolean;
  sectionCount: (formatted: string) => string;
}) {
  const name = useId();
  return (
    <fieldset role="radiogroup" aria-busy={busy || undefined} className="min-w-0">
      <legend className="mb-q8 text-body-compact font-semibold text-ink">{legend}</legend>
      <div className="flex flex-col gap-q8">
        {scenarios.map((scenario) => {
          const checked = scenario.scenarioId === selected;
          const count = scenario.targetScope.sectionOrdinals.length;
          return (
            <label
              key={scenario.scenarioId}
              className={cx(
                "relative flex min-h-row cursor-pointer items-center gap-q12 rounded-sm px-q16 transition-[color,background-color,border-color] duration-(--q-duration-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                checked ? "border-2 border-edge-selected bg-selection text-ink-accent" : "border border-edge bg-surface px-[calc(var(--q-space-16)+1px)] text-ink hover:bg-selection",
              )}
            >
              <input
                type="radio"
                name={name}
                value={scenario.scenarioId}
                checked={checked}
                onChange={() => {
                  if (!busy) onSelect(scenario.scenarioId);
                }}
                className="absolute -inset-0.5 m-0 size-[calc(100%+4px)] cursor-pointer opacity-0"
              />
              <span className="min-w-0 flex-1 py-q8">
                <span className="block text-body font-semibold">
                  <bdi>{scenarioTitle(locale, scenario)}</bdi>
                </span>
                {count > 0 ? <span className="block text-small text-ink-secondary">{sectionCount(formatInteger(locale, count))}</span> : null}
              </span>
              {checked ? <Icon name="check" size="md" active /> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
