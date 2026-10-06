// Types for the unit tests that import the builder (tests/unit/sw-build.test.ts).
export const SHELL_URL: string;
export const MANIFEST_URL: string;
export const CACHE_PREFIX: string;
export const REQUIRED_ICONS: string[];

export interface ServiceWorkerConfig {
  buildId: string;
  cachePrefix: string;
  cacheName: string;
  shellUrl: string;
  assets: string[];
}

export function listFiles(dir: string): Promise<string[]>;
export function validateAllowlist(assets: unknown): string[];
export function collectBuild(options: { distDir: string; publicDir: string }): Promise<{ buildId: string | null; assets: string[]; problems: string[]; shellMissing?: boolean }>;
export function cacheNameFor(buildId: string, assets: string[]): string;
export function renderServiceWorker(template: string, config: ServiceWorkerConfig): string;
export function buildServiceWorker(options?: {
  distDir?: string;
  publicDir?: string;
  templatePath?: string;
  outPath?: string;
  allowMissingShell?: boolean;
}): Promise<{ ok: boolean; problems: string[]; warnings: string[]; outPath?: string; config?: ServiceWorkerConfig; bytes?: number }>;
