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
import type { IntegrationScopeTemplate, PublicConnection } from "@saas/contracts/integrations";
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
import { descriptorById } from "./registry";
import { connectionDisplayName, connectionStatusMeta } from "./connections";
import { CloudflareConnectModal } from "./cloudflare-connect-modal";
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

  const Icon = PROVIDER_ICONS[providerId] ?? Plug;

  const integrations = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );
  // IR1: identity/posture comes from the served registry, not a console
  // catalog. Fail-soft: while unavailable, the header degrades to the id.
  const registryQuery = useApiQuery(
    qk.integrationRegistry(orgId),
    () => wrap(async () => (await client.integrations.getRegistry(orgId)).registry),
    { staleTime: 10 * 60_000 },
  );
  const descriptor = descriptorById(registryQuery.data, providerId);
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

  // ── Connect (IR1) ──
  // The space owns connect for any provider whose posture the hub's popup
  // flow can't express (a token method / multiple methods — today:
  // Cloudflare). IR3 replaces this modal mount with the space's real connect
  // panel rendered from `descriptor.connect`; until then the shipped modal
  // IS the token-method surface (one-milestone shim).
  const [connectOpen, setConnectOpen] = React.useState(false);
  const spaceOwnsConnect = providerId === "cloudflare";
  const oauthLive = descriptor?.connect.some((m) => m.kind === "oauth" && m.live) ?? false;

  const startOauthConnect = React.useCallback(async () => {
    setConnectOpen(false);
    const r = await wrap(() => client.integrations.connect(orgId, providerId));
    if (!r.ok) {
      toast({ kind: "error", title: "Could not start the connection", description: r.error.message });
      return;
    }
    const { installUrl } = r.data;
    const popup = window.open(installUrl, `${providerId}-connect`, "width=1020,height=780");
    if (!popup && installUrl) window.location.assign(installUrl);
  }, [client, orgId, providerId, toast]);

  // SP-A4 deep link: `?create=1[&connection=int_…]` opens the dialog once,
  // then strips the params so a refresh doesn't reopen it. `?connect=1`
  // (IR1, from the hub's space-dispatch) opens the connect flow the same way.
  const deepLinkSeeded = React.useRef(false);
  React.useEffect(() => {
    if (deepLinkSeeded.current) return;
    const wantsCreate = searchParams?.get("create") === "1";
    const wantsConnect = searchParams?.get("connect") === "1";
    if (wantsCreate || wantsConnect) {
      deepLinkSeeded.current = true;
      if (wantsCreate) {
        const conn = searchParams!.get("connection");
        if (conn) setInitialConnectionId(conn);
        setCreateOpen(true);
      }
      if (wantsConnect && spaceOwnsConnect) setConnectOpen(true);
      const next = new URLSearchParams(searchParams!.toString());
      next.delete("create");
      next.delete("connection");
      next.delete("connect");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [searchParams, pathname, router, spaceOwnsConnect]);

  React.useEffect(() => {
    // Default the toggle to the first declared mode once the capability loads.
    if (modeToggle.length > 0 && !modeToggle.some((m) => m.mode === mode)) {
      setMode(modeToggle[0]!.mode);
    }
  }, [modeToggle, mode]);

  const Surface = authoringSurfaceFor(providerId);
  const name = descriptor?.displayName ?? providerId;

  return (
    <Screen>
      <PageHeader
        title={name}
        description={
          descriptor?.tagline ??
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
            {spaceOwnsConnect ? (
              <Button variant="outline" size="sm" onClick={() => setConnectOpen(true)}>
                Connect {name}
              </Button>
            ) : (
              <Button asChild variant="outline" size="sm">
                <a href={`/orgs/${orgSlug}/integrations?connect=${providerId}`}>Connect {name}</a>
              </Button>
            )}
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

          {/* ── Scope templates (SP4: integration-managed at runtime) ── */}
          <ScopeTemplatesSection orgId={orgId} providerId={providerId} name={name} />
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

      {/* IR1 shim (see spaceOwnsConnect above): the shipped Cloudflare modal
          serves as the space's connect surface until IR3's descriptor-driven
          connect panel replaces it. */}
      {spaceOwnsConnect ? (
        <CloudflareConnectModal
          orgId={orgId}
          open={connectOpen}
          onOpenChange={setConnectOpen}
          onConnected={() => integrations.reload()}
          onGateError={(error) =>
            toast({ kind: "error", title: "Connection gated", description: error.message })
          }
          {...(oauthLive ? { onOauth: () => void startOauthConnect() } : {})}
        />
      ) : null}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Scope templates (saas-secrets-platform SP4)
// ---------------------------------------------------------------------------

/**
 * The integration-managed template catalog: the provider's declared templates
 * plus this org's curated derivations, managed here and served to every
 * create surface through the SP0 capability read — no console/db redeploy.
 * Custom templates derive from a declared BASE (which supplies the mint
 * semantics); edits bump the version; retire is the only removal (SP-A6) so
 * a template can never be deleted out from under a live secret.
 */
function ScopeTemplatesSection({
  orgId,
  providerId,
  name,
}: {
  orgId: string;
  providerId: string;
  name: string;
}) {
  const { client } = useSession();
  const { toast } = useToast();

  const templatesQuery = useApiQuery(qk.scopeTemplates(orgId, providerId), () =>
    wrap(async () => (await client.integrations.listScopeTemplates(orgId, providerId)).templates),
  );
  const templates = templatesQuery.data ?? [];
  const declared = templates.filter((t) => (t.origin ?? "declared") === "declared");

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<IntegrationScopeTemplate | null>(null);
  const [templateId, setTemplateId] = React.useState("");
  const [baseTemplate, setBaseTemplate] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const openCreate = () => {
    setTemplateId("");
    setBaseTemplate(declared[0]?.id ?? "");
    setDisplayName("");
    setDescription("");
    setFormError(null);
    setCreateOpen(true);
  };
  const openEdit = (t: IntegrationScopeTemplate) => {
    setDisplayName(t.displayName);
    setDescription(t.description);
    setFormError(null);
    setEditing(t);
  };

  const submitCreate = async () => {
    setBusy(true);
    setFormError(null);
    const r = await wrap(() =>
      client.integrations.createScopeTemplate(orgId, providerId, {
        templateId: templateId.trim(),
        baseTemplate,
        displayName: displayName.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    );
    setBusy(false);
    if (!r.ok) {
      setFormError(r.error.message);
      return;
    }
    setCreateOpen(false);
    toast({ kind: "success", title: "Template created", description: "It is live on every create surface now." });
    templatesQuery.reload();
  };

  const submitEdit = async () => {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    const r = await wrap(() =>
      client.integrations.updateScopeTemplate(orgId, providerId, editing.id, {
        displayName: displayName.trim(),
        description: description.trim(),
      }),
    );
    setBusy(false);
    if (!r.ok) {
      setFormError(r.error.message);
      return;
    }
    setEditing(null);
    toast({ kind: "success", title: "Template updated", description: "Version bumped; live everywhere." });
    templatesQuery.reload();
  };

  const setStatus = async (t: IntegrationScopeTemplate, status: "active" | "retired") => {
    const r = await wrap(() => client.integrations.updateScopeTemplate(orgId, providerId, t.id, { status }));
    if (!r.ok) {
      toast({ kind: "error", title: "Update failed", description: r.error.message });
      return;
    }
    toast({
      kind: "success",
      title: status === "retired" ? "Template retired" : "Template reactivated",
      description:
        status === "retired"
          ? "Hidden from create surfaces; existing secrets keep resolving."
          : "Offered on create surfaces again.",
    });
    templatesQuery.reload();
  };

  return (
    <>
      <div className="mb-2.5 mt-8 flex flex-wrap items-end justify-between gap-3">
        <Kicker className="mb-0">Scope templates</Kicker>
        {declared.length > 0 ? (
          <Button variant="outline" size="sm" onClick={openCreate}>
            New template
          </Button>
        ) : null}
      </div>

      {templatesQuery.loading ? (
        <p className="text-sm text-muted-foreground">Loading templates…</p>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Grants</th>
                  <th className="px-4 py-2.5">Params</th>
                  <th className="px-4 py-2.5">Max TTL</th>
                  <th className="px-4 py-2.5">Origin</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => {
                  const custom = t.origin === "custom";
                  const retired = t.status === "retired";
                  return (
                    <tr
                      key={t.id}
                      className={`border-t border-border/50 first:border-t-0 align-top${retired ? " opacity-60" : ""}`}
                    >
                      <td className="px-4 py-2.5">
                        <span className="block text-[12.5px] font-semibold">{t.displayName}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground">
                          {t.id}
                          {custom ? ` · v${t.version}` : ""}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {t.description}
                        {custom && t.baseTemplate ? (
                          <span className="mt-1 block font-mono text-[11px]">base: {t.baseTemplate}</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                        {t.params.length > 0 ? t.params.join(", ") : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                        {formatTtl(t.maxTtlSeconds)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                        {custom ? (retired ? "custom · retired" : "custom") : "declared"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs">
                        {custom ? (
                          <span className="inline-flex gap-2">
                            <button
                              type="button"
                              className="underline underline-offset-2 hover:text-foreground"
                              onClick={() => openEdit(t)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="underline underline-offset-2 hover:text-foreground"
                              onClick={() => void setStatus(t, retired ? "active" : "retired")}
                            >
                              {retired ? "Reactivate" : "Retire"}
                            </button>
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New {name} scope template</DialogTitle>
            <DialogDescription>
              A named derivation of a declared template. The base supplies what the credential can DO —
              your template can never exceed it.
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5 text-sm font-medium">
            Base template
            <select
              value={baseTemplate}
              onChange={(e) => setBaseTemplate(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
            >
              {declared.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName} ({t.id})
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            Template id
            <input
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              placeholder="prod-workers-deploy"
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
            />
          </label>
          {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="button" loading={busy} onClick={() => void submitCreate()}>
              Create template
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit dialog (display edits bump the version) */}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit template</DialogTitle>
            <DialogDescription className="font-mono text-xs">
              {editing?.id} · v{editing?.version} → v{(editing?.version ?? 0) + 1}
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1.5 text-sm font-medium">
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
            />
          </label>
          <label className="block space-y-1.5 text-sm font-medium">
            Description
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
            />
          </label>
          {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="button" loading={busy} onClick={() => void submitEdit()}>
              Save (bump version)
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
