"use client";

// The Integrations hub — a first-class org surface (promoted out of Settings):
// the place to connect the external providers Orun coordinates. GitHub is live
// and fully managed here (install/connect, status, revoke); the roadmap
// providers (Supabase, Cloudflare, Slack) render as honest "Soon" slots.
//
// Northwind restyle: serif page header, "Connected" kicker over a white
// connection card (black GitHub tile, status pill, inner stat tiles), and an
// "On the roadmap" kicker over dashed provider cards.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  GitBranch,
  Plug,
  Database,
  Cloud,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";
import type { PublicConnection } from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import {
  Kicker,
  PageHeader,
  Pill,
  Screen,
  type Tone,
} from "@/components/ui/northwind";
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
import { ConnectionAdmission } from "@/components/integrations/connection-admission";

const POLL_INTERVAL_MS = 2500;
const POLL_BUDGET_MS = 11 * 60 * 1000; // connect state TTL (10 min) + margin

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  Github: GitBranch, // roadmap slots only; the live GitHub card uses the solid mark
  Database,
  Cloud,
  MessageSquare,
};

/** Badge tone (connections.ts) → Northwind pill tone. */
const STATUS_TONE: Record<string, Tone> = {
  default: "neutral",
  success: "success",
  warning: "warning",
  destructive: "error",
};

const DAY_MS = 24 * 60 * 60 * 1000;

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
    <Screen>
      <PageHeader
        title="Integrations"
        description="Orun is an orchestration plane over the services you already use. Connect a provider, and plans can act on it — without storing your credentials."
        actions={
          <Button onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Waiting for GitHub…" : hasActive ? "Connect another" : "Connect GitHub"}
          </Button>
        }
      />

      {gateError ? (
        <div className="mt-6">
          <PreconditionInsight
            error={gateError}
            resource="integration"
            onUpgrade={() => router.push(`/orgs/${orgSlug}/settings/billing`)}
            onDismiss={() => setGateError(null)}
          />
        </div>
      ) : null}

      <Kicker className="mb-2.5 mt-8">Connected</Kicker>
      {list.loading ? (
        <div className="space-y-3">
          <Skeleton className="h-[168px] w-full rounded-xl" />
        </div>
      ) : list.error ? (
        <div className="rounded-xl border bg-card px-6 py-5">
          <div className="text-[13.5px] font-medium text-destructive">Failed to load connections</div>
          <div className="mt-1 text-xs text-muted-foreground">{list.error.message}</div>
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No GitHub connection yet"
          description="Connect a GitHub organization or account to start linking repositories to repos."
          primaryAction={{ label: "Connect GitHub", onClick: () => void connect() }}
        />
      ) : (
        <div className="space-y-3">
          {visible.map((connection) => (
            <ConnectionCard
              key={connection.id}
              orgId={orgId}
              connection={connection}
              onRevoke={() => setRevokeTarget(connection)}
              onChanged={() => list.reload()}
            />
          ))}
        </div>
      )}

      {/* Roadmap providers — honest "Soon" slots so the hub reads as a hub. */}
      <Kicker className="mb-2.5 mt-8">On the roadmap</Kicker>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {roadmapProviders().map((provider) => {
          const Icon = PROVIDER_ICONS[provider.icon] ?? Plug;
          return (
            <div key={provider.id} className="rounded-xl border border-dashed bg-muted px-5 py-[18px]">
              <div className="flex items-center gap-2.5">
                <Icon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
                <span className="text-[13.5px] font-semibold text-secondary-foreground">{provider.name}</span>
                <span className="ml-auto shrink-0 rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
                  Soon
                </span>
              </div>
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">{provider.description}</p>
            </div>
          );
        })}
      </div>

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
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Connected provider card
// ---------------------------------------------------------------------------

