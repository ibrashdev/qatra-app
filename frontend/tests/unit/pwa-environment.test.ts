import { describe, expect, it } from "vitest";
import { detectEnvironment, type EnvironmentInput } from "@/lib/pwa/environment";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_NO_SAFARI_TOKEN = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function input(overrides: Partial<EnvironmentInput> = {}): EnvironmentInput {
  return { userAgent: DESKTOP_CHROME, platform: "Win32", maxTouchPoints: 0, navigatorStandalone: undefined, displayModeStandalone: false, isSecureContext: true, hasServiceWorker: true, hasIndexedDB: true, ...overrides };
}

describe("detectEnvironment (D67 matrix)", () => {
  it("recognises iPhone Safari, not in an app, not installed", () => {
    expect(detectEnvironment(input({ userAgent: IPHONE_SAFARI, platform: "iPhone", maxTouchPoints: 5 }))).toMatchObject({ isIOS: true, isAndroid: false, isStandalone: false, inAppBrowser: null });
  });

  it("recognises an iPad that reports as a Mac by its touch screen, and a real Mac by the lack of one", () => {
    expect(detectEnvironment(input({ userAgent: IPAD_AS_MAC, platform: "MacIntel", maxTouchPoints: 5 })).isIOS).toBe(true);
    expect(detectEnvironment(input({ userAgent: IPAD_AS_MAC, platform: "MacIntel", maxTouchPoints: 0 })).isIOS).toBe(false);
  });

  it("recognises Android Chrome and desktop Chrome as ordinary browsers", () => {
    expect(detectEnvironment(input({ userAgent: ANDROID_CHROME, platform: "Linux armv81", maxTouchPoints: 5 }))).toMatchObject({ isAndroid: true, isIOS: false, inAppBrowser: null });
    expect(detectEnvironment(input())).toMatchObject({ isAndroid: false, isIOS: false, inAppBrowser: null, supportsServiceWorker: true, supportsIndexedDB: true });
  });

  it.each([
    ["facebook", `${IPHONE_SAFARI} [FBAN/FBIOS;FBAV/450.0.0.38.109;FBBV/1]`],
    ["facebook", `${ANDROID_CHROME} [FB_IAB/FB4A;FBAV/450.0.0.38.109;]`],
    ["instagram", `${IPHONE_SAFARI} Instagram 330.0.0.20.116`],
    ["tiktok", `${ANDROID_CHROME} musical_ly_2023 BytedanceWebview/d8a21c6`],
    ["snapchat", `${IPHONE_SAFARI} Snapchat/12.80.0.40`],
    ["line", `${ANDROID_CHROME} Line/13.18.1`],
    ["twitter", `${IPHONE_SAFARI} Twitter for iPhone`],
    ["wechat", `${ANDROID_CHROME} MicroMessenger/8.0.47`],
    ["linkedin", `${IPHONE_SAFARI} LinkedInApp`],
    ["webview", ANDROID_WEBVIEW],
  ])("flags the %s in-app browser (online only, open in the browser)", (name, userAgent) => {
    expect(detectEnvironment(input({ userAgent, maxTouchPoints: 5 })).inAppBrowser).toBe(name);
  });

  it("flags an iOS web view that has no Safari token, but not the installed home-screen app, which has none either", () => {
    expect(detectEnvironment(input({ userAgent: IPHONE_NO_SAFARI_TOKEN, platform: "iPhone", maxTouchPoints: 5 })).inAppBrowser).toBe("webview");
    const installed = detectEnvironment(input({ userAgent: IPHONE_NO_SAFARI_TOKEN, platform: "iPhone", maxTouchPoints: 5, navigatorStandalone: true }));
    expect(installed).toMatchObject({ isStandalone: true, inAppBrowser: null });
  });

  it("does not take Chrome on iOS for an in-app browser", () => {
    const chromeIos = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1";
    expect(detectEnvironment(input({ userAgent: chromeIos, platform: "iPhone", maxTouchPoints: 5 })).inAppBrowser).toBeNull();
  });

  it("standalone is the display mode or the iOS flag", () => {
    expect(detectEnvironment(input({ displayModeStandalone: true })).isStandalone).toBe(true);
    expect(detectEnvironment(input({ navigatorStandalone: true })).isStandalone).toBe(true);
    expect(detectEnvironment(input({ navigatorStandalone: false })).isStandalone).toBe(false);
  });

  it("a service worker needs a secure context, and a missing API is a plain false", () => {
    expect(detectEnvironment(input({ isSecureContext: false })).supportsServiceWorker).toBe(false);
    expect(detectEnvironment(input({ hasServiceWorker: false })).supportsServiceWorker).toBe(false);
    expect(detectEnvironment(input({ hasIndexedDB: false })).supportsIndexedDB).toBe(false);
  });
});
