import { sleep } from "../sleep";
import { errorResponse, mockHandlers, type MockHandler, type MockResponse, type MockScenario } from "./handlers";

export interface MockFetchOptions {
  latencyMs?: number; // simulated round trip, so loading states can be seen
  coldStartMs?: number; // for this long after creation every answer is a 503 page outside the envelope, like a sleeping free server
  scenario?: Partial<MockScenario>;
  handlers?: Readonly<Record<string, MockHandler>>;
  now?: () => number;
}

function toResponse({ status, body }: MockResponse): Response {
  if (status === 204 || body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function readBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return undefined;
  try {
    return JSON.parse(init.body);
  } catch {
    return undefined;
  }
}

// A fetch-compatible function: the real client code (envelope parsing, timeouts) runs unchanged in mock mode.
export function createMockFetch(options: MockFetchOptions = {}): typeof fetch {
  const { latencyMs = 120, coldStartMs = 0, handlers = mockHandlers, now = Date.now } = options;
  const scenario: MockScenario = { signedIn: true, hasPlan: true, ...options.scenario };
  const createdAt = now();

  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, "http://mock.invalid");
    if (!url.pathname.startsWith("/api/")) throw new TypeError("The mock layer only serves /api/*.");
    if (latencyMs > 0) await sleep(latencyMs, init?.signal);
    if (coldStartMs > 0 && now() - createdAt < coldStartMs) {
      return new Response("<!doctype html><title>Starting</title>", { status: 503, headers: { "Content-Type": "text/html" } });
    }
    const path = url.pathname.slice("/api".length);
    const method = (init?.method ?? "GET").toUpperCase();
    const handler = handlers[`${method} ${path}`];
    if (handler === undefined) return toResponse(errorResponse(404, "not_found", "No mock handler for this operation."));
    return toResponse(handler({ method, path, body: readBody(init) }, scenario));
  };
}
