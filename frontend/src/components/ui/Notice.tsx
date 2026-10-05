import type { ReactNode } from "react";
import { Icon } from "./Icon";

// UI-tokens 6.12: small secondary text with the info glyph at the start edge, no fill, never dismissible, no live region.
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-q8 text-small text-ink-secondary">
      <Icon name="info" size="sm" className="mt-1" />
      <span>{children}</span>
    </p>
  );
}
