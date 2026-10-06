// What the install and offline screens need to know about the browser (D67). Detection reads facts and never assumes: a missing API is a plain `false`,
// and nothing here claims that an install or an offline reopen works on a device that was not tested.

export interface PwaEnvironment {
  isIOS: boolean;
  isAndroid: boolean;
  isStandalone: boolean; // opened from the home-screen icon
  inAppBrowser: string | null; // a name when the page runs inside another app's browser, else null
  isSecureContext: boolean; // https, or 127.0.0.1 and localhost
  supportsServiceWorker: boolean;
  supportsIndexedDB: boolean;
}

export interface EnvironmentInput {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  navigatorStandalone: boolean | undefined; // iOS Safari only
  displayModeStandalone: boolean;
  isSecureContext: boolean;
  hasServiceWorker: boolean;
  hasIndexedDB: boolean;
}

// D67: other apps' browsers work online only and show «افتح في المتصفح». The patterns are the published user-agent markers of each app.
const IN_APP_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["facebook", /FBAN|FBAV|FB_IAB|FBIOS/i],
  ["instagram", /Instagram/i],
  ["tiktok", /TikTok|musical_ly|Bytedance/i],
  ["snapchat", /Snapchat/i],
  ["line", /\bLine\//i],
  ["twitter", /Twitter/i],
  ["wechat", /MicroMessenger/i],
  ["linkedin", /LinkedInApp/i],
  ["webview", /;\s*wv\)/i], // Android WebView
];

export function readEnvironmentInput(): EnvironmentInput {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { userAgent: "", platform: "", maxTouchPoints: 0, navigatorStandalone: undefined, displayModeStandalone: false, isSecureContext: false, hasServiceWorker: false, hasIndexedDB: false };
  }
  let displayModeStandalone = false;
  try {
    displayModeStandalone = window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    // matchMedia can be missing in a test or a very old browser
  }
  let hasIndexedDB = false;
  try {
    hasIndexedDB = typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    hasIndexedDB = false;
  }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone,
    isSecureContext: window.isSecureContext === true,
    hasServiceWorker: "serviceWorker" in navigator,
    hasIndexedDB,
  };
}

export function detectEnvironment(input: EnvironmentInput = readEnvironmentInput()): PwaEnvironment {
  const ua = input.userAgent;
  // iPadOS 13 and later report as a Mac: a touch screen on a Mac platform is an iPad.
  const isIPadOS = /Macintosh|MacIntel/i.test(input.platform || ua) && input.maxTouchPoints > 1;
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || isIPadOS;
  const isAndroid = /Android/i.test(ua);
  const isStandalone = input.displayModeStandalone || input.navigatorStandalone === true;

  let inAppBrowser: string | null = null;
  if (!isStandalone) {
    for (const [name, pattern] of IN_APP_PATTERNS) {
      if (pattern.test(ua)) {
        inAppBrowser = name;
        break;
      }
    }
    // A WKWebView of another app has no `Safari/` token; an installed home-screen app has none either, which is why standalone is excluded above.
    if (inAppBrowser === null && isIOS && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua)) inAppBrowser = "webview";
  }

  return {
    isIOS,
    isAndroid,
    isStandalone,
    inAppBrowser,
    isSecureContext: input.isSecureContext,
    supportsServiceWorker: input.hasServiceWorker && input.isSecureContext,
    supportsIndexedDB: input.hasIndexedDB,
  };
}
