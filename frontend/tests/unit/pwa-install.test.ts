import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallController, computeInstallState, getInstallController, startInstallCapture } from "@/lib/pwa/install";
import type { PwaEnvironment } from "@/lib/pwa/environment";

function env(overrides: Partial<PwaEnvironment> = {}): PwaEnvironment {
  return { isIOS: false, isAndroid: false, isStandalone: false, inAppBrowser: null, isSecureContext: true, supportsServiceWorker: true, supportsIndexedDB: true, ...overrides };
}

function promptEvent(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

describe("computeInstallState (S-33, D67)", () => {
  it.each([
    ["installed app shows nothing, even with a captured prompt", env({ isStandalone: true }), true, "installed"],
    ["an in-app browser gets the open-in-browser hint, never the button", env({ inAppBrowser: "facebook" }), true, "in_app_browser"],
    ["a captured beforeinstallprompt shows the install button", env(), true, "available"],
    ["iOS Safari gets the Share, Add to Home Screen steps", env({ isIOS: true }), false, "ios_instructions"],
    ["iOS Chrome with a prompt would still use the button", env({ isIOS: true }), true, "available"],
    ["a desktop browser without the event has no install path", env(), false, "unsupported"],
    ["Android without the event is unsupported, not iOS", env({ isAndroid: true }), false, "unsupported"],
  ])("%s", (_name, environment, promptAvailable, kind) => {
    expect(computeInstallState(environment, promptAvailable).kind).toBe(kind);
  });

  it("carries the app's name for the in-app hint", () => {
    expect(computeInstallState(env({ inAppBrowser: "instagram" }), false)).toEqual({ kind: "in_app_browser", inAppBrowser: "instagram" });
  });
});

describe("InstallController", () => {
  it("captures the event, keeps the default mini-infobar away, and notifies subscribers once per change", () => {
    const controller = new InstallController(() => env());
    const listener = vi.fn();
    controller.subscribe(listener);
    expect(controller.getState().kind).toBe("unsupported");
    const event = promptEvent();
    controller.capture(event);
    expect(event.defaultPrevented).toBe(true);
    expect(controller.getState().kind).toBe("available");
    expect(listener).toHaveBeenCalledTimes(1);
    controller.capture(promptEvent());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("prompt() shows the browser dialog once, and an accepted install is final", async () => {
    const controller = new InstallController(() => env());
    const event = promptEvent("accepted");
    controller.capture(event);
    expect(await controller.prompt()).toBe("accepted");
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(controller.getState().kind).toBe("installed");
    expect(await controller.prompt()).toBe("unavailable");
  });

  it("a dismissed prompt keeps no flag and does not claim an install", async () => {
    const controller = new InstallController(() => env());
    controller.capture(promptEvent("dismissed"));
    expect(await controller.prompt()).toBe("dismissed");
    expect(controller.getState().kind).toBe("unsupported");
  });

  it("is unavailable without a captured event, and a failing prompt is unavailable, not an error", async () => {
    const controller = new InstallController(() => env());
    expect(await controller.prompt()).toBe("unavailable");
    const broken = promptEvent();
    broken.prompt = vi.fn(async () => {
      throw new Error("not allowed");
    });
    controller.capture(broken);
    expect(await controller.prompt()).toBe("unavailable");
  });

  it("appinstalled marks the app installed", () => {
    const controller = new InstallController(() => env());
    controller.capture(promptEvent());
    controller.markInstalled();
    expect(controller.getState().kind).toBe("installed");
  });

  it("re-reads the environment on refresh (the display mode can change after install)", () => {
    let current = env();
    const controller = new InstallController(() => current);
    expect(controller.getState().kind).toBe("unsupported");
    current = env({ isIOS: true });
    controller.refresh();
    expect(controller.getState().kind).toBe("ios_instructions");
  });
});

describe("startInstallCapture", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  it("listens for beforeinstallprompt and appinstalled on the window, once, and can be stopped", () => {
    stop = startInstallCapture();
    const second = startInstallCapture();
    const event = promptEvent();
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(getInstallController().getState().kind).toBe("available");
    window.dispatchEvent(new Event("appinstalled"));
    expect(getInstallController().getState().kind).toBe("installed");
    second();
  });
});
