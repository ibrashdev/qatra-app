// The composed goal sentence of S-08 (UI-design 1.1, UI-screens "Goal box"). It names what was chosen, follows the interface language and
// is rebuilt on each change until the learner edits the box (UA-13). The wording is proposed copy (O-60).
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import { getStartMessages } from "@/i18n/start-messages";
import { checkedPaths, type Cascade, type Minutes, type StartForm } from "./start-model";

const MAX_NAMED_SECTIONS = 3;

// A learning date is written from its parts and never moved by a time zone (P-16).
export function formatLearningDate(locale: Locale, iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  const calendar = locale === "ar" ? "ar-u-ca-gregory-nu-arab" : "en-u-nu-latn";
  try {
    return new Intl.DateTimeFormat(calendar, { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(new Date(Date.UTC(year, month - 1, day)));
  } catch {
    return iso;
  }
}

export interface GoalInputs {
  locale: Locale;
  form: StartForm;
  cascade: Cascade;
  selected: readonly number[]; // the checked ordinals that exist in the edition, ascending
  minutes: Minutes;
}

// Empty until an edition and at least one section are chosen: the box then shows its placeholder.
export function composeGoal({ locale, form, cascade, selected, minutes }: GoalInputs): string {
  const { edition, category, sections } = cascade;
  if (edition === null || category === null || selected.length === 0) return "";
  const t = getStartMessages(locale).sentence;
  const messages = getStartMessages(locale);

  const chosen = sections.filter((section) => selected.includes(section.ordinal));
  const titleOf = (section: (typeof sections)[number]) => (locale === "ar" ? section.titleAr : section.titleEn);
  let what: string;
  if (chosen.length >= sections.length) what = t.all;
  else if (chosen.length <= MAX_NAMED_SECTIONS) what = t.names(chosen.map(titleOf));
  else what = t.someOf(formatInteger(locale, chosen.length), formatInteger(locale, sections.length), chosen[0]?.kind ?? "surah");

  const paths = cascade.pathChoices.length > 0 ? checkedPaths(form, cascade) : [];
  const learn = paths.length > 0 ? t.learn(t.names(paths.map((path) => t.pathNames[path]))) : "";
  const deadline = form.date === "" ? t.noDate : t.byDate(formatLearningDate(locale, form.date));

  return t.build({
    what,
    book: locale === "ar" ? edition.titleAr : edition.titleEn,
    edition: edition.editionLabel,
    category: locale === "ar" ? category.labelAr : category.labelEn,
    learn,
    minutes: messages.minutes.label(formatInteger(locale, minutes), minutes),
    deadline,
  });
}
