"use client";

// Create an agent profile (saas-agents AG7 follow-up, design §5): bind an orun
// agent type to a membership service principal with a responsible owner. The
// service principal is the agent's platform identity — a session token is
// minted for it (AG6 §3.2) — so it must be a REAL bound principal. API keys
// mint exactly such principals (with a role), so the picker offers the
// workspace's keys; the owner defaults to the signed-in user.

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusText } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import {
  AGENT_MODELS,
  AGENT_TYPES,
  DEFAULT_HARNESS,
  DELEGATION_INTERFACE_META,
  interfaceTier,
  modelOptions,
  servicePrincipalSubjectId,
} from "@/lib/agents/model";

export function CreateProfileDialog({
  orgId,
  open,
  onOpenChange,
  onCreated,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const params = useParams<{ orgSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";

  const apiKeys = useApiQuery(qk.apiKeys(orgId), () => wrap(async () => client.apiKeys.list(orgId)), {
    enabled: open,
  });
  const profile = useApiQuery(qk.profile(), () => wrap(async () => (await client.auth.getProfile()).user), {
    enabled: open,
  });
  // DX6: verified model connections contribute their defaultModel to the
  // picker — the model list is a provider-details setting, not a constant.
  const providers = useApiQuery(qk.orgAgentProviders(orgId), () => wrap(async () => client.agents.listProviders(orgId)), {
    enabled: open,
  });
  const models = modelOptions(providers.data ?? []);

  // Active (non-revoked) keys back a usable service principal.
  const keys = (apiKeys.data?.apiKeys ?? []).filter((k) => !k.revokedAt);

  const [name, setName] = React.useState("");
  const [principalUuid, setPrincipalUuid] = React.useState<string | null>(null);
  const [agentType, setAgentType] = React.useState<string>(AGENT_TYPES[0].value);
  const [model, setModel] = React.useState<string>(AGENT_MODELS[0].value);
  // DX7: how this profile's runs execute; managed requires a definition-time
  // tools allowlist (no verdict channel exists to ask mid-run).
  const [iface, setIface] = React.useState<string>("orun-sandbox");
  const [managedTools, setManagedTools] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const chosenUuid = principalUuid ?? keys[0]?.servicePrincipal.id ?? null;
  const ownerId = profile.data?.id ?? "";

  async function create() {
    if (!name || !chosenUuid || !ownerId) return;
    setBusy(true);
    const tools = managedTools
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const res = await wrap(async () =>
      client.agents.createProfile(orgId, {
        name,
        principalId: servicePrincipalSubjectId(chosenUuid),
        owner: ownerId,
        agentType,
        harness: DEFAULT_HARNESS,
        model,
        interface: iface as "orun-sandbox" | "anthropic-managed",
        ...(iface === "anthropic-managed" && tools.length > 0 ? { capability: { tools } } : {}),
      }),
    );
    setBusy(false);
    if (res.ok) {
      toast({ kind: "success", title: `Profile ${res.data.name} created` });
      setName("");
      onOpenChange(false);
      onCreated();
    } else {
      toast({ kind: "error", title: "Could not create the profile", description: res.error.message });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New agent profile</DialogTitle>
          <DialogDescription>
            A profile binds an orun agent type to a service principal — the agent&apos;s platform identity —
            with you as the responsible owner.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              placeholder="impl-default"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Service principal (an API key)</Label>
            {apiKeys.loading && !apiKeys.data ? (
              <StatusText tone="neutral">Loading…</StatusText>
            ) : keys.length === 0 ? (
              <StatusText tone="warning">
                An agent runs as a service principal — and every API key is backed by one. You have no keys
                yet: create one on{" "}
                <Link href={`/orgs/${orgSlug}/settings/api-keys`} className="underline underline-offset-2">
                  Settings › API keys
                </Link>{" "}
                (label + role — the role becomes the agent&apos;s permissions), then come back.
              </StatusText>
            ) : (
              <Select {...(chosenUuid ? { value: chosenUuid } : {})} onValueChange={setPrincipalUuid}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a service principal" />
                </SelectTrigger>
                <SelectContent>
                  {keys.map((k) => (
                    <SelectItem key={k.id} value={k.servicePrincipal.id}>
                      {k.label} · {k.servicePrincipal.role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>Agent type</Label>
            <Select value={agentType} onValueChange={setAgentType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label} — {t.blurb}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>Delegation interface</Label>
            <Select value={iface} onValueChange={setIface}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DELEGATION_INTERFACE_META).map(([value, meta]) => (
                  <SelectItem key={value} value={value}>
                    {meta.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <StatusText tone="neutral" className="text-[11.5px]">
              {interfaceTier(iface).blurb}
            </StatusText>
            {iface === "anthropic-managed" ? (
              <Input
                placeholder="Tool allowlist (comma-separated — required: managed runs narrow at definition time)"
                value={managedTools}
                onChange={(e) => setManagedTools(e.target.value)}
              />
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label>Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <StatusText tone="neutral" className="text-[11.5px]">
            Harness {DEFAULT_HARNESS} · owner {profile.data?.displayName ?? (ownerId || "you")}
          </StatusText>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={busy || !name || !chosenUuid || !ownerId}>
            {busy ? "Creating…" : "Create profile"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
