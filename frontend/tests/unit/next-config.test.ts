// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

async function rewrites() {
  const result = await nextConfig.rewrites?.();
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("next.config rewrites (API-spec 1.1: same origin, no CORS, no route handlers)", () => {
  it("forwards /api/:path* to BACKEND_ORIGIN", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BACKEND_ORIGIN", "https://backend.example.invalid");
    expect(await rewrites()).toEqual([{ source: "/api/:path*", destination: "https://backend.example.invalid/api/:path*" }]);
  });

  it("normalises a trailing slash", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BACKEND_ORIGIN", "https://backend.example.invalid/");
    expect(await rewrites()).toEqual([{ source: "/api/:path*", destination: "https://backend.example.invalid/api/:path*" }]);
  });

  it("defaults to http://localhost:8000 only in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BACKEND_ORIGIN", "");
    expect(await rewrites()).toEqual([{ source: "/api/:path*", destination: "http://localhost:8000/api/:path*" }]);
  });

  it("registers no rewrite outside development when BACKEND_ORIGIN is unset, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const env of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      vi.stubEnv("BACKEND_ORIGIN", "");
      expect(await rewrites()).toEqual([]);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each(["not a url", "ftp://backend.example.invalid", "https://backend.example.invalid/api", "https://backend.example.invalid/?x=1"])(
    "rejects an invalid BACKEND_ORIGIN: %s",
    async (value) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("BACKEND_ORIGIN", value);
      await expect(rewrites()).rejects.toThrow(/BACKEND_ORIGIN/);
    },
  );

  it("sets no CORS header and defines no other rewrite or redirect", async () => {
    // The only header block is the one for the service worker file (offline PWA); tests/unit/pwa-manifest.test.ts checks its values.
    expect(((await nextConfig.headers?.()) ?? []).map((block) => block.source)).toEqual(["/sw.js"]);
    expect(nextConfig.redirects).toBeUndefined();
    expect(JSON.stringify(nextConfig)).not.toMatch(/Access-Control/i);
    expect(JSON.stringify(await nextConfig.headers?.())).not.toMatch(/Access-Control/i);
  });
});
