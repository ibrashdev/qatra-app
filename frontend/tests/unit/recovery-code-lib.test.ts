import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { recoveryCodeAr, recoveryCodeEn, type RecoveryCodeMessages } from "@/i18n/recovery-code-messages";
import { ApiError, ConnectivityError } from "@/lib/api/errors";
import { MOCK_RECOVERY_CODE, mockProfile, mockToday, mockTodayWithoutPlan } from "@/lib/api/mock";
import { clearCodeUnavailable, clearLoginArrival, peekCodeUnavailable, peekLoginArrival, raiseCodeUnavailable, raiseLoginArrival } from "@/lib/auth/flash";
import {
  holdRecoveryCode,
  nextScreen,
  peekRecoveryCode,
  RECOVERY_CODE_FILE_NAME,
  recoveryCodeFileText,
  recoveryCodeGroups,
  resolveAbsentDestination,
  wipeRecoveryCode,
} from "@/lib/auth/recovery-handoff";

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);

beforeEach(() => {
  wipeRecoveryCode();
  clearLoginArrival();
  clearCodeUnavailable();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the held recovery code (UA-06): in memory, one at a time, handed over as a copy", () => {
  it("holds the code and its host, and holds nothing before anything is handed over", () => {
    expect(peekRecoveryCode()).toBeNull();
    holdRecoveryCode(MOCK_RECOVERY_CODE, "register");
    expect(peekRecoveryCode()).toEqual({ code: MOCK_RECOVERY_CODE, host: "register" });
  });

  it("returns a copy, so a caller cannot change what is held", () => {
    holdRecoveryCode(MOCK_RECOVERY_CODE, "recovery");
    const copy = peekRecoveryCode();
    if (copy === null) throw new Error("nothing held");
    copy.code = "changed";
    copy.host = "settings";
    expect(peekRecoveryCode()).toEqual({ code: MOCK_RECOVERY_CODE, host: "recovery" });
  });

  it("is emptied by a wipe, and a new code replaces the old one", () => {
    holdRecoveryCode("0000-0000-0000-0000-0000-0000-0000-0000", "register");
    holdRecoveryCode(MOCK_RECOVERY_CODE, "settings");
    expect(peekRecoveryCode()).toEqual({ code: MOCK_RECOVERY_CODE, host: "settings" });
    wipeRecoveryCode();
    expect(peekRecoveryCode()).toBeNull();
    wipeRecoveryCode();
    expect(peekRecoveryCode()).toBeNull();
  });

  it("touches no storage, address or history state", () => {
    const stateBefore = JSON.stringify(window.history.state);
    holdRecoveryCode(MOCK_RECOVERY_CODE, "register");
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(window.location.href).not.toContain("0123");
    expect(JSON.stringify(window.history.state)).toBe(stateBefore);
  });
});

describe("recoveryCodeGroups: the contract of E03, E07 and E08", () => {
  it("splits 32 lowercase hexadecimal characters in eight groups of four", () => {
    expect(recoveryCodeGroups(MOCK_RECOVERY_CODE)).toEqual(["0123", "4567", "89ab", "cdef", "0123", "4567", "89ab", "cdef"]);
    expect(recoveryCodeGroups("fedc-ba98-7654-3210-fedc-ba98-7654-3210")).toHaveLength(8);
  });

  it.each([
    ["an empty text", ""],
    ["no dashes", "0123456789abcdef0123456789abcdef"],
    ["seven groups", "0123-4567-89ab-cdef-0123-4567-89ab"],
    ["nine groups", "0123-4567-89ab-cdef-0123-4567-89ab-cdef-0123"],
    ["a group of five", "01234-567-89ab-cdef-0123-4567-89ab-cdef"],
    ["uppercase letters", "0123-4567-89AB-CDEF-0123-4567-89ab-cdef"],
    ["a character outside hexadecimal", "0123-4567-89ab-cdeg-0123-4567-89ab-cdef"],
    ["spaces around", " 0123-4567-89ab-cdef-0123-4567-89ab-cdef "],
    ["a line break inside", "0123-4567-89ab-cdef\n0123-4567-89ab-cdef"],
    ["a trailing dash", "0123-4567-89ab-cdef-0123-4567-89ab-cdef-"],
    ["Arabic-Indic digits", "٠١٢٣-4567-89ab-cdef-0123-4567-89ab-cdef"],
    ["a different separator", "0123 4567 89ab cdef 0123 4567 89ab cdef"],
  ])("is not a recovery code: %s", (_name, text) => {
    expect(recoveryCodeGroups(text)).toBeNull();
  });
});

