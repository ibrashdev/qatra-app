import type { OfflineMessage, SubscribeOfflineMessagesFn } from "./types";

// PWA-design 7: a BroadcastChannel only speeds up the notice to the other tabs. It is not the security mechanism: ownerState and the generation are
// checked inside every transaction, so a lost or forged message cannot open another account's copy.

export const OFFLINE_CHANNEL_NAME = "qatra-offline";

const MESSAGE_TYPES = ["OWNER_CLEARED", "SNAPSHOT_READY", "OUTBOX_CHANGED", "SYNC_DONE", "UPDATE_PENDING"] as const;

function supported(): boolean {
  return typeof BroadcastChannel !== "undefined";
}

function isOfflineMessage(value: unknown): value is OfflineMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && (MESSAGE_TYPES as readonly string[]).includes(type);
}

let publisher: BroadcastChannel | null = null;

export function publishOfflineMessage(message: OfflineMessage): void {
  if (!supported()) return;
  try {
    publisher ??= new BroadcastChannel(OFFLINE_CHANNEL_NAME);
    publisher.postMessage(message);
  } catch {
    // A closed channel or a blocked context: the other tabs find out at their next transaction.
    publisher = null;
  }
}

// Every subscriber opens its own channel object, because an object never receives its own messages while another object of the same name does.
// The tab that publishes therefore also hears itself through its subscribers, which keeps one code path for the screens.
export const subscribeOfflineMessages: SubscribeOfflineMessagesFn = (handler) => {
  if (!supported()) return () => undefined;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(OFFLINE_CHANNEL_NAME);
  } catch {
    return () => undefined;
  }
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (isOfflineMessage(event.data)) handler(event.data);
  };
  return () => {
    channel.onmessage = null;
    channel.close();
  };
};

export function closeOfflinePublisher(): void {
  publisher?.close();
  publisher = null;
}
