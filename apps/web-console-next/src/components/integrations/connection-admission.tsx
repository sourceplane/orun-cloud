"use client";

// Account-admin admission management (saas-integration-tenancy IT5b/IT8b).
// Shown for ACTIVE, account-shared connections: switch the admission posture
// (auto ↔ granted) and, under 'granted', manage which workspaces are admitted.

import * as React from "react";
import type { PublicConnection } from "@saas/contracts/integrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

export function ConnectionAdmission({
  orgId,
  connection,
  onChanged,
}: {
  orgId: string;
  connection: PublicConnection;
  /** Called after the share mode changes so the parent can refresh its list. */
  onChanged?: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  // Optimistic local mirror — the parent list only refreshes on its own poll,
  // so reflect a share-mode switch immediately without waiting for it.
  const [mode, setMode] = React.useState(connection.shareMode);
  React.useEffect(() => setMode(connection.shareMode), [connection.shareMode]);
  const isGranted = mode === "granted";

  const grants = useApiQuery(qk.connectionGrants(orgId, connection.id), () =>
    wrap(async () => (await client.integrations.listGrants(orgId, connection.id)).grants),
  );
  // The account's child workspaces (IT12) — the picker's source.
  const workspaces = useApiQuery(qk.accountWorkspaces(orgId), () =>
    wrap(async () => (await client.organizations.listWorkspaces(orgId)).workspaces),
  );

  const [admitOrgId, setAdmitOrgId] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const setShareMode = async (shareMode: "auto" | "granted") => {
    if (shareMode === mode) return;
    setBusy(true);
    const r = await wrap(() => client.integrations.update(orgId, connection.id, { shareMode }));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not update sharing", description: r.error.message });
      return;
    }
    setMode(shareMode);
    toast({
      kind: "success",
      title: shareMode === "granted" ? "Now by invitation" : "Open to all workspaces",
    });
    grants.reload();
    onChanged?.();
  };

  const admit = async () => {
    const value = admitOrgId.trim();
    if (!value) return;
    setBusy(true);
    const r = await wrap(() =>
      client.integrations.grantWorkspace(orgId, connection.id, { workspaceOrgId: value }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({
        kind: "error",
        title: "Could not admit workspace",
        description: r.status === 409 ? "That workspace is already admitted." : r.error.message,
      });
      return;
    }
    setAdmitOrgId("");
    toast({ kind: "success", title: "Workspace admitted" });
    grants.reload(); // the admitted workspace drops out of the picker
  };

  const revoke = async (workspaceOrgId: string) => {
    setBusy(true);
    const r = await wrap(() => client.integrations.revokeGrant(orgId, connection.id, workspaceOrgId));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not revoke", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Admission revoked" });
    grants.reload();
  };

  const active = (grants.data ?? []).filter((g) => g.status === "active");
  // Workspaces not yet admitted — the picker's options.
  const admittedIds = new Set(active.map((g) => g.workspaceOrgId));
  const available = (workspaces.data ?? []).filter((w) => !admittedIds.has(w.orgId));

  return (
    <div className="mt-3 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium">Workspace access</div>
        <div className="inline-flex overflow-hidden rounded-md border">
          <button
            type="button"
            disabled={busy}
            onClick={() => void setShareMode("auto")}
            className={`px-2.5 py-1 text-xs ${!isGranted ? "bg-card font-medium" : "text-muted-foreground"}`}
          >
            Open to all
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void setShareMode("granted")}
            className={`border-l px-2.5 py-1 text-xs ${isGranted ? "bg-card font-medium" : "text-muted-foreground"}`}
          >
            By invitation
          </button>
        </div>
      </div>

      {isGranted ? (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <select
              value={admitOrgId}
              onChange={(e) => setAdmitOrgId(e.target.value)}
              disabled={busy || available.length === 0}
              className="h-8 flex-1 rounded-md border bg-card px-2 text-xs"
            >
              <option value="">
                {workspaces.loading
                  ? "Loading workspaces…"
                  : available.length === 0
                    ? "No workspaces to admit"
                    : "Select a workspace…"}
              </option>
              {available.map((w) => (
                <option key={w.orgId} value={w.orgId}>
                  {w.name} ({w.workspaceRef})
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" disabled={busy || !admitOrgId} onClick={() => void admit()}>
              Admit
            </Button>
          </div>
          {grants.loading ? (
            <div className="text-xs text-muted-foreground">Loading admitted workspaces…</div>
          ) : active.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              No workspaces admitted yet — only the account can use this connection.
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-md border bg-card">
              {active.map((g) => (
                <li key={g.workspaceOrgId} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                  <span className="truncate font-mono text-xs">{g.workspaceOrgId}</span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(g.workspaceOrgId)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Every workspace under the account can use this connection. Switch to{" "}
          <Badge variant="outline">By invitation</Badge> to admit workspaces one by one.
        </p>
      )}
    </div>
  );
}
