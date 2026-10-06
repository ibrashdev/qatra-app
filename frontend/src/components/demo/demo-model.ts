import type { DemoScenario, DemoSimulation, DemoSimulationDay, SimulationAdjustment } from "@/lib/api/demo-endpoints";
import type { Locale } from "@/i18n/messages";

// The answers of E27 and E29 are read, not trusted: an element with a missing or wrong field is dropped, so a bad row never breaks the screen.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

const ADJUSTMENTS: readonly SimulationAdjustment[] = ["absence_light_review", "error_priority", "pace_reduced"];

export function readScenarios(value: unknown): DemoScenario[] {
  const list = isRecord(value) && Array.isArray(value.scenarios) ? value.scenarios : [];
  return list.flatMap((entry: unknown) => {
    if (!isRecord(entry) || !isText(entry.scenarioId) || !isText(entry.titleAr) || !isText(entry.titleEn)) return [];
    const ordinals = isRecord(entry.targetScope) && Array.isArray(entry.targetScope.sectionOrdinals) ? entry.targetScope.sectionOrdinals.filter(isCount) : [];
    return [
      {
        scenarioId: entry.scenarioId,
        titleAr: entry.titleAr,
        titleEn: entry.titleEn,
        editionKey: typeof entry.editionKey === "string" ? entry.editionKey : "",
        targetScope: { sectionOrdinals: ordinals },
      },
    ];
  });
}

function readDay(entry: unknown): DemoSimulationDay[] {
  if (!isRecord(entry) || !isCount(entry.day) || !isCount(entry.newWords) || !isCount(entry.reviews)) return [];
  const adjustment = ADJUSTMENTS.find((name) => name === entry.adjustment) ?? null;
  return [
    {
      day: entry.day,
      newWords: entry.newWords,
      reviews: entry.reviews,
      lightReviewDay: entry.lightReviewDay === true,
      adjustment,
      confirmedWordsCumulative: isCount(entry.confirmedWordsCumulative) ? entry.confirmedWordsCumulative : 0,
      overallPercent: isCount(entry.overallPercent) ? Math.min(100, Math.floor(entry.overallPercent)) : 0,
    },
  ];
}

export function readSimulations(value: unknown): DemoSimulation[] {
  const list = isRecord(value) && Array.isArray(value.simulations) ? value.simulations : [];
  return list.flatMap((entry: unknown) => {
    if (!isRecord(entry) || !isText(entry.simulationId) || !isText(entry.titleAr) || !isText(entry.titleEn) || !Array.isArray(entry.days)) return [];
    const profile = isRecord(entry.profile) ? entry.profile : {};
    const script = isRecord(entry.learnerScript) ? entry.learnerScript : {};
    const dayNumbers = (raw: unknown): number[] => (Array.isArray(raw) ? raw.filter(isCount) : []);
    return [
      {
        simulationId: entry.simulationId,
        scenarioId: typeof entry.scenarioId === "string" ? entry.scenarioId : "",
        titleAr: entry.titleAr,
        titleEn: entry.titleEn,
        // Whatever the file says, this screen only ever shows a precomputed result.
        label: "precomputed_synthetic" as const,
        profile: {
          name: typeof profile.name === "string" ? profile.name : "",
          totalWords: isCount(profile.totalWords) ? profile.totalWords : 0,
          sessionMinutes: isCount(profile.sessionMinutes) ? profile.sessionMinutes : 0,
        },
        learnerScript: {
          dailyCorrectRate: isCount(script.dailyCorrectRate) ? script.dailyCorrectRate : 0,
          absentDays: dayNumbers(script.absentDays),
          errorDays: dayNumbers(script.errorDays),
        },
        days: entry.days.flatMap(readDay),
      },
    ];
  });
}

// The title in the interface language; the other language is the field of the same row, never a translation made here.
export const scenarioTitle = (locale: Locale, scenario: Pick<DemoScenario, "titleAr" | "titleEn">): string => (locale === "ar" ? scenario.titleAr : scenario.titleEn);
export const simulationTitle = (locale: Locale, simulation: Pick<DemoSimulation, "titleAr" | "titleEn">): string => (locale === "ar" ? simulation.titleAr : simulation.titleEn);

// A rate of 0.8 is shown as 80; both 0 to 1 and 0 to 100 are read in the way the fixture writes them (a value above 1 is already a percent).
export function correctRatePercent(rate: number): number {
  return Math.min(100, Math.round(rate <= 1 ? rate * 100 : rate));
}
