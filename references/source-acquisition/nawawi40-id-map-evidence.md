# Nawawi-40 id map: evidence (C1 preparation, D68)

Prepared: 2026-10-04T13:06:00Z (retrieval date 2026-10-04, Asia/Dubai). Worker: content-acquisition, Role 6.

No source text was stored. This file and `nawawi40-id-map.json` hold ids, URLs, counts, booleans and the worker's own neutral notes only: no narration, title phrase, narrator text or grade text. The records were read in the session through the Islamic Content MCP (`get_hadith`, `search`) and nothing was copied out of it.

## Result

- Numbers accounted for: 42 of 42 (matched 35, uncertain 7, gap 0).
- `nawawi40-id-map.json` is the plain object the CLI expects for `acquire --id-map` (`{"<fortyNumber>": <hadeethencId>}`, see `backend/scripts/README.md` and `load_id_map`). It contains the 35 matched entries only. Uncertain numbers are not in it, so the CLI will not fetch them and `verify` will report them as gaps until the coordinator decides.
- D68 anchors: 66511 = hadith 1, 66512 = hadith 3, 66529 = hadith 28, 66535 = hadith 41. All four agree with this mapping; no discrepancy.
- Two bases of evidence. (a) Block records: ids 66510-66541 are a dedicated Forty run in which every narration opens with the Forty's own chain convention; 26 Forty numbers map there. (b) Standalone records: the other 16 numbers have no record in the block; they were found by `search` and opened with `get_hadith`; 9 are classed matched and 7 uncertain, by content plus the worker's recollection of the printed Forty. That recollection is not an oracle, so the verbatim `verify` step is the real gate for these 16.
- The block does not follow the Forty's order (hadith 30 has the lowest id, hadith 27 sits after hadith 41), so the ids were assigned by reading each narration, never by id arithmetic.

## Mapping table

