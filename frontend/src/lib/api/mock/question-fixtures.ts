// Shared synthetic pieces of the question mocks (session, games, placement): the placeholder words are «كلمة١», never a verse or a hadith.
// `mockContext` builds the context of a question the way the server does (D92): every token of the passage before and after the target, with the ayah
// ends as structured data between two ayat of the passage and none inside the blank.
import type { AyahEnd, QuestionContext, SourceRef, TokenRef, TokenView } from "../types";

// The reference the learner reads for a placeholder passage; the real server builds it from the section title and the ayah range.
export const MOCK_REFERENCE_AR = "سورة اصطناعية، الآيات ١\u2013٢";

export const mockSource = (reference: string, referenceAr: string = MOCK_REFERENCE_AR): SourceRef => ({
  publisher: "ناشر اصطناعي",
  editionLabel: "نسخة اصطناعية",
  bookTitleAr: "كتاب اصطناعي",
  reference,
  referenceAr,
  url: "https://example.invalid/ref/1",
  pages: [],
});

// One placeholder ayah: the unit it lies in and its words in book order (the token index is the position).
export interface MockAyah {
  unit: number;
  words: readonly string[];
}

const keyOf = (ref: TokenRef): [number, number] => {
  const [unit = "0", index = "0"] = ref.split(":");
  return [Number(unit), Number(index)];
};
const before = (a: [number, number], b: [number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

// The whole passage around the target `from` to `to` (token references of the same passage, `from` first).
export function mockContext(passage: readonly MockAyah[], from: TokenRef, to: TokenRef = from): QuestionContext {
  const low = keyOf(from);
  const high = keyOf(to);
  const tokens = passage.flatMap((ayah) => ayah.words.map((text, index): TokenView => ({ ref: `${ayah.unit}:${index}`, text })));
  const ends: AyahEnd[] = passage.slice(0, -1).map((ayah, position) => ({ afterRef: `${ayah.unit}:${ayah.words.length - 1}`, number: position + 1 }));
  return {
    before: tokens.filter((token) => before(keyOf(token.ref), low)),
    after: tokens.filter((token) => before(high, keyOf(token.ref))),
    // None inside the blank; the one that closes the blank's own ayah stays, right after it.
    ayahEnds: ends.filter((end) => before(keyOf(end.afterRef), low) || !before(keyOf(end.afterRef), high)),
  };
}
