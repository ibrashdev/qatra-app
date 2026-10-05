"use client";

import Link from "next/link";
import { BrandMark } from "./BrandMark";

// The product lockup as a link: the header of the public shell and the app shell, and the top of the side rail.
export function Brand({ href }: { href: string }) {
  return (
    <Link href={href} className="inline-flex min-h-target items-center rounded-sm">
      <BrandMark />
    </Link>
  );
}
