# Publisher terms and source/licence register (C5, D68)

Version 0.1 · 2026-10-05 (Asia/Dubai) · Status: **Draft, Needs Review by the owner** · Work package C5 (`docs/Qatra-build-plan.md`): "record publisher terms and the register of sources and licences before public display (D68)". Acceptance for C5 is "the owner accepts what is recorded"; nothing here is approved.

This is a record of what publishers published, not a legal opinion. No sacred text is copied here. Quotes are short and verbatim; where a page could not be read or says nothing, the entry says so. A working link, a free service or a 200 response does not grant a right to reuse, and no permission is stated below unless the publisher's own text says so (none of the entries below does for Qatra's use).

Retrieval date for everything checked live: 2026-10-05. Method: direct HTTPS read of the publisher page from this environment (curl, descriptive User-Agent), plus the pages' Arabic home text. The network proxy of this environment blocked quranenc.com, hadeethenc.com, everyayah.com, islamenc.com and islamhouse.com, so those publishers' own terms could NOT be read in this task; for them the register cites earlier repository evidence and labels it as secondary.

## 1. Summary table

| # | Source / publisher | Content used by Qatra | Terms read from publisher on 2026-10-05? | Permission for Qatra's use stated? |
|---|---|---|---|---|
| S1 | Islamic Content MCP, Association for Multi-lingual Islamic Content | Access channel for S2, S3, S5 (text, metadata, audio links) | Yes (terms, home FAQ) | No. Terms say nothing on reuse |
| S2 | QuranEnc (QuranEnc.com / islamenc.com reference pages) | Arabic Uthmani verse text of Juz' Amma (surahs 78-114, 564 verses) | No (blocked: egress). Secondary repo evidence only | Not verified |
| S3 | HadeethEnc (hadeethenc.com) | Nawawi Forty narration text, plus Narrator and Grade fields | No (blocked: egress). No repo evidence of its terms | Not verified |
| S4 | EveryAyah (everyayah.com), Husary 64kbps MP3 | Per-verse recitation audio, streamed by link | No (blocked: egress) | Not verified |
| S5 | IslamHouse library (via the MCP) | Candidate only (item 5271, Nawawi Forty); not the selected source | No (blocked: egress) | Not verified |
| S6 | King Fahd Complex Hafs text v18 (qurancomplex.gov.sa) | Verification reference only (D68, contract 2.7), not displayed | Not attempted: no URL recorded in the reviewed sources; not in the permitted fetch list | Not verified |
| S7 | Jamhara dictionary (islamic-content.com/dictionary) | Source of English religious UI terms (D28) | Not attempted (blocked family of hosts; terms not reviewed) | Not verified |
| S8 | Challenge terms (islamicaich.org/terms) | Governs disclosure and licence record, not content | Existing citation record only (`references/terms-citation.md`) | Not applicable |

## 2. Per-source entries

### S1. Islamic Content MCP (mcp.islamiccontent.org)

- Publisher: Association for Multi-lingual Islamic Content (islamiccontent.sa), described on its page as a licensed charity no. 2131.
- Content used: access service only; returns the text, grades, audio links and canonical URLs of other publishers' work (D68, D81 Q2).
- Where used in Qatra: source acquisition (C1 CLI `acquire`/`verify`), audio reference list (QAUD-02). Not a runtime dependency of the learner app as designed.
- Canonical URL: https://mcp.islamiccontent.org/ (endpoint https://mcp.islamiccontent.org/mcp).
- Terms URL: https://mcp.islamiccontent.org/terms.html (retrieved 2026-10-05, HTTP 200, "Last updated 14 September 2026"). Privacy page linked from it.
- Verbatim key clauses:
  - "This server provides read-only programmatic access to published Islamic texts: the Holy Qur’an with translations, the Prophetic Hadith collection, and the IslamHouse library, for use by AI assistants via the Model Context Protocol. It is provided free of charge."
  - "The server retrieves and cites published texts; it does not issue religious rulings. Translations and authenticity gradings are the work of the publishing institutions."
  - Home page FAQ (Arabic, retrieved 2026-10-05): "تُطبَّق حدود معدل معقولة لحماية المصادر" (reasonable rate limits are applied to protect the sources). Home page also states "مصدر في كل إجابة كل نتيجة تحمل رابطاً إلى الصفحة الأصلية لتتحقق بنفسك".
  - Not found in the terms page: any reuse, redistribution, commercial-use, caching, attribution wording, numeric rate limit or audio clause.
