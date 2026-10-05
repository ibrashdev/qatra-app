import { detectEnvironment, type PwaEnvironment } from "./environment";
import type { InstallState } from "@/lib/offline/types";

// The install flow of S-33 (UI-design 73, offline-spec 3.3). Chromium browsers fire `beforeinstallprompt`: it is captured, never assumed, and the button
// shows only while it is available. iOS Safari has no such event, so the learner gets the Share, Add to Home Screen steps instead. Another app's browser
// gets the open-in-browser hint (D67). Installing the icon never proves that the plan is ready; the screen shows the download state beside the help.

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform?: string }>;
}

// Pure, so every branch is tested without a browser. Order matters: an installed app shows nothing, and another app's browser cannot install at all.
export function computeInstallState(env: PwaEnvironment, promptAvailable: boolean): InstallState {
  if (env.isStandalone) return { kind: "installed", inAppBrowser: null };
  if (env.inAppBrowser !== null) return { kind: "in_app_browser", inAppBrowser: env.inAppBrowser };
  if (promptAvailable) return { kind: "available", inAppBrowser: null };
  if (env.isIOS) return { kind: "ios_instructions", inAppBrowser: null };
  return { kind: "unsupported", inAppBrowser: null };
}

export class InstallController {
  #deferred: BeforeInstallPromptEvent | null = null;
  #installed = false;
  #state: InstallState;
  readonly #listeners = new Set<() => void>();
  readonly #readEnv: () => PwaEnvironment;

  constructor(readEnv: () => PwaEnvironment = () => detectEnvironment()) {
    this.#readEnv = readEnv;
    this.#state = computeInstallState(readEnv(), false);
  }

  getState = (): InstallState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // The browser's event, kept so the button can call it later. The default mini-infobar is suppressed: the learner decides when to see the prompt.
  capture(event: Event): void {
    event.preventDefault();
    this.#deferred = event as BeforeInstallPromptEvent;
    this.#refresh();
  }

  markInstalled(): void {
    this.#installed = true;
    this.#deferred = null;
    this.#refresh();
  }

  // Shows the browser's own install dialog. The event works once; a dismissed choice keeps no flag (the browser decides when it fires again).
  async prompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
    const deferred = this.#deferred;
    if (deferred === null) return "unavailable";
    this.#deferred = null;
    this.#refresh();
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === "accepted") this.markInstalled();
      return choice.outcome;
    } catch {
      return "unavailable";
    }
  }

  refresh(): void {
    this.#refresh();
  }

  #refresh(): void {
    const env = this.#readEnv();
    const next = this.#installed ? ({ kind: "installed", inAppBrowser: null } satisfies InstallState) : computeInstallState(env, this.#deferred !== null);
    if (next.kind === this.#state.kind && next.inAppBrowser === this.#state.inAppBrowser) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }
}

let shared: InstallController | undefined;
let capturing = false;

export function getInstallController(): InstallController {
  shared ??= new InstallController();
  return shared;
}

// Called once, as early as possible: the event fires only once per page load, so a listener added later misses it.
export function startInstallCapture(): () => void {
  if (typeof window === "undefined" || capturing) return () => undefined;
  capturing = true;
  const controller = getInstallController();
  const onPrompt = (event: Event) => controller.capture(event);
  const onInstalled = () => controller.markInstalled();
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  controller.refresh();
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
    capturing = false;
  };
}
