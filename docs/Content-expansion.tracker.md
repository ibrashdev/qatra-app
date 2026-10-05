# Content expansion tracker

Task: `CONTENT-EXPANSION-01` · Draft content preparation · Updated 2026-10-05 (Asia/Dubai)

## Scope and authority

This is an isolated partial draft batch: Quran surahs 113–114 and Forty Nawawi hadiths 2–5, bank version 2. The user authorized preparing drafts from both collections. The ordinary draft workflow is recorded below; it does not extend D83's special source-only verification method, which covers only surah 112 and hadith 1 at bank version 1. It grants no publication G6. Source texts and generated draft artifacts are retained only under the ignored private build directory `backend/.content-build/expansion-batch-01/`. This partial batch is not a complete collection or a replacement for published content.

## Acquisition results

Both editions were acquired over HTTP from the Islamic Content MCP on 2026-10-05. The Quran tool was `get_quran_verses`; the hadith tool was `get_hadith`. Acquisition completed without a reported network error.

| Collection | Scope and result | Canonical source |
|---|---|---|
| Quran, `quran-hafs-quranenc`, bank 2 | Surah 113: 5 ayat (113:1–5); surah 114: 6 ayat (114:1–6); 11 ayat total, 2 raw objects, no missing surahs. | [Surah 113](https://islamenc.com/ar/quran/113) · [Surah 114](https://islamenc.com/ar/quran/114) |
| Forty Nawawi, `nawawi40-hadeethenc`, bank 2 | Requested 2–5. Two independent acquisition passes completed for mapped numbers 3, 4, 5: 3 records per pass, 6 raw objects total. IDs: 3→66512, 4→66513, 5→66514. Required metadata fields (`hadeethencId`, `fortyNumber`, `title`, `narration`, `narrator`, `grade`, `url`, `languages`) were present for each record. | [Record 66512](https://hadeethenc.com/ar/browse/hadith/66512) · [Record 66513](https://hadeethenc.com/ar/browse/hadith/66513) · [Record 66514](https://hadeethenc.com/ar/browse/hadith/66514) |

Hadith 2 had no entry in the approved local ID map and was not fetched. Candidate 4563 was excluded. The standard verifier recorded number 2 as `no_record`; it was not substituted from another record or source.

## Object integrity record

`rawSha256` is the workflow's canonical-record hash. `fileSha256` is the SHA-256 of the retained raw JSON envelope. Times are source `retrievedAt` values (UTC). For each hadith ID, the two passes have equal `rawSha256`; this is an acquisition consistency check only, not approved source-verbatim verification.

| Raw object | Source time (UTC) | rawSha256 | fileSha256 |
|---|---|---|---|
| `raw/quran-hafs-quranenc/bank2-surah-113.json` | 2026-10-05T11:37:59.604226Z | `8fdda0509301250fac6d16daedaae7f5fe6a5f7b8ba84f189eb6e36a99b1bb02` | `1b70de8bc82ec61cc1fecee484d5a73b7489d97c0533a4da335b0e520b3f98ee` |
| `raw/quran-hafs-quranenc/bank2-surah-114.json` | 2026-10-05T11:38:02.139745Z | `88e1b213f07c2c09018520eea091fadcb05c8bc80872470a746dd1bc2e96855e` | `5dcb4c8bfcc8ba461dfbad830b4b2ee23df2d1a3ce481e1ed5216ca4cd922670` |
| `raw/nawawi40-hadeethenc/bank2-pass1-forty-03.json` | 2026-10-05T11:38:17.049860Z | `28a22f7d5812c08c51dbfae027941c4574695343bbf6de66b42073e9bdf63e94` | `e5c4e175ea0706ccb61941d8fcf50458b8f5b56eb3bf34ed760ec38adc7074f6` |
| `raw/nawawi40-hadeethenc/bank2-pass1-forty-04.json` | 2026-10-05T11:38:18.302060Z | `4482c764cb8226f73d4470efd95358a817d02cdca4a7e5cf428ae0da92c8646f` | `95a6ee1fdf211d2e981ba220a44c3861d11176556e45c6b0f75102e7605b6073` |
| `raw/nawawi40-hadeethenc/bank2-pass1-forty-05.json` | 2026-10-05T11:38:18.765085Z | `06bba1c7034e328d526cfa75bc8fa91377d8586dd6c92af733e601ce4494c056` | `f8c1146be65e28ace02ea8e4392e8d5f64da519959eeeae56701d57dc1c71cdd` |
| `raw/nawawi40-hadeethenc/bank2-pass2-forty-03.json` | 2026-10-05T11:38:33.207050Z | `28a22f7d5812c08c51dbfae027941c4574695343bbf6de66b42073e9bdf63e94` | `2aa23242fd1a2933492dd39fee4f76015f2258ba3dcfa1548c2266c966930252` |
| `raw/nawawi40-hadeethenc/bank2-pass2-forty-04.json` | 2026-10-05T11:38:34.392212Z | `4482c764cb8226f73d4470efd95358a817d02cdca4a7e5cf428ae0da92c8646f` | `ba1cbb83a7500185fa887f1048e0dbd5eeb9dd4a6c586c90477be1f1e0c7144e` |
| `raw/nawawi40-hadeethenc/bank2-pass2-forty-05.json` | 2026-10-05T11:38:34.793260Z | `06bba1c7034e328d526cfa75bc8fa91377d8586dd6c92af733e601ce4494c056` | `d076401fa4ef661bd28c682c89a38410a11b25972864c4a63941271d7b4bf9c0` |

## Draft workflow results

Hadith bank 2 completed the standard local draft workflow; generated reports contain counts and references only:

| Step | Result | Evidence |
|---|---|---|
| `verify` | Passed: 12/12 units; 0 failed, 0 flagged; one documented gap, Forty 2 (`no_record`). | `nawawi40-hadeethenc/verification_report.md`, `gap_report.md`; generated 2026-10-05T11:44:41.610851Z. Method: `two_pass_nfc_equality`. |
| `segment` | Succeeded: 3 sections, 9 units, 244 words, 6 passages, 40 parts. | CLI reported one boundary doubt at Forty 5 narration; retain for human review. Grade passages were omitted for Forties 3–5 because the records did not provide enough distinct grade phrases for a grade question; no grade-coverage claim is made. |
| `build-bank` | Succeeded: 6 lessons, 191 questions, 0 skipped. | Draft `bundle.json` and workflow `publish.sql` are under the ignored build directory; no final publication SQL was generated. |
| `validate` | Succeeded: 0 issues; 191 questions; 40/40 parts covered. | CLI validation result. A passing structural validation does not resolve the boundary doubt or omitted grade paths. |

Quran remains at `acquired` only. Contract §2.7 calls for an independent King Fahd Complex Hafs v18 oracle. The reviewed source evidence (`references/source-acquisition/quran-evidence.json`) does not establish an Arabic-original oracle route. Publisher-terms register S6 says no oracle URL is recorded and that reference retrieval was not attempted; no non-synthetic oracle exists in the repository. The only local oracle file is explicitly synthetic test data, so Quran verification, segmentation, bank generation, and validation were not run.

No database or provider storage was changed. No source text was printed into this tracker.

## Status and next steps

Status: `Partial draft prepared`. Hadith numbers 3–5 have passed source-pass comparison and produced a validated draft bank; number 2 is a recorded gap. Surahs 113–114 are acquired but await the contract's independent oracle comparison. Hadith 5 narration's boundary doubt remains `Needs Review`; grade paths for hadiths 3–5 were omitted.

Next: obtain the documented Hafs v18 oracle through an approved route before verifying the Quran draft. Keep hadith 5 narration's boundary doubt visible for human review; do not claim grade coverage for hadiths 3–5. D83's source-only verifier must not be applied to this batch. `approve` and `publish` remain unrun; public release of this expanded batch requires the applicable owner review and publication G6. Nothing here claims a complete collection or replaces already published content.


## CONTENT-EXPANSION-02 — full-range acquisition and hadith draft

Status: Quran acquired; hadith standard verification and bank construction completed, but validation failed. All artifacts remain drafts; no approval or publication was recorded. The owner requested: “use Islamic content MCP and expand the content more” (2026-10-05). This records preparation authorization only. D68 governs the source route; D83's source-only method was not used for these expanded ranges.

Source objects are retained under the ignored private directory `backend/.content-build/expansion-batch-02/`. The metadata-only [batch 02 evidence index](../references/source-acquisition/expansion-batch-02-evidence.json) records each object's canonical URL, IDs, timestamp, raw payload hash and file hash without source text.

| Collection | Acquisition and pipeline result |
|---|---|
| Quran, `quran-hafs-quranenc`, bank 3 | Surahs 78–114 acquired from Islamic Content MCP: 37/37 surahs and 564 ayahs, no missing surahs; 37 raw objects. Standard verification, segmentation, bank build and validation were not run because the required independent Hafs v18 oracle is not documented here. Status remains `acquired`. |
| Forty Nawawi, `nawawi40-hadeethenc`, bank 3 | Forty 1–42 requested; 35 explicitly mapped records acquired in each of two HTTP passes (70 raw objects). Standard `verify` passed 140/140 units using `two_pass_nfc_equality`; 7 gaps remain: 2, 14, 24, 25, 35, 40 and 42 (`no_record`). `segment` succeeded (35 sections, 105 units, 2,537 words, 108 passages including 35 grade passages, 440 parts). `build-bank` succeeded (108 lessons, 1,942 questions, 3 skipped). `validate` failed (exit 1): 439/440 parts covered; `part_uncovered` at `matn:25:1`. The uncovered one-word part is passage ordinal 25, `matn`, reference `nawawi40:22`, range `58:56`–`58:56`; see evidence index. Stop downstream work pending review. |

Hadith review flags: five narration boundary doubts (Forty 5, 7, 16, 19 and 27) and one hard-split flag (Forty 29); 3 bank items were skipped for `segment_ambiguous` refs `19:16`, `85:16` and `100:16`. The validation report shows no grade-passage omissions (35 grade passages). The uncovered-part finding remains unresolved; no source rewrite, validation weakening or code change was made.

Source-match limitation: the existing ID-map evidence classifies 26 records from HadeethEnc’s dedicated Forty run and 9 standalone search records as matched; seven other standalone numbers remain uncertain and were not fetched. The 9 standalone matches depend in part on the prior reviewer’s recollection of the printed Forty and lack independent oracle evidence. Two-pass NFC equality shows consistent MCP retrieval; it does not establish exact matching to the approved printed Nawawi wording. Keep those 9 standalone matches pending human review and do not label them fully approved text. The seven unmapped numbers were not fetched or guessed; candidate 4563 was excluded.

Rate limiting: Quran acquisition first stopped with HTTP 429 after 23 objects, then the same command resumed after a 60-second backoff and completed (14 new objects). Hadith pass 1 stopped after 23 records and resumed after a 60-second backoff (12 new records); pass 2 stopped after 24 records and resumed after a 60-second backoff (11 new records). No alternate identity or source was used.

No source text was added to this tracker or metadata index. `approve` and `publish` were not run. This batch does not claim publication G6, full collection verification, or public readiness.

## CONTENT-EXPANSION-03 — grade-context remediation and resumed draft

Status: hadith bank 3 privately rebuilt and standard validation passed; source review and Quran oracle work remain open. The owner requested “use subagents and resume work and expand the content” on 2026-10-05. Work is bounded to the already authorized B8 remediation basis (analysis D71, architecture D74 and G3); it does not extend D83 or grant G6.

Batch 03 is a resumable copy of batch 02 at the same bank version 3, with the same 70 raw hadith objects; it is not another source pass. Independent coordinator checks confirmed all 118 batch 02 files match the preserved snapshot and all 70 raw hadith objects are byte-identical. Batch 03 leaves source units, sections, passages and parts, lessons, and all 41 existing grade questions unchanged. The metadata-only [batch 03 evidence index](../references/source-acquisition/expansion-batch-03-evidence.json) records this batch; no narration or grade values belong in this tracker or its public metadata.

The confirmed bank failure was a generic single-word context collision: 29 grade-only singleton phrases shared the empty blank context with the one non-grade singleton target. Grade questions compare distinct grade phrases separately. The bounded correction excludes grade passages only from the builder's and validator's generic single-word ambiguity tables; all non-grade ambiguity checks and grade-question validation remain active. No source, part, or coverage rule was changed.

Synthetic regression evidence: before the code change, the valid singleton-matn case failed with uncovered parts; after the change, both focused regressions passed. The positive case confirms four questions, including the two grade-choice questions; the negative case retains two different non-grade singleton answers at an empty context and confirms the validator rejects a forged generic recall as `ambiguous_item`. The full backend suite passed (4,587 tests) with one existing Starlette/httpx deprecation warning, and full Ruff passed. A Windows path-separator failure in the publish test helper was reproduced against the original application modules and corrected in the test helper with `.as_posix()`; that test then passed.

The resumed evidence review records eight additional candidate IDs (4563, 4714, 58194, 4810, 4558, 4706, 4704, 5456) acquired once by MCP but excluded from the ID map and bank; the seven existing gaps remain, and candidate 58194 did not match Forty 14. Candidate extracts are sanitized to D68's exact/attribution-only field allowlist; their eight retained-file SHA-256 values were verified, with original response hashes kept as informational metadata. The independently acquired OpenITI reference, Shamela 0012836, is 36,708 bytes with SHA-256 prefix `bd24252`; its 27,036-byte numbered skeleton has SHA-256 `ef9b39b7180bbb13d8185d9704ed88750d1cffba702692daf2dd8510d6229cb3`, and `load_skeleton` verified keys 1–42. Standard `verify` passed 140/140 source-pass checks with 0 failed and the same seven gaps. Separately, comparison with the independent numbered skeleton flagged 35 narration units for letter-skeleton review. This does not claim wording matches: the reference has its own sanad, takhrij and editorial wording, so the 35 flags require human review; do not trim the source. Seven unmapped numbers and the nine standalone records previously classified as matches also remain for human review. The exact King Fahd Complex Hafs v18 oracle route is still unconfirmed; Quran surahs 78–114 (37 surahs, 564 ayahs) remain acquired only.

The resumed standard pipeline completed on private batch 03: `segment` produced 35 sections, 105 units, 2,537 words, 108 passages and 440 parts, with five narration-boundary doubts (Forties 5, 7, 16, 19, 27) and one hard-split flag (Forty 29); `build-bank` produced 108 lessons, 1,943 questions and 3 skips (`19:16`, `85:16`, `100:16`); `validate` exited 0 with 0 issues and 440/440 parts covered. Independent validation confirmed 1,943 questions, including a question for hadith 22 `matn:25:1`; all 41 prior grade questions are unchanged. The prior `part_uncovered` finding is resolved in this private clone, and batch 02's historical result and all 118 files remain preserved. No D83 or G6 expansion, `approve`, `publish`, provider or database write is recorded. Quran oracle work, the source-match review and the human review of flagged text remain open; this is a bank-validated private draft, not an approved or publishable edition.
