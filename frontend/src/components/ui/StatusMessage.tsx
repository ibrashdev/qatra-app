import type { ReactNode } from "react";

// Info banner (UI-tokens 6.8): inline at the top of the content, never an overlay, not dismissible.
export function StatusMessage({ leading, action, children }: { leading?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-md border border-info-edge bg-info-tint p-q16 text-body-compact text-info-ink">
      <div className="flex items-start gap-q12">
        {leading}
        <p className="min-w-0 flex-1">{children}</p>
      </div>
      {action ? <div className="mt-q12">{action}</div> : null}
    </div>
  );
}
