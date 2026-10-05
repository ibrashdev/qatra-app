import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Harness, renderInLocale, wordOrderQuestion } from "./question-support";

function pool() {
  return within(screen.getByRole("group", { name: "Available words" }));
}
function line() {
  return within(screen.getByRole("group", { name: "Your order" }));
}

describe("word order (S-15, UI-tokens 6.16)", () => {
  it("shows the helper, the context on both sides and a pool of all tokens in snapshot order", () => {
    renderInLocale(<Harness question={wordOrderQuestion()} />);
    expect(screen.getByText("Tap a word to place it; tap it in the answer line to remove it.")).toBeInTheDocument();
    expect(screen.getByText("قبل١")).toBeInTheDocument();
    expect(screen.getByText("بعد١")).toBeInTheDocument();
    expect(pool().getAllByRole("button").map((button) => button.textContent)).toEqual(["كلمة٢", "كلمة١", "كلمة٣"]);
    expect(line().queryAllByRole("button")).toHaveLength(0);
  });

  it("places on tap, emits the ordered refs, and marks the pool chip used with its slot kept", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={wordOrderQuestion()} onAnswerSpy={spy} />);
    await user.click(pool().getByRole("button", { name: "كلمة١" }));
    expect(spy).toHaveBeenLastCalledWith({ order: ["2:0"] });
    await user.click(pool().getByRole("button", { name: "كلمة٣" }));
    expect(spy).toHaveBeenLastCalledWith({ order: ["2:0", "2:2"] });
    const used = pool().getByRole("button", { name: "كلمة١, used" });
    expect(used).toHaveAttribute("aria-disabled", "true");
    expect(pool().getAllByRole("button")).toHaveLength(3);
    expect(line().getByRole("button", { name: "كلمة١, position 1 of 3, press to remove" })).toBeInTheDocument();
    expect(line().getByRole("button", { name: "كلمة٣, position 2 of 3, press to remove" })).toBeInTheDocument();
    // Pressing a used chip again adds nothing.
    await user.click(used);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("announces a placement and moves focus to the next unused pool chip", async () => {
    const user = userEvent.setup();
    renderInLocale(<Harness question={wordOrderQuestion()} />);
    await user.click(pool().getByRole("button", { name: "كلمة٢" }));
    expect(screen.getByText("“كلمة٢” placed in position 1.")).toBeInTheDocument();
    expect(pool().getByRole("button", { name: "كلمة١" })).toHaveFocus();
  });

  it("removes a placed chip on tap, Delete and Backspace and returns it to the pool", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={wordOrderQuestion()} initialAnswer={{ order: ["2:0", "2:1", "2:2"] }} onAnswerSpy={spy} />);
    await user.click(line().getByRole("button", { name: /كلمة٢, position 2/ }));
    expect(spy).toHaveBeenLastCalledWith({ order: ["2:0", "2:2"] });
    expect(screen.getByText("“كلمة٢” removed.")).toBeInTheDocument();
    // Focus lands on the chip now in that slot.
    expect(line().getByRole("button", { name: /كلمة٣, position 2/ })).toHaveFocus();
    await user.keyboard("{Delete}");
    expect(spy).toHaveBeenLastCalledWith({ order: ["2:0"] });
    await user.keyboard("{Backspace}");
    expect(spy).toHaveBeenLastCalledWith({ order: [] });
    expect(pool().getByRole("button", { name: "كلمة٢" })).not.toHaveAttribute("aria-disabled");
  });

  it("undoes the last chip and disables undo when nothing is left", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={wordOrderQuestion()} initialAnswer={{ order: ["2:0", "2:1"] }} onAnswerSpy={spy} />);
    const undo = screen.getByRole("button", { name: "Undo" });
    await user.click(undo);
    expect(spy).toHaveBeenLastCalledWith({ order: ["2:0"] });
    await user.click(undo);
    expect(spy).toHaveBeenLastCalledWith({ order: [] });
    expect(undo).toHaveAttribute("aria-disabled", "true");
    await user.click(undo);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps the answer line and the pool each as one tab stop; arrows move, used chips are skipped", async () => {
    const user = userEvent.setup();
    renderInLocale(<Harness question={wordOrderQuestion()} initialAnswer={{ order: ["2:1"] }} />);
    const chips = pool().getAllByRole("button");
    expect(chips.filter((chip) => chip.tabIndex === 0)).toHaveLength(1);
    // The first chip is used (kept in place, not reachable); the tab stop is the first unused one.
    expect(chips[0]).toHaveAttribute("tabindex", "-1");
    expect(chips[1]).toHaveAttribute("tabindex", "0");
    chips[1]?.focus();
    await user.keyboard("{ArrowLeft}");
    expect(chips[2]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(chips[1]).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(chips[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(chips[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(chips[2]).toHaveFocus();
  });

  it("places and removes with Enter and Space", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={wordOrderQuestion()} onAnswerSpy={spy} />);
    pool().getByRole("button", { name: "كلمة٢" }).focus();
    await user.keyboard("{Enter}");
    expect(spy).toHaveBeenLastCalledWith({ order: ["2:1"] });
    line().getByRole("button", { name: /كلمة٢/ }).focus();
    await user.keyboard(" ");
    expect(spy).toHaveBeenLastCalledWith({ order: [] });
  });

  it("calls onAllPlaced once when the last pool token is placed, and not for earlier ones, removals or the hint", async () => {
    const user = userEvent.setup();
    const onAllPlaced = vi.fn();
    renderInLocale(<Harness question={wordOrderQuestion()} hintsEnabled onAllPlaced={onAllPlaced} />);
    await user.click(pool().getByRole("button", { name: "كلمة٢" }));
    await user.click(pool().getByRole("button", { name: "كلمة١" }));
    expect(onAllPlaced).not.toHaveBeenCalled();
    await user.click(pool().getByRole("button", { name: "كلمة٣" }));
    expect(onAllPlaced).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAllPlaced).toHaveBeenCalledTimes(1);
  });

  it("does not call onAllPlaced when the hint completes the line or when disabled", async () => {
    const user = userEvent.setup();
    const onAllPlaced = vi.fn();
    const view = renderInLocale(<Harness question={wordOrderQuestion()} hintsEnabled initialAnswer={{ order: ["2:1", "2:2"] }} onAllPlaced={onAllPlaced} />);
    await user.click(screen.getByRole("button", { name: "Hint" }));
    expect(onAllPlaced).not.toHaveBeenCalled();
    view.unmount();
    renderInLocale(<Harness question={wordOrderQuestion()} disabled initialAnswer={{ order: ["2:1", "2:2"] }} onAllPlaced={onAllPlaced} />);
    await user.click(pool().getByRole("button", { name: "كلمة١" }));
    expect(onAllPlaced).not.toHaveBeenCalled();
  });

  it("does not drag: chips are plain buttons without a draggable attribute", () => {
    renderInLocale(<Harness question={wordOrderQuestion()} />);
    for (const chip of pool().getAllByRole("button")) expect(chip).not.toHaveAttribute("draggable");
  });

  it("is inert when disabled", async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    renderInLocale(<Harness question={wordOrderQuestion()} disabled initialAnswer={{ order: ["2:0"] }} onAnswerSpy={spy} />);
    await user.click(pool().getByRole("button", { name: "كلمة٢" }));
    await user.click(line().getByRole("button", { name: /كلمة١/ }));
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the error line on the answer line and marks the first unused chip as the focus target", () => {
    renderInLocale(<Harness question={wordOrderQuestion()} error={{ kind: "incomplete" }} initialAnswer={{ order: ["2:1"] }} />);
    expect(screen.getByRole("group", { name: "Your order" })).toHaveAccessibleDescription("Place all the words first.");
    expect(document.querySelectorAll("[data-answer-target]")).toHaveLength(1);
    expect(document.querySelector("[data-answer-target]")).toHaveTextContent("كلمة١");
  });

  describe("hint", () => {
    it("places the first token at position 1, locked, once; chips already placed stay after it", async () => {
      const user = userEvent.setup();
      const spy = vi.fn();
      const hintSpy = vi.fn();
      renderInLocale(<Harness question={wordOrderQuestion()} hintsEnabled initialAnswer={{ order: ["2:2", "2:0"] }} onAnswerSpy={spy} onHintSpy={hintSpy} />);
      const hint = screen.getByRole("button", { name: "Hint" });
      await user.click(hint);
      expect(hintSpy).toHaveBeenCalledWith({ kind: "place_first", ref: "2:0" });
      // The hinted token moved up from position 2 to position 1; the other chip follows.
      expect(spy).toHaveBeenLastCalledWith({ order: ["2:0", "2:2"] });
      const locked = line().getByRole("button", { name: "كلمة١, position 1, placed by hint" });
      expect(locked).toHaveAttribute("aria-disabled", "true");
      expect(screen.getByText(/The first word was placed in its position\./)).toBeInTheDocument();
      expect(screen.getByText("With help")).toBeInTheDocument();
      await user.click(hint);
      expect(hintSpy).toHaveBeenCalledTimes(1);
      // The locked chip cannot be removed, by tap, Delete or undo.
      await user.click(locked);
      locked.focus();
      await user.keyboard("{Delete}");
      expect(spy).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(spy).toHaveBeenLastCalledWith({ order: ["2:0"] });
      expect(screen.getByRole("button", { name: "Undo" })).toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("after checking", () => {
    it("is read-only and marks each placed chip in place or not in place with a glyph and words", () => {
      renderInLocale(
        <Harness
          question={wordOrderQuestion()}
          initialAnswer={{ order: ["2:0", "2:2", "2:1"] }}
          result={{ correct: false, assisted: false, expected: { order: ["2:0", "2:1", "2:2"] } }}
        />,
      );
      expect(line().getByRole("button", { name: "كلمة١, position 1 of 3, in place" })).toHaveAttribute("aria-disabled", "true");
      expect(line().getByRole("button", { name: "كلمة٣, position 2 of 3, not in place" })).toBeInTheDocument();
      expect(line().getByRole("button", { name: "كلمة٢, position 3 of 3, not in place" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Undo" })).toHaveAttribute("aria-disabled", "true");
    });

    it("treats a correct verdict without an expected order as all in place", () => {
      renderInLocale(
        <Harness question={wordOrderQuestion()} initialAnswer={{ order: ["2:0", "2:1", "2:2"] }} result={{ correct: true, assisted: false, expected: {} }} />,
      );
      expect(line().getAllByRole("button").every((chip) => chip.getAttribute("aria-label")?.endsWith("in place") === true)).toBe(true);
    });
  });

  it("names the groups in Arabic and keeps the original text right to left", () => {
    renderInLocale(<Harness question={wordOrderQuestion()} />, "ar");
    const group = screen.getByRole("group", { name: "الكلمات المتاحة" });
    expect(group).toHaveAttribute("dir", "rtl");
    expect(group).toHaveAttribute("lang", "ar");
    expect(screen.getByText("اضغط كلمة لوضعها، واضغطها في سطر الإجابة لإزالتها.")).toBeInTheDocument();
  });
});
