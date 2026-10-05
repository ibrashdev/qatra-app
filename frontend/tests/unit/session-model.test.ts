import { describe, expect, it } from "vitest";
import { normalizeArabicWord } from "@/components/session/arabic-norm";
import { gradeLocally } from "@/components/session/local-grade";
import {
  firstIndexFrom,
  freezeDeep,
  isRenderableQuestion,
  lastRenderableIndex,
  needsLegend,
  nextStep,
  passageFacts,
  recallTarget,
  primaryAction,
  questionPosition,
  segmentUnit,
  stageOfStep,
  stagesOf,
  stepLineOf,
  textKindOf,
} from "@/components/session/session-model";
import { MOCK_QURAN_EDITION_ID, mockCatalog } from "@/lib/api/mock/fixtures";
import { MOCK_QUESTION_IDS, MOCK_RECALL_WORD, mockSessionSnapshot } from "@/lib/api/mock/session-handlers";
import type { PassageView, Question, SessionSnapshot, Step } from "@/lib/api/types";

const snapshot = (): SessionSnapshot => mockSessionSnapshot("55555555-5555-4555-8555-000000000001", "plan", 1, MOCK_QURAN_EDITION_ID);

// The synthetic snapshot: review, learn, order, segment, recall, similar, test.
const stepsOf = (): Step[] => snapshot().steps;
const questionAt = (steps: Step[], index: number): Question => {
  const step = steps[index];
  if (step === undefined || step.type !== "question") throw new Error("not a question step");
  return step.question;
};

describe("stages of a session (UI-tokens 6.23)", () => {
  it("maps review questions to review, the learn step and the drills to new, and test questions to test", () => {
    const steps = stepsOf();
    expect(steps.map(stageOfStep)).toEqual(["review", "new", "new", "new", "new", "new", "test"]);
    expect(stagesOf(steps)).toEqual(["review", "new", "test"]);
  });

  it("lists only the stages the snapshot holds", () => {
    const light = stepsOf().filter((step) => step.type === "question" && step.question.role !== "training");
    expect(stagesOf(light)).toEqual(["review", "test"]);
    expect(stagesOf([])).toEqual([]);
  });

  it("lists the stages in the order the session runs them: the new passage, then the reviews, then the end test (D90)", () => {
    const [review, learn, ...rest] = stepsOf();
    const test = rest[rest.length - 1];
    const drills = rest.slice(0, -1);
    if (review === undefined || learn === undefined || test === undefined) throw new Error("fixture changed");
    const d90 = [learn, ...drills, review, test];
    expect(d90.map(stageOfStep)).toEqual(["new", "new", "new", "new", "new", "review", "test"]);
    expect(stagesOf(d90)).toEqual(["new", "review", "test"]);
    // a session without reviews and one without a new passage still list what they hold
    expect(stagesOf([learn, ...drills, test])).toEqual(["new", "test"]);
    expect(stagesOf([review, learn, ...drills, test])).toEqual(["review", "new", "test"]);
  });
});

