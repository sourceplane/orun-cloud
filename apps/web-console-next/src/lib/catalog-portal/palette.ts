/**
 * Catalog-portal palette (saas-catalog-portal CP0).
 *
 * The exact colour constants from the vendored visual contract
 * (`specs/epics/saas-catalog-portal/design/Service_Catalog.dc.html`). One typed
 * source of truth so every portal component and every unit test reads the same
 * values — the catalog content is a fixed dark data surface that matches the
 * design regardless of the app's light/dark theme.
 *
 * Pure and dependency-free.
 */

/** Health states → dot colour `c`, label `t`, and lighter text colour `l`. */
export const HEALTH = {
  healthy: { c: "#34d399", t: "Healthy", l: "#86efac" },
  degraded: { c: "#fbbf24", t: "Degraded", l: "#fcd34d" },
  down: { c: "#f87171", t: "Down", l: "#fca5a5" },
  /** Resources (and entities with no runtime signal) are "Managed". */
  managed: { c: "#52525b", t: "Managed", l: "#a1a1aa" },
} as const;

export type HealthKey = keyof typeof HEALTH;

/** Lifecycle stages → dot colour `c` and text colour `t`. */
export const LIFE = {
  production: { c: "#34d399", t: "#d4d4d8" },
  experimental: { c: "#fbbf24", t: "#d4d4d8" },
  deprecated: { c: "#71717a", t: "#71717a" },
} as const;

export type LifecycleKey = keyof typeof LIFE;

/** Maturity tiers → colour `c`, chip background `bg`, chip border `b`. */
export const TIER = {
  Gold: { c: "#f59e0b", bg: "rgba(245,158,11,.1)", b: "rgba(245,158,11,.25)" },
  Silver: { c: "#9ca3af", bg: "rgba(156,163,175,.1)", b: "rgba(156,163,175,.22)" },
  Bronze: { c: "#c2855b", bg: "rgba(194,133,91,.1)", b: "rgba(194,133,91,.25)" },
} as const;

export type TierKey = keyof typeof TIER;

/** Readiness-check status → mark colour `c` and chip background `bg`. */
export const CHECK_COLOR = {
  pass: { c: "#34d399", bg: "rgba(52,211,153,.14)" },
  warn: { c: "#fbbf24", bg: "rgba(251,191,36,.14)" },
  fail: { c: "#f87171", bg: "rgba(248,113,113,.14)" },
} as const;

/** Surface greys, borders and text ramps from the design. */
export const SURFACE = {
  canvas: "#08080a",
  card: "#0d0d10",
  cardAlt: "#0c0c0f",
  cardHover: "#121215",
  panel: "#0a0a0d",
  inset: "#0e0e11",
  border: "#1c1c20",
  borderSoft: "#1a1a1e",
  borderRow: "#141417",
  borderChip: "#26262b",
  accent: "#f59e0b",
  accentInk: "#1a1206",
} as const;

/** Text ramp from brightest to faintest. */
export const TEXT = {
  bright: "#fafafa",
  primary: "#e4e4e7",
  secondary: "#d4d4d8",
  muted: "#a1a1aa",
  faint: "#71717a",
  fainter: "#52525b",
  ghost: "#3f3f46",
} as const;

/** Ownership-grade colour for the Ownership tile (matches the design). */
export function ownedColor(pct: number): string {
  if (pct >= 90) return HEALTH.healthy.c;
  if (pct >= 75) return HEALTH.degraded.c;
  return HEALTH.down.c;
}
