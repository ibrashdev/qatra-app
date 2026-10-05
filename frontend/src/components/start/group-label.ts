// The wording of the group rows of a long book (UI-screens S-08 c8, D88): the label of a group row such as the first ten hadiths and the count under it. Shared by the rows, the chips,
// the removal announcement and the goal sentence, so every place names a group the same way.
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import { getStartMessages, type GroupKind } from "@/i18n/start-messages";
import { listKind, type Cascade, type SectionGroup } from "./start-model";

// Hadith books say «الأحاديث», any other kind of section «الأقسام».
export function groupKindOf(cascade: Cascade): GroupKind {
  return listKind(cascade) === "hadith" ? "hadith" : "section";
}

export function groupLabel(locale: Locale, kind: GroupKind, group: SectionGroup): string {
  const list = getStartMessages(locale).list;
  if (group.first === group.last) return list.singleLabel(kind, formatInteger(locale, group.first));
  return list.groupLabel(kind, formatInteger(locale, group.first), formatInteger(locale, group.last));
}

export function groupCountText(locale: Locale, kind: GroupKind, group: SectionGroup): string {
  return getStartMessages(locale).list.groupCount(kind, group.sections.length, formatInteger(locale, group.sections.length));
}
