"use client";

// The Integrations hub — a first-class org surface (promoted out of Settings):
// the place to connect the external providers Orun coordinates. GitHub is live
// and fully managed here (install/connect, status, revoke); the roadmap
// providers (Supabase, Cloudflare, Slack) render as honest "Soon" slots.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Github,
  GitBranch,
  Plug,
  Database,
  Cloud,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import type { PublicConnection } from "@saas/contracts/integrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import {
  connectionDisplayName,
  connectionScopeMeta,
  connectionShareModeMeta,
  connectionStatusMeta,
  hasPendingConnection,
  uninstallDisclosure,
  visibleConnections,
} from "@/components/integrations/connections";
import { roadmapProviders } from "@/components/integrations/providers";

const POLL_INTERVAL_MS = 2500;
const POLL_BUDGET_MS = 11 * 60 * 1000; // connect state TTL (10 min) + margin

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  Github,
  Database,
  Cloud,
  MessageSquare,
};

export function IntegrationsHub({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();

  const list = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );

  const [connecting, setConnecting] = React.useState(false);
  const [gateError, setGateError] = React.useState<ApiErrorBody | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<PublicConnection | null>(null);
  const pollUntil = React.useRef<number>(0);

  const connections = list.data ?? [];
  const visible = visibleConnections(connections);
  const hasActive = connections.some((c) => c.status === "active");

  // While a connect popup is in flight (or a pending row exists), poll the list
  // so the row flips to Active without a manual refresh.
  const shouldPoll =
    (connecting || hasPendingConnection(connections)) && Date.now() < pollUntil.current;
  React.useEffect(() => {
    if (!shouldPoll) return;
    const t = setInterval(() => list.reload(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [shouldPoll, list]);

  React.useEffect(() => {
    if (connecting && hasActive) {
      setConnecting(false);
      toast({ kind: "success", title: "GitHub connected" });
    }
  }, [connecting, hasActive, toast]);

  const connect = async () => {
    setGateError(null);
    const r = await wrap(() => client.integrations.connectGithub(orgId));
    if (!r.ok) {
      if (r.status === 412) {
        setGateError(r.error);
      } else {
        toast({ kind: "error", title: "Could not start the connection", description: r.error.message });
      }
      return;
    }
    pollUntil.current = Date.now() + POLL_BUDGET_MS;
    setConnecting(true);
    list.reload();
    const popup = window.open(r.data.installUrl, "github-connect", "width=1020,height=780");
    if (!popup) {
      // Popup blocked — same flow, same tab.
      window.location.assign(r.data.installUrl);
    }
  };

  const revoke = async (connection: PublicConnection) => {
    const r = await wrap(() => client.integrations.revoke(orgId, connection.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Connection revoked" });
    list.reload();
  };

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect the external providers Orun coordinates. Repositories link to repos from each
          repo&apos;s Git settings once a provider is connected.
        </p>
      </header>

      {gateError ? (
        <PreconditionInsight
          error={gateError}
          resource="integration"
          onUpgrade={() => router.push(`/orgs/${orgSlug}/settings/billing`)}
          onDismiss={() => setGateError(null)}
        />
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-card">
              <Github className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">GitHub</CardTitle>
              <CardDescription>
                Install the GitHub App to react to pushes and pull requests, link repositories to
                repos, and act on GitHub without storing credentials.
              </CardDescription>
            </div>
          </div>
          <Button onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Waiting for GitHub…" : hasActive ? "Connect another" : "Connect"}
          </Button>
        </CardHeader>
        <CardContent>
          {list.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : list.error ? (
            <div className="py-2">
              <div className="text-sm font-medium text-destructive">Failed to load connections</div>
              <div className="text-xs text-muted-foreground">{list.error.message}</div>
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No GitHub connection yet"
              description="Connect a GitHub organization or account to start linking repositories to repos."
              primaryAction={{ label: "Connect GitHub", onClick: () => void connect() }}
            />
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((connection) => {
                const meta = connectionStatusMeta(connection.status);
                const scopeMeta = connectionScopeMeta(connection.scope);
                const shareMeta = connectionShareModeMeta(connection);
                return (
                  <li key={connection.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {connectionDisplayName(connection)}
                        </span>
                        <Badge variant={meta.tone === "default" ? "secondary" : meta.tone}>
                          {meta.label}
                        </Badge>
                        <Badge variant="outline">{scopeMeta.label}</Badge>
                        {shareMeta ? <Badge variant="outline">{shareMeta.label}</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{scopeMeta.description}</div>
                      <div className="text-xs text-muted-foreground">
                        {connection.externalAccountType ?? "GitHub"}
                        {connection.connectedAt
                          ? ` · connected ${new Date(connection.connectedAt).toLocaleDateString()}`
                          : connection.status === "pending"
                            ? " · waiting for the GitHub install to finish"
                            : ""}
                      </div>
                    </div>
                    {connection.status !== "revoked" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRevokeTarget(connection)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Roadmap providers — honest "Soon" slots so the hub reads as a hub. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">More connections</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {roadmapProviders().map((provider) => {
            const Icon = PROVIDER_ICONS[provider.icon] ?? Plug;
            return (
              <Card key={provider.id} className="border-dashed bg-muted/20">
                <CardHeader className="space-y-0 pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg border bg-card">
                        <Icon className="h-4.5 w-4.5 text-muted-foreground" />
                      </div>
                      <CardTitle className="text-sm">{provider.name}</CardTitle>
                    </div>
                    <Badge variant="secondary">Soon</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">{provider.description}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke GitHub connection?"
        description={
          revokeTarget
            ? uninstallDisclosure(revokeTarget)
            : "The platform stops receiving events for this installation and any linked repositories stop updating. This also uninstalls the App from GitHub when possible."
        }
        resourceName={revokeTarget ? connectionDisplayName(revokeTarget) : undefined}
        confirmLabel="Revoke connection"
        onConfirm={async () => {
          if (revokeTarget) await revoke(revokeTarget);
        }}
      />
    </div>
  );
}
