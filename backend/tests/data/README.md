# Synthetic test data for the content workflow (B7)

Everything here is **synthetic**. There is **no religious text**: every Arabic string is made of
neutral placeholder words («كلمة», «مثال», «تجريبي», «نص», …). Surah 112 and the ids `990001`-
`990003` only borrow the real *structure* (four ayat; a HadeethEnc-shaped URL) so that the
validators and parsers can be exercised; the wording is invented. Real source text lives only in
the gitignored `backend/.content-build/` directory and never in git
(Implementation-contract §1, §2.7).

The committed synthetic **bundle** (`synthetic_bundle.json`, contract §2.6) is not here yet: it
is produced by the segmentation package (B8).

| File | Used for |
|---|---|
| `synthetic_quran_records.json` | `acquire --records` for `quran-hafs-quranenc` (surah 112, four invented ayat). Records-file format v1: `{formatVersion, tool, retrievedAt, acquisition, records[{surah, ayah, text, url}]}` |
| `synthetic_hadith_records_pass1.json`, `synthetic_hadith_records_pass2.json` | the two independent hadith passes (Forty numbers 1-3, fake ids 990001-990003; number 3 has an empty grade on purpose). The texts are identical; only `retrievedAt` differs |
| `synthetic_oracle.txt` | `verify --oracle`: one ayah per line as `surah\|ayah\|text`. Lines 1 and 3 carry a trailing ayah number (with U+06DD) that the verifier strips; lines 2 and 4 do not |
| `synthetic_mcp_quran_response.txt` | the observed `get_quran_verses` layout (`[Surah n, translation "..."]`, one `[EXACT]` block with `[s:a]` markers, a verse line, a **tafsir line that must be dropped**, `Source:` line) |
| `synthetic_mcp_hadith_response.txt` | the observed `get_hadith` layout (title, `[EXACT]` narration, `[ATTRIBUTION]` with `Narrator:`/`Grade:`, a `[COMMENTARY]` block that must be ignored, `Source:` line, a languages sentence) |

Notes and limits:

- The two MCP response layouts follow `references/source-acquisition/mcp-evidence.json`
  (`claude_code_session_probe_2026_10_04`). The **languages sentence** of the hadith layout
  (`Published languages: ar, en, fr.`) is an assumption: the evidence only says the real answer
  ends with "a sentence listing the published languages". The parser reads it loosely and nothing
  depends on it.
- The verse and narration texts in the JSON records, the MCP response files and the oracle are
  kept equal on purpose (a test checks it), and all strings are NFC.
- `tests/workflow/test_wf_fixtures.py` fails if a fixture contains a word outside the placeholder
  vocabulary, which guards against committing real source text by accident.
