import { describe, expect, it } from "vitest";
import { absentGames, learningDateOf, missingGames, provisionalActiveMs, provisionalDaily, provisionalTodayMs, sessionEntries, snapshotTextKind, summarizeRun } from "@/components/pwa/offline-model";
import type { PlanSnapshot } from "@/lib/api/types";
import type { PendingEvent, RevalidationRecord } from "@/lib/offline/types";
import { DAILY_SESSION, GAME_SESSION, activityAt, answerAt, makeSnapshot, orderQuestion, uuid } from "./offline-support";

const snapshot = makeSnapshot();
const RUN = "99999999-9999-4999-8999-999999999999";

function pending(event: PendingEvent["event"], state: PendingEvent["state"] = "queued"): Pick<PendingEvent, "event" | "state"> {
  return { event, state };
}

describe("the sessions a snapshot offers (S-31)", () => {
  it("lists the daily descriptor first, then the games in the order of the hub, and names the games it has no descriptor for", () => {
    const entries = sessionEntries(snapshot, null);
    expect(entries.map((entry) => entry.kind)).toEqual(["daily", "word_order"]);
    expect(entries.every((entry) => entry.runnable)).toBe(true);
    expect(missingGames(entries)).toEqual(["word_choice", "similar_distinction", "word_recall"]);
  });

  it("narrows the runnable sessions to the ones E25 lists, and ignores an empty list or a status other than available", () => {
    const record = (status: RevalidationRecord["status"], allowedSessionRefs: string[]): RevalidationRecord => ({
      snapshotId: snapshot.snapshotId,
      status,
      reasonCode: "current",
      currentPlanVersion: 1,
      allowedSessionRefs,
      catalogVersion: 3,
      at: "2026-10-06T00:00:00.000Z",
    });
    expect(sessionEntries(snapshot, record("available", [DAILY_SESSION])).map((entry) => entry.runnable)).toEqual([true, false]);
    expect(sessionEntries(snapshot, record("available", [GAME_SESSION])).map((entry) => entry.runnable)).toEqual([false, true]);
    expect(sessionEntries(snapshot, record("available", [])).every((entry) => entry.runnable)).toBe(true);
    expect(sessionEntries(snapshot, record("stale", [DAILY_SESSION])).every((entry) => entry.runnable)).toBe(true);
  });

  it("marks a descriptor with no drawable question as not runnable and skips one that is not prepared", () => {
    const broken: PlanSnapshot = {
      ...snapshot,
      preparedSessions: [
        { ...snapshot.preparedSessions[0]!, steps: snapshot.preparedSessions[0]!.steps.filter((step) => step.type === "learn") },
        { ...snapshot.preparedSessions[1]!, status: "open" },
      ],
    };
    const entries = sessionEntries(broken, null);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "daily", runnable: false });
  });

  it("says why a game has no row: the material has no question of its kind, or it has some but no prepared session can be started", () => {
    // The fixture holds questions of three kinds (choice, recall, order) and no similar passages, as a short surah can.
    expect(absentGames(snapshot, sessionEntries(snapshot, null))).toEqual([
      { kind: "word_choice", reason: "needs_connection" },
      { kind: "similar_distinction", reason: "no_material" },
      { kind: "word_recall", reason: "needs_connection" },
    ]);
  });

  it("counts only the question bank and the game descriptors as material, never the questions of the daily session", () => {
    const passageId = snapshot.downloadedTargetRefs[0]!;
    const onlyOrder: PlanSnapshot = { ...snapshot, games: [orderQuestion("q-order", passageId)] };
    // The daily session still holds a choice and a recall question, yet a connection would not prepare those games: the bank has none.
    expect(absentGames(onlyOrder, sessionEntries(onlyOrder, null)).map((absent) => [absent.kind, absent.reason])).toEqual([
      ["word_choice", "no_material"],
      ["similar_distinction", "no_material"],
      ["word_recall", "no_material"],
    ]);
  });

  it("keeps the connection line for a game whose descriptor is no longer prepared, even when the bank is empty", () => {
    const used: PlanSnapshot = { ...snapshot, games: [], preparedSessions: [snapshot.preparedSessions[0]!, { ...snapshot.preparedSessions[1]!, status: "completed" }] };
    expect(absentGames(used, sessionEntries(used, null))).toEqual([
      { kind: "word_order", reason: "needs_connection" },
      { kind: "word_choice", reason: "no_material" },
      { kind: "similar_distinction", reason: "no_material" },
      { kind: "word_recall", reason: "no_material" },
    ]);
  });

  it("gives no absent game when every game of the hub has a row", () => {
    const entries = sessionEntries(snapshot, null);
    expect(absentGames(snapshot, [...entries, ...missingGames(entries).map((kind) => ({ ...entries[1]!, kind }))])).toEqual([]);
  });

  it("takes the font of the book text from the lessons: a Quran path is quran, any other is hadith, none falls back to quran", () => {
    expect(snapshotTextKind(snapshot)).toBe("quran");
    expect(snapshotTextKind({ ...snapshot, lessons: [{ ...snapshot.lessons[0]!, path: "matn" }] })).toBe("hadith");
    expect(snapshotTextKind({ ...snapshot, lessons: [] })).toBe("quran");
  });
});

