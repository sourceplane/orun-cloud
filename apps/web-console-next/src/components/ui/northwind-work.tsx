"use client";

/**
 * Work-plane primitives (orun-work-v5 WV0). The Linear-grade vocabulary of
 * the Work surface — rung glyphs, milestone diamonds, two-segment meters,
 * agent avatars, live session chips, the lens bar, group bands, and truth
 * captions. Normative spec: specs/epics/orun-work-v5/design.md §2.
 *
 * Two rules are load-bearing here, not stylistic:
 *  - Every lifecycle rendering is DERIVED (V5-E): `RungIcon` is a pure
 *    function of the fold output and accepts no input.
 *  - A pin renders BESIDE observed truth, never instead of it (WV-3):
 *    `TaskRungMark` always draws the observed glyph and adds the attributed
 *    pin badge when one exists.
 *
 * Deliberately self-contained (React + tokens only) so the console test
 * suite renders these without framework shims. The v4 intent/health chips
 * stay in components/work/hierarchy-chips.tsx until the detail pages
 * migrate (WV4/WV6).
 */

import * as React from "react";
import type { WorkLifecycleView, WorkPinView, WorkRung } from "@saas/contracts/work";
import { cn } from "@/lib/cn";
import { rungLabel } from "@/lib/work/model";
import {
  arcDasharray,
  rungGlyph,
  type MilestoneDiamondState,
} from "@/lib/work/rungs";

/* ── Rung glyphs ────────────────────────────────────────────────────── */

const ARC_STROKES: Partial<Record<WorkRung, { track: string; arc: string }>> = {
  in_progress: { track: "hsl(var(--work-track-warning))", arc: "hsl(var(--warning-accent))" },
  in_review: { track: "hsl(var(--work-track-info))", arc: "hsl(var(--info))" },
};

/**
 * The Linear-style status glyph, derived: dashed ring → empty ring → ½ ring
 * → ¾ ring → filled check → green check. Geometry is a pure function of the
 * observed rung; the ring fraction encodes ladder position, not progress.
 */
export function RungIcon({
  rung,
  size = 14,
  className,
}: {
  rung: WorkRung;
  size?: number;
  className?: string;
}) {
  const spec = rungGlyph(rung);
  const label = rungLabel(rung);
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 14 14",
    role: "img" as const,
    "aria-label": label,
    className: cn("shrink-0", className),
    "data-rung": rung,
  };
  if (spec.kind === "disc") {
    const fill = rung === "released" ? "hsl(var(--success))" : "hsl(var(--primary))";
    const check = rung === "released" ? "hsl(var(--success-foreground))" : "hsl(var(--primary-foreground))";
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="6" fill={fill} />
        <path d="M4.4 7.3l1.8 1.8 3.5-3.8" fill="none" stroke={check} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (spec.kind === "arc") {
    const strokes = ARC_STROKES[rung] ?? { track: "hsl(var(--work-track))", arc: "hsl(var(--work-idle))" };
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="5.4" fill="none" stroke={strokes.track} strokeWidth="1.6" />
        <circle
          cx="7"
          cy="7"
          r="5.4"
          fill="none"
          stroke={strokes.arc}
          strokeWidth="1.6"
          strokeDasharray={arcDasharray(spec.fraction)}
          strokeLinecap="round"
          transform="rotate(-90 7 7)"
        />
      </svg>
    );
  }
  if (spec.kind === "cross") {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="5.4" fill="none" stroke="hsl(var(--work-idle-faint))" strokeWidth="1.6" />
        <path d="M5 5l4 4M9 5l-4 4" stroke="hsl(var(--work-idle-faint))" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle
        cx="7"
        cy="7"
        r="5.4"
        fill="none"
        stroke={spec.kind === "dashed" ? "hsl(var(--work-idle-faint))" : "hsl(var(--work-idle))"}
        strokeWidth="1.6"
        {...(spec.kind === "dashed" ? { strokeDasharray: "2.4 2.6" } : {})}
      />
    </svg>
  );
}

/** Attributed pin badge — always rendered BESIDE the observed glyph. */
export function PinBadge({ pin, className }: { pin: WorkPinView; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-soft px-2 py-px text-[10.5px] text-warning",
        className,
      )}
      title={pin.note ? `“${pin.note}”` : undefined}
      data-pin={pin.rung}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
      </svg>
      pinned {rungLabel(pin.rung).toLowerCase()} · {pin.by.id}
    </span>
  );
}

/**
 * The pair every task row renders: observed truth unconditionally, the pin
 * as an attributed badge beside it when one exists (WV-3).
 */
export function TaskRungMark({
  lifecycle,
  size = 14,
  showPin = true,
  className,
}: {
  lifecycle: WorkLifecycleView;
  size?: number;
  showPin?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <RungIcon rung={lifecycle.rung} size={size} />
      {showPin && lifecycle.pinned ? <PinBadge pin={lifecycle.pinned} /> : null}
    </span>
  );
}

/* ── Milestone ladder ───────────────────────────────────────────────── */

/** Rotated-square milestone marker: filled green (complete), amber outline
 *  (active), gray outline (upcoming). */
