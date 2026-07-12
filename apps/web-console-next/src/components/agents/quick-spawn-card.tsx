"use client";

// The quick-spawn card (saas-agents-fleet AF5, design §2.1) — the fleet
// home's lead affordance, straight from the Northwind mock: the default
// profile with its identity chips, a single Spawn session button, and the
// informed-consent caption demoted to one line (the facts fit). It spawns an
// interactive session on the workspace's connected compute; a provider-gate
// refusal surfaces inline with a pointer to connect, and the session stays
// `requested`, retryable — the AG8 spawn-dialog posture, one click.

import * as React from "react";
import { useRouter } from "next/navigation";
import type { AgentProfile } from "@saas/contracts/agents";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";

export function QuickSpawnCard({
  orgId,
  orgSlug,
  profiles,
  onSpawned,
}: {
  orgId: string;
  orgSlug: string;
  profiles: AgentProfile[];
  onSpawned: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  // The primary profile: the impl-default convention, else the sole/first one.
  const profile = profiles.find((p) => p.name === "impl-default" ) ?? profiles[0];

  const spawn = React.useCallback(async () => {
    if (!profile) return;
    setBusy(true);
    const created = await wrap(async () =>
      client.agents.createSession(orgId, { profileId: profile.id, runKind: "interactive" }),
    );
    if (!created.ok) {
      setBusy(false);
      toast({ kind: "error", title: "Could not create the session", description: created.error.message });
      return;
    }
    // Provision in the background; the session page shows live state and, on
    // a provider-gate refusal, the retry affordance. Either way we take the
    // user straight to the new session (their intent when they clicked Spawn).
    void wrap(async () => client.agents.provisionSession(orgId, created.data.id));
    onSpawned();
    router.push(`/orgs/${orgSlug}/agents/${created.data.id}`);
  }, [profile, client, orgId, orgSlug, toast, onSpawned, router]);

  if (!profile) return null;

  const principalHint = profile.principalId.length > 10 ? `${profile.principalId.slice(0, 10)}…` : profile.principalId;

  return (
    <div className="mb-8 rounded-xl border bg-card px-6 pb-4 pt-5">
      {/* The composer prompt line — the mock's "describe the run" affordance.
          A full Work-attach picker rides AG8; today it spawns interactive. */}
      <p className="text-[14px] text-muted-foreground">
        Describe the run — or attach a Work task and its approved spec becomes the prompt.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px]">
          <span className="font-medium">{profile.name}</span>
          <span className="text-muted-foreground">· {profile.agentType}</span>
        </span>
        <span className="inline-flex items-center rounded-full border px-3 py-1 text-[12.5px] text-muted-foreground">
          {profile.harness} · {profile.model}
        </span>
        <Pill tone="warning">autonomy {profile.autonomyDefault}</Pill>
        <div className="ml-auto">
          <Button onClick={() => void spawn()} disabled={busy}>
            {busy ? "Spawning…" : "Spawn session →"}
          </Button>
        </div>
      </div>
      <p className="mt-3.5 border-t pt-3 text-[12px] text-muted-foreground">
        Runs in your Daytona sandbox as {principalHint} · ANTHROPIC_API_KEY injected at start, never
        stored on the session.
      </p>
    </div>
  );
}
