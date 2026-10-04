import type { ReactNode } from "react";
import { PublicShell } from "@/components/ui/PublicShell";

export default function PublicLayout({ children }: { children: ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
