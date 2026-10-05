"use client";

import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useAfterDelay } from "@/lib/dom/use-after-delay";

const SKELETON_DELAY_MS = 300;

// UI-tokens 6.14: two card skeletons and three group skeletons in the final layout, only after 300 ms. The region is busy, the blocks are hidden from
// assistive technology, and no number from an earlier load is kept.
export function ProgressSkeleton({ loadingText }: { loadingText: string }) {
  const visible = useAfterDelay(SKELETON_DELAY_MS);
  return (
    <div aria-busy="true" data-testid="progress-skeleton" className="mt-q24">
      <p className="sr-only">{loadingText}</p>
      {visible ? (
        <div aria-hidden="true" className="flex flex-col gap-q24">
          <div className="grid gap-q16 desktop:grid-cols-2">
            {[0, 1].map((index) => (
              <div key={index} className="rounded-md border border-divider bg-surface p-q16">
                <SkeletonBlock className="h-q16 w-1/3" />
                <SkeletonBlock className="mt-q12 h-progress w-full" />
                <SkeletonBlock className="mt-q12 h-q16 w-2/3" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-q16">
            {[0, 1, 2].map((index) => (
              <SkeletonBlock key={index} className="h-row w-full" />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
