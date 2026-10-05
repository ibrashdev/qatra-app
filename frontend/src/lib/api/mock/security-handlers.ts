// Mock handlers for the account screens S-23, S-24 and S-27 (E09 POST /auth/password, E08 POST /auth/recovery/rotate, E13 POST /account/delete).
// Synthetic data only. Registered by the coordinator over the shared set in mock-fetch.ts, after settingsMockHandlers.
// handlers.ts must not import this file. To wrap a key of an earlier set, read it from that set when a request arrives, not when the module loads.
import type { MockHandler } from "./handlers";

export const securityMockHandlers: Readonly<Record<string, MockHandler>> = {};
