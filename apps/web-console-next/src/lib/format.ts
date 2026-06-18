/**
 * Locale date/time formatting — one place so every surface renders timestamps
 * the same compact way and tolerates a missing/invalid value (→ "—") instead of
 * "Invalid Date". Explicit field options keep output compact across locales
 * (vs. the verbose default of a bare toLocaleString).
 */

const DATE_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
const TIME_OPTS: Intl.DateTimeFormatOptions = { ...DATE_OPTS, hour: "numeric", minute: "2-digit" };

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Compact local date, e.g. "Jun 18, 2026"; "—" for missing/invalid input. */
export function formatDate(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? d.toLocaleDateString(undefined, DATE_OPTS) : "—";
}

/** Compact local date + time, e.g. "Jun 18, 2026, 3:14 PM"; "—" for missing/invalid. */
export function formatTimestamp(iso: string | null | undefined): string {
  const d = parse(iso);
  return d ? d.toLocaleString(undefined, TIME_OPTS) : "—";
}