| fortyNumber | hadeethencId | canonicalUrl | narratorFieldPresent | gradeFieldPresent | publishedLanguages | status | note |
|---|---|---|---|---|---|---|---|
| 1 | 66511 | https://hadeethenc.com/ar/browse/hadith/66511 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith (D68 anchor) |
| 2 | 4563 | https://hadeethenc.com/ar/browse/hadith/4563 | yes | yes | 72 | uncertain | same hadith (the angelic-visitor narrative), standalone collection text; appears to differ from the Forty's printed wording in the chain-opening formula and in one word of the opening scene; the only record found for this hadith by two searches |
| 3 | 66512 | https://hadeethenc.com/ar/browse/hadith/66512 | yes | yes | 69 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith (D68 anchor); the narration shows invisible zero-width characters inside the text |
| 4 | 66513 | https://hadeethenc.com/ar/browse/hadith/66513 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 5 | 66514 | https://hadeethenc.com/ar/browse/hadith/66514 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith; includes the additional Muslim riwaya that the Forty gives |
| 6 | 66515 | https://hadeethenc.com/ar/browse/hadith/66515 | yes | yes | 72 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 7 | 66516 | https://hadeethenc.com/ar/browse/hadith/66516 | yes | yes | 64 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 8 | 4211 | https://hadeethenc.com/ar/browse/hadith/4211 | yes | yes | 66 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides; possible honorific-level difference in the closing clause only |
| 9 | 66517 | https://hadeethenc.com/ar/browse/hadith/66517 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 10 | 66518 | https://hadeethenc.com/ar/browse/hadith/66518 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 11 | 66519 | https://hadeethenc.com/ar/browse/hadith/66519 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 12 | 65255 | https://hadeethenc.com/ar/browse/hadith/65255 | yes | yes | 57 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides |
| 13 | 66520 | https://hadeethenc.com/ar/browse/hadith/66520 | yes | yes | 66 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 14 | 4714 | https://hadeethenc.com/ar/browse/hadith/4714 | yes | yes | 50 | uncertain | candidate 4714 is the same hadith (same companion) but a shorter variant that omits a clause the Forty has; candidate 58194 is a different chain with a different list of exceptions; no record in the Forty's wording found; likely a gap (D24) |
| 15 | 5437 | https://hadeethenc.com/ar/browse/hadith/5437 | yes | yes | 72 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides |
| 16 | 4709 | https://hadeethenc.com/ar/browse/hadith/4709 | yes | yes | 71 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides |
| 17 | 66521 | https://hadeethenc.com/ar/browse/hadith/66521 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 18 | 4302 | https://hadeethenc.com/ar/browse/hadith/4302 | yes | yes | 49 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides; the chain line shows invisible zero-width characters inside the text |
| 19 | 66522 | https://hadeethenc.com/ar/browse/hadith/66522 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith; includes the longer addition that the Forty gives after the first version |
| 20 | 66523 | https://hadeethenc.com/ar/browse/hadith/66523 | yes | yes | 66 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 21 | 66524 | https://hadeethenc.com/ar/browse/hadith/66524 | yes | yes | 68 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 22 | 66525 | https://hadeethenc.com/ar/browse/hadith/66525 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 23 | 66526 | https://hadeethenc.com/ar/browse/hadith/66526 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 24 | 4810 | https://hadeethenc.com/ar/browse/hadith/4810 | yes | yes | 71 | uncertain | same hadith (long divine-speech narration), standalone collection text; the body matches, but the record appears to differ from the Forty's printed wording in the opening formula and lacks the closing transmitter remark the Forty adds |
| 25 | 4558 | https://hadeethenc.com/ar/browse/hadith/4558 | yes | yes | 60 | uncertain | same hadith; the body matches, but one word of the opening frame appears to differ from the Forty's printed text |
| 26 | 66527 | https://hadeethenc.com/ar/browse/hadith/66527 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 27 | 66540 | https://hadeethenc.com/ar/browse/hadith/66540 | yes | yes | 58 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith; contains both parts (two companions) as the Forty does; sits out of numeric order at the end of the block |
| 28 | 66529 | https://hadeethenc.com/ar/browse/hadith/66529 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith (D68 anchor) |
| 29 | 66530 | https://hadeethenc.com/ar/browse/hadith/66530 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 30 | 66510 | https://hadeethenc.com/ar/browse/hadith/66510 | yes | yes | 60 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith; lowest id of the block, sits before hadith 1 |
| 31 | 4307 | https://hadeethenc.com/ar/browse/hadith/4307 | yes | yes | 58 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides |
| 32 | 66531 | https://hadeethenc.com/ar/browse/hadith/66531 | yes | yes | 59 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 33 | 66532 | https://hadeethenc.com/ar/browse/hadith/66532 | yes | yes | 59 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 34 | 65001 | https://hadeethenc.com/ar/browse/hadith/65001 | yes | yes | 71 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides; the narration shows invisible zero-width characters inside the text |
| 35 | 4706 | https://hadeethenc.com/ar/browse/hadith/4706 | yes | yes | 59 | uncertain | same hadith; the body matches, but the record appears to omit one clause that the Forty's printed text has in the list of brotherhood duties |
| 36 | 4801 | https://hadeethenc.com/ar/browse/hadith/4801 | yes | yes | 61 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides; possible honorific-level difference in one phrase only |
| 37 | 66533 | https://hadeethenc.com/ar/browse/hadith/66533 | yes | yes | 59 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 38 | 66534 | https://hadeethenc.com/ar/browse/hadith/66534 | yes | yes | 59 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith |
| 39 | 4216 | https://hadeethenc.com/ar/browse/hadith/4216 | yes | yes | 59 | matched | standalone record found by search; content matches the Forty's hadith; wording compared against the worker's recollection of the printed Forty, not an oracle, so verify decides |
| 40 | 4704 | https://hadeethenc.com/ar/browse/hadith/4704 | yes | yes | 61 | uncertain | same hadith; the record names the first narrator in a fuller form than the Forty and omits an honorific after the second mention of him |
| 41 | 66535 | https://hadeethenc.com/ar/browse/hadith/66535 | yes | yes | 59 | matched | block record (HadeethEnc's dedicated Forty run, ids 66510-66541); content matches the Forty's hadith (D68 anchor) |
| 42 | 5456 | https://hadeethenc.com/ar/browse/hadith/5456 | yes | yes | 62 | uncertain | same hadith (divine-speech narration); the record appears to differ from the Forty's printed wording in the epithet before the divine speech, in one word of the first clause, and in a repeated clause |

