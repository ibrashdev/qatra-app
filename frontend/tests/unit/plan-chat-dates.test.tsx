import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isolateDates } from "@/components/plan-chat/isolate-dates";

const SENTENCE = "الخطة الحالية: 5 أيام بمعدل 15 دقيقة يوميًا، وتنتهي في 2026-10-11. يمكنك المتابعة بالخيارات أدناه.";

describe("isolateDates (P-13: texts are shown as received, a date only gets isolated)", () => {
  it("wraps the ISO date of the Arabic sentence in a left-to-right bdi that never wraps, and leaves the rest unchanged", () => {
    const { container } = render(<p>{isolateDates(SENTENCE)}</p>);
    const isolated = container.querySelectorAll("bdi");
    expect(isolated).toHaveLength(1);
    expect(isolated[0]).toHaveAttribute("dir", "ltr");
    expect(isolated[0]).toHaveClass("whitespace-nowrap");
    expect(isolated[0]?.textContent).toBe("2026-10-11");
    expect(container.textContent).toBe(SENTENCE);
    const [before, after] = SENTENCE.split("2026-10-11");
    expect(isolated[0]?.previousSibling?.textContent).toBe(before);
    expect(isolated[0]?.nextSibling?.textContent).toBe(after);
  });

  it("returns a text without a date as the same plain string", () => {
    const plain = "المساعد غير متاح الآن؛ يمكنك متابعة التعديل بالخيارات أدناه.";
    expect(isolateDates(plain)).toBe(plain);
    expect(isolateDates("")).toBe("");
    expect(isolateDates("Session 2026-10 and 12-31 are not dates")).toBe("Session 2026-10 and 12-31 are not dates");
  });

  it("wraps every date of a text and keeps the characters between them", () => {
    const text = "تبدأ في 2026-10-07 وتنتهي في 2026-10-11 بإذن الله";
    const { container } = render(<p>{isolateDates(text)}</p>);
    expect(Array.from(container.querySelectorAll("bdi"), (node) => node.textContent)).toEqual(["2026-10-07", "2026-10-11"]);
    for (const node of container.querySelectorAll("bdi")) {
      expect(node).toHaveAttribute("dir", "ltr");
      expect(node).toHaveClass("whitespace-nowrap");
    }
    expect(container.textContent).toBe(text);
  });

  it("accepts the same shape in Arabic-Indic digits without changing the digits", () => {
    const text = "وتنتهي في ٢٠٢٦-١٠-١١.";
    const { container } = render(<p>{isolateDates(text)}</p>);
    expect(container.querySelector("bdi")?.textContent).toBe("٢٠٢٦-١٠-١١");
    expect(container.textContent).toBe(text);
  });

  it("handles a date at the start or at the end of the text", () => {
    const { container } = render(<p>{isolateDates("2026-10-11 ثم 2026-10-12")}</p>);
    expect(Array.from(container.querySelectorAll("bdi"), (node) => node.textContent)).toEqual(["2026-10-11", "2026-10-12"]);
    expect(container.textContent).toBe("2026-10-11 ثم 2026-10-12");
  });
});
