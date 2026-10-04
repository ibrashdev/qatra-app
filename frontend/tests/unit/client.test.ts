import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, DEFAULT_REQUEST_TIMEOUT_MS, READ_RETRY_POLICY } from "@/lib/api/client";
import { ApiError, ConnectivityError, hasApiErrorCode, isAbortError, isSessionEnded } from "@/lib/api/errors";
import { RequestMonitor, type RequestOutcome } from "@/lib/api/monitor";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function envelope(code: string, status: number, details: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json({ error: { code, message: "Safe text.", details } }, status, headers);
}

function html(status: number): Response {
  return new Response("<!doctype html><title>Gateway</title>", { status, headers: { "Content-Type": "text/html" } });
}

function fetchStub(...responses: Array<Response | Error>) {
  const queue = [...responses];
  return vi.fn<typeof fetch>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("No more stubbed responses");
    if (next instanceof Error) throw next;
    return next;
  });
}

const noSleep = async () => undefined;

describe("API client: request shape", () => {
  it("sends same-origin JSON requests to /api and never sets an Authorization header", async () => {
    const fetchMock = fetchStub(json({ ok: true }, 201));
    const client = createApiClient({ fetch: fetchMock });
    await client.post("/plans", { editionId: "e1" });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/plans");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.cache).toBe("no-store");
    expect(init?.body).toBe(JSON.stringify({ editionId: "e1" }));
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("sends no body and no content type on a GET", async () => {
    const fetchMock = fetchStub(json({ status: "ok" }));
    await createApiClient({ fetch: fetchMock }).get("/health");
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("returns undefined for 204", async () => {
    const client = createApiClient({ fetch: fetchStub(new Response(null, { status: 204 })) });
    await expect(client.post("/auth/logout")).resolves.toBeUndefined();
  });

  it.each(["https://elsewhere.example/x", "//elsewhere.example/x", "/a/../b", "health", "/a b", "/a\\b"])(
    "refuses a path that could leave the same origin: %s",
    async (path) => {
      const fetchMock = fetchStub(json({}));
      await expect(createApiClient({ fetch: fetchMock }).get(path)).rejects.toBeInstanceOf(TypeError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("API client: error envelope", () => {
  it("builds an ApiError from the envelope and exposes code, status and details", async () => {
    const details = { fields: [{ field: "username", rule: "username_length" }] };
    const client = createApiClient({ fetch: fetchStub(envelope("validation_error", 422, details)) });
    const error = await client.post("/auth/register", {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("validation_error");
    expect(apiError.isKnownCode).toBe(true);
    expect(apiError.details).toEqual(details);
    expect(apiError.message).toBe("Safe text.");
    expect(hasApiErrorCode(apiError, "validation_error")).toBe(true);
  });

  it("branches on the code, not the status: two 401 codes behave differently", async () => {
    const ended = await createApiClient({ fetch: fetchStub(envelope("unauthenticated", 401)) })
      .get("/me")
      .catch((e: unknown) => e);
    const wrongPassword = await createApiClient({ fetch: fetchStub(envelope("invalid_credentials", 401)) })
      .post("/auth/login", {})
      .catch((e: unknown) => e);

    expect(isSessionEnded(ended)).toBe(true);
    expect(isSessionEnded(wrongPassword)).toBe(false);
    expect((wrongPassword as ApiError).status).toBe(401);
  });

  it("keeps a code this client does not know", async () => {
    const client = createApiClient({ fetch: fetchStub(envelope("some_future_code", 409)) });
    const error = (await client.get("/x").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("some_future_code");
    expect(error.isKnownCode).toBe(false);
  });

  it("reads retryAfterSec from details, then from the Retry-After header", async () => {
    const fromDetails = (await createApiClient({
      fetch: fetchStub(envelope("throttled", 429, { retryAfterSec: 900 }, { "Retry-After": "5" })),
    })
      .post("/auth/login", {})
      .catch((e: unknown) => e)) as ApiError;
    const fromHeader = (await createApiClient({ fetch: fetchStub(envelope("throttled", 429, {}, { "Retry-After": "20" })) })
      .post("/auth/login", {})
      .catch((e: unknown) => e)) as ApiError;
    const none = (await createApiClient({ fetch: fetchStub(envelope("not_found", 404)) })
      .get("/x")
      .catch((e: unknown) => e)) as ApiError;

    expect(fromDetails.retryAfterSec).toBe(900);
    expect(fromHeader.retryAfterSec).toBe(20);
    expect(none.retryAfterSec).toBeNull();
  });

  it("treats a 503 that carries the envelope as an application answer (G-17), not as connectivity", async () => {
    const error = await createApiClient({ fetch: fetchStub(envelope("unavailable", 503)) })
      .get("/today")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ConnectivityError);
  });
});

describe("API client: connectivity classification", () => {
  it("classifies a failed fetch as network", async () => {
    const error = await createApiClient({ fetch: fetchStub(new TypeError("Failed to fetch")) })
      .get("/today")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectivityError);
    expect((error as ConnectivityError).reason).toBe("network");
    expect((error as ConnectivityError).status).toBeNull();
  });

  it.each([502, 503, 504, 500])("classifies an un-enveloped %i as a gateway answer", async (status) => {
    const error = await createApiClient({ fetch: fetchStub(html(status)) })
      .get("/today")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectivityError);
    expect((error as ConnectivityError).reason).toBe("gateway");
    expect((error as ConnectivityError).status).toBe(status);
  });

  it("never reads an un-enveloped 401 as the end of the session", async () => {
    const error = await createApiClient({ fetch: fetchStub(html(401)) })
      .get("/me")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectivityError);
    expect(isSessionEnded(error)).toBe(false);
  });

  it("classifies an un-enveloped 404 and a 200 with a non-JSON body as an invalid response", async () => {
    const notFound = await createApiClient({ fetch: fetchStub(html(404)) })
      .get("/x")
      .catch((e: unknown) => e);
    const platformPage = await createApiClient({ fetch: fetchStub(html(200)) })
      .get("/health")
      .catch((e: unknown) => e);
    expect((notFound as ConnectivityError).reason).toBe("invalid_response");
    expect((platformPage as ConnectivityError).reason).toBe("invalid_response");
  });

  it.each([
    ["not an object", JSON.stringify("error")],
    ["no error key", JSON.stringify({ message: "x" })],
    ["code is not a string", JSON.stringify({ error: { code: 7, message: "x" } })],
    ["code is not snake_case", JSON.stringify({ error: { code: "Not Snake", message: "x" } })],
    ["message missing", JSON.stringify({ error: { code: "internal" } })],
    ["details is an array", JSON.stringify({ error: { code: "internal", message: "x", details: [] } })],
  ])("does not accept a malformed envelope (%s)", async (_label, body) => {
    const response = new Response(body, { status: 500, headers: { "Content-Type": "application/json" } });
    const error = await createApiClient({ fetch: fetchStub(response) })
      .get("/x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectivityError);
  });

  describe("timeout", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function hangingFetch() {
      return vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      );
    }

    it("aborts after the request timeout and reports a timeout, not a logout", async () => {
      const client = createApiClient({ fetch: hangingFetch() });
      const result = client.get("/today").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(ConnectivityError);
      expect((error as ConnectivityError).reason).toBe("timeout");
      expect(isSessionEnded(error)).toBe(false);
    });

    it("honours a per-request timeout", async () => {
      const client = createApiClient({ fetch: hangingFetch() });
      const result = client.get("/health", { timeoutMs: 5_000 }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(((await result) as ConnectivityError).reason).toBe("timeout");
    });
  });

  it("lets a caller abort pass through as an AbortError, not as connectivity", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const result = createApiClient({ fetch: fetchMock }).get("/today", { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const error = await result;
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toBeInstanceOf(ConnectivityError);
  });
});

describe("API client: retries (API-spec 1.6 and 1.11)", () => {
  it("never retries a POST automatically, even when a retry policy is passed", async () => {
    const fetchMock = fetchStub(new TypeError("Failed to fetch"), json({ ok: true }));
    const client = createApiClient({ fetch: fetchMock, sleep: noSleep });
    const error = await client.post("/auth/register", {}, { retry: READ_RETRY_POLICY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectivityError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["PATCH", "PUT", "DELETE"] as const)("never retries a %s either", async (method) => {
    const fetchMock = fetchStub(html(502), json({}));
    const client = createApiClient({ fetch: fetchMock, sleep: noSleep });
    await client.request("/x", { method, body: {}, retry: READ_RETRY_POLICY }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a GET on connectivity errors with the given delays, then succeeds", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const fetchMock = fetchStub(html(502), new TypeError("Failed to fetch"), json({ editions: [] }));
    const client = createApiClient({ fetch: fetchMock, sleep });
    await expect(client.get("/catalog", { retry: READ_RETRY_POLICY })).resolves.toEqual({ editions: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
  });

  it("gives up after the last delay and reports the last connectivity error", async () => {
    const fetchMock = fetchStub(html(502), html(502), html(502), html(502), json({}));
    const client = createApiClient({ fetch: fetchMock, sleep: noSleep });
    const error = await client.get("/catalog", { retry: READ_RETRY_POLICY }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectivityError);
    expect(fetchMock).toHaveBeenCalledTimes(1 + READ_RETRY_POLICY.delaysMs.length);
  });

  it("does not retry a GET without a retry policy", async () => {
    const fetchMock = fetchStub(html(502), json({}));
    await createApiClient({ fetch: fetchMock, sleep: noSleep }).get("/catalog").catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries an enveloped answer: the server gave its verdict", async () => {
    const fetchMock = fetchStub(envelope("unavailable", 503), json({}));
    const client = createApiClient({ fetch: fetchMock, sleep: noSleep });
    await client.get("/today", { retry: READ_RETRY_POLICY }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a POST only when the caller marks it idempotent (E21 events carry clientEventId)", async () => {
    const fetchMock = fetchStub(new TypeError("Failed to fetch"), json({ acknowledged: [] }));
    const client = createApiClient({ fetch: fetchMock, sleep: noSleep });
    await expect(
      client.post("/sessions/s1/events", { events: [] }, { idempotent: true, retry: READ_RETRY_POLICY }),
    ).resolves.toEqual({ acknowledged: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops retrying once the caller aborts", async () => {
    const controller = new AbortController();
    const fetchMock = fetchStub(html(502), json({}));
    const sleep = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const error = await createApiClient({ fetch: fetchMock, sleep })
      .get("/catalog", { retry: READ_RETRY_POLICY, signal: controller.signal })
      .catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("API client: request monitor", () => {
  function record(monitor: RequestMonitor) {
    const events: Array<[string, number, RequestOutcome?]> = [];
    monitor.subscribe({
      onStart: (id) => events.push(["start", id]),
      onSettle: (id, outcome) => events.push(["settle", id, outcome]),
    });
    return events;
  }

  it.each([
    ["success", () => json({}), "success"],
    ["an enveloped error", () => envelope("not_found", 404), "api_error"],
    ["a gateway answer", () => html(502), "connectivity"],
    ["a network failure", () => new TypeError("Failed to fetch"), "connectivity"],
  ] as const)("reports %s once, with the outcome", async (_label, make, outcome) => {
    const monitor = new RequestMonitor();
    const events = record(monitor);
    await createApiClient({ fetch: fetchStub(make()), monitor })
      .get("/today")
      .catch(() => undefined);
    expect(events).toEqual([
      ["start", 1],
      ["settle", 1, outcome],
    ]);
  });

  it("reports one request for a request that was retried, with its final outcome", async () => {
    const monitor = new RequestMonitor();
    const events = record(monitor);
    const client = createApiClient({ fetch: fetchStub(html(502), json({})), monitor, sleep: noSleep });
    await client.get("/catalog", { retry: READ_RETRY_POLICY });
    expect(events).toEqual([
      ["start", 1],
      ["settle", 1, "success"],
    ]);
  });

  it("reports a caller abort as aborted", async () => {
    const monitor = new RequestMonitor();
    const events = record(monitor);
    const controller = new AbortController();
    controller.abort();
    await createApiClient({ fetch: fetchStub(json({})), monitor })
      .get("/today", { signal: controller.signal })
      .catch(() => undefined);
    expect(events).toEqual([
      ["start", 1],
      ["settle", 1, "aborted"],
    ]);
  });

  it("does not report an untracked request (the health probes)", async () => {
    const monitor = new RequestMonitor();
    const events = record(monitor);
    await createApiClient({ fetch: fetchStub(json({ status: "ok" })), monitor }).get("/health", { track: false });
    expect(events).toEqual([]);
  });
});