describe("the downloaded file (S-04 section 3, O-17)", () => {
  it("is named qatra-recovery-code.txt", () => {
    expect(RECOVERY_CODE_FILE_NAME).toBe("qatra-recovery-code.txt");
  });

  it("has three lines: the title, the code with its dashes, the warning, joined by line feeds", () => {
    const text = recoveryCodeFileText({ title: "T", code: MOCK_RECOVERY_CODE, warning: "W" });
    expect(text).toBe(`T\n${MOCK_RECOVERY_CODE}\nW`);
    expect(text.split("\n")).toHaveLength(3);
  });

  it("is written in the interface language, with the first line of the owner fix and no username anywhere", () => {
    const ar = recoveryCodeFileText({ title: recoveryCodeAr.fileTitle, code: MOCK_RECOVERY_CODE, warning: recoveryCodeAr.fileWarning });
    expect(ar.split("\n")).toEqual(["قطرة غيث: رمز الاسترجاع", MOCK_RECOVERY_CODE, "احتفظ بهذا الملف في مكان آمن ولا تشاركه."]);
    const en = recoveryCodeFileText({ title: recoveryCodeEn.fileTitle, code: MOCK_RECOVERY_CODE, warning: recoveryCodeEn.fileWarning });
    expect(en.split("\n")).toEqual(["Qatra: recovery code", MOCK_RECOVERY_CODE, "Keep this file somewhere safe and do not share it."]);
    for (const text of [ar, en]) expect(text).not.toContain(mockProfile.username);
  });
});

describe("nextScreen: where the continue action goes (S-04 section 1)", () => {
  it("is S-08 after registration, S-01 after a recovery and S-22 after a rotation", () => {
    expect(nextScreen("register")).toBe("/start");
    expect(nextScreen("recovery")).toBe("/login");
    expect(nextScreen("settings")).toBe("/settings");
  });
});

describe("resolveAbsentDestination: guard 9 (UI-design 2.3)", () => {
  const unauthenticated = () => new ApiError({ status: 401, code: "unauthenticated", message: "Authentication is required." });
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

  interface ReadOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
  }

  type Read = (options?: ReadOptions) => Promise<unknown>;

  function makeApi({ me, today }: { me?: Read; today?: Read } = {}) {
    return {
      me: vi.fn(async (options?: ReadOptions) => (me ? me(options) : mockProfile)),
      today: vi.fn(async (options?: ReadOptions) => (today ? today(options) : mockToday)),
    };
  }

  it("sends a visitor to S-01 with the wording that says to log in first, and never asks for the plan", async () => {
    const api = makeApi({ me: async () => Promise.reject(unauthenticated()) });
    const answer = await resolveAbsentDestination(api as never, new AbortController().signal);
    expect(answer).toEqual({ path: "/login", variant: "recovery" });
    expect(api.today).not.toHaveBeenCalled();
  });

  it("sends a learner with a plan to /today and a learner without one to /start, both with the default wording", async () => {
    const withPlan = makeApi();
    expect(await resolveAbsentDestination(withPlan as never, new AbortController().signal)).toEqual({ path: "/today", variant: "default" });
    const withoutPlan = makeApi({ today: async () => mockTodayWithoutPlan });
    expect(await resolveAbsentDestination(withoutPlan as never, new AbortController().signal)).toEqual({ path: "/start", variant: "default" });
  });

  it("sends a signed-in learner to /today when the plan cannot be read (a failed read must not strand anyone)", async () => {
    const api = makeApi({ today: async () => Promise.reject(new ConnectivityError("gateway")) });
    expect(await resolveAbsentDestination(api as never, new AbortController().signal)).toEqual({ path: "/today", variant: "default" });
  });

  it.each([
    ["a sleeping server", () => new ConnectivityError("gateway", { status: 502 })],
    ["no network", () => new ConnectivityError("network")],
    ["a timeout", () => new ConnectivityError("timeout")],
    ["an unexpected server answer", () => new ApiError({ status: 500, code: "internal", message: "Unexpected error." })],
  ])("treats a failed session probe as a visitor, so S-01 asks again and sends a learner on: %s", async (_name, error) => {
    const api = makeApi({ me: async () => Promise.reject(error()) });
    expect(await resolveAbsentDestination(api as never, new AbortController().signal)).toEqual({ path: "/login", variant: "recovery" });
  });

  it("waits a bounded time for the probe, so a hanging server cannot hold the screen", async () => {
    const api = makeApi();
    await resolveAbsentDestination(api as never, new AbortController().signal);
    const options = api.me.mock.calls[0]?.[0];
    expect(options?.timeoutMs).toBe(8_000);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers null when the caller gives up, before or during either request", async () => {
    const before = new AbortController();
    before.abort();
    expect(await resolveAbsentDestination(makeApi({ me: async () => Promise.reject(abortError()) }) as never, before.signal)).toBeNull();

    const during = new AbortController();
    const api = makeApi({
      me: () => {
        during.abort();
        return Promise.reject(abortError());
      },
    });
    expect(await resolveAbsentDestination(api as never, during.signal)).toBeNull();

    const late = new AbortController();
    const afterMe = makeApi({
      today: () => {
        late.abort();
        return Promise.resolve(mockToday);
      },
    });
    expect(await resolveAbsentDestination(afterMe as never, late.signal)).toBeNull();
  });
});

