import { cx } from "@/lib/cx";

// UI-tokens 6.14: blocks in the disabled fill with the small radius, the height of the content they stand for. They are decorative and static
// (the page is waiting, nothing in it moves), and they are hidden from assistive technology: the loading text carries the meaning.
export function SkeletonBlock({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("rounded-sm bg-disabled", className)} />;
}

// A paragraph of text lines. The last line is shorter, as the end of a paragraph is.
export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-q12">
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonBlock key={index} className={cx("h-q16", index === lines - 1 ? "w-3/5" : "w-full")} />
      ))}
    </div>
  );
}
