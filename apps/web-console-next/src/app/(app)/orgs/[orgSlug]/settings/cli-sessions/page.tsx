"use client";

import * as React from "react";
import { Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";

/**
 * Settings → Sessions & devices (saas-orun-platform OP1).
 *
 * Lists the signed-in user's active Orun CLI logins (host, created, last used)
 * with revoke. CLI sessions are per-user, but the page lives in org settings
 * (next to API keys) for discoverability. Revoking kills the whole token family,
 * so the CLI loses access at its next refresh.
 */
export default function CliSessionsPage() {
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
      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
        title="Revoke CLI session"
        description="The Orun CLI on this device loses access at its next token refresh. This cannot be undone."
        resourceName={pendingRevoke?.host ?? "this device"}
        confirmLabel="Revoke session"
        onConfirm={() => (pendingRevoke ? revoke(pendingRevoke.id) : undefined)}
      />

      <header>
        <h1 className="text-xl font-semibold tracking-tight">Sessions &amp; devices</h1>
        <p className="text-sm text-muted-foreground">
          Devices where you&rsquo;ve signed the Orun CLI in with{" "}
          <span className="font-mono">orun auth login</span>. Revoke any you don&rsquo;t recognize.
        </p>
      </header>

      {sessions.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : sessions.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{sessions.error.code}</CardTitle>
            <CardDescription>{sessions.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : active.length === 0 ? (
        <EmptyState
          icon={Terminal}
          title="No CLI sessions"
          description="Run `orun auth login` (or `orun auth login --device` on a headless box) to connect the Orun CLI to this account."
        />
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-3 md:hidden">
            {active.map((s) => (
              <Card key={s.id} className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="truncate font-medium">{s.host ?? "Unknown device"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{s.id}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setPendingRevoke({ id: s.id, host: s.host })}>
                    Revoke
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <Badge variant="outline">cli</Badge>
                  <span>created {new Date(s.createdAt).toLocaleDateString()}</span>
                  <span>last used {new Date(s.lastUsedAt).toLocaleDateString()}</span>
                </div>
              </Card>
            ))}
          </div>

          {/* Desktop: table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {active.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.host ?? "Unknown device"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(s.lastUsedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(s.expiresAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setPendingRevoke({ id: s.id, host: s.host })}>
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
