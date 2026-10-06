// The learner pages that only read: when the device goes offline on one of them, the open page makes way for the downloaded plan (PWA-design 6). Everything
// else (a form, the admin area, the demo, a result, plan revision, the settings page and its sub-pages) keeps its page and its unsent input, and shows a notice
// instead. Settings is one of those on purpose: it holds the logout, which works offline (PWA-design 7, R23 case 7), so the page must stay.
const OFFLINE_SWAP_ROUTES: ReadonlySet<string> = new Set(["/today", "/plan", "/progress", "/games", "/lessons", "/settings/sources"]);

export function isOfflineSwapRoute(pathname: string | null | undefined): boolean {
  if (pathname === null || pathname === undefined || pathname === "") return false;
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return OFFLINE_SWAP_ROUTES.has(trimmed);
}
