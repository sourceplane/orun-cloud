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
 * `?create=1[&connection=int_…][&template=…]` opens the create dialog
 * (SP-A4: the successor of the Secrets page's `?bind=1` deep link),
 * pre-selecting and locking the named connection and pre-seeding the
 * wizard's Step 1 use-case (IR4).
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
import { ConnectionDetailBody } from "./connection-detail";
import { IntegrationConnectDialog } from "./connect-panel";
import { connectDispatch } from "./registry";
import { SpaceActivity } from "./space-activity";
// IR6: importing the module registry is ALSO the side-effect registration of
// the built-in provider modules (the SP1 graft pattern) — declared refs the
// registry doesn't know fail open to nothing.
import { SpaceModules } from "./space-modules";
import { authoringSurfaceFor } from "@/components/config/authoring-registry";
import { deriveBrokerRow, deriveRotationRow } from "@/components/config/bind-secret-flow";
import {
  capabilityForProvider,
  modeToggleFor,
  resolveActiveSpaceTab,
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

/** The standard space tabs (IR2). Order fixed; presence per capability. */
type SpaceTabId = "overview" | "connections" | "secrets" | "templates" | "activity" | "settings";

const SPACE_TAB_LABELS: Record<SpaceTabId, string> = {
  overview: "Overview",
  connections: "Connections",
  secrets: "Secrets",
  templates: "Templates",
  activity: "Activity",
  settings: "Settings",
};

export function ProviderSpace({
  orgId,
  orgSlug,
  providerId,
  focusConnectionId,
}: {
  orgId: string;
  orgSlug: string;
  providerId: string;
  /** IR-U: when set, the space renders that connection's detail as a focused
   *  sub-view of the Connections tab — same header, same tabs, one page.
   *  Set by the nested `…/connections/{id}` route. */
  focusConnectionId?: string;
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

  // ── Create dialog (IR4: the outcome-first wizard owns the lifecycle
  // choice internally, so the space only passes the INITIAL mode — the
  // first declared one) ──
  const [createOpen, setCreateOpen] = React.useState(false);
  const [initialConnectionId, setInitialConnectionId] = React.useState<string | undefined>(undefined);
  const [initialTemplateId, setInitialTemplateId] = React.useState<string | undefined>(undefined);

  // ── Connect (IR3) ──
  // The space owns connect for any provider whose posture the hub's popup
  // flow can't express (a token method / multiple methods) — derived from
  // the served descriptor, never a provider name. The dialog renders the
  // ordered methods; the token recipe comes from the descriptor.
  const [connectOpen, setConnectOpen] = React.useState(false);
  const spaceOwnsConnect = descriptor ? connectDispatch(descriptor).kind === "space" : false;

  // The popup+poll path for a live install/oauth method (from the dialog's
  // primary action).
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

  // SP-A4 deep link: `?create=1[&connection=int_…][&template=…]` opens the
  // dialog once, then strips the params so a refresh doesn't reopen it.
  // `?connect=1` (IR1, from the hub's space-dispatch) opens the connect flow
  // the same way.
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
        const template = searchParams!.get("template");
        if (template) setInitialTemplateId(template);
        setCreateOpen(true);
      }
      if (wantsConnect && spaceOwnsConnect) setConnectOpen(true);
      const next = new URLSearchParams(searchParams!.toString());
      next.delete("create");
      next.delete("connection");
      next.delete("template");
      next.delete("connect");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [searchParams, pathname, router, spaceOwnsConnect]);

  // IR4: the wizard owns the lifecycle choice (its "How should it live?"
  // step); the space seeds it with the first declared mode.
  const initialMode = modeToggle[0]?.mode ?? "binding";

  const Surface = authoringSurfaceFor(providerId);
  const name = descriptor?.displayName ?? providerId;

  // ── Tab chrome (IR2): the standard space skeleton. Tabs come from the
  // served manifest declaration; while the registry read is unavailable the
  // chrome degrades to the capability read (SP-A5) — never a provider-name
  // branch. `?tab=` deep-links a tab.
  const declaredTabs = descriptor?.space.tabs;
  const fallbackTabs: SpaceTabId[] = [
    "overview",
    "connections",
    ...(capability ? (["secrets", "templates"] as SpaceTabId[]) : []),
    "settings",
  ];
  const tabs: readonly SpaceTabId[] = declaredTabs ?? fallbackTabs;
  const [tab, setTab] = React.useState<SpaceTabId>(() => {
    const requested = searchParams?.get("tab") as SpaceTabId | null;
    return requested && SPACE_TAB_LABELS[requested] ? requested : "overview";
  });
  // IR-U: a focused connection IS the Connections tab, in-place. Tab clicks
  // while focused navigate to the space root (dropping the connection), so
  // the URL and the view stay in lockstep.
  const spaceRoot = `/orgs/${orgSlug}/integrations/${providerId}`;
  const activeTab: SpaceTabId = resolveActiveSpaceTab(focusConnectionId, tab, tabs, "overview");
  const selectTab = React.useCallback(
    (t: SpaceTabId) => {
      if (focusConnectionId) {
        router.push(t === "overview" ? spaceRoot : `${spaceRoot}?tab=${t}`);
        return;
      }
      setTab(t);
    },
    [focusConnectionId, router, spaceRoot],
  );
  const showMints = descriptor?.capabilities.includes("credential-broker") ?? Boolean(capability);
  const showDeliveries = descriptor?.capabilities.includes("inbound") ?? false;

  return (
    <Screen>
      <PageHeader
        title={name}
        description={
          descriptor?.tagline ??
          "This provider's space — its connections, its secrets, its scope templates."
        }
        actions={
          <div className="flex items-center gap-2">
            {/* IR3: multi-connection providers add accounts from the space. */}
            {spaceOwnsConnect && descriptor?.multiConnection && activeConnections.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => setConnectOpen(true)}>
                Add account
              </Button>
            ) : null}
            {capability && activeConnections.length > 0 ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                Create secret
              </Button>
            ) : null}
          </div>
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

      {/* ── Tab bar (IR2 standard chrome — substrate-owned; a provider fills
          slots, it never restyles the skeleton) ── */}
      <div className="mt-6 flex gap-1 overflow-x-auto border-b" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={activeTab === t}
            onClick={() => selectTab(t)}
            className={`shrink-0 border-b-2 px-3 py-1.5 text-[12.5px] ${
              activeTab === t
                ? "border-foreground font-semibold"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {SPACE_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* ── Focused connection (IR-U): the detail renders IN PLACE, as a
          sub-view of the Connections tab — the header + tabs above stay, so
          it is one unified page, never a second one. ── */}
      {focusConnectionId ? (
        <ConnectionDetailBody
          orgId={orgId}
          orgSlug={orgSlug}
          connectionId={focusConnectionId}
          backToListHref={`${spaceRoot}?tab=connections`}
          {...(capability ? { templatesHref: `${spaceRoot}?tab=templates` } : {})}
          {...(capability
            ? {
                onCreateSecret: (connId: string) => {
                  setInitialConnectionId(connId);
                  setCreateOpen(true);
                },
              }
            : {})}
          onRevoked={() => {
            integrations.reload();
            router.push(`${spaceRoot}?tab=connections`);
          }}
          onChanged={() => integrations.reload()}
        />
      ) : null}

      {/* ── Overview / Connections list ── */}
      {!focusConnectionId && (activeTab === "overview" || activeTab === "connections") ? (
        <>
          <Kicker className="mb-2.5 mt-6">Connections</Kicker>
          {connections.length === 0 ? (
            <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
              No {name} connection yet.{" "}
              {spaceOwnsConnect ? (
                <button type="button" className="underline" onClick={() => setConnectOpen(true)}>
                  Connect {name}
                </button>
              ) : (
                <QuietLink href={`/orgs/${orgSlug}/integrations?connect=${providerId}`}>
                  Connect from the Integrations hub
                </QuietLink>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card">
              {connections.map((c: PublicConnection) => {
                const meta = connectionStatusMeta(c.status);
                return (
                  <a
                    key={c.id}
                    href={`/orgs/${orgSlug}/integrations/${providerId}/connections/${c.id}`}
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
          {activeTab === "overview" && capability && providerSecrets.length > 0 ? (
            <div className="mt-4 rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
              {providerSecrets.length} {name} secret{providerSecrets.length === 1 ? "" : "s"} at the
              selected scope — see the Secrets tab; activity per connection is on the Activity tab.
            </div>
          ) : null}
          {/* IR6: the provider's declared modules (design §5.3) — each a
              compact summary read through existing worker reads; unknown ids
              render nothing (fail-open). */}
          {activeTab === "overview" ? (
            <SpaceModules
              orgId={orgId}
              orgSlug={orgSlug}
              providerId={providerId}
              connections={connections}
              moduleRefs={descriptor?.space.modules}
            />
          ) : null}
        </>
      ) : null}

      {/* ── Activity (IR2): the mint ledger + inbound delivery log ── */}
      {activeTab === "activity" ? (
        <SpaceActivity
          orgId={orgId}
          connections={connections}
          showMints={showMints}
          showDeliveries={showDeliveries}
        />
      ) : null}

      {/* ── Settings: the descriptor rendered honestly ── */}
      {activeTab === "settings" ? (
        <div className="mt-4 rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
          <div className="grid gap-1.5">
            <div>
              provider <span className="font-mono text-[11px]">{providerId}</span>
              {descriptor ? <> · category {descriptor.category} · manifest v{descriptor.version}</> : null}
            </div>
            {descriptor ? (
              <div>
                connect methods:{" "}
                {descriptor.connect
                  .map((m) => `${m.kind}${m.live ? "" : " (not configured here)"}`)
                  .join(" · ")}
              </div>
            ) : (
              <div>Registry unavailable — provider details are limited right now.</div>
            )}
            {capability ? <div>authoring: {capability.authoring}</div> : null}
            <div>
              Revoke and custody live on each connection&apos;s page (Connections tab · danger zone).
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Secrets (the owner's create + footprint) ── */}
      {activeTab === "secrets" ? (
        capability ? (
        <>
          <div className="mb-2.5 mt-6 flex flex-wrap items-end justify-between gap-3">
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

        </>
        ) : capabilitiesQuery.loading ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading capability…</p>
        ) : (
          <div className="mt-6 rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
            {name} is not a secret source — it declares no secrets capability.
          </div>
        )
      ) : null}

      {/* ── Scope templates (SP4: integration-managed at runtime) ── */}
      {activeTab === "templates" ? (
        <ScopeTemplatesSection orgId={orgId} providerId={providerId} name={name} />
      ) : null}

      {/* ── Create dialog: the provider's registered authoring surface (IR4:
          the outcome-first wizard by default — it owns mode/scope/summary
          internally, so the dialog is pure chrome) ── */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) {
            setInitialConnectionId(undefined);
            setInitialTemplateId(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create {name} secret</DialogTitle>
            <DialogDescription>
              Pick what you need; Orun mints it from the connection — the substrate performs the
              governed write.
            </DialogDescription>
          </DialogHeader>

          <Surface
            scope={scope}
            orgId={orgId}
            enabled={createOpen}
            mode={initialMode}
            providerId={providerId}
            initialConnectionId={initialConnectionId}
            initialTemplateId={initialTemplateId}
            onCancel={() => setCreateOpen(false)}
            onCreated={() => {
              setCreateOpen(false);
              setInitialConnectionId(undefined);
              setInitialTemplateId(undefined);
              toast({
                kind: "success",
                title: "Secret created",
                description: "It appears on the Secrets page like every other secret.",
              });
              secrets.reload();
            }}
          />
        </DialogContent>
      </Dialog>

      {/* IR3: the descriptor-driven connect surface — ordered methods, the
          token recipe served from the adapter's own grammar. */}
      {spaceOwnsConnect && descriptor ? (
        <IntegrationConnectDialog
          orgId={orgId}
          descriptor={descriptor}
          open={connectOpen}
          onOpenChange={setConnectOpen}
          onConnected={() => integrations.reload()}
          onGateError={(error) =>
            toast({ kind: "error", title: "Connection gated", description: error.message })
          }
          onPopupConnect={() => void startOauthConnect()}
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