describe("the arrival banner of S-01 for a code that is gone (flash.ts)", () => {
  it("is the weakest of the arrival banners: the others win, and it is shown when it is alone", () => {
    raiseLoginArrival("code_unavailable");
    expect(peekLoginArrival()).toBe("code_unavailable");
    raiseLoginArrival("account_deleted");
    expect(peekLoginArrival()).toBe("account_deleted");
    raiseLoginArrival("reset_done");
    expect(peekLoginArrival()).toBe("reset_done");
    raiseLoginArrival("session_ended");
    expect(peekLoginArrival()).toBe("session_ended");
    clearLoginArrival();
    expect(peekLoginArrival()).toBeNull();
  });
});

describe("the note for the screens after S-04 (flash.ts): in memory, shown once, and short-lived", () => {
  it("is not raised by default, is read without being consumed, and goes when it is cleared", () => {
    expect(peekCodeUnavailable()).toBe(false);
    raiseCodeUnavailable();
    expect(peekCodeUnavailable()).toBe(true);
    expect(peekCodeUnavailable()).toBe(true);
    clearCodeUnavailable();
    expect(peekCodeUnavailable()).toBe(false);
  });

  it("expires after 30 seconds, so a screen that does not show it yet cannot show it long afterwards", () => {
    let now = 5_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    raiseCodeUnavailable();
    now += 29_999;
    expect(peekCodeUnavailable()).toBe(true);
    now += 1;
    expect(peekCodeUnavailable()).toBe(true);
    now += 1;
    expect(peekCodeUnavailable()).toBe(false);
  });

  it("is raised afresh by a new redirect", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    raiseCodeUnavailable();
    now = 40_000;
    expect(peekCodeUnavailable()).toBe(false);
    raiseCodeUnavailable();
    expect(peekCodeUnavailable()).toBe(true);
  });

  it("is kept in memory only: no storage, no address, no history state", () => {
    raiseCodeUnavailable();
    raiseLoginArrival("code_unavailable");
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });
});

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

