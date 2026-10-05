import { ArrowLeft, Check, CircleAlert, CircleCheck, Copy, Download, Droplet, ExternalLink, Eye, EyeOff, Info, Lightbulb, Lock, RefreshCw, TriangleAlert, Undo2, X, type LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";

// The only place that imports the icon set (Lucide, owner decision of 4 October 2026). Screens ask for a meaning, never a glyph.
const GLYPHS = {
  back: ArrowLeft,
  check: Check,
  close: X,
  copy: Copy,
  download: Download,
  droplet: Droplet,
  error: CircleAlert,
  eye: Eye,
  "eye-off": EyeOff,
  external: ExternalLink,
  hint: Lightbulb,
  info: Info,
  lock: Lock,
  refresh: RefreshCw,
  success: CircleCheck,
  undo: Undo2,
  warning: TriangleAlert,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof GLYPHS;

// UI-tokens 5: direction arrows mirror in right-to-left (back, and the undo arrow of 6.16); check, close, copy, download, info, warning, error, eye,
// the droplet, the lightbulb, the lock, refresh and external-link do not.
const MIRRORED: ReadonlySet<IconName> = new Set<IconName>(["back", "undo"]);

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
