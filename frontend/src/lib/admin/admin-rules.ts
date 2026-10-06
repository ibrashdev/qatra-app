// The field rules of the content manager API (docs/Content-admin.md section 3, "Text limits"). The edit forms judge a value with them before anything is
// sent, and the mock layer judges a request body with the same functions, so a value the form lets through is one the mock accepts. The server stays the
// judge: whatever it answers 422 or 409 is shown from the copy deck, never as the text it sent.

export const TEXT_LIMITS = {
  name: 120, // titles, labels, author and provider
  sourceTitle: 200,
  note: 500, // the withdrawal note
  licenseUrl: 500,
} as const;

export const DISPLAY_ORDER_MIN = 0;
export const DISPLAY_ORDER_MAX = 9999;

export type TextRule = "empty" | "too_long" | "control_character";
export type UrlRule = "too_long" | "control_character" | "https_required";
export type OrderRule = "empty" | "not_integer" | "out_of_range";

// A control character in a title or a note is refused (section 3): the C0 and C1 ranges, which include tab and line breaks.
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

// The length counts characters, not UTF-16 units, so a letter outside the basic plane counts once.
export function characterCount(value: string): number {
  return Array.from(value).length;
}

export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

// The rule a text breaks after trimming, or null. Text that must be present is `required`; the note of a withdrawal and every title is.
export function textRule(value: string, max: number, options: { required?: boolean } = {}): TextRule | null {
  const required = options.required ?? true;
  if (hasControlCharacter(value)) return "control_character";
  const trimmed = value.trim();
  if (trimmed === "") return required ? "empty" : null;
  return characterCount(trimmed) > max ? "too_long" : null;
}

// The license link: empty means "clear it" (null), anything else must start with https:// and fit 500 characters.
export function licenseUrlRule(value: string): UrlRule | null {
  if (hasControlCharacter(value)) return "control_character";
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (characterCount(trimmed) > TEXT_LIMITS.licenseUrl) return "too_long";
  return trimmed.startsWith("https://") && trimmed.length > "https://".length ? null : "https_required";
}

// Digits typed in either Arabic numeral system are read as the same Western digits.
export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)));
}

// The display order as typed: a whole number from 0 to 9999.
export function displayOrderRule(value: string): OrderRule | null {
  const trimmed = normalizeDigits(value.trim());
  if (trimmed === "") return "empty";
  if (!/^\d+$/.test(trimmed)) return "not_integer";
  const number = Number(trimmed);
  return number < DISPLAY_ORDER_MIN || number > DISPLAY_ORDER_MAX ? "out_of_range" : null;
}

export function parseDisplayOrder(value: string): number | null {
  const trimmed = normalizeDigits(value.trim());
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}
