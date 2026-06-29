/**
 * Status mark for runs & jobs (Activities redesign).
 *
 * A rounded square tinted with the status colour, holding the status glyph. The
 * glyph spins for in-progress states (running / claimed), matching the design's
 * `data-spin` treatment via Tailwind's `animate-spin`.
 */

import * as React from "react";
import type { StatusVisual } from "@/lib/runs-portal/palette";

export function StatusMark({
  vis,
  box = 24,
  glyph = 13,
  strokeWidth = 2.4,
  radius = 6,
}: {
  vis: StatusVisual;
  /** Outer square size. */
  box?: number;
  /** Inner glyph size. */
  glyph?: number;
  strokeWidth?: number;
  radius?: number;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center"
      style={{ width: box, height: box, borderRadius: radius, background: vis.tint }}
      aria-hidden="true"
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke={vis.color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={vis.spin ? "animate-spin [animation-duration:0.9s]" : undefined}
      >
        <path d={vis.icon} />
      </svg>
    </span>
  );
}

/** A small actor avatar — bot glyph or initials, tinted per the resolved actor. */
export function ActorChip({
  actor,
  box = 18,
}: {
  actor: { bot: boolean; icon: string; initials: string; bg: string; fg: string; name: string };
  box?: number;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[5px] text-[8px] font-bold"
      style={{ width: box, height: box, background: actor.bg, color: actor.fg }}
      title={actor.name}
      aria-hidden="true"
    >
      {actor.bot ? (
        <svg
          width={box * 0.55}
          height={box * 0.55}
          viewBox="0 0 24 24"
          fill="none"
          stroke={actor.fg}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={actor.icon} />
        </svg>
      ) : (
        actor.initials
      )}
    </span>
  );
}
