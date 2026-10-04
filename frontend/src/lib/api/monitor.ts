export type RequestOutcome = "success" | "api_error" | "connectivity" | "aborted";

export interface RequestMonitorListener {
  onStart?: (id: number) => void;
  onSettle?: (id: number, outcome: RequestOutcome) => void;
}

// Lets the wake-up logic watch every tracked request without the client knowing about it.
export class RequestMonitor {
  #nextId = 1;
  readonly #listeners = new Set<RequestMonitorListener>();

  start(): number {
    const id = this.#nextId++;
    for (const listener of [...this.#listeners]) listener.onStart?.(id);
    return id;
  }

  settle(id: number, outcome: RequestOutcome): void {
    for (const listener of [...this.#listeners]) listener.onSettle?.(id, outcome);
  }

  subscribe(listener: RequestMonitorListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
