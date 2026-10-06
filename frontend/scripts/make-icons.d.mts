export const BRAND_BLUE: string;
export const GLYPH: string;
export const ICON_SPECS: { file: string; size: number; glyphShare: number }[];
export function readDropletPath(root?: string): Promise<string>;
export function iconSvg(spec: { size: number; glyphShare: number }, dropletPath: string): string;
export function makeIcons(options?: { outDir?: string; root?: string }): Promise<{ file: string; size: number; bytes: number }[]>;
