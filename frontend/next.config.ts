import type { NextConfig } from "next";

// Server-side only: the value is read here and never reaches the browser bundle.
function resolveBackendOrigin(): string | null {
  const configured = process.env.BACKEND_ORIGIN?.trim();
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error("BACKEND_ORIGIN must be an absolute http(s) URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("BACKEND_ORIGIN must use http or https");
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error("BACKEND_ORIGIN must be an origin only; the rewrite appends /api/*");
    }
    return url.origin;
  }
  // The localhost default is development only, so a missing value in production is visible.
  return process.env.NODE_ENV === "development" ? "http://localhost:8000" : null;
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    const origin = resolveBackendOrigin();
    if (origin === null) {
      console.warn("[qatra] BACKEND_ORIGIN is not set: this build does not forward /api/*.");
      return [];
    }
    return [{ source: "/api/:path*", destination: `${origin}/api/:path*` }];
  },
};

export default nextConfig;
