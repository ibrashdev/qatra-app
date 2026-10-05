import { formatInteger } from "@/i18n/format";
import type { Locale } from "@/i18n/messages";

// The options of the time-zone select of S-22 (UI-screens S-22 "Time zone options", O-46): the IANA names the browser knows, each with its
// current offset, sorted by offset and then by name. The profile's zone is always among them, and so is the browser's own.

// A native <option> holds text only, so a zone name cannot sit in a <bdi dir="ltr">. These two marks isolate it the same way.
const LTR_ISOLATE = "⁦";
const POP_ISOLATE = "⁩";

export interface TimeZoneOption {
  value: string;
  offsetMinutes: number;
  fromBrowser: boolean; // the browser's zone, marked only when it differs from the profile's
}

// The browsers write the sign of a long offset as a hyphen or as U+2212.
const LONG_OFFSET = /^GMT(?:([+\-−])(\d{1,2})(?::(\d{2}))?)?$/;

// The offset of `zone` at `at`, in minutes east of UTC. A zone the engine does not know counts as UTC: the select must still list it.
export function offsetMinutesOf(zone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = LONG_OFFSET.exec(name);
    if (match === null) return 0;
    const minutes = Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
    return match[1] === "+" || match[1] === undefined ? minutes : -minutes;
  } catch {
    return 0;
  }
}

function supportedZones(): readonly string[] {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

export interface TimeZoneInputs {
  profileZone: string; // the zone in force
  also?: readonly string[]; // any other zone that must be listed, for example the pending one
  browserZone: string;
  at?: Date;
}

export function timeZoneOptions({ profileZone, also = [], browserZone, at = new Date() }: TimeZoneInputs): TimeZoneOption[] {
  const names = new Set<string>([...supportedZones(), profileZone, ...also, browserZone]);
  return [...names]
    .map((value) => ({ value, offsetMinutes: offsetMinutesOf(value, at), fromBrowser: value === browserZone && value !== profileZone }))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

// «UTC+٤» in the Arabic interface, "UTC+4" in the English one; a half or quarter hour keeps its minutes («UTC+٥:٣٠»).
export function formatUtcOffset(locale: Locale, offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const total = Math.abs(offsetMinutes);
  const hours = formatInteger(locale, Math.floor(total / 60));
  const rest = total % 60;
  return `UTC${sign}${rest === 0 ? hours : `${hours}:${formatInteger(locale, rest).padStart(2, formatInteger(locale, 0))}`}`;
}

// The text of one option: the name and the offset, each isolated left to right, and the mark when it is the browser's zone.
export function timeZoneOptionLabel(locale: Locale, option: TimeZoneOption, fromBrowserText: string): string {
  const name = `${LTR_ISOLATE}${option.value}${POP_ISOLATE}`;
  const offset = `${LTR_ISOLATE}${formatUtcOffset(locale, option.offsetMinutes)}${POP_ISOLATE}`;
  return option.fromBrowser ? `${name} · ${offset} · ${fromBrowserText}` : `${name} · ${offset}`;
}
