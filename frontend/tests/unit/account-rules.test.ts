import { describe, expect, it } from "vitest";
import {
  checkConfirmation,
  checkPassword,
  checkUsername,
  passwordViolations,
  pickPasswordRule,
  pickUsernameRule,
  usernameViolations,
} from "@/lib/auth/account-rules";

// The cases below are the ones the backend tests for its own policy (backend/tests/auth/test_auth_policy.py), so the browser and the server
// agree on what a username and a password are. The strings are synthetic.

describe("usernames the server accepts have no violation (API-spec E03)", () => {
  it.each([
    ["three letters", "abc"],
    ["letters, digits and underscore", "sample_user_01"],
    ["mixed case", "A_b_3"],
    ["underscores only", "___"],
    ["digits only", "123"],
    ["the longest", "a".repeat(24)],
    ["Arabic letters", "أحمد"],
    ["Arabic letters with an underscore", "اسم_مستخدم"],
    ["tatweel, which lies inside the approved letter range", "\u0640\u0640\u0640"],
    ["Arabic-Indic digits, which are mapped to ASCII", "user١٢٣"],
    ["fullwidth letters and digit, which NFKC makes ASCII", "ＵＳＥＲ１"],
    ["the lam-alef ligature, which NFKC expands to two letters", "ﻻﻻﻻ"],
    ["an Arabic letter written as base plus combining mark, which NFKC composes", "ا\u0653".repeat(15)],
  ])("%s", (_name, username) => {
    expect(usernameViolations(username)).toEqual([]);
    expect(checkUsername(username)).toBeNull();
  });
});

describe("the length is counted in code points after NFKC", () => {
  it.each([
    ["empty", ""],
    ["one", "a"],
    ["two", "ab"],
    ["twenty-five", "a".repeat(25)],
    ["twenty-five Arabic letters", "ا".repeat(25)],
    ["seven ligatures that expand to twenty-eight letters", "\uFDF2".repeat(7)],
  ])("%s is too short or too long", (_name, username) => {
    expect(usernameViolations(username)).toEqual(["username_length"]);
  });

  it("accepts the Arabic upper bound", () => {
    expect(checkUsername("ا".repeat(24))).toBeNull();
  });
});

describe("a character outside the approved classes is `username_chars`", () => {
  it.each([
    ["a hyphen", "user-name"],
    ["a dot", "user.name"],
    ["an at sign", "user@name"],
    ["a dollar sign", "ab$"],
    ["a Latin letter outside ASCII", "café"],
    ["extended Arabic-Indic digits", "user۱۲۳"],
    ["an Arabic diacritic (fatha)", "أَحمد"],
    ["emoji", "\u{1F600}\u{1F600}\u{1F600}"],
    ["CJK letters", "名前名前"],
    ["a lone surrogate", "\ud800abc"],
  ])("%s", (_name, username) => {
    expect(usernameViolations(username)).toEqual(["username_chars"]);
    expect(checkUsername(username)).toBe("username_chars");
  });
});

describe("a space or an invisible character is `username_invisible_or_space`, never silently removed", () => {
  it.each([
    ["spaces between letters", "a b c"],
    ["a space after two letters", "ab c"],
    ["a tab", "user\tname"],
    ["a newline", "user\nname"],
    ["a zero width space", "ab\u200Bc"],
    ["a zero width joiner", "ab\u200Dc"],
    ["bidi controls", "\u200F\u202Eabc"],
    ["a no-break space, which NFKC makes an ordinary space", "a\u00A0b"],
    ["an ideographic space", "a\u3000b"],
    ["a byte order mark", "abc\uFEFF"],
    ["a hangul filler", "ab\u3164c"],
    ["a braille blank", "ab\u2800c"],
    ["an arabic letter mark", "ab\u061Cc"],
    ["a soft hyphen", "ab\u00ADc"],
    ["a variation selector", "ab\uFE0Fc"],
  ])("%s", (_name, username) => {
    expect(usernameViolations(username)).toEqual(["username_invisible_or_space"]);
    expect(checkUsername(username)).toBe("username_invisible_or_space");
  });

  it("does not trim: a leading or trailing space is an error", () => {
    expect(checkUsername(" abc")).toBe("username_invisible_or_space");
    expect(checkUsername("abc ")).toBe("username_invisible_or_space");
    expect(checkUsername("   ")).toBe("username_invisible_or_space");
  });
});

