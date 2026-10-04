"use client";

import Link from "next/link";
import { useLocale } from "@/i18n/LocaleProvider";

// The product name as text. No logo exists yet, and none is drawn for it (antislop R-23).
export function Brand({ href }: { href: string }) {
  const { messages } = useLocale();
  return (
    <Link href={href} className="inline-flex min-h-target items-center rounded-sm text-section text-primary-deep">
      {messages.appName}
    </Link>
  );
}