- Attribution text required: none stated in the terms. Each tool response carries a CITE instruction asking that the returned canonical link be carried in full, exactly as returned (documented in `references/source-acquisition/quran-audio-evidence.md` on the unmerged branch and in the MCP tool instructions). This is a request in the tool output, not a licence term.
- Restrictions: purpose stated is use "by AI assistants via the Model Context Protocol", which is not obviously the same as bulk acquisition for republishing in an app. Rate limit unspecified. Cloudflare refused a default Python urllib User-Agent (HTTP 403, evidence file) and earlier a probe was blocked (error 1010, `mcp-evidence.json`); a descriptive User-Agent was accepted later. Do not evade blocks.
- Conflicts / risks for Qatra: terms do not grant any right to re-display, store or cache the content in an offline PWA; they say translations and gradings belong to the publishing institutions. The service cannot grant rights over upstream content.
- Open questions: see Q1, Q2, Q9.
- Evidence: `references/source-acquisition/mcp-evidence.json`, `references/source-acquisition/manifest.json` (field `service.service_terms_content`), `docs/Source-acquisition.md`, `docs/Decision-register.md` D68/D81.

### S2. QuranEnc (Arabic Uthmani verse text, Juz' Amma)

- Publisher: QuranEnc project (quranenc.com; reference pages shown as islamenc.com in returned links). The Arabic text came interleaved with a Muyassar tafsir line in the MCP response (the tafsir is NOT stored or displayed, D20/D26/D68).
- Content used: Arabic verse text only, 564 verses, surahs 78-114.
- Where used in Qatra: reading, question segmentation, memorization games (learning content); canonical per-surah link shown beside text (D21 as amended by D68).
- Canonical URL pattern: https://islamenc.com/ar/quran/<surah> (verse pages https://islamenc.com/ar/quran/<surah>/<verse>).
- Terms URL: https://quranenc.com/ar/home/api/ (candidate; the publisher's API documentation). Retrieval 2026-10-05: **not reachable from this environment (egress blocked)**. An earlier attempt on 2026-10-04 returned HTTP 429.
- Verbatim key clauses: **Not found / unreachable (egress blocked, 2026-10-05).** Secondary evidence only (not a publisher quote): `references/source-acquisition/quran-evidence.json` records that search-indexed API documentation states re-publication conditions for translation content (no modification/addition/deletion, clear attribution to publisher and QuranEnc, version information, retaining transcript/version information, reporting notes, updating to new source versions, avoiding inappropriate ads), "expressly for translations", and that "permission for republishing Quran Arabic source text was not verified". Those paraphrases must be re-read in the publisher's own page before relying on them.
- Attribution text required: not verified. Likely to be requested for translations (publisher and QuranEnc); whether it applies to the Arabic text is unknown.
- Restrictions: unknown for the Arabic text; translation conditions above include no modification of text.
- Conflicts / risks for Qatra: segmentation into questions and masking of words could count as "modification" if the translation conditions were applied to Arabic text; offline caching in IndexedDB is a copy and re-display; King Fahd lineage and printed page numbers not established (`quran-evidence.json`); D68 sample check found surah 112 matches King Fahd Hafs after Unicode normalization, full verification pending (contract 2.7).
- Open questions: Q3, Q4, Q5.
- Evidence: `references/source-acquisition/quran-evidence.json`, `references/source-acquisition/mcp-evidence.json` (claude_code_session_probe), D68, D62.

### S3. HadeethEnc (Nawawi Forty narrations, Narrator and Grade fields)

