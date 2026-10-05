// The two latest routes of this visit, in memory only: nothing is stored, and a reload starts empty.
// A screen that needs to know where the visitor came from asks here (S-03 names the screen it was opened from).
let current: string | null = null;
let previous: string | null = null;

// Called by the tracker once a route has been committed. The same path again (a hash or a re-render) changes nothing.
export function noteRoute(pathname: string): void {
  if (pathname === current) return;
  previous = current;
  current = pathname;
}

// The route before `pathname`. A screen can ask while it renders, before the tracker has seen its own path: the current route is then
// still the one it replaces. Once the tracker has run, the same answer is the previous route.
export function routeBefore(pathname: string): string | null {
  return current === pathname ? previous : current;
}

export function resetRouteHistoryForTests(): void {
  current = null;
  previous = null;
}
