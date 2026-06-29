/**
 * Runs-portal palette (Activities redesign).
 *
 * The colour / glyph constants behind the org-wide Activities feed and the run
 * detail view, expressed against the app's theme tokens (`--success` /
 * `--destructive` / `--muted-foreground` …) so the surface reads the same in
 * both light and dark themes — exactly the approach the catalog portal took.
 *
 * The one exception is the "running" blue: the visual contract
 * (`specs/epics/saas-catalog-portal/design/Service_Catalog.dc.html`) uses a
 * soft cobalt for in-progress runs/jobs/progress bars that has no semantic
 * token, so it stays a literal (like the Silver/Bronze tier metals in the
 * catalog palette).
 *
 * Status glyph paths are lifted verbatim from the design's `RUN_ST` / `STEP_ST`
 * maps so the rendered icons match pixel-for-pixel. Pure and dependency-free:
 * one source of truth the workbench, the run detail view, and the unit tests
 * all read.
 */

import type { RunStatus, RunJobStatus, ActorRef, RunSource } from "@saas/contracts/state";

/** The design's in-progress cobalt — used for running runs/jobs and progress bars. */
export const RUN_BLUE = "#6f9fd8";

/** SVG `path d` glyphs for run/job status marks (verbatim from the design). */
export const STATUS_GLYPH = {
  check: "M20 6 9 17l-5-5",
  cross: "M18 6 6 18 M6 6l12 12",
  spinner: "M21 12a9 9 0 1 1-6.2-8.5",
  clock: "M12 7v5l3 2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  slash: "M4.9 4.9 19 19 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  skip: "M9 18l6-6-6-6 M5 18l6-6-6-6",
} as const;

/** A status' rendered identity: ink colour, soft tint, label, glyph, and spin. */
export interface StatusVisual {
  /** Text / stroke colour. */
  color: string;
  /** Soft background tint for the status chip / icon square. */
  tint: string;
  /** Human label. */
  label: string;
  /** SVG path glyph. */
  icon: string;
  /** Whether the glyph should spin (in-progress states). */
  spin: boolean;
}

/** Run lifecycle status → visual. `pending` is the design's "Queued" state. */
export const RUN_STATUS: Record<RunStatus, StatusVisual> = {
  succeeded: { color: "hsl(var(--success))", tint: "hsl(var(--success) / 0.1)", label: "Succeeded", icon: STATUS_GLYPH.check, spin: false },
  failed: { color: "hsl(var(--destructive))", tint: "hsl(var(--destructive) / 0.1)", label: "Failed", icon: STATUS_GLYPH.cross, spin: false },
  running: { color: RUN_BLUE, tint: "rgba(111,159,216,0.1)", label: "Running", icon: STATUS_GLYPH.spinner, spin: true },
  pending: { color: "hsl(var(--muted-foreground))", tint: "hsl(var(--muted-foreground) / 0.1)", label: "Pending", icon: STATUS_GLYPH.clock, spin: false },
  canceled: { color: "hsl(var(--muted-foreground) / 0.8)", tint: "hsl(var(--muted-foreground) / 0.08)", label: "Canceled", icon: STATUS_GLYPH.slash, spin: false },
};

/** Job lifecycle status → visual (run detail jobs rail + steps). */
export const JOB_STATUS: Record<RunJobStatus, StatusVisual> = {
  succeeded: { color: "hsl(var(--success))", tint: "hsl(var(--success) / 0.1)", label: "Succeeded", icon: STATUS_GLYPH.check, spin: false },
  failed: { color: "hsl(var(--destructive))", tint: "hsl(var(--destructive) / 0.1)", label: "Failed", icon: STATUS_GLYPH.cross, spin: false },
  timed_out: { color: "hsl(var(--destructive))", tint: "hsl(var(--destructive) / 0.1)", label: "Timed out", icon: STATUS_GLYPH.cross, spin: false },
  running: { color: RUN_BLUE, tint: "rgba(111,159,216,0.1)", label: "Running", icon: STATUS_GLYPH.spinner, spin: true },
  claimed: { color: RUN_BLUE, tint: "rgba(111,159,216,0.1)", label: "Claimed", icon: STATUS_GLYPH.spinner, spin: true },
  queued: { color: "hsl(var(--muted-foreground))", tint: "hsl(var(--muted-foreground) / 0.1)", label: "Queued", icon: STATUS_GLYPH.clock, spin: false },
  canceled: { color: "hsl(var(--muted-foreground) / 0.8)", tint: "hsl(var(--muted-foreground) / 0.08)", label: "Canceled", icon: STATUS_GLYPH.slash, spin: false },
};

/** Trigger / source glyphs (the design's `RUN_TRIG`). */
export const SOURCE_GLYPH = {
  /** CI — a forking pull-request glyph. */
  ci: "M6 3v12 M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M15 6a9 9 0 0 1-9 9",
  /** CLI — a terminal prompt glyph. */
  cli: "M4 17l6-6-6-6 M12 19h8",
  /** Bot / automation actor (workflow, service principal, system). */
  bot: "M4 17l6-6-6-6 M12 19h8",
} as const;

/** A run's source → its short display label. */
export function sourceLabel(source: RunSource): string {
  return source === "ci" ? "CI" : "CLI";
}

/** Avatar palette for human actors — soft, theme-stable hues keyed by id hash. */
const AVATAR_HUES = ["#6f9fd8", "#5cbf92", "#c79bd8", "#d8a85c", "#7fb0c4", "#cf8a8a"] as const;

/** Stable small hash of a string → index into a fixed list. */
function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

/** Up-to-two-letter initials from a display label (falls back to "?"). */
export function actorInitials(label: string | null | undefined): string {
  const name = (label ?? "").trim();
  if (!name) return "?";
  const parts = name.split(/[\s._@-]+/).filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** A rendered actor avatar: bot icon vs initials, plus its colours. */
export interface ActorAvatar {
  /** Render the bot glyph (true) or initials (false). */
  bot: boolean;
  /** Bot glyph path (when `bot`). */
  icon: string;
  /** Initials (when not `bot`). */
  initials: string;
  /** Display name. */
  name: string;
  /** Avatar background tint. */
  bg: string;
  /** Avatar foreground (text / glyph) colour. */
  fg: string;
}

/**
 * Resolve a run's actor + source into an avatar. CI runs and non-user actors
 * (workflow / service_principal / system) render as a bot; humans render with
 * hashed-hue initials. Honest: derives only from the run's `createdBy`/`source`,
 * never fabricated.
 */
export function actorAvatar(actor: ActorRef | null | undefined, source: RunSource): ActorAvatar {
  const name = actor?.displayName?.trim() || (actor?.kind === "user" ? actor.id : sourceLabel(source));
  const isBot = source === "ci" || (actor != null && actor.kind !== "user");
  if (isBot) {
    return {
      bot: true,
      icon: SOURCE_GLYPH.bot,
      initials: "",
      name,
      bg: "rgba(111,159,216,0.12)",
      fg: RUN_BLUE,
    };
  }
  const hue = AVATAR_HUES[hashIndex(actor?.id ?? name, AVATAR_HUES.length)]!;
  return {
    bot: false,
    icon: "",
    initials: actorInitials(name),
    name,
    bg: `${hue}26`,
    fg: hue,
  };
}
