import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  LOCALE_BOOT_SCRIPT,
  LOCALE_STORAGE_KEY,
  applyLocaleToDocument,
  detectBrowserLocale,
  readStoredLocale,
  writeStoredLocale,
} from "@/i18n/locale";
import { directionForLocale, getMessages, isLocale } from "@/i18n/messages";

describe("direction and language (F0-3)", () => {
  it("maps ar to rtl and en to ltr", () => {
    expect(directionForLocale("ar")).toBe("rtl");
    expect(directionForLocale("en")).toBe("ltr");
  });

  it("applies lang and dir to the root element", () => {
    const root = document.createElement("html");
    applyLocaleToDocument("en", root);
    expect([root.lang, root.dir]).toEqual(["en", "ltr"]);
    applyLocaleToDocument("ar", root);
    expect([root.lang, root.dir]).toEqual(["ar", "rtl"]);
  });

  it("accepts only the two interface languages", () => {
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});

describe("browser language (UA-11)", () => {
  it.each([
    [["ar-AE"], "ar"],
    [["ar"], "ar"],
    [["en-US"], "en"],
    [["EN-gb"], "en"],
    [["fr-FR", "en-US"], "en"],
    [["fr-FR", "ar-EG", "en-US"], "ar"],
    [["fr-FR"], "ar"],
    [["zh-Hans-CN"], "ar"],
    [[], "ar"],
  ] as const)("%j gives %s", (languages, expected) => {
    expect(detectBrowserLocale(languages)).toBe(expected);
  });
});

describe("stored preference (UA-17): storage may be missing or throw", () => {
  it("reads a valid value and ignores anything else", () => {
    expect(readStoredLocale({ getItem: () => "en" })).toBe("en");
    expect(readStoredLocale({ getItem: () => "ar" })).toBe("ar");
    expect(readStoredLocale({ getItem: () => "fr" })).toBeNull();
    expect(readStoredLocale({ getItem: () => null })).toBeNull();
  });

  it("returns null when storage is unavailable or its accessor throws", () => {
    expect(readStoredLocale(null)).toBeNull();
    expect(
      readStoredLocale({
        getItem: () => {
          throw new DOMException("blocked", "SecurityError");
        },
      }),
    ).toBeNull();
  });

  it("writes under the documented key and swallows a failing write", () => {
    const setItem = vi.fn();
    writeStoredLocale("en", { setItem });
    expect(setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, "en");
    expect(() =>
      writeStoredLocale("ar", {
        setItem: () => {
          throw new DOMException("quota", "QuotaExceededError");
        },
      }),
    ).not.toThrow();
    expect(() => writeStoredLocale("ar", null)).not.toThrow();
  });
});

describe("boot script: same answer as the client code, and it never throws", () => {
  interface BootCase {
    stored?: string | null;
    languages?: string[];
    language?: string;
    storageThrows?: boolean;
  }

  function boot(options: BootCase) {
    const documentElement = { lang: "", dir: "" };
    const localStorage = {
      getItem: () => {
        if (options.storageThrows) throw new Error("blocked");
        return options.stored ?? null;
      },
    };
    const navigator = { languages: options.languages, language: options.language };
    runInNewContext(LOCALE_BOOT_SCRIPT, { document: { documentElement }, localStorage, navigator });
    return documentElement;
  }

  const cases: [BootCase, string, string][] = [
    [{ stored: "en", languages: ["ar-AE"] }, "en", "ltr"],
    [{ stored: "ar", languages: ["en-US"] }, "ar", "rtl"],
    [{ stored: null, languages: ["en-US"] }, "en", "ltr"],
    [{ stored: null, languages: ["fr-FR", "en-US"] }, "en", "ltr"],
    [{ stored: null, languages: ["ar-AE"] }, "ar", "rtl"],
    [{ stored: "junk", languages: ["fr-FR"] }, "ar", "rtl"],
    [{ stored: null, languages: [], language: "en-GB" }, "en", "ltr"],
    [{ storageThrows: true, languages: ["en-US"] }, "en", "ltr"],
    [{ storageThrows: true, languages: ["de"] }, "ar", "rtl"],
  ];

  it.each(cases)("%j gives lang %s and dir %s", (options, lang, dir) => {
    const root = boot(options);
    expect([root.lang, root.dir]).toEqual([lang, dir]);
    // The client code must agree with the script for the same inputs.
    const stored = options.stored === undefined || options.storageThrows ? null : options.stored;
    const languages = options.languages?.length ? options.languages : options.language ? [options.language] : [];
    const expected = readStoredLocale({ getItem: () => stored }) ?? detectBrowserLocale(languages);
    expect(root.lang).toBe(expected);
  });
});

describe("message catalog", () => {
  it("has the same shape in both languages", () => {
    const shape = (value: unknown): unknown =>
      typeof value === "function"
        ? "fn"
        : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]))
          : typeof value;
    expect(shape(getMessages("ar"))).toEqual(shape(getMessages("en")));
  });

  it("fixes the four tabs and the wake-up line as the documents give them", () => {
    expect(getMessages("ar").tabs).toEqual({ today: "اليوم", games: "الألعاب", progress: "التقدم", settings: "الإعدادات" });
    expect(getMessages("ar").server.waking).toBe("جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.");
    expect(getMessages("en").server.waking).toBe("Starting the free server, this may take about a minute.");
    expect(getMessages("ar").appName).toBe("قطرة غيث");
  });

  it("contains no em dash, en dash or spaced double hyphen in any string (antislop R-02)", () => {
    const strings: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (typeof value === "function") strings.push(String((value as (text: string) => unknown)("x")));
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
    };
    collect(getMessages("ar"));
    collect(getMessages("en"));
    expect(strings.length).toBeGreaterThan(20);
    const dashes = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]| -- `);
    for (const text of strings) expect(text).not.toMatch(dashes);
  });
});
