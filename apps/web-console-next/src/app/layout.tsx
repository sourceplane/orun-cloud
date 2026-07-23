import type { Metadata, Viewport } from "next";
import { Newsreader } from "next/font/google";
import "../styles/globals.css";
import { Providers } from "./providers";
import { CONSOLE_TITLE, PRODUCT_DESCRIPTION, PRODUCT_NAME, STORAGE_PREFIX } from "@/lib/app-config";
import { TARGETS } from "@/lib/api";
import { bootPrimerScript } from "@/lib/boot-primer";

// Northwind display serif — page titles, greetings, stat numerals. Exposed as
// a CSS variable so globals.css can fold it into --font-serif.
const newsreader = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-newsreader",
});

export const metadata: Metadata = {
  title: CONSOLE_TITLE,
  description: PRODUCT_DESCRIPTION,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: PRODUCT_NAME,
    statusBarStyle: "black-translucent",
  },
};

// `viewport-fit=cover` enables `env(safe-area-inset-*)` on notched devices;
// theme-color tints the mobile browser chrome to match light/dark surfaces.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#121212" },
  ],
};

// The whole console is session-authenticated and renders nothing of value
// statically — the root Providers tree (SessionProvider, theme, CommandPalette)
// is fully client-only and trips Next.js 15's static export with
// `TypeError: Cannot read properties of undefined (reading 'url')` inside
// useMemo on every route including /_not-found. Opt the entire app out of
// static prerender at the root; per-route fixes don't help because the
// failing code paths live in the layout's Providers.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={newsreader.variable}>
      <body className="min-h-screen bg-background text-foreground antialiased">
        {/*
          esbuild's `keepNames` helper (`__name`) is referenced by the
          next-themes inline theme script in the @opennextjs/cloudflare build,
          but it isn't defined in the browser — so without this shim every page
          throws `ReferenceError: __name is not defined` and crashes before
          hydration. Define a no-op (returning the target) ahead of that script.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: "globalThis.__name=globalThis.__name||function(t){return t};",
          }}
        />
        {/*
          IC3 boot primer: fire the session-boot reads (profile + org list)
          the moment HTML arrives — before any bundle downloads or hydrates —
          so boot data races the JS instead of waiting for it. The hydrated
          SDK client adopts these in-flight responses (see lib/boot-primer.ts).
        */}
        <script dangerouslySetInnerHTML={{ __html: bootPrimerScript(TARGETS, STORAGE_PREFIX) }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
