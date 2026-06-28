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
export const CHECK_MARK: Record<"pass" | "warn" | "fail", string> = {
  pass: "M20 6 9 17l-5-5",
  warn: "M12 8v5 M12 17h.01",
  fail: "M18 6 6 18 M6 6l12 12",
};
