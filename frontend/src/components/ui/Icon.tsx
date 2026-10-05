import { ArrowLeft, Check, CircleAlert, CircleCheck, Droplet, Eye, EyeOff, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";

// The only place that imports the icon set (Lucide, owner decision of 4 October 2026). Screens ask for a meaning, never a glyph.
const GLYPHS = {
  back: ArrowLeft,
  check: Check,
  close: X,
  droplet: Droplet,
  error: CircleAlert,
  eye: Eye,
  "eye-off": EyeOff,
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof GLYPHS;

// UI-tokens 5: direction arrows mirror in right-to-left; check, close, info, warning, error, eye and the droplet do not.
const MIRRORED: ReadonlySet<IconName> = new Set<IconName>(["back"]);

// UI-tokens 4: 16, 20, 24 and 32 px. The classes follow the --q-icon-* tokens, so the glyphs scale with the browser font size.
const SIZES = {
  sm: "size-icon-sm",
  md: "size-icon-md",
  lg: "size-icon-lg",
  xl: "size-icon-xl",
} as const;

export type IconSize = keyof typeof SIZES;

// Decorative always: the accessible name lives on the control or in the phrase beside the glyph, never on the glyph.
export function Icon({ name, size = "lg", active = false, className }: { name: IconName; size?: IconSize; active?: boolean; className?: string }) {
  const Glyph = GLYPHS[name];
  return <Glyph aria-hidden="true" focusable="false" strokeWidth={active ? 2 : 1.5} className={cx("shrink-0", SIZES[size], MIRRORED.has(name) && "rtl:-scale-x-100", className)} />;
}
