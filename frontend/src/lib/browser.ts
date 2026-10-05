// Browser calls that a test replaces: jsdom cannot reload a page.
export function reloadPage(): void {
  window.location.reload();
}

// The IANA time zone the browser reports, for E03. A browser that reports none gets UTC, which Settings can correct later (UI-screens O-15).
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