- Publisher: HadeethEnc (hadeethenc.com), reached through the MCP.
- Content used: narration text for the 42 Forty records (35 matched, 7 uncertain in `nawawi40-id-map.json`/evidence; gaps are excluded per D68), plus the "Narrator" (takhrij) and "Grade" fields kept and labelled as from the HadeethEnc record (D68 amending D25). Explanation, benefits and translations are not stored or displayed.
- Where used in Qatra: reading, question segmentation, games; canonical link `https://hadeethenc.com/ar/browse/hadith/<id>` shown as reference.
- Terms URL: https://hadeethenc.com/ (API/terms page not located; one guessed API page was blocked by egress on 2026-10-05).
- Verbatim key clauses: **Not found / unreachable (egress blocked, 2026-10-05). No publisher terms for HadeethEnc are recorded anywhere in the repository.**
- Attribution text required: not verified. D68 already requires labelling Narrator and Grade as from the HadeethEnc record.
- Restrictions: unknown. Gradings are "the work of the publishing institutions" (S1 terms), so reuse of the grade and takhrij text is a separate rights question from the hadith text.
- Conflicts / risks: Qatra's planned storage (private Storage bucket, then app cache) and display of grades is unverified; text contains invisible zero-width characters in some records (evidence file); 7 records uncertain; offline cache copies the text.
- Open questions: Q3, Q4, Q6.
- Evidence: `references/source-acquisition/nawawi40-id-map-evidence.md`, `nawawi40-id-map.json`, `mcp-evidence.json`, D68, D25.

### S4. EveryAyah (Husary 64kbps recitation audio)

- Publisher: EveryAyah (everyayah.com); reciter Mahmoud Khalil Al-Husary folder `Husary_64kbps` as named by the MCP (not listened to or verified).
- Content used: audio, streamed by the user's browser directly from the publisher; the Qatra manifest stores only URLs and verse numbers (564 entries for Juz' Amma). Audio is not hosted by Qatra (addendum section 3, still Draft).
- Where used in Qatra: optional recitation player in Juz' Amma learning steps (`docs/Quran-audio-streaming.addendum.md`, Draft, Needs Review).
- Canonical URL: https://everyayah.com/data/Husary_64kbps/SSSAAA.mp3.
- Terms URL: https://everyayah.com (home). Retrieval 2026-10-05: **not reachable (egress blocked)**.
- Verbatim key clauses: **Not found / unreachable (egress blocked, 2026-10-05).** The addendum (section 4) states that a service answer or a working link does not grant republication rights and that no licence is inferred (also in the audio evidence file, "Terms checked").
- Attribution text required: not verified.
- Restrictions: unknown. Distinction recorded: streaming from the publisher's host (current design) vs hosting copies on Qatra's own storage (not designed; would need explicit permission).
- Conflicts / risks: hotlinking may be restricted or the host may throttle or change; only two files (78:1, 114:6) were ever probed (HEAD 200, audio/mpeg, 4 October 2026); no check of CORS, range requests or redirects; offline PWA cannot cache cross-origin audio without hosting rights, so the UI must say audio needs the internet (addendum proposed text); public display with no rights confirmation is the C5 risk. The MCP terms do not mention audio.
- Open questions: Q7, Q8.
- Evidence: unmerged branch file `references/source-acquisition/quran-audio-evidence.md` (read via `git show origin/claude/sharp-turing-10nwqo:...`), `docs/Quran-audio-streaming.addendum.md` sections 4 and 6.

### S5. IslamHouse library (candidate)

- Publisher: IslamHouse (islamhouse.com). Item 5271 "Nawawi Forty (Arabic)" was recorded as a separate candidate, not the selected source (`docs/Source-acquisition.md`; superseded for text by D68, which selects HadeethEnc records).
- Content used: none in the planned app.
- Terms: **Not found / unreachable (egress blocked, 2026-10-05).** Not required unless the owner reselects IslamHouse; its presence in the MCP service terms is as a retrieved library, with no reuse clause.
- Open question: Q10.

### S6. King Fahd Complex Hafs text v18 (verification tool)

- Publisher: King Fahd Complex for the Printing of the Holy Quran (qurancomplex.gov.sa); used only to compare text after NFC normalization (D68, `docs/Implementation-contract.md` 2.7), not displayed.
- Terms: **Not found / not read.** No canonical URL for the v18 file is recorded in the files reviewed for this task, and the host was not fetched. Needed only if the verification file is stored in the repository or shown; comparison alone should be confirmed with the owner.
- Open question: Q5.

### S7. Jamhara dictionary (UI terminology, D28)

