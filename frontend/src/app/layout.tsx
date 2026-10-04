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

export const metadata: Metadata = {
  // No logo exists yet; an empty icon stops browsers from requesting /favicon.ico.
  icons: { icon: "data:," },
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
