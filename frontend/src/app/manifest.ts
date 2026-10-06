import type { MetadataRoute } from "next";

// The public web app manifest (PWA-design 2, offline-spec 3.2), served at /manifest.webmanifest. It holds nothing personal: no account id, no plan, no
// learner data in any field or URL. `start_url` is the public prerendered shell, which asks the browser's own storage what to show. The brand blue is the
// icon background; the page colours match the layout's viewport theme colour (a manifest is JSON, so it cannot read a CSS variable, like themeColor).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/qatra",
    name: "قطرة غيث",
    short_name: "قطرة غيث",
    description: "تطبيق لحفظ القرآن والأحاديث، يعمل بالخطة المحمّلة دون اتصال.",
    lang: "ar",
    dir: "rtl",
    start_url: "/offline",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F5FAFE",
    theme_color: "#F5FAFE",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
