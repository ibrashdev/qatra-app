// A return path (the ?next= of /login?next=<path>, UI-design 2.3 guard 1) is accepted only when it is a path inside this app.
// router.replace must never receive anything else: a foreign origin or a javascript: URL would leave the app or run script.

const ORIGIN_PROBE = "https://app.invalid";
const MAX_LENGTH = 512;

// Guest routes redirect a signed-in visitor anyway, and /api and /_next are not pages.
const EXCLUDED_ROOTS = ["/login", "/register", "/recovery", "/recovery-code", "/api", "/_next"];

export function safeNextPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  // A single leading slash only: "//host" is protocol-relative, and a backslash is read as a slash by browsers.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  if (Array.from(raw).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return null;

  let url: URL;
  try {
    url = new URL(raw, ORIGIN_PROBE);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN_PROBE) return null;
  if (EXCLUDED_ROOTS.some((root) => url.pathname === root || url.pathname.startsWith(`${root}/`))) return null;
  // The parsed form: dot segments are resolved, so "/a/../login" cannot slip past the list above.
  return `${url.pathname}${url.search}${url.hash}`;
}
