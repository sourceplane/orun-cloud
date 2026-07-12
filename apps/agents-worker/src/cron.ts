// Minimal 5-field cron for routine triggers (saas-agents-fleet AF6, design
// §5.1). Deliberately small: minute hour day-of-month month day-of-week, with
// `*`, `*/n`, lists and ranges — evaluated in UTC. The product floor is
// HOURLY (the minute field must pin specific minutes), enforced at routine
// validation so a typo'd `* * * * *` can never spend every minute of a month.
// Pure and dependency-free; the scheduler tick supplies the clock.

export interface CronSpec {
  minute: Set<number> | "any";
  hour: Set<number> | "any";
  dayOfMonth: Set<number> | "any";
  month: Set<number> | "any";
  dayOfWeek: Set<number> | "any";
}

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

function parseField(field: string, min: number, max: number): Set<number> | "any" | null {
  if (field === "*") return "any";
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const step = part.match(/^(\*|\d+-\d+)\/(\d+)$/);
    if (step) {
      const n = Number(step[2]);
      if (!Number.isInteger(n) || n <= 0) return null;
      let lo = min;
      let hi = max;
      if (step[1] !== "*") {
        const [a, b] = step[1]!.split("-").map(Number);
        lo = a!;
        hi = b!;
        if (lo < min || hi > max || lo > hi) return null;
      }
      for (let v = lo; v <= hi; v += n) out.add(v);
      continue;
    }
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < min || b > max || a > b) return null;
      for (let v = a; v <= b; v++) out.add(v);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    const v = Number(part);
    if (v < min || v > max) return null;
    out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** parseCron parses a 5-field expression; null on any malformation. */
export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed = fields.map((f, i) => parseField(f, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1]));
  if (parsed.some((p) => p === null)) return null;
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
  };
}

/** The hourly product floor: the minute field must pin specific minutes and
 * name at most a handful (a `0,15,30,45 * * * *` quarter-hour cron is still
 * sub-hourly and refused). */
export function isHourlyOrCoarser(spec: CronSpec): boolean {
  return spec.minute !== "any" && spec.minute.size === 1;
}

function matchField(set: Set<number> | "any", v: number): boolean {
  return set === "any" || set.has(v);
}

/** cronMatches — does this UTC instant's minute satisfy the spec? Standard
 * cron dom/dow semantics: when BOTH are restricted, either may match. */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!matchField(spec.minute, at.getUTCMinutes())) return false;
  if (!matchField(spec.hour, at.getUTCHours())) return false;
  if (!matchField(spec.month, at.getUTCMonth() + 1)) return false;
  const domRestricted = spec.dayOfMonth !== "any";
  const dowRestricted = spec.dayOfWeek !== "any";
  const domOk = matchField(spec.dayOfMonth, at.getUTCDate());
  const dowOk = matchField(spec.dayOfWeek, at.getUTCDay());
  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * dueSince — did any minute in (from, to] match? The scheduler's misfire
 * semantics ride on the caller passing `from = max(lastFiredAt, to - lookback)`:
 * a missed tick fires ONCE on recovery (the window still covers the slot),
 * and anything older than the lookback is forgotten — predicates, not
 * backlogs (design §5.3).
 */
export function dueSince(spec: CronSpec, from: Date, to: Date): boolean {
  // Scan minute boundaries after `from` up to `to`; windows are bounded by
  // the caller's lookback so this stays a ≤lookback-minutes loop.
  const start = Math.floor(from.getTime() / 60_000) + 1;
  const end = Math.floor(to.getTime() / 60_000);
  for (let m = start; m <= end; m++) {
    if (cronMatches(spec, new Date(m * 60_000))) return true;
  }
  return false;
}
