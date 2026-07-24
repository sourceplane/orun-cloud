// The origin chip (saas-agent-supervision SV0, design §2.3): one chip
// vocabulary for an implementer's provenance, rendered on fleet rows and the
// implementer cockpit. Colour is neutral — the state pill owns fleet colour;
// origin is provenance, not status. A backfilled (inferred) origin renders
// muted so nobody mistakes inference for door-recorded truth.

import * as React from "react";
import Link from "next/link";
import type { AgentOrigin } from "@saas/contracts/agents";
import { Pill } from "@/components/ui/northwind";
import { originChip } from "@/lib/agents/model";

export function OriginChipView({
  origin,
  orgSlug,
  linked = false,
}: {
  origin: AgentOrigin;
  orgSlug: string;
  /** When true and the origin has a destination, wrap the chip in a deep link.
   * Fleet rows are already a row-level link, so they pass linked={false} to
   * avoid nesting anchors. */
  linked?: boolean;
}) {
  const chip = originChip(origin, orgSlug);
  const titleText = chip.backfilled ? `${chip.title ?? chip.label} · inferred` : chip.title;
  const pill = (
    <Pill tone={chip.tone} {...(chip.backfilled ? { className: "opacity-60" } : {})}>
      <span {...(titleText ? { title: titleText } : {})}>
        {chip.label}
        {chip.backfilled ? <span className="ml-1 text-muted-foreground">·?</span> : null}
      </span>
    </Pill>
  );
  if (linked && chip.href) {
    return (
      <Link href={chip.href} className="shrink-0 no-underline hover:opacity-80">
        {pill}
      </Link>
    );
  }
  return pill;
}
