// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { D53_NOTICE_AR, D53_NOTICE_EN, PLAN_CONVERSATION_AR, PLAN_CONVERSATION_EN, TRANSPARENCY_LINE_AR, TRANSPARENCY_LINE_EN, getTermsText, type TermsBlock, type TermsText } from "@/i18n/terms-text";
import type { TermsOpener } from "@/lib/nav/terms-opener";

const root = path.resolve(__dirname, "../..");
const AUTH_DOC = path.resolve(root, "../docs/Authentication-and-privacy.md");
const SCREENS_DOC = path.resolve(root, "../docs/UI-screens.md");
// The documents sit beside frontend/ in the repository; a copy of the frontend alone has nothing to compare with, and those checks are skipped.
const hasDocs = existsSync(AUTH_DOC) && existsSync(SCREENS_DOC);

const OPENERS: TermsOpener[] = ["register", "consent", "home"];

const ar = getTermsText("ar");
const en = getTermsText("en");

function texts(text: TermsText): string[] {
  const blocks = (block: TermsBlock) => (block.kind === "paragraph" ? [block.text] : [...block.items]);
  return [text.versionLine, text.termsHeading, text.privacyHeading, ...Object.values(text.returnButton), ...[...text.terms, ...text.privacy].flatMap((topic) => [topic.title, ...topic.blocks.flatMap(blocks)])];
}

describe("the text of S-03 in both languages (UI-screens S-03 sections 2 and 3)", () => {
  it("has the same shape in Arabic and English: the same parts, topics, block kinds and list lengths, and no empty string (NFR-14)", () => {
    const shape = (text: TermsText) => ({
      terms: text.terms.map((topic) => topic.blocks.map((block) => (block.kind === "list" ? `list ${block.items.length}` : "paragraph"))),
      privacy: text.privacy.map((topic) => topic.blocks.map((block) => (block.kind === "list" ? `list ${block.items.length}` : "paragraph"))),
      openers: Object.keys(text.returnButton).sort(),
    });
    expect(shape(en)).toEqual(shape(ar));
    expect(shape(ar).openers).toEqual([...OPENERS].sort());
    for (const text of [...texts(ar), ...texts(en)]) expect(text.trim(), "an empty string").not.toBe("");
  });

  it("names the seven topics of the spec, three under the terms and four under the privacy statement, in this order", () => {
    expect(ar.terms.map((topic) => topic.title)).toEqual(["الكتاب كما هو", "صحة المراجع", "لا فتوى ولا شرح"]);
    expect(ar.privacy.map((topic) => topic.title)).toEqual(["البيانات التي نجمعها", "بيانات الحساب والنموذج الخارجي", "الحذف والاحتفاظ", "ما لا نستنتجه عنك"]);
    expect(en.terms.map((topic) => topic.title)).toEqual(["The book as it is", "Accuracy of references", "No fatwa or explanation"]);
    expect(en.privacy.map((topic) => topic.title)).toEqual(["Data we collect", "Account data and external models", "Deletion and retention", "What we do not infer"]);
    expect([ar.termsHeading, ar.privacyHeading]).toEqual(["شروط الاستخدام", "بيان الخصوصية"]);
    expect([en.termsHeading, en.privacyHeading]).toEqual(["Terms of use", "Privacy statement"]);
  });

  it("has the version line of c3 with a place for the version, and the return buttons of c6", () => {
    expect(ar.versionLine).toBe("إصدار الشروط: {version}");
    expect(en.versionLine).toBe("Terms version: {version}");
    expect(ar.returnButton).toEqual({ register: "العودة إلى إنشاء الحساب", consent: "العودة إلى الموافقة", home: "العودة إلى الصفحة الرئيسية" });
    expect(en.returnButton).toEqual({ register: "Back to create account", consent: "Back to consent", home: "Back to home" });
  });

  it("keeps the shell strings of S-03 (the back control names and the error banner) in the shell catalog, in both languages", () => {
    const [shellAr, shellEn] = [getMessages("ar").terms, getMessages("en").terms];
    expect(shellAr.destinations).toEqual({ register: "إنشاء الحساب", consent: "الموافقة", home: "الصفحة الرئيسية" });
    expect(shellEn.destinations).toEqual({ register: "Create account", consent: "Consent", home: "Home" });
    expect(shellAr.unavailable).toBe("تعذّر فتح شروط الاستخدام وبيان الخصوصية. تحقّق من الاتصال ثم أعد المحاولة.");
    expect(shellEn.unavailable).toBe("The terms of use and privacy statement could not be opened. Check your connection and try again.");
    // c6 repeats the destination of c1 after "Back to".
    for (const opener of OPENERS) {
      expect(ar.returnButton[opener]).toBe(`العودة إلى ${shellAr.destinations[opener]}`);
      expect(en.returnButton[opener].toLowerCase()).toBe(`back to ${shellEn.destinations[opener].toLowerCase()}`);
    }
  });

  it("quotes the fixed sentences inside the text: the notice of the book, the transparency line, and the plan-conversation paragraph", () => {
    const paragraphs = (text: TermsText) => [...text.terms, ...text.privacy].flatMap((topic) => topic.blocks).flatMap((block) => (block.kind === "paragraph" ? [block.text] : []));
    for (const [text, sentences] of [
      [ar, [D53_NOTICE_AR, TRANSPARENCY_LINE_AR, PLAN_CONVERSATION_AR]],
      [en, [D53_NOTICE_EN, TRANSPARENCY_LINE_EN, PLAN_CONVERSATION_EN]],
    ] as const) {
      for (const sentence of sentences) expect(paragraphs(text).some((paragraph) => paragraph.includes(sentence)), sentence.slice(0, 40)).toBe(true);
    }
  });

  it("shows no reference to the project's own documents, decisions, tables or columns, in either language", () => {
    const internal = /\bD\d{2}\b|\bA-\d+|OPEN-\d+|\bNFR\b|\bUA-\d+|\.md\b|profiles\.|private\.|plan_chat|user_id|ai_usage|\bRLS\b|الجدول أعلاه|table above|Architecture-and-data/;
    for (const text of [...texts(ar), ...texts(en)]) expect(internal.test(text), text.slice(0, 60)).toBe(false);
  });

  it("does not show the sentence of the earlier rules-engine design, nor the embedding provider or the offline paragraph (not built in this batch)", () => {
    const all = [...texts(ar), ...texts(en)].join("\n");
    for (const left of ["أثناء التحدي", "وكيل التعليم", "حساب العرض", "مزود التضمين", "embedding", "دون اتصال", "offline", "الملاحظات"]) expect(all, left).not.toContain(left);
  });

  it("writes no em dash or en dash and no invisible character, so the text is only what it seems to be", () => {
    const dashes = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);
    const invisible = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\u061C\u0640]/;
    for (const text of [...texts(ar), ...texts(en)]) {
      expect(dashes.test(text), text.slice(0, 60)).toBe(false);
      expect(invisible.test(text), text.slice(0, 60)).toBe(false);
    }
  });

  it("is loaded with the S-03 route only, so no other page carries the text (only the terms components import it)", () => {
    function files(directory: string): string[] {
      return readdirSync(directory).flatMap((entry) => {
        const full = path.join(directory, entry);
        return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(entry) ? [full] : [];
      });
    }
    const importers = files(path.join(root, "src"))
      .filter((file) => /from\s+"[^"]*terms-text"/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .sort();
    expect(importers).toEqual(["src/components/terms/TermsBody.tsx", "src/components/terms/TermsScreen.tsx"]);
  });
});

