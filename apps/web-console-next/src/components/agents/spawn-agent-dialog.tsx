"use client";

// Spawn an agent from a Work item (saas-agents AG8, design §6): the Work tab
// is where sessions are born. A Spec spawns a DESIGN run (turn the item into
// epic files + proposed contracts); a task spawns an IMPLEMENTATION run. The
// dialog creates the session and (by default) provisions its sandbox on the
// workspace's connected providers — refusals from the spawn gate (no verified
// Daytona/Anthropic connection) surface with a pointer to the Agents tab, and
// the session stays `requested`, retryable after connecting.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { AgentRunKind } from "@saas/contracts/agents";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { StatusText } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { workRefForItem } from "@/lib/agents/model";

export function SpawnAgentDialog({
  orgId,
  itemKey,
  runKind,
  open,
  onOpenChange,
}: {
  orgId: string;
  /** The Work item key (spec key for design runs, task key otherwise). */
  itemKey: string;
  runKind: AgentRunKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const params = useParams<{ orgSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";

  const profiles = useApiQuery(
    qk.orgAgentProfiles(orgId),
    () => wrap(async () => client.agents.listProfiles(orgId)),
    { enabled: open },
  );
  const profileRows = profiles.data ?? [];

  const [profileId, setProfileId] = React.useState<string | null>(null);
  const [provision, setProvision] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [gateError, setGateError] = React.useState<string | null>(null);
  const chosen = profileId ?? profileRows[0]?.id ?? null;

  async function spawn() {
    if (!chosen) return;
    setBusy(true);
    setGateError(null);
    const created = await wrap(async () =>
      client.agents.createSession(orgId, {
        profileId: chosen,
        runKind,
        taskKey: itemKey,
        workRef: workRefForItem(orgId, itemKey),
      }),
    );
    if (!created.ok) {
      setBusy(false);
      toast({ kind: "error", title: "Could not create the session", description: created.error.message });
      return;
    }
    let provisioned = true;
    if (provision) {
      const boot = await wrap(async () => client.agents.provisionSession(orgId, created.data.id));
      if (!boot.ok) {
        provisioned = false;
        // The spawn gate refused (design §10.3) — the session stays
        // `requested` and retries after the workspace connects providers.
        setGateError(boot.error.message);
      }
    }
    setBusy(false);
    if (provisioned) {
      onOpenChange(false);
      toast({
        kind: "success",
        title: `${runKind === "design" ? "Design" : "Implementation"} run spawned`,
        description: `${created.data.id} · watch it on the Agents tab`,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {runKind === "design" ? "Design with an agent" : "Implement with an agent"}
          </DialogTitle>
          <DialogDescription>
            {runKind === "design"
              ? `A hosted design run turns ${itemKey} into epic files and proposed contracts — delivered as a PR, reviewed like any other.`
              : `A hosted implementation run works ${itemKey} on a branch and opens a PR.`}
          </DialogDescription>
        </DialogHeader>

        {profileRows.length === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            No agent profiles yet. A profile binds an orun agent type to a service principal with a
            responsible owner — create one with <code className="font-mono">orun agent profile create</code>,
            then spawn from here.
          </p>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Profile</Label>
              <div className="grid gap-1">
                {profileRows.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-2 text-[13px]">
                    <input
                      type="radio"
                      name="agent-profile"
                      checked={chosen === p.id}
                      onChange={() => setProfileId(p.id)}
                    />
                    <span className="font-medium">{p.name}</span>
                    <span className="text-[12px] text-muted-foreground">
                      {p.agentType} · {p.model}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-[13px]">
              <Checkbox checked={provision} onCheckedChange={(v) => setProvision(v === true)} />
              Start the sandbox now (needs connected Daytona + Anthropic)
            </label>
            {gateError ? (
              <StatusText tone="warning">
                Session created, but the sandbox refused to start: {gateError}.{" "}
                <Link href={`/orgs/${orgSlug}/agents`} className="underline underline-offset-2">
                  Connect providers on the Agents tab
                </Link>{" "}
                and provision it from there.
              </StatusText>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {gateError ? "Close" : "Cancel"}
          </Button>
          <Button onClick={() => void spawn()} disabled={busy || !chosen}>
            {busy ? "Spawning…" : "Spawn agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
