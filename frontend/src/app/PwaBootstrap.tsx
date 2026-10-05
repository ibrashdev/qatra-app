"use client";

import { useEffect } from "react";
import { startInstallCapture } from "@/lib/pwa/install";
import { registerServiceWorker } from "@/lib/pwa/register";

// Mounted once from the root layout. It renders nothing: it captures the install prompt as early as the browser allows and registers the service worker
// after the page has loaded. Both fail safely (an unsupported browser, a development server, a blocked registration): the app then simply works online.
export function PwaBootstrap() {
  useEffect(() => {
    const stopCapture = startInstallCapture();
    void registerServiceWorker();
    return stopCapture;
  }, []);
  return null;
}
