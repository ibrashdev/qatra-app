import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnswerFeedback } from "@/components/questions/AnswerFeedback";
import { QuestionSource } from "@/components/questions/QuestionSource";
import { renderInLocale, recallQuestion, similarQuestion, SOURCE, wordChoiceQuestion, wordOrderQuestion } from "./question-support";

describe("answer feedback (UI-tokens 6.17, UI-screens P-21 and P-22)", () => {
  it("keeps one polite status region in place, empty until there is a result", () => {
    const { rerender } = renderInLocale(<AnswerFeedback question={wordChoiceQuestion()} result={null} textKind="quran" />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toBeEmptyDOMElement();
    rerender(<AnswerFeedback question={wordChoiceQuestion()} result={{ correct: true, assisted: false, expected: { optionId: "o2" } }} textKind="quran" />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("Correct.");
  });

  it("correct: the phrase only, no original, no chip", () => {
    renderInLocale(<AnswerFeedback question={wordChoiceQuestion()} result={{ correct: true, assisted: false, expected: { optionId: "o2" } }} textKind="quran" />, "ar");
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("إجابة صحيحة.");
    expect(region).not.toHaveTextContent("خيار٢");
    expect(screen.queryByText("بمساعدة")).toBeNull();
  });

  it("needs review: the gentle phrase and the context with the correct option in place", () => {
    renderInLocale(<AnswerFeedback question={wordChoiceQuestion()} result={{ correct: false, assisted: false, expected: { optionId: "o2" } }} textKind="quran" />, "ar");
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("هذا الموضع يحتاج إلى مراجعة. الأصل:");
    expect(region).toHaveTextContent("قبل١ خيار٢ بعد١");
    const original = region.querySelector(".font-quran");
    expect(original).not.toBeNull();
    expect(original).toHaveAttribute("dir", "rtl");
    expect(original).toHaveAttribute("lang", "ar");
  });

  it("needs review in a hadith edition uses the hadith font", () => {
    renderInLocale(<AnswerFeedback question={wordChoiceQuestion()} result={{ correct: false, assisted: false, expected: { optionId: "o2" } }} textKind="hadith" />);
    expect(screen.getByRole("status").querySelector(".font-hadith")).not.toBeNull();
  });

  it("word order needs review: the tokens in the expected order", () => {
    renderInLocale(<AnswerFeedback question={wordOrderQuestion()} result={{ correct: false, assisted: false, expected: { order: ["2:0", "2:1", "2:2"] } }} textKind="quran" />);
    expect(screen.getByRole("status")).toHaveTextContent("كلمة١ كلمة٢ كلمة٣");
  });

  it("recall needs review: the context with the expected word", () => {
    renderInLocale(<AnswerFeedback question={recallQuestion()} result={{ correct: false, assisted: false, expected: { word: "كلمة١" } }} textKind="quran" />);
    expect(screen.getByRole("status")).toHaveTextContent("قبل١ كلمة١ بعد١");
  });

  it("recall needs review before the word is known: the context with a blank stands in, and no word is invented", () => {
    renderInLocale(<AnswerFeedback question={recallQuestion()} result={{ correct: false, assisted: false, expected: {} }} textKind="quran" />);
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("This spot needs review. The original:");
    expect(region).toHaveTextContent("قبل١");
    expect(region).toHaveTextContent("بعد١");
    expect(screen.getByRole("img", { name: "the missing word" })).toBeInTheDocument();
    expect(region).not.toHaveTextContent("كلمة١");
  });

  it("a correct recall answer shows no context and no blank", () => {
    renderInLocale(<AnswerFeedback question={recallQuestion()} result={{ correct: true, assisted: false, expected: {} }} textKind="quran" />);
    expect(screen.queryByRole("img", { name: "the missing word" })).toBeNull();
  });

  it("similar distinction shows the original for either outcome (D31)", () => {
    renderInLocale(<AnswerFeedback question={similarQuestion()} result={{ correct: true, assisted: false, expected: { optionId: "s1" } }} textKind="quran" />);
    expect(screen.getByRole("status")).toHaveTextContent("قبل١ متشابه١ بعد١");
  });

  it("an assisted answer shows the chip and the practice sentence, in either outcome", () => {
    renderInLocale(<AnswerFeedback question={wordChoiceQuestion()} result={{ correct: true, assisted: true, expected: { optionId: "o2" } }} textKind="quran" />);
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("With help");
    expect(region).toHaveTextContent("An answer with help counts as practice, not as independent recall.");
  });

  it("shows the calm lines for a rejected or pending answer and for an updated verdict", () => {
    const base = { correct: true, assisted: false, expected: { optionId: "o2" } };
    const { rerender } = renderInLocale(<AnswerFeedback question={wordChoiceQuestion()} result={{ ...base, status: "rejected" }} textKind="quran" />);
    expect(screen.getByRole("status")).toHaveTextContent("This answer was not counted.");
    rerender(<AnswerFeedback question={wordChoiceQuestion()} result={{ ...base, status: "pending" }} textKind="quran" />);
    expect(screen.getByRole("status")).toHaveTextContent("This answer is still being verified.");
    rerender(<AnswerFeedback question={wordChoiceQuestion()} result={{ ...base, updated: true }} textKind="quran" />);
    expect(screen.getByRole("status")).toHaveTextContent("The result of this question was updated.");
  });

  it("never shows a percentage or a score, in either language", () => {
    for (const language of ["ar", "en"] as const) {
      const { unmount } = renderInLocale(
        <AnswerFeedback question={wordChoiceQuestion()} result={{ correct: false, assisted: true, expected: { optionId: "o2" } }} textKind="quran" />,
        language,
      );
      expect(screen.getByRole("status").textContent).not.toMatch(/[%٪]|\d|score|درجة/u);
      unmount();
    }
  });

  it("does not claim an original it cannot build", () => {
    renderInLocale(<AnswerFeedback question={wordChoiceQuestion()} result={{ correct: false, assisted: false, expected: { optionId: "missing" } }} textKind="quran" />);
    expect(screen.getByRole("status")).toHaveTextContent("This spot needs review. The original:");
    expect(screen.getByRole("status").querySelector("[dir=rtl]")).toBeNull();
  });
});

describe("question source line (P-20)", () => {
  it("joins book, edition and reference with a dot and links the canonical URL in a new tab", () => {
    const { container } = renderInLocale(<QuestionSource source={SOURCE} />);
    expect(container.querySelectorAll("bdi").length).toBeGreaterThanOrEqual(4);
    expect(container).toHaveTextContent("كتاب اصطناعي · نسخة اصطناعية · المرجع ١ · https://example.test/reference/1");
    const link = screen.getByRole("link", { name: "المرجع ١, opens in a new tab" });
    expect(link).toHaveAttribute("href", SOURCE.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("names the link in Arabic", () => {
    renderInLocale(<QuestionSource source={SOURCE} />, "ar");
    expect(screen.getByRole("link", { name: "المرجع ١، يفتح في نافذة جديدة" })).toBeInTheDocument();
  });

  it("adds the printed page for a printed edition", () => {
    renderInLocale(<QuestionSource source={{ ...SOURCE, pages: ["٣٢"] }} />, "ar");
    expect(screen.getByText(/ص ٣٢/)).toBeInTheDocument();
  });

  it("never makes a script link from a value that is not a web address", () => {
    renderInLocale(<QuestionSource source={{ ...SOURCE, url: "javascript:alert(1)" }} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the D50 notice only when asked", () => {
    const { rerender } = renderInLocale(<QuestionSource source={SOURCE} />, "ar");
    expect(screen.queryByText(/تنبيه: نُقل هذا النص حرفيًا/)).toBeNull();
    rerender(<QuestionSource source={SOURCE} showD50Notice />);
    expect(screen.getByText("تنبيه: نُقل هذا النص حرفيًا عن الكتاب، ولم يُتحقق من صحة الحديث.")).toBeInTheDocument();
  });
});
