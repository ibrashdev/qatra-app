import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Cairo (arabic) and Inter (latin) from the Fontsource subset entry files; Amiri Quran and Amiri are declared in fonts.css.
import "@fontsource/cairo/arabic-400.css";
import "@fontsource/cairo/arabic-600.css";
import "@fontsource/cairo/arabic-700.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "../styles/fonts.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { LOCALE_BOOT_SCRIPT } from "@/i18n/locale";
import { PwaBootstrap } from "./PwaBootstrap";

export const metadata: Metadata = {
  // The icons are the approved S-01 droplet glyph, white on the brand blue, rasterised once by scripts/make-icons.mjs (offline decision G-08).
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // iOS has no install prompt: the learner adds the app by hand, and this is how the home-screen app is named and shown.
  appleWebApp: { capable: true, title: "قطرة غيث", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light",
  themeColor: "#F5FAFE",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOT_SCRIPT }} />
      </head>
      <body>
        <PwaBootstrap />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
