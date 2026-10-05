"use client";

import { BackControl } from "@/components/ui/BackControl";

// c1 and c2 of S-12 and S-13: the back control at the start edge and the H1. The signed-in shell has no bar slot for a back control, so the
// pair sits at the top of the page. After a route change the shell moves focus to the H1 (data-page-heading).
export function PlanHeader({ title, backDestination, backHref }: { title: string; backDestination: string; backHref: string }) {
  return (
    <div className="flex items-center gap-q12">
      <BackControl destination={backDestination} href={backHref} />
      <h1 data-page-heading tabIndex={-1} className="min-w-0 flex-1 text-title text-ink">
        {title}
      </h1>
    </div>
  );
}
