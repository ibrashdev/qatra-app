import { vi } from "vitest";

// Fakes for navigator.serviceWorker and registrations. EventTarget based, so the code under test uses the real listener API.

export class FakeWorker extends EventTarget {
  state = "installed";
  readonly messages: unknown[] = [];
  statusReply: unknown = null;
  constructor(state = "installed") {
    super();
    this.state = state;
  }
  postMessage(message: unknown, transfer?: unknown[]): void {
    this.messages.push(message);
    const port = transfer?.[0] as MessagePort | undefined;
    if (port !== undefined && (message as { type?: string }).type === "GET_STATUS" && this.statusReply !== null) {
      port.postMessage(this.statusReply);
      port.close();
    }
  }
  setState(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

export class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  active: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
}

export class FakeContainer extends EventTarget {
  controller: unknown = null;
  register = vi.fn<(url: string, options?: unknown) => Promise<FakeRegistration>>(async () => new FakeRegistration());
  getRegistration = vi.fn<(scope?: string) => Promise<FakeRegistration | undefined>>(async () => undefined);
}

export function installContainer(container: FakeContainer = new FakeContainer(), secure = true): FakeContainer {
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
  return container;
}

export function removeContainer(): void {
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  delete (window as unknown as { isSecureContext?: unknown }).isSecureContext;
}

export interface FakeLockManager {
  held: { name: string; mode: string }[];
  request: (name: string, options: { mode?: string }, callback: () => Promise<void> | void) => Promise<void>;
  query: () => Promise<{ held: { name: string; mode: string }[]; pending: unknown[] }>;
}

export function fakeLocks(): FakeLockManager {
  const manager: FakeLockManager = {
    held: [],
    request: async (name, options, callback) => {
      const entry = { name, mode: options.mode ?? "exclusive" };
      manager.held.push(entry);
      try {
        await callback();
      } finally {
        manager.held.splice(manager.held.indexOf(entry), 1);
      }
    },
    query: async () => ({ held: [...manager.held], pending: [] }),
  };
  return manager;
}