describe("the step machine", () => {
  it("moves from step to step and ends after the last one", () => {
    const steps = stepsOf();
    expect(firstIndexFrom(steps, 0)).toBe(0);
    expect(nextStep(steps, 0)).toEqual({ index: 1, skipped: 0 });
    expect(nextStep(steps, 5)).toEqual({ index: 6, skipped: 0 });
    expect(nextStep(steps, 6)).toEqual({ index: null, skipped: 0 });
    expect(lastRenderableIndex(steps)).toBe(6);
  });

  it("skips a question that cannot be drawn and counts it, with no event for it (S-19 'Question not valid')", () => {
    const steps = stepsOf();
    const broken: Step = { type: "question", question: { ...questionAt(steps, 3), options: [] } as Question };
    const withBroken = [...steps.slice(0, 3), broken, ...steps.slice(4)];
    expect(isRenderableQuestion(broken.type === "question" ? broken.question : questionAt(steps, 3))).toBe(false);
    expect(nextStep(withBroken, 2)).toEqual({ index: 4, skipped: 1 });
    expect(questionPosition(withBroken, 4)).toEqual({ k: 3, n: 5 });
    const lastBroken = [...steps.slice(0, 6), { type: "question", question: { ...questionAt(steps, 6), options: [] } } as Step];
    expect(lastRenderableIndex(lastBroken)).toBe(5);
    expect(nextStep(lastBroken, 5)).toEqual({ index: null, skipped: 1 });
  });

  it("names the one action of the bar: practice, check, next, and finish on the last question", () => {
    const steps = stepsOf();
    expect(primaryAction(steps, 1, false)).toBe("start_practice");
    expect(primaryAction(steps, 0, false)).toBe("check");
    expect(primaryAction(steps, 0, true)).toBe("next");
    expect(primaryAction(steps, 6, false)).toBe("check");
    expect(primaryAction(steps, 6, true)).toBe("finish");
  });

  it("finishes from a learn step that has no question after it", () => {
    expect(primaryAction(stepsOf().slice(0, 2), 1, false)).toBe("finish");
  });

  it("counts question k of n over the question steps only", () => {
    const steps = stepsOf();
    expect(questionPosition(steps, 0)).toEqual({ k: 1, n: 6 });
    expect(questionPosition(steps, 2)).toEqual({ k: 2, n: 6 });
    expect(questionPosition(steps, 6)).toEqual({ k: 6, n: 6 });
    expect(questionPosition(steps, 1)).toEqual({ k: 0, n: 6 });
  });
});

describe("the step line (c6)", () => {
  it("says how the session starts, and that a reload starts again", () => {
    const steps = stepsOf();
    expect(stepLineOf(steps, false)).toBe("review");
    expect(stepLineOf(steps, true)).toBe("restart");
    const light = steps.filter((step) => step.type !== "learn");
    expect(stepLineOf(light, false)).toBe("light");
    expect(stepLineOf(steps.slice(1), false)).toBeNull();
  });
});

describe("the font of the book text", () => {
  it("takes the edition format from the catalog, then the learn path, then quran", () => {
    const current = snapshot();
    expect(textKindOf(current, mockCatalog.editions)).toBe("quran");
    const hadithEdition = mockCatalog.editions.find((edition) => edition.contentFormat === "hadith_collection");
    if (hadithEdition === undefined) throw new Error("the fixture has no hadith edition");
    expect(textKindOf({ ...current, editionId: hadithEdition.editionId }, mockCatalog.editions)).toBe("hadith");

    const learn = current.steps.find((step): step is Extract<Step, { type: "learn" }> => step.type === "learn");
    if (learn === undefined) throw new Error("no learn step");
    const matn: SessionSnapshot = { ...current, editionId: "unknown", steps: [{ type: "learn", passage: { ...learn.passage, path: "matn" } }] };
    expect(textKindOf(matn, null)).toBe("hadith");
    expect(textKindOf({ ...current, editionId: "unknown", steps: [] }, null)).toBe("quran");
  });

  it("remembers per passage what only a learn step says (path, D50 notice)", () => {
    const facts = passageFacts(stepsOf());
    expect([...facts.values()]).toEqual([{ path: "quran", showD50Notice: false }]);
  });
});

describe("the passage highlight (UI-tokens 6.24)", () => {
  const passage = (): PassageView => {
    const learn = stepsOf().find((step): step is Extract<Step, { type: "learn" }> => step.type === "learn");
    if (learn === undefined) throw new Error("no learn step");
    return learn.passage;
  };

  it("marks the tokens inside the range, both ends included, and keeps the text as received", () => {
    const { units, highlight } = passage();
    const first = units[0];
    const second = units[1];
    if (first === undefined || second === undefined) throw new Error("two units expected");
    const one = segmentUnit(first, highlight);
    expect(one.map((segment) => segment.text).join("")).toBe(first.text);
    expect(one).toEqual([
      { text: "كلمة١ ", marked: false },
      { text: "كلمة٢ كلمة٣ كلمة٤", marked: true },
    ]);
    const two = segmentUnit(second, highlight);
    expect(two).toEqual([
      { text: "كلمة٥ كلمة٦", marked: true },
      { text: " كلمة٧ كلمة٨", marked: false },
    ]);
    expect(needsLegend([one, two])).toBe(true);
  });

  it("shows no legend when the whole text is the passage, and none when nothing is marked", () => {
    const unit = { unitRef: 3, kind: "ayah" as const, reference: "3:1", text: "كلمة١ كلمة٢" };
    const whole = segmentUnit(unit, { startRef: "3:0", endRef: "3:1" });
    expect(whole).toEqual([{ text: "كلمة١ كلمة٢", marked: true }]);
    expect(needsLegend([whole])).toBe(false);
    const none = segmentUnit(unit, { startRef: "9:0", endRef: "9:1" });
    expect(needsLegend([none])).toBe(false);
  });
});

