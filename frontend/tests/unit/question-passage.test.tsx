import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnswerFeedback } from "@/components/questions/AnswerFeedback";
import { ContextLine, Blank } from "@/components/questions/OriginalText";
import type { QuestionContext } from "@/lib/api/types";
import { Harness, recallQuestion, renderInLocale, wordChoiceQuestion, wordOrderQuestion } from "./question-support";

// D90: every question shows the whole passage around the blank; the ayah ends are structured data drawn beside the text.
const OPEN = "﴿";
const CLOSE = "﴾";

// A passage over two ayat: the first ends at 1:2, the second at 2:2; the target is 2:1.
const TWO_AYAT: QuestionContext = {
  before: [
    { ref: "1:0", text: "أول١" },
    { ref: "1:1", text: "أول٢" },
    { ref: "1:2", text: "أول٣" },
    { ref: "2:0", text: "ثان١" },
  ],
  after: [{ ref: "2:2", text: "ثان٣" }],
  ayahEnds: [{ afterRef: "1:2", number: 1 }],
};

function marks(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-ayah-end]"));
}

describe("the whole passage around the blank (D90)", () => {
  it("draws every token before the blank, the blank, then every token after it, in one line", () => {
    const { container } = renderInLocale(<ContextLine context={TWO_AYAT} textKind="quran" slot={<Blank />} />, "ar");
    expect(container).toHaveTextContent(`أول١ أول٢ أول٣ ${OPEN}١${CLOSE} ثان١ ثان٣`);
    expect(screen.getByRole("img", { name: "الكلمة الناقصة" }).className).toContain("border-dashed");
  });

  it("draws the number of an ayah end in Arabic-Indic digits inside ornate brackets, hidden from assistive technology", () => {
    const { container } = renderInLocale(<ContextLine context={TWO_AYAT} textKind="quran" slot={<Blank />} />, "en");
    const [mark, ...rest] = marks(container);
    expect(rest).toHaveLength(0);
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark?.textContent).toBe(`${OPEN}١${CLOSE}`);
    // The number is the same digits in both interface languages: it is part of the Arabic text.
    expect(container.querySelector("[dir=rtl][lang=ar]")).not.toBeNull();
  });

  it("never puts the ayah end inside a token: the token texts are exactly what the server sent", () => {
    const { container } = renderInLocale(<ContextLine context={TWO_AYAT} textKind="quran" slot={<Blank />} />);
    const withoutMarks = (container.textContent ?? "").replace(`${OPEN}١${CLOSE}`, "");
    for (const token of [...TWO_AYAT.before, ...TWO_AYAT.after]) {
      expect(withoutMarks).toContain(token.text);
      expect(token.text).not.toContain(OPEN);
    }
  });

  it("draws the end that closes the blank's own ayah right after the blank", () => {
    // The target is the last word of the first ayah: its end belongs to neither side.
    const context: QuestionContext = {
      before: [
        { ref: "1:0", text: "أول١" },
        { ref: "1:1", text: "أول٢" },
      ],
      after: [{ ref: "2:0", text: "ثان١" }],
      ayahEnds: [{ afterRef: "1:2", number: 1 }],
    };
    const { container } = renderInLocale(<ContextLine context={context} textKind="quran" slot={<Blank />} />, "ar");
    const blank = screen.getByRole("img", { name: "الكلمة الناقصة" });
    expect(blank.nextSibling?.textContent).toBe(" ");
    expect(blank.nextSibling?.nextSibling).toBe(marks(container)[0]);
    expect(container).toHaveTextContent(`أول١ أول٢ ${OPEN}١${CLOSE} ثان١`);
  });

  it("shows a passage with no ayah ends (a hadith) and a server older than D90 without any mark", () => {
    const hadith: QuestionContext = { before: [{ ref: "1:6", text: "قبل" }], after: [{ ref: "1:8", text: "بعد" }], ayahEnds: [] };
    const older: QuestionContext = { before: [{ ref: "1:6", text: "قبل" }], after: [{ ref: "1:8", text: "بعد" }] };
    for (const context of [hadith, older]) {
      const { container, unmount } = renderInLocale(<ContextLine context={context} textKind="hadith" slot={<Blank />} />);
      expect(marks(container)).toHaveLength(0);
      expect(container).toHaveTextContent("قبل بعد");
      unmount();
    }
  });

  it("is what a choice question and a recall question show around their blank", () => {
    const choice = renderInLocale(<Harness question={wordChoiceQuestion({ context: TWO_AYAT })} />, "ar");
    expect(choice.container).toHaveTextContent(`أول١ أول٢ أول٣ ${OPEN}١${CLOSE} ثان١`);
    expect(marks(choice.container)).toHaveLength(1);
    choice.unmount();
    const recall = renderInLocale(<Harness question={recallQuestion({ context: TWO_AYAT })} />, "ar");
    expect(recall.container).toHaveTextContent(`أول١ أول٢ أول٣ ${OPEN}١${CLOSE} ثان١`);
    expect(marks(recall.container)).toHaveLength(1);
  });

  it("is what a word-order question shows above its answer line, with the tiles below as before", () => {
    const { container } = renderInLocale(<Harness question={wordOrderQuestion({ context: TWO_AYAT })} />, "ar");
    const place = screen.getByRole("img", { name: "الجزء الناقص" });
    expect(place.className).toContain("border-dashed");
    expect(place.parentElement).toHaveTextContent(`أول١ أول٢ أول٣ ${OPEN}١${CLOSE} ثان١`);
    expect(marks(container)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /كلمة[١٢٣]/ })).toHaveLength(3); // the three tiles
  });

  it("shows no passage line for a word-order question whose part is the whole passage", () => {
    renderInLocale(<Harness question={wordOrderQuestion({ context: { before: [], after: [], ayahEnds: [] } })} />, "ar");
    expect(screen.queryByRole("img", { name: "الجزء الناقص" })).toBeNull();
  });

  it("is the original of a wrong answer: the whole passage with the expected word marked and the ayah end kept", () => {
    const question = wordChoiceQuestion({ context: TWO_AYAT });
    const { container } = renderInLocale(
      <AnswerFeedback question={question} result={{ correct: false, assisted: false, expected: { optionId: "o2" } }} textKind="quran" />,
      "ar",
    );
    const original = container.querySelector<HTMLElement>("[data-feedback] [dir=rtl]");
    expect(original).toHaveTextContent(`أول١ أول٢ أول٣ ${OPEN}١${CLOSE} ثان١ خيار٢ ثان٣`);
    expect(original?.querySelector("mark")?.textContent).toBe("خيار٢");
    expect(marks(original as HTMLElement)).toHaveLength(1);
  });
});
