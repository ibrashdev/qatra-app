import type { ReactNode } from "react";
import type { AdminMessages } from "@/i18n/admin-messages";
import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";
import {
  DISPLAY_ORDER_MAX,
  DISPLAY_ORDER_MIN,
  TEXT_LIMITS,
  displayOrderRule,
  licenseUrlRule,
  parseDisplayOrder,
  textRule,
  type OrderRule,
  type TextRule,
  type UrlRule,
} from "@/lib/admin/admin-rules";
import {
  RIGHTS_STATUSES,
  WITHDRAW_REASONS,
  type AdminBook,
  type AdminCategory,
  type AdminSource,
  type EditionBookRef,
  type EditionDetail,
  type EditionStatus,
  type RightsStatus,
  type SectionDetail,
  type UpdateBookBody,
  type UpdateCategoryBody,
  type UpdateEditionBody,
  type UpdateSectionBody,
  type UpdateSourceBody,
  type WithdrawReason,
} from "@/lib/api/admin-types";

// Pure helpers of the content manager screens: how a row is titled, how a form's values become a PATCH body, which rule a value breaks, and which row
// may be deleted. Nothing here reads the network or the page.

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Titles. The Arabic interface shows the Arabic title; the English one shows the English title and falls back to the Arabic one.

export function bookTitle(locale: Locale, book: EditionBookRef | AdminBook): string {
  return locale === "en" && book.titleEn !== null && book.titleEn !== "" ? book.titleEn : book.titleAr;
}

export function categoryLabel(locale: Locale, category: AdminCategory): string {
  return locale === "en" && category.labelEn !== null && category.labelEn !== "" ? category.labelEn : category.labelAr;
}

