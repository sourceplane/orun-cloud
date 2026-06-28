/**
 * Catalog-portal palette (saas-catalog-portal CP0).
 *
 * The colour constants behind the catalog portal, expressed against the app's
 * theme tokens (the `--background` / `--foreground` / `--primary` … CSS
 * variables defined in `styles/globals.css`) rather than fixed hex. This keeps
 * the portal consistent with the rest of the console in BOTH light and dark
 * themes — the structure still mirrors the vendored visual contract
 * (`specs/epics/saas-catalog-portal/design/Service_Catalog.dc.html`), but the
 * surfaces, borders and text ramp now follow whichever theme is active instead
 * of staying a permanently-dark island inside a light app.
 *
 * Status hues (healthy/degraded/down, pass/warn/fail) map onto the semantic
 * tokens (`--success` / `--warning` / `--destructive`) which are tuned for
 * legibility on both surfaces; the rare metal tiers (Silver/Bronze) keep their
 * literal hue since the design has no token for them.
 *
 * One typed source of truth so every portal component and every unit test reads
 * the same values. Pure and dependency-free.
 */

/** Health states → dot colour `c`, label `t`, and text colour `l`. */
export const HEALTH = {
  healthy: { c: "hsl(var(--success))", t: "Healthy", l: "hsl(var(--success))" },
  degraded: { c: "hsl(var(--warning))", t: "Degraded", l: "hsl(var(--warning))" },
  down: { c: "hsl(var(--destructive))", t: "Down", l: "hsl(var(--destructive))" },
  /** Resources (and entities with no runtime signal) are "Managed". */
  managed: { c: "hsl(var(--muted-foreground))", t: "Managed", l: "hsl(var(--muted-foreground))" },
} as const;

export type HealthKey = keyof typeof HEALTH;

/** Lifecycle stages → dot colour `c` and text colour `t`. */
export const LIFE = {
  production: { c: "hsl(var(--success))", t: "hsl(var(--foreground) / 0.9)" },
  experimental: { c: "hsl(var(--warning))", t: "hsl(var(--foreground) / 0.9)" },
  deprecated: { c: "hsl(var(--muted-foreground) / 0.8)", t: "hsl(var(--muted-foreground) / 0.8)" },
} as const;

export type LifecycleKey = keyof typeof LIFE;

/** Maturity tiers → colour `c`, chip background `bg`, chip border `b`. */
export const TIER = {
  Gold: { c: "hsl(var(--primary))", bg: "hsl(var(--primary) / 0.1)", b: "hsl(var(--primary) / 0.25)" },
  Silver: { c: "#9ca3af", bg: "rgba(156,163,175,.1)", b: "rgba(156,163,175,.22)" },
  Bronze: { c: "#c2855b", bg: "rgba(194,133,91,.1)", b: "rgba(194,133,91,.25)" },
} as const;

export type TierKey = keyof typeof TIER;

/** Readiness-check status → mark colour `c` and chip background `bg`. */
export const CHECK_COLOR = {
  pass: { c: "hsl(var(--success))", bg: "hsl(var(--success) / 0.14)" },
  warn: { c: "hsl(var(--warning))", bg: "hsl(var(--warning) / 0.14)" },
  fail: { c: "hsl(var(--destructive))", bg: "hsl(var(--destructive) / 0.14)" },
} as const;

/** Surface greys, borders and text ramps mapped onto the theme tokens. */
export const SURFACE = {
  canvas: "hsl(var(--background))",
  card: "hsl(var(--card))",
  cardAlt: "hsl(var(--card))",
  cardHover: "hsl(var(--muted))",
  panel: "hsl(var(--background))",
  inset: "hsl(var(--popover))",
  border: "hsl(var(--border))",
  borderSoft: "hsl(var(--border))",
  borderRow: "hsl(var(--border) / 0.6)",
  borderChip: "hsl(var(--input))",
  accent: "hsl(var(--primary))",
  accentInk: "hsl(var(--primary-foreground))",
} as const;

/** Text ramp from brightest to faintest, against the theme foreground. */
export const TEXT = {
  bright: "hsl(var(--foreground))",
  primary: "hsl(var(--foreground))",
  secondary: "hsl(var(--foreground) / 0.9)",
  muted: "hsl(var(--muted-foreground))",
  faint: "hsl(var(--muted-foreground) / 0.8)",
  fainter: "hsl(var(--muted-foreground) / 0.6)",
  ghost: "hsl(var(--muted-foreground) / 0.45)",
} as const;

/** Ownership-grade colour for the Ownership tile (matches the design). */
export function ownedColor(pct: number): string {
  if (pct >= 90) return HEALTH.healthy.c;
  if (pct >= 75) return HEALTH.degraded.c;
  return HEALTH.down.c;
}