- Publisher: as cited in D28: islamic-content.com/dictionary (the Scientific Reference's Jamhara encyclopedia). Used as the source of English UI terms with religious meaning (not translated by machine).
- Terms: **Not found / not read** in this task. Whether individual terms may be reproduced in UI text is not recorded.
- Open question: Q11.

### S8. Challenge terms (context only)

- islamicaich.org/terms v1.0 (reviewed 9 September 2026, read 3 October 2026), clause 9 asks for disclosure of external tools, AI models, data sources and open-source components and a record of their provenance and licences (summary in `references/terms-citation.md`; that file is a summary, not the text). This register supports that record; it is not a substitute for the tools and licences log in `docs/Delivery-and-baseline.md`.

## 3. Cross-cutting conflicts and risks for Qatra's planned use

1. Offline PWA cache (D46/D58/D59) stores copies of text on learners' devices; no publisher text read grants caching or redistribution.
2. Segmentation into questions, masking words and re-ordering parts may be treated as modification of the text by publishers that forbid modification (stated, via secondary evidence only, for QuranEnc translations). The original text is preserved in Qatra (D31/D25) but the displayed form is altered.
3. Grades and takhrij (Narrator/Grade fields) are the work of publishing institutions (S1 terms), so rights over them may differ from rights over the text.
4. Audio is third-party; streaming from the publisher's host is a lower-exposure design than hosting, but still unverified for rights, availability and CORS.
5. The MCP terms (read) cover access by AI assistants and are silent on reuse; D68 already records "rights owner-accepted pending verification" and requires publisher terms before public display. This register shows that, as of 2026-10-05, the terms of QuranEnc, HadeethEnc and EveryAyah are still unread by this task, so the C5 condition is not yet met.
6. Public display depends on the owner's decision (D68 accepted the risk but not unverified public release).

## 4. Open questions for the owner

1. Q1. Is the MCP's "for use by AI assistants via the Model Context Protocol" wording sufficient for bulk acquisition into a private bucket, or should the Association (contact on terms page) be asked in writing for permission?
2. Q2. Acceptable request rate: the service says only "reasonable"; should the CLI be capped (the audio run used about 2.5 requests per second)?
3. Q3. Can someone with unrestricted network access open quranenc.com/ar/home/api/, the HadeethEnc terms/API page and any site-wide terms and send the exact text, so that this register can record verbatim clauses (they were blocked here)?
4. Q4. Does the owner accept publishing Arabic text, segmented and masked, under these publishers' conditions, or should written permission be requested before public display?
5. Q5. Is King Fahd Complex v18 stored in the repository or used only for a transient comparison, and where is its terms page (no URL is recorded)?
6. Q6. Do the Narrator and Grade fields need a separate permission, given the MCP states gradings belong to the publishing institutions?
7. Q7. May Qatra stream EveryAyah audio from the publisher's host in the public app, and is an alternative (e.g. publisher-endorsed host or no audio) wanted if permission cannot be confirmed?
8. Q8. What attribution wording should appear for audio, QuranEnc and HadeethEnc (publisher text required, or the owner's own credit line and the returned canonical links)?
9. Q9. Who contacts the publishers (the MCP page lists a contact email, obfuscated in the page HTML) and who records the replies?
10. Q10. Is IslamHouse item 5271 definitely out of scope (D68 selects HadeethEnc)?
11. Q11. May Jamhara terms be reproduced in UI strings, and what does the owner want recorded for D28?
12. Q12. What is the minimum evidence the owner will accept to close C5 (quoted publisher text, written permission, or an explicit risk acceptance recorded as a decision)?

## 5. Evidence references (repository paths)

- `docs/Decision-register.md` (D19, D21, D24, D25, D27, D28, D62, D68, D81)
- `docs/Source-acquisition.md`, `docs/Content-and-sources.md`, `docs/Delivery-and-baseline.md` (tools and licences log)
- `docs/Quran-audio-streaming.addendum.md` (Draft, Needs Review)
- `references/terms-citation.md`
- `references/source-acquisition/manifest.json`, `mcp-evidence.json`, `quran-evidence.json`, `nawawi40-id-map-evidence.md`, `nawawi40-id-map.json`
- Unmerged branch `origin/claude/sharp-turing-10nwqo`: `references/source-acquisition/quran-audio-evidence.md` (read-only)
- Live reads on 2026-10-05: https://mcp.islamiccontent.org/terms.html and https://mcp.islamiccontent.org/ (HTTP 200)