export function MilestoneDiamond({
  state,
  size = 14,
  className,
}: {
  state: MilestoneDiamondState;
  size?: number;
  className?: string;
}) {
  const fill =
    state === "complete" ? "hsl(var(--success))" : "hsl(var(--card))";
  const stroke =
    state === "complete"
      ? "none"
      : state === "active"
        ? "hsl(var(--warning-accent))"
        : "hsl(var(--work-outline))";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      role="img"
      aria-label={`milestone ${state}`}
      className={cn("shrink-0", className)}
      data-milestone={state}
    >
      <rect
        x="3.4"
        y="3.4"
        width="7.2"
        height="7.2"
        rx="1.6"
        transform="rotate(45 7 7)"
        fill={fill}
        {...(stroke === "none" ? {} : { stroke, strokeWidth: 1.6 })}
      />
    </svg>
  );
}

/** One rung of the milestone ladder: diamond + connecting rail + content.
 *  Set `last` on the final row to stop the rail. */
export function MilestoneRail({
  state,
  last = false,
  children,
  className,
}: {
  state: MilestoneDiamondState;
  last?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-3.5", className)}>
      <div className="flex w-4 shrink-0 flex-col items-center">
        <MilestoneDiamond state={state} className="mt-[3px]" />
        {last ? null : <span aria-hidden className="mt-[5px] w-[1.5px] flex-1 bg-border" />}
      </div>
      <div className={cn("min-w-0 flex-1", last ? "" : "pb-5")}>{children}</div>
    </div>
  );
}

/* ── Meters ─────────────────────────────────────────────────────────── */

/**
 * The Work two-segment meter: landed green + in-flight amber over a quiet
 * track, always with its arithmetic beside it (WV-2). Pass `fraction` as
 * the pre-formatted `n/m` string (callers own what n counts).
 */
export function WorkMeter({
  donePct,
  activePct = 0,
  fraction,
  width = 150,
  className,
}: {
  donePct: number;
  activePct?: number;
  fraction?: React.ReactNode;
  width?: number;
  className?: string;
}) {
  const done = Math.max(0, Math.min(100, donePct));
  const active = Math.max(0, Math.min(100 - done, activePct));
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-2", className)} style={{ width: fraction ? undefined : width }}>
      <span
        aria-hidden
        className="flex h-1 overflow-hidden rounded-sm bg-[hsl(var(--work-track))]"
        style={{ width: fraction ? width - 42 : width }}
      >
        {done > 0 ? <span className="bg-success" style={{ width: `${done}%` }} /> : null}
        {active > 0 ? <span className="bg-warning-accent" style={{ width: `${active}%` }} /> : null}
      </span>
      {fraction != null ? (
        <span className="w-[34px] shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground">{fraction}</span>
      ) : null}
    </span>
  );
}

/* ── Actors ─────────────────────────────────────────────────────────── */

/** Agent teammate avatar: square with the four-point star — deliberately
 *  unconfusable with round human initials at equal visual rank (V5-F). */
export function AgentAvatar({
  size = 18,
  title,
  className,
}: {
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    <span
      aria-label={title ?? "agent"}
      title={title}
      className={cn("grid shrink-0 place-items-center bg-[hsl(var(--agent-soft))]", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28) }}
      data-actor="agent"
    >
      <svg width={Math.round(size * 0.56)} height={Math.round(size * 0.56)} viewBox="0 0 14 14" aria-hidden>
        <path
          d="M7 1.2l1.5 4.1 4.3 1.2-4.3 1.2L7 11.8 5.5 7.7 1.2 6.5l4.3-1.2Z"
          fill="hsl(var(--agent))"
        />
      </svg>
    </span>
  );
}

/** Live agent-session chip: pulsing dot + mono `agent · session`. Renders a
 *  plain anchor when `href` is given (session pages are full navigations). */
export function SessionChip({
  agent,
  session,
  href,
  live = true,
  className,
}: {
  agent: string;
  session: string;
  href?: string;
  live?: boolean;
  className?: string;
}) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full bg-info", live && "animate-livepulse")}
      />
      <span className="truncate font-mono">
        {agent} · {session}
      </span>
    </>
  );
  const cls = cn("inline-flex min-w-0 items-center gap-1.5 text-[11px] text-info", href && "hover:underline", className);
  if (href) {
    return (
      <a href={href} className={cls} onClick={(e) => e.stopPropagation()}>
        {body}
      </a>
    );
  }
  return <span className={cls}>{body}</span>;
}

/* ── The lens bar ───────────────────────────────────────────────────── */

/** Sticky home tab bar: lenses left, Filter/Display/New right (§3.1). */
export function LensBar({
  children,
  actions,
  className,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-[5] flex items-center gap-1.5 border-b border-border/70 bg-background/95 pb-3 pt-3.5 backdrop-blur-[6px]",
        className,
      )}
    >
      {children}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function LensTab({
  active = false,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "rounded-[7px] px-3 py-[5px] text-[12.5px] transition-colors",
        active
          ? "bg-accent font-semibold text-foreground"
          : "font-normal text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ── Grouping & captions ────────────────────────────────────────────── */

/** Full-width group header band inside a list card. */
export function GroupBand({
  icon,
  label,
  count,
  labelClassName,
  className,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  count?: number;
  labelClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-border/50 bg-muted px-[18px] py-[7px] first:border-t-0",
        className,
      )}
    >
      {icon}
      <span className={cn("text-[11.5px] font-semibold", labelClassName)}>{label}</span>
      {count != null ? <span className="text-[11.5px] text-muted-foreground/70">{count}</span> : null}
    </div>
  );
}

/** The one-sentence truth-source caption under a lens list (§0). */
export function TruthCaption({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-2.5 text-xs leading-relaxed text-muted-foreground/85", className)} {...props} />;
}
