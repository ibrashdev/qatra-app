"use client";

import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useAfterDelay } from "@/lib/dom/use-after-delay";

const SKELETON_DELAY_MS = 300;

// UI-tokens 6.14: five skeleton sections in the final layout, only after 300 ms, so a fast load never flashes them. The region is busy and the
// blocks are hidden from assistive technology; the loading text carries the meaning.
export function TodaySkeleton({ loadingText }: { loadingText: string }) {
  const visible = useAfterDelay(SKELETON_DELAY_MS);
  return (
    <div aria-busy="true" data-testid="today-skeleton">
      <p className="sr-only">{loadingText}</p>
      {visible
        ? Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="mt-q24" aria-hidden="true">
              <SkeletonBlock className="h-q16 w-1/3" />
              <SkeletonBlock className="mt-q12 h-q16 w-full" />
              {index === 1 ? <SkeletonBlock className="mt-q12 h-progress w-full" /> : null}
            </div>
          ))
        : null}
    </div>
  );
}
