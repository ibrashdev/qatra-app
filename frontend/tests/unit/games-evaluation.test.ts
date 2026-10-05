import { describe, expect, it } from "vitest";
import { SUPPORTED_NORMALIZATION_POLICY, evaluateProvisionalAnswer } from "@/lib/games/evaluation";
import { choiceQuestion, orderQuestion, recallQuestion } from "./offline-support";

const POLICY = SUPPORTED_NORMALIZATION_POLICY;

describe("evaluateProvisionalAnswer (PWA-design 4: local, provisional, never authoritative)", () => {
  it("grades a word choice and a similar-distinction question from the answer key", () => {
    const question = choiceQuestion("q1", "p1");
    expect(evaluateProvisionalAnswer(question, { optionId: "q1-a" }, POLICY)).toEqual({ available: true, provisional: true, correct: true, assisted: false, expected: { optionId: "q1-a" } });
    expect(evaluateProvisionalAnswer(question, { optionId: "q1-b" }, POLICY)).toMatchObject({ available: true, correct: false });
    const similar = { ...question, type: "similar_distinction" as const };
    expect(evaluateProvisionalAnswer(similar as never, { optionId: "q1-a" }, POLICY)).toMatchObject({ correct: true });
  });

  it("grades a word order by the whole order", () => {
    const question = orderQuestion("q2", "p1");
    expect(evaluateProvisionalAnswer(question, { order: ["1:0", "1:1"] }, POLICY)).toMatchObject({ correct: true, expected: { order: ["1:0", "1:1"] } });
    expect(evaluateProvisionalAnswer(question, { order: ["1:1", "1:0"] }, POLICY)).toMatchObject({ correct: false });
    expect(evaluateProvisionalAnswer(question, { order: ["1:0"] }, POLICY)).toMatchObject({ correct: false });
  });

  it("grades a recall answer after normalisation, and gives no original word (the key holds only normalised forms)", () => {
    const question = recallQuestion("q3", "p1");
    expect(evaluateProvisionalAnswer(question, { text: "alpha" }, POLICY)).toMatchObject({ correct: true, expected: {} });
    expect(evaluateProvisionalAnswer(question, { text: "" }, POLICY)).toMatchObject({ correct: false });
    expect(evaluateProvisionalAnswer(question, { text: "beta" }, POLICY)).toMatchObject({ correct: false });
  });

  it("marks a hinted answer as assisted", () => {
    const question = choiceQuestion("q1", "p1");
    expect(evaluateProvisionalAnswer(question, { optionId: "q1-a" }, POLICY, { hintUsed: true })).toMatchObject({ correct: true, assisted: true });
  });

  it("a missing policy is «feedback unavailable», not a guess", () => {
    const question = choiceQuestion("q1", "p1");
    for (const policy of [undefined, null, ""]) {
      expect(evaluateProvisionalAnswer(question, { optionId: "q1-a" }, policy)).toEqual({ available: false, provisional: true, reason: "policy_missing" });
    }
  });

  it("an unsupported policy, on the snapshot or on the question, is feedback unavailable too", () => {
    const question = choiceQuestion("q1", "p1");
    expect(evaluateProvisionalAnswer(question, { optionId: "q1-a" }, "arabic-norm-v2")).toEqual({ available: false, provisional: true, reason: "policy_unsupported" });
    const odd = { ...question, policy: { ...question.policy, normalizationPolicyVersion: "arabic-norm-v2" } } as never;
    expect(evaluateProvisionalAnswer(odd, { optionId: "q1-a" }, POLICY)).toMatchObject({ available: false, reason: "policy_unsupported" });
  });

  it("always says it is provisional", () => {
    const question = choiceQuestion("q1", "p1");
    expect(evaluateProvisionalAnswer(question, { optionId: "q1-a" }, POLICY).provisional).toBe(true);
    expect(evaluateProvisionalAnswer(question, { optionId: "q1-a" }, null).provisional).toBe(true);
  });
});
