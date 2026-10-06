import { API_MODE, type ApiMode } from "@/lib/config";
import { createApiClient, type ApiClient } from "./client";
import { createEndpoints, probeHealth, type Endpoints } from "./endpoints";
import { createMockFetch } from "./mock";
import { RequestMonitor } from "./monitor";
import { WakeUpController } from "./wakeup";

export interface ApiRuntime {
  mode: ApiMode;
  client: ApiClient;
  api: Endpoints;
  monitor: RequestMonitor;
  wakeUp: WakeUpController;
  // Issues the first request of a page load (GET /api/health). Safe to call more than once.
  boot: () => void;
}

export function createApiRuntime(options: { mode?: ApiMode; fetch?: typeof fetch } = {}): ApiRuntime {
  const mode = options.mode ?? API_MODE;
  const monitor = new RequestMonitor();
  const client = createApiClient({
    monitor,
    // The mock starts as a visitor; the synthetic accounts in mock/fixtures.ts sign in through the login screen.
    fetch: options.fetch ?? (mode === "mock" ? createMockFetch({ scenario: { signedIn: false } }) : undefined),
  });
  const api = createEndpoints(client);
  const wakeUp = new WakeUpController({ probe: (signal) => probeHealth(api, signal) });
  wakeUp.attach(monitor);

  let booted = false;
  return {
    mode,
    client,
    api,
    monitor,
    wakeUp,
    boot: () => {
      if (booted) return;
      // The browser says there is no connection: no probe is sent (offline-spec 6, R23 case 2: the offline shell makes no /api request). `booted` stays false,
      // so a later call after the connection is back still starts the first request.
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      booted = true;
      // The outcome is not used: the wake-up controller watches the request through the monitor.
      api.health({ track: true }).catch(() => undefined);
    },
  };
}

let shared: ApiRuntime | undefined;

export function getApiRuntime(): ApiRuntime {
  shared ??= createApiRuntime();
  return shared;
}
