"use client";

import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useAfterDelay } from "@/lib/dom/use-after-delay";

const SKELETON_DELAY_MS = 300;

// UI-tokens 6.14: two card-shaped blocks in the final layout, only after 300 ms, so a fast load never flashes them. The region is busy, the blocks are
// hidden from assistive technology, and the loading text carries the meaning. Used by S-07 and S-25.
export function CatalogSkeleton({ loadingText }: { loadingText: string }) {
  const visible = useAfterDelay(SKELETON_DELAY_MS);
  return (
    <div aria-busy="true" data-testid="catalog-skeleton" className="mt-q24">
      <p className="sr-only">{loadingText}</p>
      {visible ? (
        <div aria-hidden="true" className="flex flex-col gap-q16">
          {[0, 1].map((index) => (
            <div key={index} className="rounded-md border border-divider bg-surface p-q16">
              <SkeletonBlock className="h-q16 w-2/3" />
              <SkeletonBlock className="mt-q8 h-q16 w-1/2" />
              <SkeletonBlock className="mt-q12 h-q16 w-full" />
              <SkeletonBlock className="mt-q12 h-row w-full" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
