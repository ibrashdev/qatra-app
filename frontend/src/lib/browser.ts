// Browser calls that a test replaces: jsdom cannot reload a page.
export function reloadPage(): void {
  window.location.reload();
}
