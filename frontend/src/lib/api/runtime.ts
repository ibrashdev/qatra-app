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
    fetch: options.fetch ?? (mode === "mock" ? createMockFetch() : undefined),
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
