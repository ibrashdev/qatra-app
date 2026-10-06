"use client";

import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useAfterDelay } from "@/lib/dom/use-after-delay";

const SKELETON_DELAY_MS = 300;

// UI-tokens 6.14: blocks in the final layout, only after 300 ms, so a fast load never flashes one. The region is busy, the blocks are hidden from
// assistive technology, and the loading text carries the meaning.
export function DemoSkeleton({ loadingText, rows = 3 }: { loadingText: string; rows?: number }) {
  const visible = useAfterDelay(SKELETON_DELAY_MS);
  return (
    <div aria-busy="true" data-testid="demo-skeleton">
      <p className="sr-only">{loadingText}</p>
      {visible ? (
        <div aria-hidden="true" className="flex flex-col gap-q8">
          {Array.from({ length: rows }, (_, index) => (
            <SkeletonBlock key={index} className="h-row w-full" />
          ))}
        </div>
      ) : (
        <div aria-hidden="true" className="h-row" />
      )}
    </div>
  );
}