describe("several rules, and the one a screen shows", () => {
  it("lists every broken rule in the fixed order of the API", () => {
    expect(usernameViolations("a-")).toEqual(["username_length", "username_chars"]);
    expect(usernameViolations("a b-c")).toEqual(["username_chars", "username_invisible_or_space"]);
    expect(usernameViolations("\u200B$")).toEqual(["username_length", "username_chars", "username_invisible_or_space"]);
  });

  it("shows the first failure in the order of the spec: empty, space or invisible, other character, length", () => {
    expect(checkUsername("")).toBe("empty");
    expect(checkUsername("a b-c")).toBe("username_invisible_or_space");
    expect(checkUsername("\u200B$")).toBe("username_invisible_or_space");
    expect(checkUsername("a-")).toBe("username_chars");
    expect(checkUsername("ab")).toBe("username_length");
  });

  it("picks one rule from the names of a server answer by the same order, and ignores names of other fields", () => {
    expect(pickUsernameRule(["username_length", "username_chars"])).toBe("username_chars");
    expect(pickUsernameRule(["username_length", "username_invisible_or_space", "username_chars"])).toBe("username_invisible_or_space");
    expect(pickUsernameRule(["username_length"])).toBe("username_length");
    expect(pickUsernameRule(["password_min_chars", "time_zone_invalid", "forbidden_field"])).toBeNull();
    expect(pickUsernameRule([])).toBeNull();
    expect(pickPasswordRule(["username_length", "password_max_bytes"])).toBe("password_max_bytes");
    expect(pickPasswordRule(["password_min_chars", "password_max_bytes"])).toBe("password_min_chars");
    expect(pickPasswordRule(["language_invalid"])).toBeNull();
  });

  it("never throws on odd input", () => {
    for (const text of ["", "\u0000", "\ud800", "\u200B", "Ａ".repeat(1000), "آ"]) {
      expect(() => checkUsername(text)).not.toThrow();
      expect(() => checkPassword(text)).not.toThrow();
    }
  });
});

describe("passwords (P-08): at least 15 code points, at most 72 UTF-8 bytes, on the raw value", () => {
  it.each([
    ["empty", "", ["password_min_chars"]],
    ["fourteen letters", "a".repeat(14), ["password_min_chars"]],
    ["fifteen letters", "a".repeat(15), []],
    ["fifteen Arabic letters (30 bytes)", "ب".repeat(15), []],
    ["fifteen emoji (60 bytes)", "\u{1F600}".repeat(15), []],
    ["the longest in ASCII", "a".repeat(72), []],
    ["one byte over in ASCII", "a".repeat(73), ["password_max_bytes"]],
    ["the longest in Arabic (72 bytes)", "ب".repeat(36), []],
    ["one letter over in Arabic (74 bytes)", "ب".repeat(37), ["password_max_bytes"]],
    ["the longest in emoji (72 bytes)", "\u{1F600}".repeat(18), []],
    ["one emoji over (76 bytes)", "\u{1F600}".repeat(19), ["password_max_bytes"]],
    ["fifteen spaces: there is no composition rule", " ".repeat(15), []],
  ] as const)("%s", (_name, password, expected) => {
    expect(passwordViolations(password)).toEqual(expected);
  });

  it("counts a string that cannot be written as UTF-8 as over the limit, as the server does", () => {
    expect(passwordViolations("a".repeat(15) + "\ud800")).toEqual(["password_max_bytes"]);
    expect(checkPassword("a".repeat(15) + "\ud800")).toBe("password_max_bytes");
  });

  it("reports empty first, then the one rule that fails, and null for a good password", () => {
    expect(checkPassword("")).toBe("empty");
    expect(checkPassword("a".repeat(14))).toBe("password_min_chars");
    expect(checkPassword("a".repeat(73))).toBe("password_max_bytes");
    expect(checkPassword("synthetic passphrase for docs only")).toBeNull();
  });

  it("never trims or normalizes: spaces count and a precomposed letter is one code point", () => {
    expect(checkPassword(" ".repeat(14))).toBe("password_min_chars");
    expect(checkPassword(` ${"a".repeat(14)} `)).toBeNull();
    // base letter plus combining mark is two code points on the raw value: fifteen pairs are thirty.
    expect(passwordViolations("é".repeat(7))).toEqual(["password_min_chars"]);
    expect(passwordViolations("é".repeat(8))).toEqual([]);
  });
});

describe("the confirmation (P-08)", () => {
  it("is empty, a mismatch, or fine", () => {
    expect(checkConfirmation("a long synthetic phrase", "")).toBe("empty");
    expect(checkConfirmation("a long synthetic phrase", "a long synthetic phras")).toBe("mismatch");
    expect(checkConfirmation("a long synthetic phrase", "A long synthetic phrase")).toBe("mismatch");
    expect(checkConfirmation("a long synthetic phrase", "a long synthetic phrase")).toBeNull();
  });

  it("compares the raw values: a trailing space is a difference", () => {
    expect(checkConfirmation("a long synthetic phrase", "a long synthetic phrase ")).toBe("mismatch");
  });

  it("calls a filled confirmation of an empty password a mismatch", () => {
    expect(checkConfirmation("", "x")).toBe("mismatch");
  });
});