// Text that is owned by the source (UI-screens S-03 section 1): compared with it here, so a change in either shows up.
describe.skipIf(!hasDocs)("the Arabic text against its source, docs/Authentication-and-privacy.md and docs/UI-screens.md", () => {
  const source = hasDocs ? readFileSync(AUTH_DOC, "utf8") : "";
  const screens = hasDocs ? readFileSync(SCREENS_DOC, "utf8") : "";

  // Words only: spacing, punctuation and the codes in brackets ("(D25)") do not count, so a list can be made of the source's sentences.
  const words = (value: string) => value.replace(/\((?:D\d+|A-\d+)[^)]*\)/g, "").replace(/[^\p{L}\p{N}\p{M}]/gu, "");
  const corpus = words(source);

  it("quotes the three fixed sentences exactly as the source fixes them", () => {
    for (const sentence of [D53_NOTICE_AR, TRANSPARENCY_LINE_AR, PLAN_CONVERSATION_AR]) expect(source.includes(sentence), sentence.slice(0, 40)).toBe(true);
  });

  it("uses the proposed headings, return buttons, error banner and version line of the screen spec", () => {
    for (const title of [...ar.terms, ...ar.privacy].map((topic) => topic.title)) expect(screens.includes(`«${title}»`), title).toBe(true);
    expect(screens.includes(Object.values(ar.returnButton).join(" / "))).toBe(true);
    expect(screens.includes(getMessages("ar").terms.unavailable)).toBe(true);
    expect(screens.includes(ar.versionLine.replace("{version}", "{TERMS_VERSION}"))).toBe(true);
    expect(screens.includes(`رجوع إلى {${Object.values(getMessages("ar").terms.destinations).join(" / ")}}`)).toBe(true);
  });

  it("uses the proposed English of the screen spec for the headings, the version line, the error banner and the return buttons", () => {
    const pairs = [...ar.terms, ...ar.privacy].map((topic, index) => [topic.title, [...en.terms, ...en.privacy][index]?.title] as const);
    for (const [arabic, english] of pairs) expect(screens.includes(`«${arabic}» / ${english}`), `${arabic} / ${english}`).toBe(true);
    expect(screens.includes(en.versionLine.replace("{version}", "{TERMS_VERSION}"))).toBe(true);
    expect(screens.includes(getMessages("en").terms.unavailable)).toBe(true);
    expect(screens.includes("Back to create account / consent / home")).toBe(true);
    expect(screens.includes(`Back to {${Object.values(getMessages("en").terms.destinations).join(" / ")}}`)).toBe(true);
  });

  it("takes every clause of the body from the source: nothing is added to the words of the bullets and table rows it quotes", () => {
    // The comparison can fail: a phrase of the source is found, one that is not there is not.
    expect(corpus.includes(words("صحة المراجع ومطابقة النسخة مسؤولية مدير المحتوى"))).toBe(true);
    expect(corpus.includes(words("تستخدم لبناء خطتك وحساب وقتك النشط وتقدمك"))).toBe(false);
    const body = [...ar.terms, ...ar.privacy].flatMap((topic) => topic.blocks).flatMap((block) => (block.kind === "paragraph" ? [block.text] : [...block.items]));
    const clauses = body
      .flatMap((text) => text.split(/[؛:.،()«»]/))
      .map((clause) => words(clause))
      .filter((clause) => clause.length >= 3);
    const missing = [...new Set(clauses)].filter((clause) => !corpus.includes(clause));
    // The few clauses that join two phrases of the source, or turn a table cell into a sentence, are named here by their words, so the owner
    // can review them. A clause that stops being needed has to leave this list, so it cannot grow unnoticed.
    const JOINS = new Map<string, string>([
      ["الذيوافقعليهووقتالموافقةبتوقيتالخادمفقط", "joins the two cells of the terms-consent row, whose column names are left out"],
      ["رسائلالمتعلموالمساعدوالحالة", "joins the two parts of the plan-conversation row (state, and messages)"],
      ["وتحفظرسائلالمحادثةمعالحسابوتحذفمعهفيطلبالحذفنفسه", "joins the sentence on saving messages with the deletion phrase of the same row"],
      ["فتراتتعلموألعابنشطةمتحققمنها", "writes the slash of «تعلم/ألعاب» as a conjunction"],
      ["حذفالحسابحذففورينهائيلمستخدمAuthوكلالصفوفالشخصية", "leaves out the interface details between the subject and its predicate"],
      ["وتشملمحادثاتالخطة", "says in plain words what the two table names of the plan conversation stand for"],
    ]);
    expect(missing.filter((clause) => !JOINS.has(clause))).toEqual([]);
    expect([...JOINS.keys()].filter((clause) => !missing.includes(clause))).toEqual([]);
  });

  it("leaves nothing out of the bullets it quotes: every clause of them is on the page, but the clauses named here", () => {
    const section = source.slice(source.indexOf("## شروط الاستخدام وبيان الخصوصية"));
    const bullets = section
      .slice(0, section.indexOf("\n## ", 5))
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
    // Ten bullets. Not compared here: the one on the data collected (its purposes and periods are in the table rows, checked above), the
    // plan-conversation paragraph (quoted exactly above), the pointer to the deletion policy, and the offline paragraph (shown when F13 ships).
    const SKIPPED = new Set([3, 5, 7, 8]);
    expect(bullets).toHaveLength(10);
    const page = words([...ar.terms, ...ar.privacy].flatMap((topic) => topic.blocks).map((block) => (block.kind === "paragraph" ? block.text : block.items.join(" "))).join(" "));
    const clauses = bullets
      .filter((_, index) => !SKIPPED.has(index))
      .flatMap((bullet) => bullet.replace(/\((?:D\d+|A-\d+)[^)]*\)/g, "").split(/[؛:.،()«»]/))
      .map((clause) => words(clause))
      .filter((clause) => clause.length >= 3);
    expect(clauses.length).toBeGreaterThan(30);
    const missing = [...new Set(clauses)].filter((clause) => !page.includes(clause));
    // What the page leaves out of those bullets, and why. An entry that is no longer needed has to go, so the list cannot grow unnoticed.
    const OMITTED = new Map<string, string>([
      ["أومزودالتضمين", "the embedding provider: this build has none (D69)"],
      ["ولايرسلنصالمتعلمإلىمزودالتضمين", "the embedding provider: this build has none (D69)"],
      ["ومقدموالخدمةكمافي", "pointer to the table section; the providers are named in a paragraph of their own"],
      ["البياناتالمسموحةومكانها", "the name of that section, which the page does not show"],
      ["يحلهذاالسطرمحلنصD51بقرارD75", "a note on the change of wording, for the document and not for the reader"],
      ["المرجعيةص٥", "a page reference to the document of the challenge"],
    ]);
    expect(missing.filter((clause) => !OMITTED.has(clause))).toEqual([]);
    expect([...OMITTED.keys()].filter((clause) => !missing.includes(clause))).toEqual([]);
  });
});
