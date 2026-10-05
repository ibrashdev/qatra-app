// The client side of the account rules (API-spec E03, UI-screens P-03, P-08 and S-02 "Validation"). The server judges again and has the last word.
// The username classes follow the backend policy: NFKC first, then Arabic-Indic digits to ASCII, then each character is judged on that form.

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 24;
export const PASSWORD_MIN_CHARS = 15;
export const PASSWORD_MAX_BYTES = 72;

// The rule names of the API. A violation is a rule that is broken; a screen shows one of them per field.
export type UsernameViolation = "username_invisible_or_space" | "username_chars" | "username_length";
export type PasswordViolation = "password_min_chars" | "password_max_bytes";

// What a screen can say about a field. `empty` and `mismatch` exist only on the client.
export type UsernameRule = "empty" | UsernameViolation;
export type PasswordRule = "empty" | PasswordViolation;
export type ConfirmationRule = "empty" | "mismatch";

// The order in which the spec reports the first failure of a username, which is also the order that picks one rule from a server answer.
const USERNAME_ORDER: readonly UsernameViolation[] = ["username_invisible_or_space", "username_chars", "username_length"];
const PASSWORD_ORDER: readonly PasswordViolation[] = ["password_min_chars", "password_max_bytes"];

// Characters that are blank although they are not all whitespace or format characters.
const INVISIBLE_CODE_POINTS: ReadonlySet<number> = new Set([0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x2800, 0x3164, 0xffa0]);
const INVISIBLE_RANGES: readonly (readonly [low: number, high: number])[] = [
  [0x180b, 0x180f], // Mongolian free variation selectors and vowel separator
  [0xfe00, 0xfe0f], // variation selectors
  [0xe0000, 0xe007f], // tag characters
  [0xe0100, 0xe01ef], // variation selectors supplement
];
const INVISIBLE_CATEGORY = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]$/u;

type CharClass = "ok" | "invisible" | "invalid";

function classify(char: string): CharClass {
  const code = char.codePointAt(0) ?? 0;
  const digit = code >= 0x30 && code <= 0x39;
  const latin = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
  const arabicLetter = code >= 0x0621 && code <= 0x064a; // the approved range, tatweel included
  if (char === "_" || digit || latin || arabicLetter) return "ok";
  if (/\s/u.test(char) || INVISIBLE_CATEGORY.test(char) || INVISIBLE_CODE_POINTS.has(code) || INVISIBLE_RANGES.some(([low, high]) => code >= low && code <= high)) {
    return "invisible";
  }
  return "invalid";
}

// What the server stores as the display name: NFKC, with Arabic-Indic digits written as ASCII.
function displayForm(raw: string): string {
  return raw.normalize("NFKC").replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

// A string that cannot be written as UTF-8 counts as over the limit, as it does on the server.
function utf8Length(text: string): number {
  return LONE_SURROGATE.test(text) ? PASSWORD_MAX_BYTES + 1 : new TextEncoder().encode(text).length;
}

// Every rule a username breaks, in the order of the API (the mock layer answers with this list).
// The length is counted in code points after NFKC; a space or an invisible character is reported in place of "other character".
export function usernameViolations(raw: string): UsernameViolation[] {
  const characters = Array.from(displayForm(raw));
  const classes = new Set(characters.map(classify));
  const rules: UsernameViolation[] = [];
  if (characters.length < USERNAME_MIN_LENGTH || characters.length > USERNAME_MAX_LENGTH) rules.push("username_length");
  if (classes.has("invalid")) rules.push("username_chars");
  if (classes.has("invisible")) rules.push("username_invisible_or_space");
  return rules;
}

// The length is in Unicode code points and the cap in UTF-8 bytes, both on the raw value: never trimmed or normalized.
export function passwordViolations(raw: string): PasswordViolation[] {
  const rules: PasswordViolation[] = [];
  if (Array.from(raw).length < PASSWORD_MIN_CHARS) rules.push("password_min_chars");
  if (utf8Length(raw) > PASSWORD_MAX_BYTES) rules.push("password_max_bytes");
  return rules;
}

// The rule names of a server answer, reduced to the one a field shows. Names of other fields or unknown names give null.
function firstOf<T extends string>(order: readonly T[], names: readonly string[]): T | null {
  return order.find((rule) => names.includes(rule)) ?? null;
}

export const pickUsernameRule = (names: readonly string[]): UsernameViolation | null => firstOf(USERNAME_ORDER, names);
export const pickPasswordRule = (names: readonly string[]): PasswordViolation | null => firstOf(PASSWORD_ORDER, names);

// The first failure of the spec's order (empty, space or invisible, other character, length), or null. Never trims: a space is an error.
export function checkUsername(raw: string): UsernameRule | null {
  return raw === "" ? "empty" : pickUsernameRule(usernameViolations(raw));
}

export function checkPassword(raw: string): PasswordRule | null {
  return raw === "" ? "empty" : pickPasswordRule(passwordViolations(raw));
}

export function checkConfirmation(password: string, confirmation: string): ConfirmationRule | null {
  if (confirmation === "") return "empty";
  return confirmation === password ? null : "mismatch";
}
