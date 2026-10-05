import { screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import {
  errorMessage,
  expectedOriginal,
  finalizeAnswer,
  placeFirst,
  questionPrompt,
  resolveHint,
  showsOriginal,
  validateAnswer,
} from "@/components/questions/question-logic";
import type { QuestionViewHandle } from "@/components/questions/types";
import { questionMessages } from "@/i18n/question-messages";
import { Harness, recallQuestion, renderInLocale, similarQuestion, wordChoiceQuestion, wordOrderQuestion } from "./question-support";

describe("QuestionView dispatcher", () => {
  it("renders the piece of each question type", () => {
    const view = renderInLocale(<Harness question={wordOrderQuestion()} />);
    expect(screen.getByRole("group", { name: "Available words" })).toBeInTheDocument();
    view.unmount();
    const choice = renderInLocale(<Harness question={wordChoiceQuestion()} />);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    choice.unmount();
    const similar = renderInLocale(<Harness question={similarQuestion()} />);
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    similar.unmount();
    renderInLocale(<Harness question={recallQuestion()} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("always shows the source line, with the D50 notice on request", () => {
    renderInLocale(<Harness question={wordChoiceQuestion()} showD50Notice />, "ar");
    expect(screen.getByText(/كتاب اصطناعي/)).toBeInTheDocument();
    expect(screen.getByText(/تنبيه: نُقل هذا النص حرفيًا/)).toBeInTheDocument();
  });

  describe("modes for S-09 (no hint, no feedback) and S-19 (both)", () => {
    const result = { correct: false, assisted: false, expected: { optionId: "o2" } };

    it("with showFeedback off draws nothing of the result, neither the block nor the tile marks", () => {
      renderInLocale(<Harness question={wordChoiceQuestion()} initialAnswer={{ optionId: "o3" }} result={result} showFeedback={false} />);
      expect(screen.queryByText("This spot needs review. The original:")).toBeNull();
      expect(screen.getAllByRole("status").every((region) => region.textContent === "")).toBe(true);
      expect(screen.queryByText(/Your choice/)).toBeNull();
      expect(screen.getByRole("radiogroup")).not.toHaveAttribute("aria-readonly");
      expect(screen.queryByRole("button", { name: "Hint" })).toBeNull();
    });

    it("with feedback on shows the block and makes the pieces read-only", () => {
      renderInLocale(<Harness question={wordChoiceQuestion()} initialAnswer={{ optionId: "o3" }} result={result} hintsEnabled />);
      expect(screen.getByText("This spot needs review. The original:")).toBeInTheDocument();
      expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-readonly", "true");
      expect(screen.getByRole("button", { name: "Hint" })).toHaveAttribute("aria-disabled", "true");
    });

    it("disabled alone makes the piece read-only without any feedback", () => {
      renderInLocale(<Harness question={wordChoiceQuestion()} disabled />);
      expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-readonly", "true");
    });
  });

  it("exposes focusAnswer to move focus to the first control that needs an answer", () => {
    const ref = createRef<QuestionViewHandle>();
    renderInLocale(<Harness question={wordChoiceQuestion()} ref={ref} />);
    ref.current?.focusAnswer();
    expect(screen.getAllByRole("radio")[0]).toHaveFocus();
  });

  it("focusAnswer reaches the recall input and the first unused chip", () => {
    const recall = createRef<QuestionViewHandle>();
    const view = renderInLocale(<Harness question={recallQuestion()} ref={recall} />);
    recall.current?.focusAnswer();
    expect(screen.getByRole("textbox")).toHaveFocus();
    view.unmount();
    const order = createRef<QuestionViewHandle>();
    renderInLocale(<Harness question={wordOrderQuestion()} ref={order} />);
    order.current?.focusAnswer();
    expect(screen.getByRole("button", { name: "كلمة٢" })).toHaveFocus();
  });

  it("renders in both interface languages with the original text right to left", () => {
    for (const language of ["ar", "en"] as const) {
      const { container, unmount } = renderInLocale(<Harness question={wordChoiceQuestion()} />, language);
      expect(container.querySelector('[dir="rtl"][lang="ar"]')).not.toBeNull();
      expect(document.documentElement.lang).toBe(language);
      unmount();
    }
  });
});

describe("question rules", () => {
  const messages = questionMessages("en");

  it("validates what is complete: order, choice, recall", () => {
    expect(validateAnswer(wordOrderQuestion(), { order: ["2:0"] })).toEqual({ kind: "incomplete" });
    expect(validateAnswer(wordOrderQuestion(), { order: ["2:0", "2:1", "2:2"] })).toBeNull();
    expect(validateAnswer(wordChoiceQuestion(), null)).toEqual({ kind: "empty" });
    expect(validateAnswer(similarQuestion(), { optionId: "s1" })).toBeNull();
    expect(validateAnswer(recallQuestion(), { text: "   " })).toEqual({ kind: "empty" });
    expect(validateAnswer(recallQuestion(), { text: "كلمة وكلمة" })).toEqual({ kind: "multiple_words" });
    expect(validateAnswer(recallQuestion(), { text: " كلمة " })).toBeNull();
  });

  it("trims the outer spaces of a recall answer and sends nothing when invalid", () => {
    expect(finalizeAnswer(recallQuestion(), { text: "  كلمة  " })).toEqual({ text: "كلمة" });
    expect(finalizeAnswer(recallQuestion(), { text: "a b" })).toBeNull();
    expect(finalizeAnswer(wordChoiceQuestion(), { optionId: "o1" })).toEqual({ optionId: "o1" });
  });

  it("picks the error copy by question type and honours an override", () => {
    expect(errorMessage(wordChoiceQuestion(), { kind: "empty" }, messages)).toBe("Choose an answer first.");
    expect(errorMessage(recallQuestion(), { kind: "empty" }, messages)).toBe("Type a word first.");
    expect(errorMessage(recallQuestion(), { kind: "multiple_words" }, messages)).toBe("Type one word only.");
    expect(errorMessage(wordOrderQuestion(), { kind: "incomplete" }, messages)).toBe("Place all the words first.");
    expect(errorMessage(wordChoiceQuestion(), { kind: "empty", message: "x" }, messages)).toBe("x");
  });

  it("resolves the fixed hint of each game (contract 2.4)", () => {
    expect(resolveHint(recallQuestion(), null)).toEqual({ kind: "first_letter", letter: "ك" });
    expect(resolveHint(wordOrderQuestion(), null)).toEqual({ kind: "place_first", ref: "2:0" });
    expect(resolveHint(wordChoiceQuestion(), null)).toEqual({ kind: "remove_option", optionId: "o1" });
    expect(resolveHint(wordChoiceQuestion(), { optionId: "o1" })).toEqual({ kind: "remove_option", optionId: "o3" });
    // Never the correct option, even when the only wrong one is selected.
    expect(resolveHint(similarQuestion(), { optionId: "s2" })).toEqual({ kind: "remove_option", optionId: "s2" });
    expect(resolveHint(recallQuestion({ hintFirstLetter: "" }), null)).toBeNull();
  });

  it("moves the hinted token to position 1 without losing the rest", () => {
    expect(placeFirst(["2:2", "2:0"], "2:0")).toEqual(["2:0", "2:2"]);
    expect(placeFirst([], "2:0")).toEqual(["2:0"]);
  });

  it("words the prompt per game, placement and grade path", () => {
    expect(questionPrompt(wordOrderQuestion(), messages)).toBe("Put the words in the order they appear in the text.");
    expect(questionPrompt(wordChoiceQuestion(), messages)).toBe("Choose the missing word.");
    expect(questionPrompt(wordChoiceQuestion({ variant: "segment" }), messages)).toBe("Choose what comes next.");
    expect(questionPrompt(wordChoiceQuestion(), messages, { gradePath: true })).toMatch(/grade/);
    expect(questionPrompt(wordChoiceQuestion(), messages, { placement: true })).toBe("Choose the word that completes the phrase.");
    expect(questionPrompt(recallQuestion(), messages)).toBe("Type the missing word.");
    expect(questionPrompt(similarQuestion(), messages)).toBe("Choose the correct one as it appears in the book.");
  });

  it("builds the original only from the question and the expected value", () => {
    expect(expectedOriginal(wordOrderQuestion(), { expected: { order: ["2:0", "2:1", "2:2"] } })).toBe("كلمة١ كلمة٢ كلمة٣");
    expect(expectedOriginal(wordOrderQuestion(), { expected: { order: ["9:9"] } })).toBeNull();
    expect(expectedOriginal(wordOrderQuestion(), { expected: {} })).toBeNull();
    expect(expectedOriginal(wordChoiceQuestion(), { expected: { optionId: "o2" } })).toBe("قبل١ خيار٢ بعد١");
    expect(expectedOriginal(recallQuestion(), { expected: { word: "كلمة١" } })).toBe("قبل١ كلمة١ بعد١");
    expect(expectedOriginal(recallQuestion(), { expected: { word: "" } })).toBeNull();
  });

  it("shows the original for a similar distinction in both outcomes and for the rest only when review is needed", () => {
    const right = { correct: true, assisted: false, expected: {} };
    const wrong = { correct: false, assisted: false, expected: {} };
    expect(showsOriginal(similarQuestion(), right)).toBe(true);
    expect(showsOriginal(wordChoiceQuestion(), right)).toBe(false);
    expect(showsOriginal(wordChoiceQuestion(), wrong)).toBe(true);
  });
});
