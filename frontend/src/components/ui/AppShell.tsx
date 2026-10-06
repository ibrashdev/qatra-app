"use client";

import { usePathname } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { OfflineNotice } from "@/components/pwa/OfflineNotice";
import { OfflineShell } from "@/components/pwa/OfflineShell";
import { useApiRuntime, useWakeUpState } from "@/lib/api/react";
import { isOfflineSwapRoute } from "@/lib/net/offline-routes";
import { useConnectivityStatus } from "@/lib/net/use-connectivity";
import { Brand } from "./Brand";
import { SideRail, TabBar } from "./MainNav";
import { SkipLink } from "./SkipLink";
import { TopBar } from "./TopBar";
import { WakeUpStatus } from "./WakeUpStatus";
import { useRouteFocus } from "./use-page-chrome";

// page: the page and its chrome. offline-auto: the connection dropped on a page that only reads, so the downloaded plan took the place of the page (the page
// is unmounted). offline-manual: the learner opened the downloaded plan from a notice; the page stays mounted but hidden, so what was typed in it survives.
type ShellMode = "page" | "offline-auto" | "offline-manual";

interface ShellState {
  mode: ShellMode;
  // Keys the page when it comes back from an automatic swap, so it loads its data fresh (the old page was unmounted and had no connection when it last asked).
  generation: number;
  // The offline episode that was left for good (by the shell's own successful check, or by the learner's choice to return). One episode swaps the page once.
  exitedEpisode: number;
}

// Signed-in shell (UI-design 2.1): bottom tab bar below 1024 px, start-edge rail from 1024 px.
// Both navs are in the DOM and CSS shows one, so the focus order matches the visual order at every width.
//
// It also decides what an open page does when the connection drops (PWA-design 6). A browser that is already offline gets the offline page from the service
// worker; a page that is already open never reloads, so this shell swaps it in place, without a request, a reload or a change of address:
//   a page that only reads (isOfflineSwapRoute) is replaced by the downloaded plan, and comes back by itself once the plan's own check reaches the server;
//   any other page (a form, the admin area, a result) stays, with a notice that says what is and is not saved and a way to open the downloaded plan.
// Nothing here redirects: coming back needs the plan's successful check, going in again needs a new offline episode, so the two cannot loop.
export function AppShell({ children }: { children: ReactNode }) {
  useRouteFocus();
  const pathname = usePathname();
  const { connectivity } = useApiRuntime();
  const { status, episode } = useConnectivityStatus();
  const wake = useWakeUpState();
  const [shell, setShell] = useState<ShellState>({ mode: "page", generation: 0, exitedEpisode: 0 });
  const { mode } = shell;

  // An offline episode that starts, or is found, on a page that only reads. Adjusted while rendering, so the page never paints once more before it is swapped.
  if (mode === "page" && status === "offline" && episode !== shell.exitedEpisode && isOfflineSwapRoute(pathname)) {
    setShell({ ...shell, mode: "offline-auto" });
  }

  const onReconnected = useCallback(() => {
    // The plan's check reached the server, so the last failed request no longer counts, and this episode is over.
    connectivity.markReachable();
    const exited = connectivity.getState().episode;
    setShell((current) => ({ mode: "page", generation: current.mode === "offline-auto" ? current.generation + 1 : current.generation, exitedEpisode: exited }));
  }, [connectivity]);
  const onReturn = useCallback(() => {
    const exited = connectivity.getState().episode;
    setShell((current) => ({ ...current, mode: "page", exitedEpisode: exited }));
  }, [connectivity]);
  const openOffline = useCallback(() => setShell((current) => ({ ...current, mode: "offline-manual" })), []);

  // Coming back from the downloaded plan, the control that had focus is gone: focus goes to the heading of the page, or its main region.
  const previousMode = useRef<ShellMode>(mode);
  useEffect(() => {
    const before = previousMode.current;
    previousMode.current = mode;
    if (mode === "page" && before !== "page") (document.querySelector<HTMLElement>("[data-page-heading]") ?? document.getElementById("main"))?.focus();
  }, [mode]);

  if (mode === "offline-auto") return <OfflineShell embedded={{ onReconnected }} />;

  const notice =
    status === "offline" ? (
      <OfflineNotice kind="offline" onOpenOffline={openOffline} />
    ) : status === "server_unavailable" && wake.phase === "timed_out" ? (
      <OfflineNotice kind="server" onOpenOffline={openOffline} />
    ) : null;

  // The page keeps its place in the tree between "page" and "offline-manual" (the plan is rendered before it, in the slot that is empty otherwise), so React
  // keeps it mounted and the hidden page still holds what was typed. The plan comes first in the document, so its #main and skip link are the ones in use.
  return (
    <>
      {mode === "offline-manual" ? <OfflineShell embedded={{ onReconnected, onReturn }} /> : null}
      <div hidden={mode === "offline-manual"} className="flex min-h-dvh flex-col rail:flex-row">
        <SkipLink />
        <SideRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar below="rail">
            <Brand href="/today" />
          </TopBar>
          <main
            id="main"
            tabIndex={-1}
            className="mx-auto w-full max-w-column flex-1 px-page py-q24 rail:py-q40"
          >
            <WakeUpStatus>{notice}</WakeUpStatus>
            <Fragment key={shell.generation}>{children}</Fragment>
          </main>
        </div>
        <TabBar />
      </div>
    </>
  );
}
