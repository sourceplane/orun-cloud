/**
 * Catalog-portal icon paths (saas-catalog-portal CP0).
 *
 * SVG `path d` constants from the visual contract, kept as data so the
 * view-model can hand a renderer the exact glyph per kind / check status
 * without importing an icon component into the pure layer. Mirrors the design's
 * `ICON` / `MARK` maps verbatim.
 */

/** Kind → outline glyph path (Component cube · API share · Resource cylinder). */
export const KIND_ICON: Record<string, string> = {
  Component:
    "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z M3.3 7l8.7 5 8.7-5 M12 22V12",
  API: "M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2 M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06 M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8",
  Resource:
    "M12 2C7.58 2 4 3.34 4 5s3.58 3 8 3 8-1.34 8-3-3.58-3-8-3Z M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5 M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3",
};

/** Fallback glyph for kinds without a dedicated icon (System/Domain/Group). */
export const DEFAULT_ICON: string = KIND_ICON.Component!;

/** Resolve a kind's glyph path, case-insensitively, with a safe fallback. */
export function iconForKind(kind: string): string {
  const hit = Object.keys(KIND_ICON).find((k) => k.toLowerCase() === kind.toLowerCase());
  return hit ? KIND_ICON[hit]! : DEFAULT_ICON;
}

/** Check-status → tick/warn/cross mark path (drawer scorecard rows). */
export const CHECK_MARK: Record<"pass" | "warn" | "fail" | "unknown", string> = {
  pass: "M20 6 9 17l-5-5",
  warn: "M12 8v5 M12 17h.01",
  fail: "M18 6 6 18 M6 6l12 12",
  unknown: "M5 12h14", // an em-dash: no signal, no verdict
};

/**
 * Service-definition document glyphs (dedicated page Docs tab). Mirrors the
 * design's `docsFor` icon constants verbatim.
 */
export const DOC_ICON = {
  /** README / overview document. */
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6",
  /** ARCHITECTURE / PROVISIONING — an open book. */
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  /** RUNBOOK — an open binder. */
  runbook: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z",
  /** API.md — an endpoint link glyph. */
  api: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.6 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.6",
} as const;

/**
 * Activity-event glyphs + accent colours (dedicated page Activity tab). Mirrors
 * the design's `activityFor` icon/colour map; we surface only the honest,
 * provenance-derived subset (no fabricated run/deploy events) until a runtime
 * source exists.
 */
export const ACTIVITY_ICON: Record<string, { d: string; c: string }> = {
  deploy: { d: "M12 3v13 M7 11l5 5 5-5 M5 21h14", c: "#34d399" },
  fail: { d: "M18 6 6 18 M6 6l12 12", c: "#f87171" },
  incident: { d: "m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z M12 9v4 M12 17h.01", c: "#fbbf24" },
  pr: { d: "M6 3v12 M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M15 6a9 9 0 0 1-9 9", c: "#a78bfa" },
  check: { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4", c: "#60a5fa" },
  commit: { d: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3 12h6 M15 12h6", c: "#71717a" },
};
