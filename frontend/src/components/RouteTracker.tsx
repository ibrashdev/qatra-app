"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { noteRoute } from "@/lib/nav/route-history";

// Renders nothing. It keeps the route history current, so a screen can tell which screen opened it.
export function RouteTracker(): null {
  const pathname = usePathname();
  useEffect(() => {
    noteRoute(pathname);
  }, [pathname]);
  return null;
}