describe("the provisional figures of the day (D40: never a completed day)", () => {
  it("counts overlapping intervals once and ignores answers and blocked events", () => {
    const events = [
      pending(activityAt(snapshot, RUN, 0, 0, 60_000)),
      pending(activityAt(snapshot, RUN, 1, 30_000, 60_000)), // overlaps the first by 30 s: the union is 90 s
      pending(activityAt(snapshot, RUN, 2, 300_000, 10_000)),
      pending(activityAt(snapshot, RUN, 3, 500_000, 99_000), "blocked"),
      pending(answerAt(snapshot, RUN, 4)),
    ];
    expect(provisionalActiveMs(events)).toBe(100_000);
    expect(provisionalActiveMs([])).toBe(0);
  });

  it("caps the percentage at 100 and never says the day is completed", () => {
    const over = provisionalDaily("2026-10-06", 600_000, 900_000);
    expect(over).toMatchObject({ dailyPercent: 100, dailyCompleted: false, dailyActiveMs: 900_000, extraActiveMs: 0 });
    expect(provisionalDaily("2026-10-06", 600_000, 150_000).dailyPercent).toBe(25);
    expect(provisionalDaily("2026-10-06", 0, 150_000).dailyPercent).toBe(0);
  });

  it("names the learning date in the plan's time zone and counts only the intervals of that day", () => {
    // 2026-10-05 21:00 UTC is already 2026-10-06 at 01:00 in Dubai.
    const evening = Date.parse("2026-10-05T21:00:00.000Z");
    expect(learningDateOf(evening, "Asia/Dubai")).toBe("2026-10-06");
    expect(learningDateOf(evening, "UTC")).toBe("2026-10-05");
    expect(learningDateOf(evening, "Not/AZone")).toBe("2026-10-05");
    const events = [pending(activityAt(snapshot, RUN, 0, 0, 20_000)), pending(activityAt(snapshot, RUN, 1, 40 * 3_600_000, 20_000))]; // 2026-10-05 10:00 UTC and 2026-10-07 02:00 UTC
    expect(provisionalTodayMs(events, "UTC", Date.parse("2026-10-05T12:00:00.000Z"))).toBe(20_000);
  });
});

describe("the local summary of a run", () => {
  it("counts each question once with its local first verdict, and sums the active time", () => {
    const questions = snapshot.preparedSessions[0]!.steps.flatMap((step) => (step.type === "question" ? [step.question] : []));
    const events = [
      answerAt(snapshot, RUN, 0, 0, { questionId: "q-choice", answer: { optionId: "q-choice-a" } }), // right
      answerAt(snapshot, RUN, 1, 1000, { questionId: "q-choice", answer: { optionId: "q-choice-b" } }), // the same question again: not counted twice
      answerAt(snapshot, RUN, 2, 2000, { questionId: "q-recall", answer: { text: "wrong" }, hintUsed: true }), // wrong and assisted
      activityAt(snapshot, RUN, 3, 0, 4000),
      activityAt(snapshot, RUN, 4, 10_000, 6000),
    ];
    expect(summarizeRun(events, questions)).toEqual({ answered: 2, correct: 1, assisted: 1, total: 2, activeMs: 10_000 });
    expect(summarizeRun([], questions)).toEqual({ answered: 0, correct: 0, assisted: 0, total: 2, activeMs: 0 });
    // An answer for a question that is not in the descriptor is ignored.
    expect(summarizeRun([answerAt(snapshot, RUN, 0, 0, { questionId: uuid() })], questions).answered).toBe(0);
  });
});
