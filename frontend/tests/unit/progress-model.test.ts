import { describe, expect, it } from "vitest";
import { clampPercent, groupSections, sectionKind, selectPlan } from "@/components/progress/progress-model";
import { mockProgress } from "@/lib/api/mock/today-handlers";
import type { PlanProgress, ProgressResponse } from "@/lib/api/types";

const basePlan = mockProgress.plans[0] as PlanProgress;
const plan = (change: Partial<PlanProgress>): PlanProgress => ({ ...basePlan, ...change });
const response = (...plans: PlanProgress[]): ProgressResponse => ({ ...mockProgress, plans });

type Section = PlanProgress["sections"][number];
const section = (ordinal: number, status: Section["status"], titleEn = `Surah ${ordinal}`): Section => ({ ordinal, reference: String(ordinal), titleAr: `اسم ${ordinal}`, titleEn, percent: 10, status });

describe("selectPlan", () => {
  it("prefers the active plan, then a completed one", () => {
    const active = plan({ planId: "a", status: "active" });
    const completed = plan({ planId: "c", status: "completed" });
    expect(selectPlan(response(completed, active))).toEqual({ kind: "plan", plan: active, completed: false });
    expect(selectPlan(response(plan({ planId: "p", status: "paused" }), completed))).toEqual({ kind: "plan", plan: completed, completed: true });
  });

  it("has no plan to show with only paused plans or none, and says whether a paused one exists", () => {
    expect(selectPlan(response(plan({ status: "paused" })))).toEqual({ kind: "none", hasPausedPlan: true });
    expect(selectPlan(response())).toEqual({ kind: "none", hasPausedPlan: false });
  });
});

describe("groupSections", () => {
  const sections = [section(1, "confirmed"), section(2, "new"), section(3, "reviewing"), section(4, "needs_refresh"), section(5, "learning")];

  it("orders the groups needs refresh, in progress, confirmed, and keeps each section in its received order", () => {
    const groups = groupSections(plan({ sections }));
    expect(groups.map((group) => group.id)).toEqual(["needsRefresh", "progress", "confirmed"]);
    expect(groups[1]?.rows.map((row) => row.ordinal)).toEqual([3, 5]);
  });

  it("leaves new sections in no group and drops empty groups", () => {
    expect(groupSections(plan({ sections: [section(1, "new"), section(2, "new")] }))).toEqual([]);
    expect(groupSections(plan({ sections: [section(1, "confirmed")] })).map((group) => group.id)).toEqual(["confirmed"]);
  });

  it("opens needs refresh and in progress, and closes confirmed", () => {
    expect(groupSections(plan({ sections })).map((group) => [group.id, group.open])).toEqual([
      ["needsRefresh", true],
      ["progress", true],
      ["confirmed", false],
    ]);
  });
});

describe("sectionKind and clampPercent", () => {
  it("reads the noun from the numeric English labels", () => {
    expect(sectionKind(plan({ sections: [section(1, "new", "Surah 78")] }))).toBe("surah");
    expect(sectionKind(plan({ sections: [section(1, "new", "Hadith 1")] }))).toBe("hadith");
    expect(sectionKind(plan({ sections: [section(1, "new", "Chapter")] }))).toBe("section");
    expect(sectionKind(plan({ sections: [] }))).toBe("section");
  });

  it("keeps a percent inside 0 to 100 and whole", () => {
    expect([clampPercent(-5), clampPercent(27.9), clampPercent(140)]).toEqual([0, 27, 100]);
  });
});
