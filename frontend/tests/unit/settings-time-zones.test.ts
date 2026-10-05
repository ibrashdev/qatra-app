import { describe, expect, it } from "vitest";
import { formatUtcOffset, offsetMinutesOf, timeZoneOptionLabel, timeZoneOptions } from "@/lib/settings/time-zones";

// A fixed instant, so a zone with daylight saving has one answer (5 October 2026, noon UTC).
const AT = new Date("2026-10-05T12:00:00Z");

describe("S-22 time-zone offsets", () => {
  it("reads the current offset of a zone in minutes east of UTC", () => {
    expect(offsetMinutesOf("Asia/Dubai", AT)).toBe(240);
    expect(offsetMinutesOf("Asia/Kolkata", AT)).toBe(330);
    expect(offsetMinutesOf("America/New_York", AT)).toBe(-240);
    expect(offsetMinutesOf("UTC", AT)).toBe(0);
  });

  it("counts a zone the engine does not know as UTC, so it can still be listed", () => {
    expect(offsetMinutesOf("Not/AZone", AT)).toBe(0);
  });
});

describe("S-22 offset text", () => {
  it("writes the Arabic interface in Arabic-Indic digits and the English one in Western digits", () => {
    expect(formatUtcOffset("ar", 240)).toBe("UTC+٤");
    expect(formatUtcOffset("en", 240)).toBe("UTC+4");
  });

  it("keeps the minutes of a half or quarter hour, and the sign of a west zone", () => {
    expect(formatUtcOffset("en", 330)).toBe("UTC+5:30");
    expect(formatUtcOffset("ar", 330)).toBe("UTC+٥:٣٠");
    expect(formatUtcOffset("en", 345)).toBe("UTC+5:45");
    expect(formatUtcOffset("en", -210)).toBe("UTC-3:30");
    expect(formatUtcOffset("en", 0)).toBe("UTC+0");
  });
});

describe("S-22 time-zone options (O-46)", () => {
  const options = timeZoneOptions({ profileZone: "Asia/Dubai", browserZone: "Asia/Dubai", at: AT });

  it("lists the zones the browser knows, sorted by offset and then by name", () => {
    expect(options.length).toBeGreaterThan(100);
    for (let index = 1; index < options.length; index += 1) {
      const before = options[index - 1];
      const after = options[index];
      if (before === undefined || after === undefined) throw new Error("hole in the list");
      expect(before.offsetMinutes <= after.offsetMinutes).toBe(true);
      if (before.offsetMinutes === after.offsetMinutes) expect(before.value < after.value).toBe(true);
    }
  });

  it("always has the profile's zone, even one the browser does not list", () => {
    const list = timeZoneOptions({ profileZone: "UTC", browserZone: "Asia/Dubai", at: AT });
    expect(list.find((option) => option.value === "UTC")).toMatchObject({ offsetMinutes: 0 });
  });

  it("adds the zones that must be listed, such as the pending one", () => {
    const list = timeZoneOptions({ profileZone: "Asia/Dubai", also: ["Custom/Pending"], browserZone: "Asia/Dubai", at: AT });
    expect(list.some((option) => option.value === "Custom/Pending")).toBe(true);
  });

  it("marks the browser's zone only when it differs from the profile's", () => {
    expect(options.some((option) => option.fromBrowser)).toBe(false);
    const other = timeZoneOptions({ profileZone: "Asia/Dubai", browserZone: "Europe/London", at: AT });
    expect(other.filter((option) => option.fromBrowser).map((option) => option.value)).toEqual(["Europe/London"]);
  });

  it("lists each zone once", () => {
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
  });
});

describe("S-22 time-zone option text", () => {
  const dubai = { value: "Asia/Dubai", offsetMinutes: 240, fromBrowser: false };

  it("isolates the name and the offset left to right and joins them with a middle dot", () => {
    expect(timeZoneOptionLabel("ar", dubai, "من المتصفح")).toBe("⁦Asia/Dubai⁩ · ⁦UTC+٤⁩");
    expect(timeZoneOptionLabel("en", dubai, "From the browser")).toBe("⁦Asia/Dubai⁩ · ⁦UTC+4⁩");
  });

  it("adds the mark for the browser's zone", () => {
    expect(timeZoneOptionLabel("ar", { ...dubai, fromBrowser: true }, "من المتصفح")).toBe("⁦Asia/Dubai⁩ · ⁦UTC+٤⁩ · من المتصفح");
  });
});
