import type { ReactNode } from "react";
import { PrivacyFrame } from "@/components/privacy/PrivacyFrame";

// S-26's frame (back control and H1) is the layout of the route, so it stays on screen under the loading view, the text and the failure view.
export default function PrivacyLayout({ children }: { children: ReactNode }) {
  return <PrivacyFrame>{children}</PrivacyFrame>;
}
