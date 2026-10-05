"use client";

import { useLocale } from "@/i18n/LocaleProvider";
import { renderTemplate } from "@/i18n/template";
import { getTermsText, type TermsBlock, type TermsTopic } from "@/i18n/terms-text";
import { TERMS_VERSION } from "@/lib/config";

// The page already keeps a link or a focus clear of the app bar below 1024 px (html scroll-padding). From 1024 px that padding shrinks to 8 px,
// because the app shell has no bar there; the public shell keeps its bar, so an anchored heading adds the bar's height itself (S-03 section 4).
const ANCHOR = "rail:scroll-mt-appbar";

// A paragraph or a list. The first block sits 8 px under its heading, the next ones 16 px apart; list items 8 px apart (UI-screens S-03 section 2).
function Block({ block, first }: { block: TermsBlock; first: boolean }) {
  const spacing = first ? "mt-q8" : "mt-q16";
  if (block.kind === "paragraph") {
    return <p className={`${spacing} text-body text-ink`}>{block.text}</p>;
  }
  return (
    <ul className={`${spacing} list-disc ps-q24 text-body text-ink marker:text-ink-secondary`}>
      {block.items.map((item, index) => (
        <li key={index} className={index === 0 ? undefined : "mt-q8"}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function Topics({ topics }: { topics: readonly TermsTopic[] }) {
  return topics.map((topic, index) => (
    <div key={topic.title} className={index === 0 ? "mt-q16" : "mt-q24"}>
      <h3 className="text-body font-semibold text-ink">{topic.title}</h3>
      {topic.blocks.map((block, position) => (
        <Block key={position} block={block} first={position === 0} />
      ))}
    </div>
  ));
}

// The part of S-03 that S-26 shows again in the app shell: the version line, the two parts with their anchors, and their topics.
// It has no H1, back control or closing button: the frame around it brings its own.
export function TermsBody() {
  const { locale } = useLocale();
  const text = getTermsText(locale);
  return (
    <>
      {/* Without a build-time version there is nothing true to show, so the line is left out. */}
      {TERMS_VERSION !== null ? (
        <p className="mt-q8 text-small text-ink-secondary">{renderTemplate(text.versionLine, { version: <bdi>{TERMS_VERSION}</bdi> })}</p>
      ) : null}
      <h2 id="terms" tabIndex={-1} className={`mt-q24 ${ANCHOR} text-section text-ink`}>
        {text.termsHeading}
      </h2>
      <Topics topics={text.terms} />
      <hr aria-hidden="true" className="my-q32 border-0 border-t border-divider" />
      <h2 id="privacy" tabIndex={-1} className={`${ANCHOR} text-section text-ink`}>
        {text.privacyHeading}
      </h2>
      <Topics topics={text.privacy} />
    </>
  );
}
