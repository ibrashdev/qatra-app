"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isAbortError, isSessionEnded } from "@/lib/api/errors";
import { useApiRuntime } from "@/lib/api/react";
import type { Profile } from "@/lib/api/types";

// The anchors of S-03 that S-26 keeps when it hands a visitor over: nothing else from the address is carried to the public page.
const KEPT_ANCHORS: ReadonlySet<string> = new Set(["#terms", "#privacy"]);

// Guard 13 (coordinator decision): the text of S-26 needs no session and calls no API, but the route belongs to the signed-in shell. One background
// read of E11 asks whether there is a session; on `401` the visitor goes to S-03 (the same text in the public shell) by `replace`, keeping the
// `#terms` or `#privacy` anchor. The text never waits for this read, and any other failure of it is ignored: the screen has nothing to retry.
// The read is untracked, so a slow server raises no wake-up line over a page that has already shown everything it has.
export function usePrivacyGuard(): void {
  const { client } = useApiRuntime();
  const router = useRouter();

  useEffect(() => {
    const controller = new AbortController();
    client.get<Profile>("/me", { signal: controller.signal, track: false }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error) || !isSessionEnded(error)) return;
      const { hash } = window.location;
      router.replace(`/terms${KEPT_ANCHORS.has(hash) ? hash : ""}`);
    });
    return () => controller.abort();
  }, [client, router]);
}