describe("the messages of S-04 (UI-screens S-04 section 3 and the owner copy fixes of 4 October 2026)", () => {
  const KEYS = Object.keys(recoveryCodeAr) as Array<keyof RecoveryCodeMessages>;

  it("exist in both languages for the same keys, none empty", () => {
    expect(Object.keys(recoveryCodeEn)).toEqual(Object.keys(recoveryCodeAr));
    for (const key of KEYS) {
      expect(strings(recoveryCodeAr[key]).every((text) => text.trim() !== ""), `ar ${key}`).toBe(true);
      expect(strings(recoveryCodeEn[key]).every((text) => text.trim() !== ""), `en ${key}`).toBe(true);
    }
  });

  it("contain no em dash, no en dash and no ellipsis, in either language (R-02 and the owner fixes)", () => {
    for (const text of [...strings(recoveryCodeAr), ...strings(recoveryCodeEn)]) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toContain(EN_DASH);
      expect(text).not.toContain(ELLIPSIS);
      expect(text).not.toContain("...");
    }
  });

  it("give the Arabic of the S-04 table verbatim", () => {
    expect(getMessages("ar").screens.recoveryCode).toBe("حفظ رمز الاسترجاع"); // c2
    expect(recoveryCodeAr.step).toBe("الخطوة ٣ من ٣"); // c1
    expect(recoveryCodeAr.lead).toBe("يظهر هذا الرمز مرة واحدة فقط ولن نستطيع عرضه لك مرة أخرى. احفظه في مكان آمن خارج التطبيق."); // c3
    expect(recoveryCodeAr.oldCodeInvalid).toBe("الرمز القديم لم يعد صالحًا."); // c3b
    expect(recoveryCodeAr.blockName).toBe("رمز الاسترجاع"); // c5
    expect(recoveryCodeAr.blockDescription).toBe("يظهر مرة واحدة فقط");
    expect(recoveryCodeAr.copy).toBe("نسخ"); // c6
    expect(recoveryCodeAr.download).toBe("تنزيل"); // c7
    expect(recoveryCodeAr.confirmLabel).toBe("حفظت الرمز في مكان آمن خارج التطبيق"); // c8
    expect(recoveryCodeAr.continueLabel).toBe("متابعة"); // c9
    expect(recoveryCodeAr.confirmRequired).toBe("أكّد أنك حفظت الرمز قبل المتابعة.");
    expect(recoveryCodeAr.copied).toBe("تم النسخ");
    expect(recoveryCodeAr.downloaded).toBe("تم تنزيل الملف");
    expect(recoveryCodeAr.copyUnavailable).toBe("تعذّر النسخ تلقائيًا. حدّد الرمز وانسخه يدويًا.");
    expect(recoveryCodeAr.fileWarning).toBe("احتفظ بهذا الملف في مكان آمن ولا تشاركه.");
    expect(recoveryCodeAr.leave.title).toBe("لم تؤكد حفظ الرمز");
    expect(recoveryCodeAr.leave.body).toBe("إن غادرت الآن فلن يظهر هذا الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.");
    expect(recoveryCodeAr.leave.stay).toBe("البقاء وحفظ الرمز");
    expect(recoveryCodeAr.leave.leave).toBe("المغادرة دون حفظ");
    expect(recoveryCodeAr.unavailable).toBe("لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات.");
  });

  it("give the proposed English of the S-04 table", () => {
    expect(getMessages("en").screens.recoveryCode).toBe("Save your recovery code");
    expect(recoveryCodeEn.step).toBe("Step 3 of 3");
    expect(recoveryCodeEn.lead).toBe("This code is shown only once and we cannot show it to you again. Keep it in a safe place outside the app.");
    expect(recoveryCodeEn.oldCodeInvalid).toBe("Your old code no longer works.");
    expect(recoveryCodeEn.blockName).toBe("Recovery code");
    expect(recoveryCodeEn.blockDescription).toBe("Shown once only");
    expect(recoveryCodeEn.copy).toBe("Copy");
    expect(recoveryCodeEn.download).toBe("Download");
    expect(recoveryCodeEn.confirmLabel).toBe("I have saved the code in a safe place outside the app");
    expect(recoveryCodeEn.continueLabel).toBe("Continue");
    expect(recoveryCodeEn.confirmRequired).toBe("Confirm that you have saved the code before you continue.");
    expect(recoveryCodeEn.copied).toBe("Copied");
    expect(recoveryCodeEn.downloaded).toBe("File downloaded");
    expect(recoveryCodeEn.copyUnavailable).toBe("Automatic copy is not available. Select the code and copy it by hand.");
    expect(recoveryCodeEn.fileWarning).toBe("Keep this file somewhere safe and do not share it.");
    expect(recoveryCodeEn.leave.title).toBe("You have not confirmed saving the code");
    expect(recoveryCodeEn.leave.body).toBe("If you leave now this code will not be shown again. You can create a new one in Settings.");
    expect(recoveryCodeEn.leave.stay).toBe("Stay and save the code");
    expect(recoveryCodeEn.leave.leave).toBe("Leave without saving");
    expect(recoveryCodeEn.unavailable).toBe("The code cannot be shown again. You can create a new one in Settings.");
  });

  it("carry the owner fixes: c4 in two sentences, the file title with a colon, and the full recovery-host sentences", () => {
    expect(recoveryCodeAr.warning).toBe("لا يمكن استرجاع الحساب دون الرمز. إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك.");
    expect(recoveryCodeEn.warning).toBe("The account cannot be recovered without the code. If you lose both your password and this code, we cannot recover your account.");
    expect(recoveryCodeAr.fileTitle).toBe("قطرة غيث: رمز الاسترجاع");
    expect(recoveryCodeEn.fileTitle).toBe("Qatra: recovery code");
    expect(recoveryCodeAr.leave.bodyRecovery).toBe("إن غادرت الآن فلن يظهر هذا الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات بعد تسجيل الدخول.");
    expect(recoveryCodeEn.leave.bodyRecovery).toBe("If you leave now this code will not be shown again. You can create a new one in Settings after you log in.");
    expect(recoveryCodeAr.unavailableRecovery).toBe("لا يمكن عرض الرمز مرة أخرى. يمكنك إنشاء رمز جديد من الإعدادات بعد تسجيل الدخول.");
    expect(recoveryCodeEn.unavailableRecovery).toBe("The code cannot be shown again. You can create a new one in Settings after you log in.");
  });

  it("are joined into the catalog of each language", () => {
    expect(getMessages("ar").recoveryCode).toBe(recoveryCodeAr);
    expect(getMessages("en").recoveryCode).toBe(recoveryCodeEn);
  });

  it("are Arabic in the Arabic catalog and Latin in the English one (the file title of the Arabic file is the Arabic product name)", () => {
    expect(recoveryCodeAr.fileTitle.startsWith("قطرة غيث")).toBe(true);
    expect(recoveryCodeEn.fileTitle.startsWith("Qatra")).toBe(true);
    expect(/[؀-ۿ]/.test(recoveryCodeEn.lead)).toBe(false);
    expect(/[؀-ۿ]/.test(recoveryCodeAr.lead)).toBe(true);
  });
});
