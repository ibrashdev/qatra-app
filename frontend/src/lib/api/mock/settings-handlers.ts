// Mock handlers for the settings screen S-22 (E12 PATCH /me, and the E11 read it changes). Synthetic data only.
// Registered by the coordinator over the shared set in mock-fetch.ts: { ...mockHandlers, ...accountMockHandlers, ...settingsMockHandlers, ...securityMockHandlers }.
// handlers.ts must not import this file. To wrap a key of an earlier set, read it from that set when a request arrives, not when the module loads.
import type { MockHandler } from "./handlers";

export const settingsMockHandlers: Readonly<Record<string, MockHandler>> = {};
