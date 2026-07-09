"use client";

import * as React from "react";
import { Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, ListRow, Pill } from "@/components/ui/northwind";
import { AccountTabs } from "@/components/account/account-tabs";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { sessionClientLabel } from "@/lib/oauth-consent";

/**
 * Account → Sessions & devices (saas-settings-ia SI1; was Settings › Developer).
 *
 * Lists the signed-in user's active Orun CLI logins (host, created, last used)
 * with revoke. MCP OAuth grants (saas-mcp-server MCP3) appear in the same list —
 * they ARE CLI-shaped sessions, labeled `mcp:<clientId>` and rendered with the
 * vetted client's name. CLI sessions are per-user — not org-scoped — so this
 * lives in the personal account area alongside Profile and Security, not under
 * a workspace's settings. Revoking kills the whole token family, so the CLI or
 * MCP client loses access at its next refresh.
 */
export default function AccountSessionsPage() {
  const { client } = useSession();
  const { toast } = useToast();
  const sessions = useApiQuery(qk.cliSessions(), () =>
    wrap(async () => (await client.cliSessions.list()).sessions),
  );
  const [pendingRevoke, setPendingRevoke] = React.useState<{ id: string; host: string | null } | null>(
    null,
  );

  const revoke = async (id: string) => {
    const r = await wrap(() => client.cliSessions.revoke(id));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Session revoked" });
    sessions.reload();
  };

  const active = (sessions.data ?? []).filter((s) => !s.revokedAt);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Your account</h1>
        <p className="text-sm text-muted-foreground">Manage your profile and session.</p>
      </header>

      <AccountTabs active="sessions" />

      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
        title="Revoke CLI session"
        description="The Orun CLI on this device loses access at its next token refresh. This cannot be undone."
        resourceName={pendingRevoke?.host ?? "this device"}
        confirmLabel="Revoke session"
        onConfirm={() => (pendingRevoke ? revoke(pendingRevoke.id) : undefined)}
      />

      <SettingsHeader
        title="Sessions & devices"
        description={
          <>
            Devices where you&rsquo;ve signed the Orun CLI in with{" "}
            <span className="font-mono">orun auth login</span>. Revoke any you don&rsquo;t recognize.
          </>
        }
      />

      {sessions.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </SettingsPanel>
      ) : sessions.error ? (
        <SettingsPanel>
          <div className="text-[13.5px] font-semibold text-destructive">{sessions.error.code}</div>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">{sessions.error.message}</p>
        </SettingsPanel>
      ) : active.length === 0 ? (
        <EmptyState
          icon={Terminal}
          title="No CLI sessions"
          description="Run `orun auth login` (or `orun auth login --device` on a headless box) to connect the Orun CLI to this account."
        />
      ) : (
        <ListCard>
          {active.map((s) => {
            const { label, kind } = sessionClientLabel(s.host);
            return (
            <ListRow key={s.id} className="items-start">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{label}</span>
                  <Pill tone="neutral">{kind}</Pill>
                </div>
                <div className="font-mono text-[11.5px] text-muted-foreground">{s.id}</div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
                  <span>created {new Date(s.createdAt).toLocaleDateString()}</span>
                  <span>last used {new Date(s.lastUsedAt).toLocaleDateString()}</span>
                  <span>expires {new Date(s.expiresAt).toLocaleDateString()}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-destructive hover:text-destructive"
                onClick={() => setPendingRevoke({ id: s.id, host: label })}
              >
                Revoke
              </Button>
            </ListRow>
            );
          })}
        </ListCard>
      )}
    </div>
  );
}
