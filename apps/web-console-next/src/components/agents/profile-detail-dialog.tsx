"use client";

// Profile audit view (saas-agents AG7 follow-up): a read-only detail dialog so
// an operator can inspect the identity a session runs AS without leaving the
// console. It surfaces exactly what the profile wire record carries — the
// agent type, harness, model, the service principal it acts as, the
// responsible owner, and the autonomy default plus its movement history (AF7).
//
// NOTE on scope: the profile's PROMPT and tool/capability contract are NOT on
// this wire shape — they live in the sealed orun agent type (agents/*.md), and
// the profile may only NARROW that ceiling (see toPublicProfile in
// apps/agents-worker, which deliberately omits `capability`). We say so rather
// than pretend the console can audit them today.

import * as React from "react";
import type { AgentProfile } from "@saas/contracts/agents";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kicker, Pill, StatusText } from "@/components/ui/northwind";
import { AGENT_MODELS, AGENT_TYPES } from "@/lib/agents/model";

function modelLabel(model: string): string {
  return AGENT_MODELS.find((m) => m.value === model)?.label ?? model;
}

function agentTypeLabel(agentType: string): string {
  return AGENT_TYPES.find((t) => t.value === agentType)?.label ?? agentType;
}

/** A label/value row — the console's detail-row convention. */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border/50 py-2 text-[13px] first:border-t-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  );
}

/** Read the AF7 autonomy-movement address into a compact human line. */
function autonomyMovement(evidence: AgentProfile["autonomyEvidence"]): string | null {
  if (!evidence) return null;
  const e = evidence as {
    direction?: string;
    from?: string;
    to?: string;
    by?: string;
    at?: string;
    trigger?: string;
  };
  if (!e.direction) return null;
  const when = e.at ? new Date(e.at).toLocaleDateString() : null;
  const arrow = e.from && e.to ? ` ${e.from} → ${e.to}` : "";
  const who =
    e.direction === "demoted" && e.trigger
      ? ` (${e.trigger})`
      : e.by
        ? ` by ${e.by}`
        : "";
  return `${e.direction}${arrow}${when ? ` on ${when}` : ""}${who}`;
}

export function ProfileDetailDialog({
  profile,
  open,
  onOpenChange,
}: {
  profile: AgentProfile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const movement = autonomyMovement(profile.autonomyEvidence);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              {profile.name}
              <Pill tone="neutral">{agentTypeLabel(profile.agentType)}</Pill>
            </span>
          </DialogTitle>
          <DialogDescription>
            The identity a session runs as — inspect it before you trust a run to it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div>
            <Kicker className="mb-1.5">Runtime</Kicker>
            <div className="border-t border-border/50">
              <Row label="Agent type" value={agentTypeLabel(profile.agentType)} />
              <Row label="Harness" value={profile.harness} />
              <Row label="Model" value={modelLabel(profile.model)} />
            </div>
          </div>

          <div>
            <Kicker className="mb-1.5">Identity &amp; permissions</Kicker>
            <div className="border-t border-border/50">
              <Row
                label="Service principal"
                value={<span className="font-mono text-[12px]">{profile.principalId}</span>}
              />
              <Row label="Responsible owner" value={<span className="font-mono text-[12px]">{profile.owner}</span>} />
              <Row label="Autonomy default" value={<Pill tone="warning">{profile.autonomyDefault}</Pill>} />
              {movement ? <Row label="Autonomy history" value={movement} /> : null}
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
              Permissions are the service principal&apos;s role — the role its API key was minted with.
              Autonomy governs how far a session may act before it must ask a human.
            </p>
          </div>

          <div>
            <Kicker className="mb-1.5">Prompt &amp; tools</Kicker>
            <StatusText tone="neutral" className="text-[12px] leading-relaxed">
              The prompt and tool contract live in the sealed orun agent type
              (<span className="font-mono">agents/{profile.agentType}.md</span>); this profile can only
              narrow that ceiling. They are not projected to the console, so audit them at the agent type.
            </StatusText>
          </div>

          <div className="text-[11px] text-muted-foreground">
            <span className="font-mono">{profile.id}</span> · created{" "}
            {new Date(profile.createdAt).toLocaleString()} · updated{" "}
            {new Date(profile.updatedAt).toLocaleString()}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
