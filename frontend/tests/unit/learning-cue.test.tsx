import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LearningCue } from "@/components/learning-cue";
import { learningCueMessages } from "@/i18n/games-messages";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import { renderInLocale } from "./question-support";

beforeEach(() => {
  localStorage.clear();
  resetLocaleStoreForTests();
});

describe("the learning-cycle cue (FC-13)", () => {
  it("shows the approved Arabic heading and caption and the three stages in reading order", () => {
    renderInLocale(<LearningCue />, "ar");
    const note = screen.getByRole("note", { name: "مسار الإتقان · خطوات عامة" });
    const stages = within(note).getAllByRole("listitem");
    expect(stages.map((stage) => stage.textContent)).toEqual(["تدريب وتغطية", "نجاح مراجعات الأيام ١ ٣ ٧", "تأكيد التمكّن"]);
    expect(within(note).getByText("التدريب والمراجعة يساعدانك على تثبيت حفظك.")).toBeInTheDocument();
  });

  it("speaks English in the English interface, with the same three stages", () => {
    renderInLocale(<LearningCue />, "en");
    const note = screen.getByRole("note", { name: "Mastery path · general steps" });
    expect(within(note).getAllByRole("listitem").map((stage) => stage.textContent)).toEqual([
      "Practice and coverage",
      "Reviews pass on days 1, 3, 7",
      "Mastery confirmed",
    ]);
    expect(within(note).getByText("Training and review help you make your memorization stick.")).toBeInTheDocument();
  });

  it("is an ordered list, with decorative arrows between the stages only", () => {
    const { container } = renderInLocale(<LearningCue />, "en");
    expect(screen.getByRole("list").tagName).toBe("OL");
    // Two arrows for three stages, none after the last, and every one hidden from assistive technology.
    const arrows = container.querySelectorAll("li svg");
    expect(arrows).toHaveLength(2);
    expect([...arrows].every((arrow) => arrow.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(container.querySelector("li:last-child svg")).toBeNull();
  });

  it("is explanatory only: no progress value, no live region, no control", () => {
    const { container } = renderInLocale(<LearningCue />, "en");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.textContent).not.toMatch(/\d+\s*%|٪/);
  });

  it("keeps the same stage count in both catalogs, with no dash in the wording", () => {
    for (const locale of ["ar", "en"] as const) {
      const t = learningCueMessages(locale);
      expect(t.stages).toHaveLength(3);
      expect(`${t.heading}${t.stages.join("")}${t.caption}`).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`));
    }
  });
});
