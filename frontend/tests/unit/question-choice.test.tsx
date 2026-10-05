import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Harness, renderInLocale, similarQuestion, wordChoiceQuestion } from "./question-support";

describe("word choice and similar distinction tiles (UI-tokens 6.16)", () => {
  it("is a radio group with one tab stop, named by the interface language", () => {
    renderInLocale(<Harness question={wordChoiceQuestion()} />);
    const group = screen.getByRole("radiogroup", { name: "Options" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(4);
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    expect(radios[0]).toHaveAttribute("dir", "rtl");
    expect(radios[0]).toHaveAttribute("lang", "ar");
    expect(radios.every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("names the group in Arabic", () => {
    renderInLocale(<Harness question={wordChoiceQuestion()} />, "ar");
    expect(screen.getByRole("radiogroup", { name: "الخيارات" })).toBeInTheDocument();
  });

  it("emits an optionId payload on click, Space and Enter", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={wordChoiceQuestion()} onAnswerSpy={spy} />);
    await user.click(screen.getByRole("radio", { name: "خيار٣" }));
    expect(spy).toHaveBeenLastCalledWith({ optionId: "o3" });
    expect(screen.getByRole("radio", { name: "خيار٣" })).toHaveAttribute("aria-checked", "true");

    screen.getByRole("radio", { name: "خيار١" }).focus();
    await user.keyboard(" ");
    expect(spy).toHaveBeenLastCalledWith({ optionId: "o1" });
    screen.getByRole("radio", { name: "خيار٤" }).focus();
    await user.keyboard("{Enter}");
    expect(spy).toHaveBeenLastCalledWith({ optionId: "o4" });
  });

  it("moves focus with the arrows without selecting, and Home and End jump", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={wordChoiceQuestion()} onAnswerSpy={spy} />);
    const radios = screen.getAllByRole("radio");
    radios[0]?.focus();
    // Left is the next tile: the group is right to left in both interface languages.
    await user.keyboard("{ArrowLeft}");
    expect(radios[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(radios[2]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(radios[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(radios[3]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(radios[0]).toHaveFocus();
    expect(spy).not.toHaveBeenCalled();
    // The tab stop follows the focus (roving tabindex).
    await user.keyboard("{End}");
    expect(radios.filter((radio) => radio.tabIndex === 0)).toEqual([radios[3]]);
  });

  it("announces the pick politely in a word choice", async () => {
    const user = userEvent.setup();
    renderInLocale(<Harness question={wordChoiceQuestion()} />);
    await user.click(screen.getByRole("radio", { name: "خيار٢" }));
    expect(screen.getByText("“خيار٢” selected.")).toBeInTheDocument();
  });

  it("never repeats a similar option in a live region, not even the pick", async () => {
    const user = userEvent.setup();
    const { container } = renderInLocale(<Harness question={similarQuestion()} />);
    await user.click(screen.getByRole("radio", { name: "متشابه٢" }));
    for (const region of container.querySelectorAll('[role="status"]')) expect(region.textContent).not.toContain("متشابه");
  });

  it("stacks segment options and keeps the segment prompt name on the blank", () => {
    renderInLocale(<Harness question={wordChoiceQuestion({ variant: "segment" })} />);
    expect(screen.getByRole("radiogroup")).toHaveStyle({ gridTemplateColumns: "1fr" });
    expect(screen.getByRole("img", { name: "the missing part" })).toBeInTheDocument();
  });

  it("shows the context around a blank named for the missing word", () => {
    renderInLocale(<Harness question={wordChoiceQuestion()} />);
    expect(screen.getByRole("img", { name: "the missing word" })).toBeInTheDocument();
    const block = screen.getByRole("img", { name: "the missing word" }).parentElement;
    expect(block).toHaveAttribute("dir", "rtl");
    expect(block).toHaveAttribute("lang", "ar");
    expect(block).toHaveTextContent("قبل١");
    expect(block).toHaveTextContent("بعد١");
    expect(block).toHaveClass("font-quran");
  });

  it("uses the hadith font for a hadith edition", () => {
    renderInLocale(<Harness question={wordChoiceQuestion()} textKind="hadith" />);
    expect(screen.getByRole("radio", { name: "خيار١" }).querySelector(".font-hadith")).not.toBeNull();
  });

  it("is read-only when disabled: no selection and aria-readonly", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={wordChoiceQuestion()} disabled onAnswerSpy={spy} />);
    await user.click(screen.getByRole("radio", { name: "خيار١" }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("radio", { name: "خيار١" })).toHaveAttribute("aria-disabled", "true");
  });

  it("shows the error line tied to the group", () => {
    renderInLocale(<Harness question={wordChoiceQuestion()} error={{ kind: "empty" }} />);
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAccessibleDescription("Choose an answer first.");
    expect(group).toHaveAttribute("aria-invalid", "true");
  });

  it("takes a screen's own wording for the empty error (S-09)", () => {
    renderInLocale(<Harness question={wordChoiceQuestion()} error={{ kind: "empty", message: "Choose an answer or press Skip." }} />);
    expect(screen.getByRole("radiogroup")).toHaveAccessibleDescription("Choose an answer or press Skip.");
  });

  describe("hint", () => {
    it("removes one wrong option other than the selected one, once", async () => {
      const user = userEvent.setup();
      const hintSpy = vi.fn();
      renderInLocale(<Harness question={wordChoiceQuestion()} hintsEnabled onHintSpy={hintSpy} />);
      await user.click(screen.getByRole("radio", { name: "خيار١" }));
      const hint = screen.getByRole("button", { name: "Hint" });
      await user.click(hint);
      expect(hintSpy).toHaveBeenCalledTimes(1);
      expect(hintSpy).toHaveBeenCalledWith({ kind: "remove_option", optionId: "o3" });
      expect(screen.queryByRole("radio", { name: "خيار٣" })).toBeNull();
      expect(screen.getAllByRole("radio")).toHaveLength(3);
      expect(screen.getByText(/A wrong option was removed/)).toBeInTheDocument();
      expect(screen.getByText("With help")).toBeInTheDocument();
      expect(hint).toHaveAttribute("aria-disabled", "true");
      await user.click(hint);
      expect(hintSpy).toHaveBeenCalledTimes(1);
      expect(screen.getAllByRole("radio")).toHaveLength(3);
    });

    it("keeps the selection when the removed option was another one", async () => {
      const user = userEvent.setup();
      renderInLocale(<Harness question={wordChoiceQuestion()} hintsEnabled />);
      await user.click(screen.getByRole("radio", { name: "خيار٣" }));
      await user.click(screen.getByRole("button", { name: "Hint" }));
      // The selected wrong option is skipped; the first other wrong option goes.
      expect(screen.queryByRole("radio", { name: "خيار١" })).toBeNull();
      expect(screen.getByRole("radio", { name: "خيار٣" })).toHaveAttribute("aria-checked", "true");
    });

    it("in a similar distinction removes the wrong option, warns before the press and does not auto-select", async () => {
      const user = userEvent.setup();
      renderInLocale(<Harness question={similarQuestion()} hintsEnabled />);
      expect(screen.getByRole("button", { name: "Hint" })).toHaveAccessibleDescription(/It removes the wrong option/);
      await user.click(screen.getByRole("button", { name: "Hint" }));
      const radios = screen.getAllByRole("radio");
      expect(radios).toHaveLength(1);
      expect(radios[0]).toHaveTextContent("متشابه١");
      expect(radios[0]).toHaveAttribute("aria-checked", "false");
    });

    it("clears the selection when a similar hint removes the option the learner had picked", async () => {
      const user = userEvent.setup();
      const spy = vi.fn();
      renderInLocale(<Harness question={similarQuestion()} hintsEnabled onAnswerSpy={spy} />);
      await user.click(screen.getByRole("radio", { name: "متشابه٢" }));
      await user.click(screen.getByRole("button", { name: "Hint" }));
      expect(spy).toHaveBeenLastCalledWith(null);
      expect(screen.getAllByRole("radio")).toHaveLength(1);
    });

    it("notes that a hint does not pass a review round", () => {
      renderInLocale(<Harness question={wordChoiceQuestion({ role: "review" })} hintsEnabled />);
      expect(screen.getByRole("button", { name: "Hint" })).toHaveAccessibleDescription("A hint in a review does not pass the round.");
    });

    it("is not drawn when hints are off (S-09)", () => {
      renderInLocale(<Harness question={wordChoiceQuestion()} />);
      expect(screen.queryByRole("button", { name: "Hint" })).toBeNull();
    });

    it("cannot be used once the answer is checked", async () => {
      const user = userEvent.setup();
      const hintSpy = vi.fn();
      renderInLocale(
        <Harness question={wordChoiceQuestion()} hintsEnabled result={{ correct: true, assisted: false, expected: { optionId: "o2" } }} onHintSpy={hintSpy} />,
      );
      const hint = screen.getByRole("button", { name: "Hint" });
      expect(hint).toHaveAttribute("aria-disabled", "true");
      await user.click(hint);
      expect(hintSpy).not.toHaveBeenCalled();
    });
  });

  describe("after checking", () => {
    it("marks the correct tile and the learner's wrong pick with words and glyphs, fills the blank", () => {
      renderInLocale(
        <Harness question={wordChoiceQuestion()} initialAnswer={{ optionId: "o3" }} result={{ correct: false, assisted: false, expected: { optionId: "o2" } }} />,
      );
      expect(screen.getByRole("radio", { name: "خيار٢, the correct one" })).toBeInTheDocument();
      const wrong = screen.getByRole("radio", { name: "خيار٣, your choice, needs review" });
      expect(wrong).toHaveTextContent("Your choice: needs review");
      expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-readonly", "true");
      // The blank now holds the correct option.
      expect(screen.queryByRole("img", { name: "the missing word" })).toBeNull();
    });

    it("labels the wrong option of a similar distinction a memorization error, keeps the learner's border", () => {
      renderInLocale(
        <Harness question={similarQuestion()} initialAnswer={{ optionId: "s2" }} result={{ correct: false, assisted: false, expected: { optionId: "s1" } }} />,
      );
      const wrong = screen.getByRole("radio", { name: "متشابه٢, a memorization error" });
      expect(wrong).toHaveTextContent("A memorization error");
      expect(wrong.className).toContain("border-edge-selected");
      expect(screen.getByRole("radio", { name: "متشابه١, the correct one" })).toBeInTheDocument();
    });

    it("does not state the wrong similar option outside its tile", () => {
      const { container } = renderInLocale(
        <Harness question={similarQuestion()} initialAnswer={{ optionId: "s2" }} result={{ correct: false, assisted: false, expected: { optionId: "s1" } }} />,
      );
      const outside = Array.from(container.querySelectorAll("[role=status], [role=img], p, a")).map((node) => node.textContent ?? "").join(" ");
      expect(outside).not.toContain("متشابه٢");
      // The feedback block reads the original.
      expect(screen.getAllByRole("status").some((region) => region.textContent?.includes("متشابه١") === true)).toBe(true);
    });
  });
});
