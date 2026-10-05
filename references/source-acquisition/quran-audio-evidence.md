# Quran audio list (Husary, Juz' Amma): acquisition evidence (Sprint 3, D68, D81)

Prepared: 2026-10-05. Worker: W-AUDL, content-workflow engineer (Role 6), checked by the coordinator. Status: Acquired metadata, Needs Review; not wired into the app. Two acquisition runs were made on 2026-10-05: the first (01:53Z to 01:58Z, 05:53 to 05:58 Asia/Dubai) used the default `/en/` verse page links and was replaced; the second and final run (02:04Z to 02:08Z, 06:04 to 06:08 Asia/Dubai) used `language: "ar"`. The JSON holds the final run.

No religious text was stored. This file and `quran-audio-husary-juz-amma.json` hold verse numbers, URLs, counts and neutral notes only. The verse text and default translation that `get_quran_verses` returns were parsed in memory for the verse numbers and discarded; nothing of them was written to disk.

## Purpose and authority

- Purpose: a per-verse Husary audio reference list for Juz' Amma (surahs 78 to 114) as metadata-only evidence for the later manifest generator (QAUD-02) and app manifest. No audio file was fetched.
- Owner's words on 5 October 2026 in the Sprint 3 session, as relayed in the worker brief, answering where the Quran audio list should come from: "The Quran audio list: mcp.islamiccontent.org".
- D68: the Islamic Content MCP is the approved source for both books (Juz' Amma from QuranEnc). D81 Q2: the owner allows mcp.islamiccontent.org for content acquisition and verification.
- Design reference: `docs/Quran-audio-streaming.addendum.md` (sections 2, 3.1, 3.4, 3.5, 6), still Draft, Needs Review. This work does not approve it and creates neither the generator nor `frontend/src/lib/quran-audio/manifest.generated.json`.

## Method

- Endpoint `https://mcp.islamiccontent.org/mcp`, Streamable HTTP, JSON-RPC 2.0, protocolVersion 2025-06-18: `initialize`, then the `notifications/initialized` notification, then `tools/call`. Headers `Content-Type: application/json`, `Accept: application/json, text/event-stream` and a descriptive `User-Agent`. The `initialize` answer was `text/event-stream` (`event: message` and `data:` lines), as the brief states; the script parser accepts server-sent events or plain JSON and handled every answer. The server returned no `Mcp-Session-Id` (it is stateless, as its home page says) and identified itself as `islamic-content` 0.1.0.
- Client: a small Python script kept outside the repository. Sequential, at least 0.4 s between request starts (measured 2.50 requests per second over the first audio pass and 2.48 over the final one, under the 3 per second limit), at most 2 retries per failed call with 2 s and 5 s pauses.
- Verse numbers: `get_quran_verses {"surah": s}` for s = 78 to 114 (37 calls in the first run, not repeated; whole surah, no other arguments). Only the verse numbers were read, from the standalone marker lines of the exact-text block (footnote references in the commentary block ignored). Every surah returned 1 to N without gaps and without a truncation notice.
- Audio links, first run (replaced): `get_quran_audio {"surah": s, "ayah": a, "reciter": "husary"}` for each of the 564 verses. These arguments omit `language`, so the verse page links came back as `/en/`.
- Audio links, final run: the same call plus `"language": "ar"` for each of the 564 verses (decision below). The MP3 URL and the verse page URL were kept exactly as returned. The first line of every response named the requested reference and the reciter key.
- Timing: first run, verse numbers finished 01:53:43Z and audio pass 01:54:29Z to 01:58:15Z. Final run, audio pass 02:04:15Z to 02:08:02Z. `acquiredAt` in the JSON is 2026-10-05T02:08:02Z.
- Calls, first run (replaced): 630 script HTTP attempts, 627 succeeded and 3 failed. Succeeded: 7 `initialize` handshakes (each followed by the notification), 1 `tools/list`, 40 `get_quran_verses` (37 for the list, 3 diagnostic), 572 `get_quran_audio` (564 for the list; 8 diagnostic: two format probes for 78:1, with and without `language: "ar"`, one label probe for 114:6, five random spot-checks). Plus 6 curl requests to the same host (4 page GETs: terms, home, its `/en` path, privacy; 2 `initialize` probes), all HTTP 200.
- Calls, final run: 576 script HTTP attempts, all succeeded, none retried: 3 handshakes, 570 `get_quran_audio` (564 for the list, 1 format probe for 78:1, 5 random spot-checks). Both runs together: 1,206 script attempts plus 6 curl requests, all to mcp.islamiccontent.org. Nothing was sent to everyayah.com.
- Error and retries: the first script run (first run only) failed at `initialize` with HTTP 403 on all 3 attempts (1 call and 2 retries, 01:49:31Z to 01:49:38Z). The service sits behind Cloudflare, which refused the default `Python-urllib/3.11` User-Agent; curl's default agent and the agent string `python-httpx/0.28.1` (the default of the httpx client in `backend/app/workflow/mcp_client.py`) were each accepted in one `initialize` probe. The fix was an explicit descriptive User-Agent. No other call failed and no retry was needed in either run.

## Validation results

- Total entries: 564. The addendum (section 1) and Implementation-contract 2.1 state 564. Difference: 0.
- Per surah (surah=verses): 78=40, 79=46, 80=42, 81=29, 82=19, 83=36, 84=25, 85=22, 86=17, 87=19, 88=26, 89=30, 90=20, 91=15, 92=21, 93=11, 94=8, 95=8, 96=19, 97=5, 98=8, 99=8, 100=11, 101=11, 102=8, 103=3, 104=9, 105=5, 106=4, 107=7, 108=3, 109=6, 110=3, 111=5, 112=4, 113=5, 114=6.
- MP3 URLs: all 564 equal `https://everyayah.com/data/Husary_64kbps/SSSAAA.mp3` exactly, with SSS and AAA the zero-padded surah and verse of the entry: HTTPS, host exactly everyayah.com, no port, query, fragment or credentials. `checks.urlPattern` is "passed". The final run's 564 MP3 URLs are byte-identical to the first run's (564 of 564, 0 different; the ordered URL lists have the same SHA-256, da0e3e9f1547fdee92243c75569f31afee51378f44d2640f65b80d1d9673d7f9), so the `language` argument does not change them.
- Verse page URLs: all 564 equal `https://islamenc.com/ar/quran/<surah>/<verse>` exactly: HTTPS on `islamenc.com` (the QuranEnc reference site named in D68), naming the same surah and verse as the entry, with no port, query, fragment or credentials. Each is the Arabic counterpart of the first run's `/en/` link for the same verse (564 of 564).
- References are unique and ascending by surah then verse. The verses that have audio links are exactly the verses `get_quran_verses` returned.
- Independent self-check, rerun on the final file: a separate script re-read the written JSON and rechecked every rule above (0 failures) and the file format (LF only, one final newline, ASCII only, no dash characters). A field-by-field comparison with the first-run file showed only the expected differences: the `versePageUrl` values, `acquiredAt`, and the added `source.versePageLanguage`.
- Spot-check: 5 random entries (78:30, 79:8, 80:29, 81:13, 85:9) were requested again with fresh `get_quran_audio` calls using `language: "ar"`; the MP3 URL and verse page URL were identical to the file in 5 of 5. The first run's own self-check and 5 spot-checks (default language) had also passed.

## Decision: verse page language

The optional `language` argument of `get_quran_audio` (default "en") selects only the language of the verse page link. The first run omitted it and received `/en/` links. D68 and the addendum's 4 October sample use the `/ar/` pattern (`https://islamenc.com/ar/quran/78/1`), and the coordinator decided on 2026-10-05 to use the Arabic links, so the final run replaced the first and `source.versePageLanguage` in the JSON is "ar". The MP3 URLs are the same in both runs.

## Terms checked (read 2026-10-05)

- Terms of Use, `https://mcp.islamiccontent.org/terms.html`, last updated 14 September 2026: read-only programmatic access to published Islamic texts for AI assistants through MCP, free of charge. The server retrieves and cites published texts and issues no rulings; translations and gradings are the work of the publishing institutions. Operator: Association for Multi-lingual Islamic Content (islamiccontent.sa), licensed charity no. 2131. The page states no numeric rate limit, no attribution wording, no reuse, redistribution or licence terms, and says nothing about audio files.
- Home page FAQ (Arabic; the English rendering is mine): the service is free and needs no key or registration, and "reasonable rate limits are applied to protect the sources". It also says every result carries a public link to its original source, that it keeps no accounts and does no tracking, and that it is stateless. The privacy page (14 September 2026) says no account is needed and no personal information is collected.
- Notice in every response: a CITE block asks that the returned links be carried in full, exactly as returned, beside whatever is taken from the text. Both links are stored verbatim for every verse in the JSON file.
- Constraints that apply: (1) rate, unspecified "reasonable" limits, so keep requests sequential and paced (done: sequential, about 2.5 requests per second in both runs); (2) attribution, keep the returned links verbatim (done: `audioUrl` and `versePageUrl`; cite the service when the list is used); (3) reuse, not addressed by the terms. The audio files belong to another party (everyayah.com), and a service answer or a working link does not grant republication rights (addendum section 4). No licence is inferred. G5 and G6 are not granted by this work.

## What this does not establish

- That any of the 564 MP3 files exists, is complete or is served correctly. everyayah.com is not reachable from this environment and nothing was requested from it. The only availability evidence remains the two samples in addendum section 6 (78:1 and 114:6, 4 October 2026).
- That a file matches its verse, the reciter or the narration. The folder name `Husary_64kbps` comes from the service; nobody listened.
- Playback, content type, byte ranges, redirects or CORS behaviour (addendum sections 3.5 and 6).
- Rights to reuse or republish the audio, beyond the terms stated above.
- The approval of the audio design, or any wiring. No generator and no app manifest were created, and nothing in the app changed.
- That the verse numbers agree with any other numbering source. They come from the QuranEnc-backed service; only the total (564) was compared, with the addendum.

## Next steps

1. After the owner decides on the audio design (addendum version 2), QAUD-02a (generator with synthetic fixtures) and QAUD-02b (real manifest) can take this list as input. The generator records its own generation and verification times and checks every file over HTTPS once everyayah.com is reachable (D81 Q2 lists it for that purpose), without leaving that host.
2. QAUD-04 on 6 October: source and device checks (all 564 files over the network; Safari iOS and Chrome Android; Arabic RTL and English LTR; keyboard and screen reader), and a listening or other matching check for reciter and verse.
3. Any client for this service must send a descriptive User-Agent; urllib's default is refused with HTTP 403 (the httpx default of the repository's workflow client was accepted in one probe).
