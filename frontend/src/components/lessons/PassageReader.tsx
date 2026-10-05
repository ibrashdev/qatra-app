"use client";

import { Fragment, useId } from "react";
import { AyahEndMark, OriginalText, QuestionSource } from "@/components/questions";
import { HadithRecord } from "@/components/session/HadithRecord";
import { Notice } from "@/components/ui/Notice";
import { useLocale } from "@/i18n/LocaleProvider";
import { lessonsMessages } from "@/i18n/lessons-messages";
import { questionMessages } from "@/i18n/question-messages";
import type { LessonSectionDetail } from "@/lib/api/types";
import { ayahNumberOf, hadithRecordOf, readerBlocks, sectionSource, textKindOfSection } from "./lessons-model";

// The text of one section, read only (D90): the verses or the hadith exactly as the book has them, in the original-text font, then the line of the book and
// the «المصدر» link, and for a hadith its takhrij and grade. There is no question, no answer, no game and no way into a session from here. A surah is shown
// passage by passage under the passage's own reference (the ayat), with the ayah numbers drawn as decoration after each ayah, as a question shows them; a
// hadith is one block, its narration shown once however many paths the plan reads it on.
export function PassageReader({ detail }: { detail: LessonSectionDetail }) {
  const { locale } = useLocale();
  const t = lessonsMessages(locale);
  const idBase = useId();
  const textKind = textKindOfSection(detail);
  const blocks = readerBlocks(detail);
  const hadith = detail.kind === "hadith";
  const record = hadithRecordOf(detail);
  const headings = !hadith && blocks.length > 1;

  return (
    <div className="flex flex-col gap-q24">
      {blocks.map((block, position) => {
        const headingId = `${idBase}-${position}`;
        return (
          <section key={block.passage.passageId} aria-labelledby={headings ? headingId : undefined} aria-label={headings ? undefined : t.reader.textLabel} className="flex flex-col gap-q8">
            {headings ? (
              <h2 id={headingId} className="text-section text-ink">
                <bdi lang="ar">{block.passage.referenceAr !== undefined && block.passage.referenceAr !== "" ? block.passage.referenceAr : block.passage.reference}</bdi>
              </h2>
            ) : null}
            <OriginalText textKind={textKind}>
              {hadith ? (
                <div className="flex flex-col gap-q12">
                  {block.units.map((unit) => (
                    <p key={unit.unitRef}>{unit.text}</p>
                  ))}
                </div>
              ) : (
                <p>
                  {block.units.map((unit, index) => {
                    const number = unit.kind === "ayah" ? ayahNumberOf(unit.reference) : null;
                    return (
                      <Fragment key={unit.unitRef}>
                        {index > 0 ? " " : null}
                        {unit.text}
                        {number !== null ? (
                          <>
                            {" "}
                            <AyahEndMark number={number} />
                          </>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </p>
              )}
            </OriginalText>
          </section>
        );
      })}

      <QuestionSource source={sectionSource(detail)} />

      {hadith ? <HadithRecord takhrij={record.takhrij} grade={record.grade} /> : null}
      {detail.passages.some((passage) => passage.showD50Notice) ? <Notice>{questionMessages(locale).d50Notice}</Notice> : null}
    </div>
  );
}
