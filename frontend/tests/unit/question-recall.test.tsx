import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Harness, recallQuestion, renderInLocale } from "./question-support";

describe("word recall (S-18, UI-tokens 6.2)", () => {
  it("is a labelled Arabic input with the keyboard hints switched off", () => {
    renderInLocale(<Harness question={recallQuestion()} />);
    const input = screen.getByLabelText("The missing word");
    expect(input).toHaveAttribute("dir", "rtl");
    expect(input).toHaveAttribute("lang", "ar");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAccessibleDescription("Type the word in Arabic. Vowel marks are not needed.");
    expect(input).toHaveClass("font-quran");
  });

  it("names the label in Arabic", () => {
    renderInLocale(<Harness question={recallQuestion()} />, "ar");
    expect(screen.getByRole("textbox", { name: "الكلمة الناقصة" })).toBeInTheDocument();
    expect(screen.getByText("اكتب الكلمة بالعربية. لا يلزم كتابة الحركات.")).toBeInTheDocument();
  });

  it("emits the typed text as it is typed, and null when it is cleared; no client normalisation", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={recallQuestion()} onAnswerSpy={spy} />);
    const input = screen.getByLabelText("The missing word");
    await user.type(input, "كَلِمة");
    expect(spy).toHaveBeenLastCalledWith({ text: "كَلِمة" });
    expect(input).toHaveValue("كَلِمة");
    await user.clear(input);
    expect(spy).toHaveBeenLastCalledWith(null);
  });

  it("checks on Enter, but not while an IME composition is open", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderInLocale(<Harness question={recallQuestion()} onSubmit={onSubmit} />);
    const input = screen.getByLabelText("The missing word");
    await user.type(input, "كلمة{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);

    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("is read-only when disabled", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={recallQuestion()} disabled onAnswerSpy={spy} />);
    const input = screen.getByLabelText("The missing word");
    expect(input).toHaveAttribute("readonly");
    await user.type(input, "ب");
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the empty and the two-words errors tied to the input", () => {
    const { rerender } = renderInLocale(<Harness question={recallQuestion()} error={{ kind: "empty" }} />);
    expect(screen.getByLabelText("The missing word")).toHaveAccessibleDescription(/Type a word first\./);
    expect(screen.getByLabelText("The missing word")).toHaveAttribute("aria-invalid", "true");
    rerender(<Harness question={recallQuestion()} error={{ kind: "multiple_words" }} />);
    expect(screen.getByLabelText("The missing word")).toHaveAccessibleDescription(/Type one word only\./);
  });

  describe("hint", () => {
    it("shows the first letter once, announces it, leaves the input empty and marks the answer assisted", async () => {
      const user = userEvent.setup();
      const hintSpy = vi.fn();
      const spy = vi.fn();
      renderInLocale(<Harness question={recallQuestion()} hintsEnabled onHintSpy={hintSpy} onAnswerSpy={spy} />);
      const hint = screen.getByRole("button", { name: "Hint" });
      await user.click(hint);
      expect(hintSpy).toHaveBeenCalledWith({ kind: "first_letter", letter: "ك" });
      expect(screen.getByText("ك")).toHaveAttribute("lang", "ar");
      expect(screen.getByText(/First letter: ك/)).toBeInTheDocument(); // the polite announcement
      expect(screen.getByText("With help")).toBeInTheDocument();
      expect(screen.getByLabelText("The missing word")).toHaveValue("");
      expect(spy).not.toHaveBeenCalled();
      expect(hint).toHaveAttribute("aria-disabled", "true");
      await user.click(hint);
      expect(hintSpy).toHaveBeenCalledTimes(1);
    });

    it("is not drawn when hints are off (S-09)", () => {
      renderInLocale(<Harness question={recallQuestion()} />);
      expect(screen.queryByRole("button", { name: "Hint" })).toBeNull();
    });
  });

  describe("after checking", () => {
    it("keeps the typed word in a read-only input when correct, with no repeat in the feedback", () => {
      renderInLocale(<Harness question={recallQuestion()} initialAnswer={{ text: "كلمة١" }} result={{ correct: true, assisted: false, expected: { word: "كلمة١" } }} />);
      expect(screen.getByLabelText("The missing word")).toHaveValue("كلمة١");
      expect(screen.getByLabelText("The missing word")).toHaveAttribute("readonly");
      expect(screen.getAllByRole("status").some((region) => region.textContent?.includes("Correct.") === true)).toBe(true);
    });

    it("shows the original with the expected word in the blank, and never the typed text, when it needs review", () => {
      renderInLocale(<Harness question={recallQuestion()} initialAnswer={{ text: "خطأ١" }} result={{ correct: false, assisted: false, expected: { word: "كلمة١" } }} />);
      const feedback = screen.getAllByRole("status").find((region) => region.textContent?.includes("The original:") === true);
      expect(feedback).toBeDefined();
      expect(feedback).toHaveTextContent("قبل١ كلمة١ بعد١");
      expect(feedback).not.toHaveTextContent("خطأ١");
    });
  });
});
