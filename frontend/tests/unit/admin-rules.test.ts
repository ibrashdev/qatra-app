import { describe, expect, it } from "vitest";
import {
  characterCount,
  displayOrderRule,
  hasControlCharacter,
  licenseUrlRule,
  normalizeDigits,
  parseDisplayOrder,
  TEXT_LIMITS,
  textRule,
} from "@/lib/admin/admin-rules";

describe("admin field rules (docs/Content-admin.md section 3)", () => {
  it("counts characters, not UTF-16 units", () => {
    expect(characterCount("abc")).toBe(3);
    expect(characterCount("𝒜𝒷")).toBe(2);
    expect(characterCount("كتاب")).toBe(4);
  });

  it("judges a text after trimming: 1 to the limit, control characters refused", () => {
    expect(textRule("", TEXT_LIMITS.name)).toBe("empty");
    expect(textRule("   ", TEXT_LIMITS.name)).toBe("empty");
    expect(textRule("x", TEXT_LIMITS.name)).toBeNull();
    expect(textRule("x".repeat(120), TEXT_LIMITS.name)).toBeNull();
    expect(textRule("x".repeat(121), TEXT_LIMITS.name)).toBe("too_long");
    expect(textRule(`  ${"x".repeat(120)}  `, TEXT_LIMITS.name)).toBeNull();
    expect(textRule("x".repeat(200), TEXT_LIMITS.sourceTitle)).toBeNull();
    expect(textRule("x".repeat(501), TEXT_LIMITS.note)).toBe("too_long");
    expect(textRule("a\u0000b", TEXT_LIMITS.name)).toBe("control_character");
    expect(textRule("a\nb", TEXT_LIMITS.note)).toBe("control_character");
    expect(textRule("a\u009Fb", TEXT_LIMITS.name)).toBe("control_character");
    expect(hasControlCharacter("plain text")).toBe(false);
  });

  it("lets an optional text be empty, which means clear", () => {
    expect(textRule("", TEXT_LIMITS.name, { required: false })).toBeNull();
    expect(textRule("   ", TEXT_LIMITS.name, { required: false })).toBeNull();
    expect(textRule("x".repeat(121), TEXT_LIMITS.name, { required: false })).toBe("too_long");
  });

  it("accepts a license link that starts with https:// and fits 500 characters, or an empty one", () => {
    expect(licenseUrlRule("")).toBeNull();
    expect(licenseUrlRule("https://example.invalid/license")).toBeNull();
    expect(licenseUrlRule("http://example.invalid/license")).toBe("https_required");
    expect(licenseUrlRule("ftp://example.invalid")).toBe("https_required");
    expect(licenseUrlRule("https://")).toBe("https_required");
    expect(licenseUrlRule(`https://${"a".repeat(492)}`)).toBeNull();
    expect(licenseUrlRule(`https://${"a".repeat(493)}`)).toBe("too_long");
    expect(licenseUrlRule("https://a\u0007b")).toBe("control_character");
  });

  it("reads the display order as a whole number from 0 to 9999, in either numeral system", () => {
    expect(displayOrderRule("")).toBe("empty");
    expect(displayOrderRule("abc")).toBe("not_integer");
    expect(displayOrderRule("1.5")).toBe("not_integer");
    expect(displayOrderRule("-1")).toBe("not_integer");
    expect(displayOrderRule("0")).toBeNull();
    expect(displayOrderRule("9999")).toBeNull();
    expect(displayOrderRule("10000")).toBe("out_of_range");
    expect(displayOrderRule("٥")).toBeNull();
    expect(displayOrderRule("۱۲")).toBeNull();
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
    expect(parseDisplayOrder("٣٢")).toBe(32);
    expect(parseDisplayOrder("x")).toBeNull();
  });
});
