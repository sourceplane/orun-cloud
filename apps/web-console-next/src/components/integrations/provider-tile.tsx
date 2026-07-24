/**
 * ProviderTile — the colored brand glyph tile used across the Integrations
 * console (hub connected rows, detail header). A pure function of the provider
 * id: brand-colored square + white glyph, with a neutral category-agnostic
 * fallback so a provider without a brand entry still renders sensibly.
 *
 * saas-integrations-console IX1.
 */

import * as React from "react";
import {
  Cloud,
  Database,
  MessageSquare,
  Plug,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface TileBrand {
  /** Background color of the tile. */
  bg: string;
  /** Glyph color (defaults to white). */
  fg?: string;
  /** lucide glyph, or `mark: "github"` for the solid GitHub mark. */
  icon?: LucideIcon;
  mark?: "github";
}

/** Brand tiles per provider id. */
const BRANDS: Record<string, TileBrand> = {
  github: { bg: "#171717", mark: "github" },
  slack: { bg: "#4A154B", icon: MessageSquare },
  supabase: { bg: "#3ECF8E", fg: "#0B3B26", icon: Database },
  cloudflare: { bg: "#F6821F", icon: Cloud },
};

export function ProviderTile({
  provider,
  size = 40,
  className,
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  const brand = BRANDS[provider];
  const fg = brand?.fg ?? "#FFFFFF";
  const radius = Math.round(size * 0.28);
  const glyph = Math.round(size * 0.5);
  return (
    <span
      className={cn("grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size, borderRadius: radius, background: brand?.bg ?? "#171717" }}
      aria-hidden
    >
      {brand?.mark === "github" ? (
        <GithubMark size={glyph} color={fg} />
      ) : (
        (() => {
          const Icon = brand?.icon ?? Plug;
          return <Icon style={{ width: glyph, height: glyph, color: fg }} strokeWidth={1.9} />;
        })()
      )}
    </span>
  );
}

/** Solid GitHub mark (the lucide icon is stroke-only; the design uses the mark). */
export function GithubMark({ size = 20, color = "#FFFFFF" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
      <path d="M12 1.27a11 11 0 0 0-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.65-1.28-1.65-.92-.65.1-.65.1-.65 1.1 0 1.73 1.1 1.73 1.1.92 1.65 2.57 1.2 3.21.92a2 2 0 0 1 .64-1.47c-2.47-.27-5.04-1.19-5.04-5.5 0-1.1.46-2.1 1.2-2.84a3.76 3.76 0 0 1 0-2.93s.91-.28 3.11 1.1c1.8-.49 3.7-.49 5.5 0 2.1-1.38 3.02-1.1 3.02-1.1a3.76 3.76 0 0 1 .1 2.84 4.1 4.1 0 0 1 1.19 2.93c0 4.31-2.58 5.23-5.04 5.5.45.37.82.92.82 2.02v3.03c0 .27.1.64.73.55A11 11 0 0 0 12 1.27" />
    </svg>
  );
}