Every retrieved record returned both a Narrator field and a Grade field. Each `Source:` URL printed by the tool equals the canonical pattern above. `publishedLanguages` is the number of languages in HadeethEnc's own list for that record, as returned (a number only).

## Uncertain numbers: candidates for the coordinator

| fortyNumber | candidateIds | what to decide |
|---|---|---|
| 2 | 4563 | Include in a trial `--id-map` so that `verify` can adjudicate against the oracle, or record a D24 gap |
| 14 | 4714, 58194 | Include in a trial `--id-map` so that `verify` can adjudicate against the oracle, or record a D24 gap |
| 24 | 4810 | Include in a trial `--id-map` so that `verify` can adjudicate against the oracle, or record a D24 gap |
| 25 | 4558 | Include in a trial `--id-map` so that `verify` can adjudicate against the oracle, or record a D24 gap |
| 35 | 4706 | Include in a trial `--id-map` so that `verify` can adjudicate against the oracle, or record a D24 gap |
| 40 | 4704 | Include in a trial `--id-map` so that `verify` can adjudicate against the oracle, or record a D24 gap |
| 42 | 5456 | Include in a trial `--id-map` so that `verify` can adjudicate against the oracle, or record a D24 gap |

Searches for better candidates (phrases from the Forty's own opening, from the worker's knowledge) returned no other record for any of these seven numbers.

## Other records seen, not part of the Forty's 42 (not mapped)

| hadeethencId | publishedLanguages | note |
|---|---|---|
| 66536 | 58 | inside the block but not one of the 42; likely from the supplementary set that follows the Forty; not mapped |
| 66537 | 58 | inside the block but not one of the 42; likely from the supplementary set that follows the Forty; not mapped |
| 66538 | 58 | inside the block but not one of the 42; likely from the supplementary set that follows the Forty; not mapped |
| 66541 | 58 | inside the block but not one of the 42; likely from the supplementary set that follows the Forty; not mapped |
| 58194 | 13 | different chain with a different list of exceptions than Forty hadith 14; not mapped (candidate for 14 only as a non-match) |

## Ids scanned

- Range scan with `get_hadith` (language `ar`), one id per call: 66500 to 66560 inclusive (61 ids). The prescribed range was 66505-66560; 66500-66504 were added below it to bound the block.
- Records returned: 30 (66510-66527, 66529-66538, 66540, 66541). No record: 66500-66509, 66528, 66539, 66542-66560 (31 ids). The stop rule (8 consecutive empty ids) is met on both sides: 66500-66509 below and 66542-66560 above.
- Standalone candidates opened with `get_hadith` after `search`: 4211, 4216, 4302, 4307, 4558, 4563, 4704, 4706, 4709, 4714, 4801, 4810, 5437, 5456, 58194, 65001, 65255 (17 ids).

## Tool calls

- `get_hadith`: 78 (61 range scan + 17 candidates).
- `search` (language `ar`, sources `hadith`): 23 (one first-pass opening phrase for each of the 16 numbers missing from the block, plus 7 follow-ups: 3 more for hadith 2, 1 more for hadith 14, and 1 each for hadiths 24, 35 and 42).
- Total Islamic Content calls: 101, plus 1 ToolSearch call to load the three tool schemas.

## Technical flags for the CLI step

- Invisible zero-width characters appear inside the narration text of 66512, 4302 and 65001 (observed in the raw responses). `mcp_client.py` leaves ZWNJ untouched by design, so a verbatim comparison against an oracle without them could fail for these ids; check at `verify`.
- Narration text for 66514, 66522, 66540 and several standalone records contains more than one riwaya or part; the CLI stores the `[EXACT]` block as returned.
- Records outside the block carry the standard collection text; their wording can differ from the Forty's printed text in chain formulas, honorifics and single words (see the notes column).

## Open questions for the coordinator

1. For the 7 uncertain numbers (2, 14, 24, 25, 35, 40, 42): include them in a trial `--id-map` and let `verify` adjudicate, or record D24 gaps now? Hadith 14 is the clearest likely gap.
2. Is honorific-level variation (an added or missing epithet after a name or divine name) acceptable as "the Forty's wording" for numbers 8 and 36, as the D68 anchors suggest? If not, move them to uncertain.
3. Does the oracle used at `verify` contain the zero-width characters, or should the CLI strip them (see flag above)?