describe("the snapshot is immutable", () => {
  it("is frozen all the way down, so no screen code can change it", () => {
    const frozen = freezeDeep(snapshot());
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.steps)).toBe(true);
    const step = frozen.steps[0];
    if (step === undefined || step.type !== "question") throw new Error("a question step expected");
    expect(Object.isFrozen(step.question)).toBe(true);
    expect(() => {
      (step.question as { questionId: string }).questionId = "changed";
    }).toThrow(TypeError);
  });
});

describe("policy arabic-norm-v1 (contract 2.5)", () => {
  it("drops marks, folds the letters and trims", () => {
    expect(normalizeArabicWord("  ٱلْعَالَمِينَ ")).toBe("العالمين");
    expect(normalizeArabicWord("إِيمَـانٌ")).toBe("ايمان");
    expect(normalizeArabicWord("رَحْمَةٌ")).toBe("رحمه");
    expect(normalizeArabicWord("مُؤْمِن")).toBe("مومن");
    expect(normalizeArabicWord("«هُدًى»")).toBe("هدي");
    expect(normalizeArabicWord("Word")).toBe("word");
  });
});

describe("the first verdict from the answer key (the server's answer replaces it)", () => {
  const steps = stepsOf();

  it("grades word order, choice and similar distinction, and marks a hint as assisted", () => {
    const order = questionAt(steps, 2);
    expect(gradeLocally(order, { order: ["1:1", "1:2", "1:3"] }, false)).toEqual({ correct: true, assisted: false, expected: { order: ["1:1", "1:2", "1:3"] } });
    expect(gradeLocally(order, { order: ["1:2", "1:1", "1:3"] }, true).correct).toBe(false);
    const choice = questionAt(steps, 3);
    expect(gradeLocally(choice, { optionId: "seg-a" }, true)).toEqual({ correct: true, assisted: true, expected: { optionId: "seg-a" } });
    expect(gradeLocally(choice, { optionId: "seg-b" }, false).correct).toBe(false);
    const similar = questionAt(steps, 5);
    expect(gradeLocally(similar, { optionId: "sim-b" }, false).correct).toBe(false);
  });

  it("grades a recall answer by its normal form and leaves the original word to the server", () => {
    const recall = questionAt(steps, 4);
    const ok = gradeLocally(recall, { text: ` ${MOCK_RECALL_WORD}ٌ ` }, false);
    expect(ok.correct).toBe(true);
    expect(ok.expected).toEqual({});
    expect(gradeLocally(recall, { text: "خطأ" }, false).correct).toBe(false);
    expect(gradeLocally(recall, { text: "" }, false).correct).toBe(false);
    expect(recall.questionId).toBe(MOCK_QUESTION_IDS.recall);
  });
});

describe("the target of a recall question, read from the learn passage", () => {
  it("finds the word between the context words by their refs, and stays null where the passage does not hold it", () => {
    const steps = stepsOf();
    const recall = questionAt(steps, 4);
    expect(recallTarget(steps, recall)).toBe(MOCK_RECALL_WORD);
    expect(recallTarget(steps.filter((step) => step.type !== "learn"), recall)).toBeNull();
    expect(recallTarget(steps, questionAt(steps, 3))).toBeNull();
    const fromAfter = { ...recall, context: { before: [], after: [{ ref: "2:2", text: "كلمة٧" }] } } as Question;
    expect(recallTarget(steps, fromAfter)).toBe(MOCK_RECALL_WORD);
    const elsewhere = { ...recall, context: { before: [{ ref: "9:0", text: "x" }], after: [] } } as Question;
    expect(recallTarget(steps, elsewhere)).toBeNull();
  });
});