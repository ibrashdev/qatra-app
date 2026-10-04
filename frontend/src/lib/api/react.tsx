"use client";

import { createContext, use, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { getApiRuntime, type ApiRuntime } from "./runtime";
import type { WakeUpState } from "./wakeup";

const ApiRuntimeContext = createContext<ApiRuntime | null>(null);

const SERVER_WAKE_STATE: WakeUpState = { phase: "idle" };

export function ApiRuntimeProvider({ children, runtime }: { children: ReactNode; runtime?: ApiRuntime }) {
  const value = useMemo(() => runtime ?? getApiRuntime(), [runtime]);

  useEffect(() => {
    value.boot();
  }, [value]);

  return <ApiRuntimeContext value={value}>{children}</ApiRuntimeContext>;
}

export function useApiRuntime(): ApiRuntime {
  const value = use(ApiRuntimeContext);
  if (value === null) throw new Error("useApiRuntime must be used inside ApiRuntimeProvider.");
  return value;
}

export function useWakeUpState(): WakeUpState {
  const { wakeUp } = useApiRuntime();
  return useSyncExternalStore(wakeUp.subscribe, wakeUp.getState, () => SERVER_WAKE_STATE);
}