export function sectionTitle(locale: Locale, section: { titleAr: string; titleEn: string }): string {
  return locale === "en" && section.titleEn !== "" ? section.titleEn : section.titleAr;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Labels from the copy deck, with the raw value as the fallback for a value the deck does not know.

export const statusLabel = (t: AdminMessages, status: EditionStatus): string => t.statuses[status];
export const rightsLabel = (t: AdminMessages, status: RightsStatus): string => t.rights[status];
export const languageLabel = (t: AdminMessages, code: string): string => t.languages[code] ?? code;
export const formatLabel = (t: AdminMessages, format: string): string => t.contentFormats[format] ?? format;

// The reason of a withdrawal is normally one of the three codes of the CLI; a code this build does not know is shown as it is.
export const withdrawReasonLabel = (t: AdminMessages, code: string): string => ((WITHDRAW_REASONS as readonly string[]).includes(code) ? t.withdrawReasons[code as WithdrawReason] : code);

export type ChipTone = "success" | "info" | "warning" | "error" | "neutral";

// A published edition is the live one, a checked one waits for the owner, a draft is unfinished, and a withdrawn one is the only error.
export function statusTone(status: EditionStatus): ChipTone {
  switch (status) {
    case "published":
      return "success";
    case "validated":
      return "info";
    case "draft":
      return "warning";
    case "revoked":
      return "error";
    case "superseded":
      return "neutral";
  }
}

// The rows of a record whose fields may be null (the approval and the withdrawal of an edition): only a value that is there makes a row.
export interface PresentedRow {
  label: string;
  value: ReactNode;
}

export function presentRows(entries: ReadonlyArray<readonly [label: string, value: string | null, render: (value: string) => ReactNode]>): PresentedRow[] {
  return entries.flatMap(([label, value, render]) => (value === null || value === "" ? [] : [{ label, value: render(value) }]));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Dates and numbers. A server timestamp is shown in UTC with the zone named, so two managers read the same time.

const DATE_LOCALES: Record<Locale, string> = { ar: "ar-u-ca-gregory-nu-arab", en: "en-u-ca-gregory-nu-latn" };

export function formatTimestamp(locale: Locale, value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat(DATE_LOCALES[locale], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(time));
}

export const formatCount = (locale: Locale, value: number | null, t: AdminMessages): string => (value === null ? t.notAvailable : formatInteger(locale, value));

// The unit text is shown in the face of its book: an `ayah` unit in the Quran face, anything else (a narration, a takhrij or a grade) in the hadith face.
export type TextFace = "quran" | "hadith";

export const unitFace = (kind: string): TextFace => (kind === "ayah" ? "quran" : "hadith");

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What may be deleted: the row must not be in use (docs/Content-admin.md section 3). The server stays the judge and answers 409 `in_use`.

export const bookDeletable = (book: AdminBook): boolean => book.editionCount === 0;
export const categoryDeletable = (category: AdminCategory): boolean => category.bookCount === 0;
export const sourceDeletable = (source: AdminSource): boolean => source.editionCount === 0;

// The edition's own buttons, from the actions the server computed. Whether any button beyond the rename is on offer decides the "no actions" line.
export function hasEditionActions(actions: EditionDetail["actions"]): boolean {
  return actions.archive || actions.unarchive || actions.withdraw || actions.delete;
}

export const sectionRenameAllowed = (section: Pick<SectionDetail, "edition">): boolean => section.edition.status !== "revoked";

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Forms. A form keeps its values as strings, as typed. `*Errors` returns the rule each broken field breaks, `*Patch` the body of the changed fields.
// A field the manager left as it was is not sent; a PATCH with no field is not sent at all.

export type FieldRule = TextRule | UrlRule | OrderRule | "choose";
export type FieldErrors<K extends string> = Partial<Record<K, FieldRule>>;

const sameText = (typed: string, current: string): boolean => typed.trim() === current;
const sameOptional = (typed: string, current: string | null): boolean => typed.trim() === (current ?? "");
// A body that carries the concurrency token and nothing else changes nothing, so it is not sent.
const carriesChange = (patch: object): boolean => Object.keys(patch).length > 1;
const optional = (typed: string): string | null => (typed.trim() === "" ? null : typed.trim());

// A message for the rule a field broke, in the interface language. Limits are written in the digits of the language.
export function fieldRuleText(locale: Locale, t: AdminMessages, rule: FieldRule, max: number = TEXT_LIMITS.name): string {
  switch (rule) {
    case "empty":
    case "choose":
      return t.rules.required;
    case "too_long":
      return t.rules.tooLong(formatInteger(locale, max));
    case "control_character":
      return t.rules.control;
    case "https_required":
      return t.rules.https;
    case "not_integer":
      return t.rules.notInteger;
    case "out_of_range":
      return t.rules.outOfRange(formatInteger(locale, DISPLAY_ORDER_MIN), formatInteger(locale, DISPLAY_ORDER_MAX));
  }
}

function collect<K extends string>(entries: ReadonlyArray<readonly [K, FieldRule | null]>): FieldErrors<K> {
  const errors: FieldErrors<K> = {};
  for (const [field, rule] of entries) if (rule !== null) errors[field] = rule;
  return errors;
}

export const hasErrors = (errors: object): boolean => Object.keys(errors).length > 0;

// Edition label.
export type EditionLabelValues = {
  editionLabel: string;
};
export const editionLabelErrors = (values: EditionLabelValues): FieldErrors<"editionLabel"> => collect([["editionLabel", textRule(values.editionLabel, TEXT_LIMITS.name)]]);
export function editionLabelPatch(edition: Pick<EditionDetail, "editionLabel" | "updatedAt">, values: EditionLabelValues): UpdateEditionBody | null {
  return sameText(values.editionLabel, edition.editionLabel) ? null : { expectedUpdatedAt: edition.updatedAt, editionLabel: values.editionLabel.trim() };
}

// Section titles. Both are NOT NULL in the database, so both must be present: the English title cannot be cleared.
export type SectionValues = {
  titleAr: string;
  titleEn: string;
};
export const sectionErrors = (values: SectionValues): FieldErrors<keyof SectionValues> =>
  collect<keyof SectionValues>([
    ["titleAr", textRule(values.titleAr, TEXT_LIMITS.name)],
    ["titleEn", textRule(values.titleEn, TEXT_LIMITS.name)],
  ]);
export function sectionPatch(section: { titleAr: string; titleEn: string }, values: SectionValues): UpdateSectionBody | null {
  const patch: UpdateSectionBody = {};
  if (!sameText(values.titleAr, section.titleAr)) patch.titleAr = values.titleAr.trim();
  if (!sameText(values.titleEn, section.titleEn)) patch.titleEn = values.titleEn.trim();
  return Object.keys(patch).length === 0 ? null : patch;
}

// Book.
export type BookValues = {
  titleAr: string;
  titleEn: string;
  author: string;
  categoryId: string;
};
export const bookValues = (book: AdminBook): BookValues => ({ titleAr: book.titleAr, titleEn: book.titleEn ?? "", author: book.author, categoryId: book.category.id });
export const bookErrors = (values: BookValues): FieldErrors<keyof BookValues> =>
  collect<keyof BookValues>([
    ["titleAr", textRule(values.titleAr, TEXT_LIMITS.name)],
    ["titleEn", textRule(values.titleEn, TEXT_LIMITS.name, { required: false })],
    ["author", textRule(values.author, TEXT_LIMITS.name)],
    ["categoryId", values.categoryId === "" ? "choose" : null],
  ]);
export function bookPatch(book: AdminBook, values: BookValues): UpdateBookBody | null {
  const patch: UpdateBookBody = { expectedUpdatedAt: book.updatedAt };
  if (!sameText(values.titleAr, book.titleAr)) patch.titleAr = values.titleAr.trim();
  if (!sameOptional(values.titleEn, book.titleEn)) patch.titleEn = optional(values.titleEn);
  if (!sameText(values.author, book.author)) patch.author = values.author.trim();
  if (values.categoryId !== book.category.id) patch.categoryId = values.categoryId;
  return carriesChange(patch) ? patch : null;
}

// Category. The display order is typed as text and sent as a number.
export type CategoryValues = {
  labelAr: string;
  labelEn: string;
  displayOrder: string;
};
export const categoryValues = (category: AdminCategory): CategoryValues => ({ labelAr: category.labelAr, labelEn: category.labelEn ?? "", displayOrder: String(category.displayOrder) });
export const categoryErrors = (values: CategoryValues): FieldErrors<keyof CategoryValues> =>
  collect<keyof CategoryValues>([
    ["labelAr", textRule(values.labelAr, TEXT_LIMITS.name)],
    ["labelEn", textRule(values.labelEn, TEXT_LIMITS.name, { required: false })],
    ["displayOrder", displayOrderRule(values.displayOrder)],
  ]);
export function categoryPatch(category: AdminCategory, values: CategoryValues): UpdateCategoryBody | null {
  const patch: UpdateCategoryBody = { expectedUpdatedAt: category.updatedAt };
  if (!sameText(values.labelAr, category.labelAr)) patch.labelAr = values.labelAr.trim();
  if (!sameOptional(values.labelEn, category.labelEn)) patch.labelEn = optional(values.labelEn);
  const order = parseDisplayOrder(values.displayOrder);
  if (order !== null && order !== category.displayOrder) patch.displayOrder = order;
  return carriesChange(patch) ? patch : null;
}

// Source. A cleared license link is sent as null.
export type SourceValues = {
  title: string;
  provider: string;
  licenseUrl: string;
  rightsStatus: string; // one of RIGHTS_STATUSES, as chosen in the list
};
export const sourceValues = (source: AdminSource): SourceValues => ({ title: source.title, provider: source.provider, licenseUrl: source.licenseUrl ?? "", rightsStatus: source.rightsStatus });
export const sourceErrors = (values: SourceValues): FieldErrors<keyof SourceValues> =>
  collect<keyof SourceValues>([
    ["title", textRule(values.title, TEXT_LIMITS.sourceTitle)],
    ["provider", textRule(values.provider, TEXT_LIMITS.name)],
    ["licenseUrl", licenseUrlRule(values.licenseUrl)],
    ["rightsStatus", (RIGHTS_STATUSES as readonly string[]).includes(values.rightsStatus) ? null : "choose"],
  ]);
export function sourcePatch(source: AdminSource, values: SourceValues): UpdateSourceBody | null {
  const patch: UpdateSourceBody = { expectedUpdatedAt: source.updatedAt };
  if (!sameText(values.title, source.title)) patch.title = values.title.trim();
  if (!sameText(values.provider, source.provider)) patch.provider = values.provider.trim();
  if (!sameOptional(values.licenseUrl, source.licenseUrl)) patch.licenseUrl = optional(values.licenseUrl);
  if (values.rightsStatus !== source.rightsStatus) patch.rightsStatus = values.rightsStatus as RightsStatus;
  return carriesChange(patch) ? patch : null;
}

// The withdrawal form: the reason must be chosen and the note present, at most 500 characters.
export interface WithdrawValues {
  reason: string | null;
  note: string;
}
export const withdrawErrors = (values: WithdrawValues): FieldErrors<keyof WithdrawValues> =>
  collect<keyof WithdrawValues>([
    ["reason", values.reason === null ? "choose" : null],
    ["note", textRule(values.note, TEXT_LIMITS.note)],
  ]);
