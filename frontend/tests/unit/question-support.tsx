import { render } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { QuestionView, type QuestionViewProps } from "@/components/questions/QuestionView";
import type { HintEffect } from "@/components/questions/types";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LOCALE_STORAGE_KEY } from "@/i18n/locale";
import { resetLocaleStoreForTests } from "@/i18n/locale-store";
import type { AnswerPayload, RecallQuestion, SimilarQuestion, SourceRef, WordChoiceQuestion, WordOrderQuestion } from "@/lib/api/types";

// Synthetic only: the words are placeholders (UI-screens P-20), never a verse or a hadith.
export const SOURCE: SourceRef = {
  publisher: "ناشر اصطناعي",
  editionLabel: "نسخة اصطناعية",
  bookTitleAr: "كتاب اصطناعي",
  reference: "المرجع ١",
  url: "https://example.test/reference/1",
  pages: [],
};

const BASE = {
  passageId: "passage-1",
  role: "training" as const,
  reviewRoundId: null,
  context: { before: [{ ref: "1:0", text: "قبل١" }], after: [{ ref: "1:9", text: "بعد١" }] },
  policy: { normalizationPolicyVersion: "arabic-norm-v1" as const, scoringPolicyVersion: "v1" as const },
  source: SOURCE,
};

export function wordOrderQuestion(overrides: Partial<WordOrderQuestion> = {}): WordOrderQuestion {
  return {
    ...BASE,
    questionId: "q-order",
    type: "word_order",
    tokens: [
      { ref: "2:1", text: "كلمة٢" },
      { ref: "2:0", text: "كلمة١" },
      { ref: "2:2", text: "كلمة٣" },
    ],
    answerKey: { order: ["2:0", "2:1", "2:2"] },
    ...overrides,
  };
}

export function wordChoiceQuestion(overrides: Partial<WordChoiceQuestion> = {}): WordChoiceQuestion {
  return {
    ...BASE,
    questionId: "q-choice",
    type: "word_choice",
    variant: "word",
    options: [
      { optionId: "o1", text: "خيار١" },
      { optionId: "o2", text: "خيار٢" },
      { optionId: "o3", text: "خيار٣" },
      { optionId: "o4", text: "خيار٤" },
    ],
    answerKey: { optionId: "o2" },
    ...overrides,
  };
}

export function similarQuestion(overrides: Partial<SimilarQuestion> = {}): SimilarQuestion {
  return {
    ...BASE,
    questionId: "q-similar",
    type: "similar_distinction",
    options: [
      { optionId: "s1", text: "متشابه١" },
      { optionId: "s2", text: "متشابه٢" },
    ],
    answerKey: { optionId: "s1" },
    ...overrides,
  };
}

export function recallQuestion(overrides: Partial<RecallQuestion> = {}): RecallQuestion {
  return {
    ...BASE,
    questionId: "q-recall",
    type: "word_recall",
    hintFirstLetter: "ك",
    answerKey: { acceptedNorms: ["كلمه١"] },
    ...overrides,
  };
}

export function setLanguage(language: "ar" | "en") {
  localStorage.setItem(LOCALE_STORAGE_KEY, language);
  resetLocaleStoreForTests();
}

export function renderInLocale(ui: ReactElement, language: "ar" | "en" = "en") {
  setLanguage(language);
  return render(ui, { wrapper: LocaleProvider });
}

type HarnessProps = Omit<QuestionViewProps, "answer" | "onAnswerChange" | "hint" | "onHint" | "textKind"> & {
  initialAnswer?: AnswerPayload | null;
  textKind?: QuestionViewProps["textKind"];
  onAnswerSpy?: (answer: AnswerPayload | null) => void;
  onHintSpy?: (effect: HintEffect) => void;
};

// The screen's side of the contract: it owns the answer and the hint state, and passes them back.
export function Harness({ initialAnswer = null, textKind = "quran", onAnswerSpy, onHintSpy, ...props }: HarnessProps) {
  const [answer, setAnswer] = useState<AnswerPayload | null>(initialAnswer);
  const [hint, setHint] = useState<HintEffect | null>(null);
  return (
    <QuestionView
      {...props}
      textKind={textKind}
      answer={answer}
      onAnswerChange={(next) => {
        setAnswer(next);
        onAnswerSpy?.(next);
      }}
      hint={hint}
      onHint={(effect) => {
        setHint(effect);
        onHintSpy?.(effect);
      }}
    />
  );
}
