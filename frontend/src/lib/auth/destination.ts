import type { Endpoints } from "@/lib/api/endpoints";

export type HomePath = "/today" | "/start";

// Where a signed-in visitor lands: /start when E18 says there is no plan, else /today (UI-design 2.3 guard 2).
// A failed read must not strand someone who just signed in, so any failure falls back to /today, which handles its own states.
export async function homeDestination(api: Pick<Endpoints, "today">, signal?: AbortSignal): Promise<HomePath> {
  try {
    const today = await api.today({ signal });
    return today.plan === null ? "/start" : "/today";
  } catch {
    return "/today";
  }
}