function ConnectionCard({
  orgId,
  connection,
  onRevoke,
  onChanged,
}: {
  orgId: string;
  connection: PublicConnection;
  onRevoke: () => void;
  onChanged: () => void;
}) {
  const meta = connectionStatusMeta(connection.status);
  const scopeMeta = connectionScopeMeta(connection.scope);
  const shareMeta = connectionShareModeMeta(connection);
  const tone = STATUS_TONE[meta.tone] ?? "neutral";
  const statusLabel = connection.status === "active" ? "Connected" : meta.label;

  const caption = connection.inherited
    ? `Shared by ${connection.sharedByName ?? "your account"}${
        connection.sharedByWorkspaceRef ? ` (${connection.sharedByWorkspaceRef})` : ""
      } — link repos from a project's Git tab`
    : connection.connectedAt
      ? `authorized ${new Date(connection.connectedAt).toLocaleDateString(undefined, {
          month: "short",
          year: "numeric",
        })}`
      : connection.status === "pending"
        ? "waiting for the GitHub install to finish"
        : null;

  return (
    <div className="rounded-xl border bg-card px-5 py-[18px] sm:px-6 sm:py-[22px]">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-[#171717]" aria-hidden>
          <GithubMark />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold leading-tight">GitHub</span>
            <Pill tone={tone} dot live={connection.status === "pending"}>
              {statusLabel}
            </Pill>
            <MiniPill>{scopeMeta.label}</MiniPill>
            {shareMeta ? <MiniPill>{shareMeta.label}</MiniPill> : null}
            {connection.inherited ? <MiniPill>Inherited</MiniPill> : null}
          </div>
          <div className="mt-[3px] text-[12.5px] text-muted-foreground">
            Installation{" "}
            <span className="font-mono text-[11.5px]">{connectionDisplayName(connection)}</span>
            {connection.externalAccountType ? <> · {connection.externalAccountType}</> : null}
            {caption ? <> · {caption}</> : null}
          </div>
        </div>
        {/* Inherited connections are read-only in a child workspace. */}
        {connection.status !== "revoked" && !connection.inherited ? (
          <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={onRevoke}>
            Revoke
          </Button>
        ) : null}
      </div>

      {connection.status === "active" ? (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {connection.repositorySelection ? (
            <StatTile
              label="Repositories"
              value={connection.repositorySelection === "all" ? "All" : "Selected"}
              unit="allowed"
              caption={
                connection.repositorySelection === "all"
                  ? "The installation covers every repository."
                  : "Allowlist — Orun only sees what you grant."
              }
            />
          ) : null}
          <StatTile
            label="Sharing"
            value={connection.scope === "account" ? "Account" : "Workspace"}
            unit="scope"
            caption={shareMeta?.description ?? scopeMeta.description}
          />
          {connection.connectedAt ? (
            <ConnectedTile connectedAt={connection.connectedAt} />
          ) : null}
        </div>
      ) : null}

      {connection.status === "active" && connection.scope === "account" && !connection.inherited ? (
        <ConnectionAdmission orgId={orgId} connection={connection} onChanged={onChanged} />
      ) : null}
    </div>
  );
}

function ConnectedTile({ connectedAt }: { connectedAt: string }) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(connectedAt).getTime()) / DAY_MS));
  return (
    <StatTile
      label="Connected"
      value={days === 0 ? "Today" : `${days}d`}
      unit={days === 0 ? undefined : "ago"}
      caption={`since ${new Date(connectedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`}
    />
  );
}

/** Inner stat tile: kicker + serif 22px value + 13px unit + 12px caption. */
function StatTile({
  label,
  value,
  unit,
  caption,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string | undefined;
  caption: string;
}) {
  return (
    <div className="rounded-[10px] border border-[#ECECEC] px-4 py-3.5 dark:border-border">
      <Kicker className="tracking-[.07em]">{label}</Kicker>
      <div className="mt-1.5 font-serif text-[22px] font-medium leading-tight">
        {value}
        {unit ? <span className="font-sans text-[13px] font-normal text-muted-foreground"> {unit}</span> : null}
      </div>
      <div className="mt-1 text-xs leading-normal text-muted-foreground">{caption}</div>
    </div>
  );
}

/** 10.5px caps outline mini-pill (scope / sharing provenance). */
function MiniPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
      {children}
    </span>
  );
}

/** Solid GitHub mark (the lucide icon is stroke-only; the mock uses the mark). */
function GithubMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#FAFAFA" aria-hidden>
      <path d="M12 1.27a11 11 0 0 0-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.65-1.28-1.65-.92-.65.1-.65.1-.65 1.1 0 1.73 1.1 1.73 1.1.92 1.65 2.57 1.2 3.21.92a2 2 0 0 1 .64-1.47c-2.47-.27-5.04-1.19-5.04-5.5 0-1.1.46-2.1 1.2-2.84a3.76 3.76 0 0 1 0-2.93s.91-.28 3.11 1.1c1.8-.49 3.7-.49 5.5 0 2.1-1.38 3.02-1.1 3.02-1.1a3.76 3.76 0 0 1 .1 2.84 4.1 4.1 0 0 1 1.19 2.93c0 4.31-2.58 5.23-5.04 5.5.45.37.82.92.82 2.02v3.03c0 .27.1.64.73.55A11 11 0 0 0 12 1.27" />
    </svg>
  );
}
