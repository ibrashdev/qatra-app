import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatClock, formatInteger } from "@/i18n/format";
import { getMessages } from "@/i18n/messages";
import { renderTemplate } from "@/i18n/template";

describe("number formatting (UI-tokens 3.4): Arabic-Indic digits in Arabic, Western digits in English", () => {
  it("formats an integer without grouping", () => {
    expect(formatInteger("ar", 20)).toBe("٢٠");
    expect(formatInteger("en", 20)).toBe("20");
    expect(formatInteger("ar", 1234)).toBe("١٢٣٤");
    expect(formatInteger("en", 1234)).toBe("1234");
  });

  it("formats a countdown as mm:ss with two digits each", () => {
    expect(formatClock("ar", 900)).toBe("١٥:٠٠");
    expect(formatClock("en", 900)).toBe("15:00");
    expect(formatClock("en", 5)).toBe("00:05");
    expect(formatClock("ar", 61)).toBe("٠١:٠١");
    expect(formatClock("en", 3600)).toBe("60:00");
  });

  it("clamps below zero and rounds down", () => {
    expect(formatClock("en", -3)).toBe("00:00");
    expect(formatClock("en", 59.9)).toBe("00:59");
  });
});

describe("renderTemplate: placeholders filled with nodes", () => {
  it("puts each value where its placeholder stands and keeps the rest of the text", () => {
    const { container } = render(<p>{renderTemplate("before {time} after", { time: <bdi dir="ltr">15:00</bdi> })}</p>);
    expect(container.querySelector("p")?.textContent).toBe("before 15:00 after");
    expect(container.querySelector("bdi")).toHaveAttribute("dir", "ltr");
  });

  it("leaves an unknown placeholder as written", () => {
    const { container } = render(<p>{renderTemplate("a {unknown} b", {})}</p>);
    expect(container.textContent).toBe("a {unknown} b");
  });

  it("fills the lock message of P-06 with a left-to-right clock in both languages", () => {
    for (const locale of ["ar", "en"] as const) {
      const template = getMessages(locale).form.throttleClock;
      expect(template).toContain("{time}");
      const { container, unmount } = render(<p>{renderTemplate(template, { time: <bdi dir="ltr">{formatClock(locale, 900)}</bdi> })}</p>);
      expect(container.querySelector("bdi")?.textContent).toBe(locale === "ar" ? "١٥:٠٠" : "15:00");
      expect(container.textContent).not.toContain("{time}");
      unmount();
    }
  });
});

describe("the copy of S-01 and the shared form patterns, as the spec gives it", () => {
  it("keeps the fixed Arabic strings of UI-screens verbatim", () => {
    const ar = getMessages("ar");
    expect(ar.screens.login).toBe("الدخول");
    expect(ar.auth.login.usernameLabel).toBe("اسم المستخدم");
    expect(ar.auth.login.passwordLabel).toBe("كلمة المرور");
    expect(ar.auth.login.submit).toBe("دخول");
    expect(ar.auth.login.submitting).toBe("جارٍ الدخول…");
    expect(ar.auth.login.forgotPassword).toBe("نسيت كلمة المرور");
    expect(ar.auth.login.noAccount).toBe("ليس لديك حساب؟");
    expect(ar.auth.login.createAccount).toBe("إنشاء حساب");
    expect(ar.auth.login.usernameRequired).toBe("أدخل اسم المستخدم.");
    expect(ar.auth.login.passwordRequired).toBe("أدخل كلمة المرور.");
    expect(ar.auth.login.invalidCredentials).toBe("اسم المستخدم أو كلمة المرور غير صحيحة.");
    expect(ar.auth.login.arrival).toEqual({
      sessionEnded: "انتهت جلستك. سجّل الدخول للمتابعة.",
      resetDone: "تم تعيين كلمة مرور جديدة. سجّل الدخول بها.",
      accountDeleted: "تم حذف حسابك.",
    });
    expect(ar.form.showPassword).toBe("إظهار كلمة المرور");
    expect(ar.form.hidePassword).toBe("إخفاء كلمة المرور");
    expect(ar.form.errorSummary("٢")).toBe("يوجد ٢ أخطاء في النموذج");
    expect(ar.form.offline).toBe("لا يوجد اتصال بالشبكة. تحقّق من اتصالك ثم أعد المحاولة.");
    expect(ar.form.backOnline).toBe("عاد الاتصال.");
    expect(ar.form.throttleSeconds("٢٠")).toBe("محاولات كثيرة. انتظر ٢٠ ثانية ثم أعد المحاولة.");
    expect(ar.form.throttleClock).toBe("محاولات كثيرة. يمكنك المحاولة بعد {time}.");
    expect(ar.form.throttleOver).toBe("يمكنك المحاولة الآن.");
    expect(ar.form.stillProcessing).toBe("ما زلنا نعالج طلبك، قد يستغرق ذلك لحظات.");
    expect(ar.form.internal).toBe("حدث خطأ غير متوقع. حاول مرة أخرى.");
    expect(ar.form.unavailable).toBe("الخدمة غير متاحة مؤقتًا. حاول بعد قليل.");
    expect(ar.form.forbiddenOrigin).toBe("تعذّر إكمال الطلب. أعد تحميل الصفحة ثم حاول مرة أخرى.");
    expect(ar.form.reloadPage).toBe("إعادة تحميل الصفحة");
  });

  it("gives the proposed English counterparts", () => {
    const en = getMessages("en");
    expect(en.screens.login).toBe("Log in");
    expect(en.auth.login.usernameRequired).toBe("Enter your username.");
    expect(en.auth.login.passwordRequired).toBe("Enter your password.");
    expect(en.auth.login.submitting).toBe("Logging in…");
    expect(en.auth.login.forgotPassword).toBe("Forgot your password?");
    expect(en.auth.login.noAccount).toBe("Don't have an account?");
    expect(en.auth.login.createAccount).toBe("Create an account");
    expect(en.auth.login.invalidCredentials).toBe("The username or password is not correct.");
    expect(en.form.errorSummary("2")).toBe("There are 2 errors in the form");
    expect(en.form.throttleSeconds("20")).toBe("Too many attempts. Wait 20 seconds and try again.");
    expect(en.form.throttleClock).toBe("Too many attempts. You can try again in {time}.");
    expect(en.form.stillProcessing).toBe("We are still processing your request; this may take a moment.");
    expect(en.form.reloadPage).toBe("Reload page");
  });

  it("keeps every placeholder the Arabic catalog has in the English one", () => {
    const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort();
    expect(placeholders(getMessages("en").form.throttleClock)).toEqual(placeholders(getMessages("ar").form.throttleClock));
  });
});
