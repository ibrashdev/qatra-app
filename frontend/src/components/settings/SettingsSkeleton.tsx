"use client";

import { SkeletonBlock } from "@/components/ui/Skeleton";
import { useAfterDelay } from "@/lib/dom/use-after-delay";

const SKELETON_DELAY_MS = 300;

// UI-tokens 6.14: skeleton rows and form fields in the final layout, only after 300 ms, so a fast load never flashes them. The region is busy and the
// blocks are hidden from assistive technology; the loading text carries the meaning (G-23).
export function SettingsSkeleton({ loadingText }: { loadingText: string }) {
  const visible = useAfterDelay(SKELETON_DELAY_MS);
  return (
    <div aria-busy="true" data-testid="settings-skeleton" className="mt-q24">
      <p className="sr-only">{loadingText}</p>
      {visible ? (
        <div aria-hidden="true" className="flex flex-col gap-q24">
          <div className="flex flex-col gap-q12">
            <SkeletonBlock className="h-q16 w-1/3" />
            <div className="flex flex-col gap-q8">
              {[0, 1, 2, 3, 4].map((index) => (
                <SkeletonBlock key={index} className="h-row w-full" />
              ))}
            </div>
          </div>
          <div className="flex max-w-form flex-col gap-q24">
            <SkeletonBlock className="h-q16 w-1/3" />
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex flex-col gap-q8">
                <SkeletonBlock className="h-q16 w-1/4" />
                <SkeletonBlock className="h-input w-full" />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
