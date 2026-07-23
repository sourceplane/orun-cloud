"use client";

/**
 * The per-provider integration space (saas-secrets-platform SP2, design
 * addendum SP-A2) — the OWNER's surface for its secrets:
 *
 *   - **Create** lives here (ownership-model: "creation flows down from the
 *     owner"): the create dialog renders the provider's registered authoring
 *     surface (custom for Cloudflare, the SP1 default for declarative
 *     providers) at a scope the operator picks (workspace / project / env).
 *   - **This provider's secrets** — the filtered substrate read: the rows this
 *     provider's connections produced, at the selected scope. Lifecycle verbs
 *     stay on the Secrets lens (SP-D2 both is allowed; v1 links there).
 *   - **Scope templates** — the provider's declared catalog (read-only here
 *     until SP4 promotes it to runtime-managed).
 *   - **Connections** — this provider's connections, linking to the existing
 *     per-connection detail pages (custody/revoke stay there).
 *
 * `?create=1[&connection=int_…]` opens the create dialog (SP-A4: the
 * successor of the Secrets page's `?bind=1` deep link), pre-selecting and
 * locking the named connection.
 */

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Cloud, Database, GitBranch, MessageSquare, Plug, type LucideIcon } from "lucide-react";
import type { ConfigScope } from "@saas/sdk";
import type { PublicConnection } from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Kicker, PageHeader, Pill, QuietLink, Screen, StatusDot, type Tone } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { providerById } from "./providers";
import { connectionDisplayName, connectionStatusMeta } from "./connections";
import { authoringSurfaceFor } from "@/components/config/authoring-registry";
import { deriveBrokerRow, deriveRotationRow } from "@/components/config/bind-secret-flow";
import {
  capabilityForProvider,
  modeToggleFor,
  providerBoundSecrets,
} from "./provider-space-lib";
// Side effect: register the built-in custom surfaces (Cloudflare) before the
// registry is consulted below.
import "./authoring-surfaces";

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  github: GitBranch,
  slack: MessageSquare,
  cloudflare: Cloud,
  supabase: Database,
};

/** Badge tone (connections.ts) → Northwind tone (mirrors connection-detail). */
const STATUS_TONE: Record<string, Tone> = {
  default: "neutral",
  success: "success",
  warning: "warning",
  destructive: "error",
};

function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}

