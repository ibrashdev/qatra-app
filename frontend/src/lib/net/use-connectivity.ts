"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const readOnline = (): boolean => navigator.onLine;
const readOnlineOnServer = (): boolean => true;

// P-05. The browser flag is a hint, not proof: it raises the offline banner before any press, and no submit is ever disabled for it.
// `reconnected` is true from the moment the browser reports the connection back until it drops again, for the polite «the connection is back» status.
export function useConnectivity(): { online: boolean; reconnected: boolean } {
  const online = useSyncExternalStore(subscribe, readOnline, readOnlineOnServer);
  const [reconnected, setReconnected] = useState(false);

  useEffect(() => {
    const onOnline = () => setReconnected(true);
    const onOffline = () => setReconnected(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return { online, reconnected };
}
