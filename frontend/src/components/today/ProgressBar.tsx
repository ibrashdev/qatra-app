// UI-tokens 6.10: an 8 px track in the disabled fill, the fill in the primary colour growing from the start edge, capped at 100 %. The bar carries
// its meaning in words (`aria-valuetext`) and the value is always also visible as text beside it. No transition: the bar is instant, so reduced motion
// needs nothing more.
export function ProgressBar({ percent, labelledBy, valueText }: { percent: number; labelledBy: string; valueText: string }) {
  const capped = Math.min(100, Math.max(0, Math.trunc(percent)));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={capped}
      aria-valuetext={valueText}
      aria-labelledby={labelledBy}
      className="h-progress w-full overflow-hidden rounded-sm bg-disabled"
    >
      <div className="h-full rounded-sm bg-primary" style={{ width: `${capped}%` }} />
    </div>
  );
}