export function ProviderSpace({
  orgId,
  orgSlug,
  providerId,
}: {
  orgId: string;
  orgSlug: string;
  providerId: string;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const provider = providerById(providerId);
  const Icon = PROVIDER_ICONS[providerId] ?? Plug;

  const integrations = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );
  const capabilitiesQuery = useApiQuery(
    qk.secretsCapabilities(orgId),
    () => wrap(async () => (await client.integrations.listSecretsCapabilities(orgId)).capabilities),
    { staleTime: 10 * 60_000 },
  );
  const capability = capabilityForProvider(capabilitiesQuery.data ?? [], providerId);
  const modeToggle = modeToggleFor(capability);

  const connections = React.useMemo(
    () => (integrations.data ?? []).filter((c) => c.provider === providerId),
    [integrations.data, providerId],
  );
  const activeConnections = connections.filter((c) => c.status === "active");

  // ── Create-scope selection (workspace / project / environment) ──
  // The provider space is org-level, but a secret lives at a config scope —
  // the operator picks the rung (same chain the Secrets console browses).
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const [projectId, setProjectId] = React.useState("");
  const environments = useApiQuery(
    qk.environments(orgId, projectId),
    () => wrap(async () => (await client.environments.list(orgId, projectId)).environments),
    { enabled: !!projectId },
  );
  const [environmentId, setEnvironmentId] = React.useState("");
  const scope: ConfigScope =
    projectId && environmentId
      ? { kind: "environment", orgId, projectId, environmentId }
      : projectId
        ? { kind: "project", orgId, projectId }
        : { kind: "organization", orgId };
  const scopeKey = `${orgId}:${projectId || "-"}:${environmentId || "-"}`;

  // ── This provider's secrets at the selected scope (filtered read) ──
  const secrets = useApiQuery(qk.configSecrets(`provider-space:${scopeKey}`), () =>
    wrap(async () =>
      scope.kind === "environment"
        ? (await client.config.listSecretChain(scope)).secrets
        : (await client.config.listSecretMetadata(scope)).secrets,
    ),
  );
  const providerSecrets = React.useMemo(
    () => providerBoundSecrets(secrets.data ?? [], providerId),
    [secrets.data, providerId],
  );

  // ── Create dialog ──
  const [createOpen, setCreateOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"binding" | "rotated">("binding");
  const [initialConnectionId, setInitialConnectionId] = React.useState<string | undefined>(undefined);

  // SP-A4 deep link: `?create=1[&connection=int_…]` opens the dialog once,
  // then strips the params so a refresh doesn't reopen it.
  const deepLinkSeeded = React.useRef(false);
  React.useEffect(() => {
    if (deepLinkSeeded.current) return;
    if (searchParams?.get("create") === "1") {
      deepLinkSeeded.current = true;
      const conn = searchParams.get("connection");
      if (conn) setInitialConnectionId(conn);
      setCreateOpen(true);
      const next = new URLSearchParams(searchParams.toString());
      next.delete("create");
      next.delete("connection");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [searchParams, pathname, router]);

  React.useEffect(() => {
    // Default the toggle to the first declared mode once the capability loads.
    if (modeToggle.length > 0 && !modeToggle.some((m) => m.mode === mode)) {
      setMode(modeToggle[0]!.mode);
    }
  }, [modeToggle, mode]);

  const Surface = authoringSurfaceFor(providerId);
  const name = provider?.name ?? providerId;

  return (
    <Screen>
      <PageHeader
        title={name}
        description={
          provider?.description ??
          "This provider's space — its connections, its secrets, its scope templates."
        }
        actions={
          capability && activeConnections.length > 0 ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              Create secret
            </Button>
          ) : undefined
        }
      />

      <div className="flex items-center gap-2.5">
        <Icon className="h-[18px] w-[18px] shrink-0 text-secondary-foreground" strokeWidth={1.8} aria-hidden />
        {activeConnections.length > 0 ? (
          <Pill tone="success">connected</Pill>
        ) : (
          <>
            <Pill tone="neutral">not connected</Pill>
            <Button asChild variant="outline" size="sm">
              <a href={`/orgs/${orgSlug}/integrations?connect=${providerId}`}>Connect {name}</a>
            </Button>
          </>
        )}
        {capability ? (
          <span className="text-xs text-muted-foreground">
            secret source · {capability.supportedModes.join(" + ")}
            {capability.deliveryTargets.length > 0 ? ` · delivers to ${capability.deliveryTargets.join(", ")}` : ""}
          </span>
        ) : null}
      </div>

      {/* ── Secrets (the owner's create + footprint) ── */}
      {capability ? (
        <>
          <div className="mb-2.5 mt-8 flex flex-wrap items-end justify-between gap-3">
            <Kicker className="mb-0">Secrets</Kicker>
            <div className="flex items-center gap-2 text-xs">
              <select
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setEnvironmentId("");
                }}
                className="h-8 rounded-md border bg-card px-2"
                aria-label="Project scope"
              >
                <option value="">Workspace scope</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {projectId ? (
                <select
                  value={environmentId}
                  onChange={(e) => setEnvironmentId(e.target.value)}
                  className="h-8 rounded-md border bg-card px-2"
                  aria-label="Environment scope"
                >
                  <option value="">Project scope</option>
                  {(environments.data ?? []).map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>

          {secrets.loading ? (
            <p className="text-sm text-muted-foreground">Loading secrets…</p>
          ) : providerSecrets.length === 0 ? (
            <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
              No {name} secrets at this scope yet.{" "}
              {activeConnections.length > 0
                ? "Create one — it appears on the Secrets page like every other secret."
                : `Connect ${name} first, then create one here.`}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead>
                    <tr className="border-b text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
                      <th className="px-4 py-2.5">Secret</th>
                      <th className="px-4 py-2.5">Provenance</th>
                      <th className="px-4 py-2.5">Manage</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providerSecrets.map((s) => {
                      const broker = deriveBrokerRow(s);
                      const rotation = deriveRotationRow(s);
                      return (
                        <tr key={s.id} className="border-t border-border/50 first:border-t-0 align-top">
                          <td className="px-4 py-2.5">
                            <span className="block font-mono text-[12px]">{s.secretKey}</span>
                            {s.displayName ? (
                              <span className="block text-[11px] text-muted-foreground">{s.displayName}</span>
                            ) : null}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">
                            {rotation?.label ?? broker?.label ?? "—"}
                          </td>
                          <td className="px-4 py-2.5 text-xs">
                            <QuietLink href={`/orgs/${orgSlug}/secrets`}>on Secrets</QuietLink>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Scope templates (read-only until SP4) ── */}
          <Kicker className="mb-2.5 mt-8">Scope templates</Kicker>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
                    <th className="px-4 py-2.5">Type</th>
                    <th className="px-4 py-2.5">Grants</th>
                    <th className="px-4 py-2.5">Params</th>
                    <th className="px-4 py-2.5">Max TTL</th>
                  </tr>
                </thead>
                <tbody>
                  {capability.scopeTemplates.map((t) => (
                    <tr key={t.id} className="border-t border-border/50 first:border-t-0 align-top">
                      <td className="px-4 py-2.5">
                        <span className="block text-[12.5px] font-semibold">{t.displayName}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground">{t.id}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{t.description}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                        {t.params.length > 0 ? t.params.join(", ") : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                        {formatTtl(t.maxTtlSeconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : capabilitiesQuery.loading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading capability…</p>
      ) : (
        <div className="mt-8 rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
          {name} is not a secret source — it declares no secrets capability.
        </div>
      )}

      {/* ── Connections ── */}
      <Kicker className="mb-2.5 mt-8">Connections</Kicker>
      {connections.length === 0 ? (
        <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
          No {name} connection yet.{" "}
          <QuietLink href={`/orgs/${orgSlug}/integrations?connect=${providerId}`}>
            Connect from the Integrations hub
          </QuietLink>
          .
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {connections.map((c: PublicConnection) => {
            const meta = connectionStatusMeta(c.status);
            return (
              <a
                key={c.id}
                href={`/orgs/${orgSlug}/integrations/${c.id}`}
                className="flex items-center gap-3 border-t border-border/50 px-5 py-3 text-sm first:border-t-0 hover:bg-muted/40"
              >
                <StatusDot tone={STATUS_TONE[meta.tone] ?? "neutral"} />
                <span className="font-medium">{connectionDisplayName(c)}</span>
                <span className="text-xs text-muted-foreground">{meta.label}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{c.id}</span>
              </a>
            );
          })}
        </div>
      )}

      {/* ── Create dialog: the provider's registered authoring surface ── */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setInitialConnectionId(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create {name} secret</DialogTitle>
            <DialogDescription>
              {mode === "binding"
                ? "No value is stored — the credential is minted from the connection just-in-time at resolve."
                : "The value is minted once from the connection, stored encrypted, and re-minted on the rotation schedule."}
            </DialogDescription>
          </DialogHeader>

          {modeToggle.length > 1 ? (
            <div className="inline-flex self-start overflow-hidden rounded-md border">
              {modeToggle.map((entry, i) => (
                <button
                  key={entry.mode}
                  type="button"
                  onClick={() => setMode(entry.mode)}
                  className={`${i > 0 ? "border-l " : ""}px-2.5 py-1 text-xs ${mode === entry.mode ? "bg-card font-medium" : "text-muted-foreground"}`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}

          <Surface
            scope={scope}
            orgId={orgId}
            enabled={createOpen}
            mode={mode}
            providerId={providerId}
            initialConnectionId={initialConnectionId}
            onCancel={() => setCreateOpen(false)}
            onCreated={() => {
              const wasRotated = mode === "rotated";
              setCreateOpen(false);
              setInitialConnectionId(undefined);
              toast(
                wasRotated
                  ? { kind: "success", title: "Rotated secret created", description: "Minted from the connection and stored; it re-mints on the schedule." }
                  : { kind: "success", title: "Scoped credential created", description: "Minted at resolve — nothing is stored." },
              );
              secrets.reload();
            }}
          />
        </DialogContent>
      </Dialog>
    </Screen>
  );
}
