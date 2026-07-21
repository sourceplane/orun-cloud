"use client";

// BYO provider connections (saas-agents AG12, design §10.5) — the "add your
// AI provider keys" surface. One component, two doors: the Agents tab renders
// it beside where sessions spawn; the Integrations hub renders it among the
// provider cards. Key display is write-only-with-hint — the value is never
// readable back, so the card shows `…last4` and the verified state only.

import * as React from "react";
import type { AgentProvider, ProviderConnection } from "@saas/contracts/agents";
import { AGENT_PROVIDERS } from "@saas/contracts/agents";
import { Check, Plus, RotateCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pill } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { connectionTone, PROVIDER_META, MODEL_PROVIDER_SET, connectionModel, connectionReady } from "@/lib/agents/model";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

/** "3 minutes ago" style relative time; falls back to a short date past a day. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ProviderConnections({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const providers = useApiQuery(qk.orgAgentProviders(orgId), () =>
    wrap(async () => client.agents.listProviders(orgId)),
  );

  if (providers.loading && !providers.data) {
    return <Skeleton className="h-40 w-full rounded-xl" />;
  }
  const rows = providers.data ?? [];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {AGENT_PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider}
          orgId={orgId}
          provider={provider}
          connections={rows.filter((c) => c.provider === provider)}
          reload={providers.reload}
        />
      ))}
    </div>
  );
}

function ProviderBadge({ name }: { name: string }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary font-mono text-[12px] font-semibold uppercase text-foreground/70">
      {name.slice(0, 2)}
    </span>
  );
}

function ProviderCard({
  orgId,
  provider,
  connections,
  reload,
}: {
  orgId: string;
  provider: AgentProvider;
  connections: ProviderConnection[];
  reload: () => void;
}) {
  const meta = PROVIDER_META[provider];
  const { client } = useSession();
  const { toast } = useToast();
  const isModelProvider = MODEL_PROVIDER_SET.has(provider);
  // OpenAI-compatible providers have no built-in default model — dispatch
  // can't build a client without one, so the field is required for them
  // (Anthropic ships a built-in default, so it stays optional there).
  const modelRequired = provider === "openai" || provider === "openrouter";
  const [apiKey, setApiKey] = React.useState("");
  const [apiUrl, setApiUrl] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [defaultModel, setDefaultModel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);

  function buildConfig(): Record<string, string> | undefined {
    // Daytona: an optional self-hosted API URL. Model providers: an optional
    // OpenAI-compatible base URL and a default model. Empty fields are omitted
    // so the server keeps its vendor defaults.
    const config: Record<string, string> = {};
    if (provider === "daytona") {
      if (apiUrl.trim()) config.apiUrl = apiUrl.trim();
    } else if (isModelProvider) {
      if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
      if (defaultModel.trim()) config.defaultModel = defaultModel.trim();
    }
    return Object.keys(config).length > 0 ? config : undefined;
  }

  const canConnect = !!apiKey && (!modelRequired || !!defaultModel.trim());

  function resetForm() {
    setApiKey("");
    setApiUrl("");
    setBaseUrl("");
    setDefaultModel("");
    setFormOpen(false);
  }

  async function connect() {
    if (!canConnect) return;
    setBusy(true);
    const config = buildConfig();
    const res = await wrap(async () =>
      client.agents.connectProvider(orgId, { provider, apiKey, ...(config ? { config } : {}) }),
    );
    setBusy(false);
    if (res.ok) {
      // The key never sits in component state longer than the one request.
      resetForm();
      toast(
        res.data.status === "verified"
          ? { kind: "success", title: `${meta.name} connected`, description: "Key verified against the provider." }
          : {
              kind: "warning",
              title: `${meta.name} connected, but the key failed verification`,
              description: res.data.statusReason,
            },
      );
      reload();
    } else {
      toast({ kind: "error", title: `Could not connect ${meta.name}`, description: res.error.message });
    }
  }

  async function verify(connectionId: string) {
    setBusy(true);
    const res = await wrap(async () => client.agents.verifyProvider(orgId, connectionId));
    setBusy(false);
    if (res.ok) {
      toast(
        res.data.status === "verified"
          ? { kind: "success", title: `${meta.name} key verified` }
          : { kind: "warning", title: "Verification failed", description: res.data.statusReason },
      );
    } else {
      toast({ kind: "error", title: "Verification failed", description: res.error.message });
    }
    reload();
  }

  async function disconnect(connectionId: string) {
    setBusy(true);
    const res = await wrap(async () => client.agents.disconnectProvider(orgId, connectionId));
    setBusy(false);
    if (res.ok) toast({ kind: "default", title: `${meta.name} disconnected` });
    else toast({ kind: "error", title: "Disconnect failed", description: res.error.message });
    reload();
  }

  const connected = connections.length > 0;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
      {/* Header: identity + connection count. */}
      <div className="flex items-start gap-3 px-5 pb-3.5 pt-4">
        <ProviderBadge name={meta.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold">{meta.name}</span>
            {connected ? (
              <span className="text-[11.5px] text-muted-foreground">
                {connections.length} {connections.length === 1 ? "key" : "keys"}
              </span>
            ) : (
              <Pill tone="neutral">Not connected</Pill>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{meta.blurb}</p>
        </div>
        {!connected && !formOpen ? (
          <Button size="sm" onClick={() => setFormOpen(true)}>
            Connect
          </Button>
        ) : null}
      </div>

      {/* Connected keys. */}
      {connections.map((c) => {
        const model = connectionModel(c);
        const ready = connectionReady(c);
        return (
          <div key={c.id} className="border-t border-border/50 px-5 py-3.5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{c.name}</span>
                  <Pill tone={connectionTone(c.status)} dot>
                    {c.status}
                  </Pill>
                  {isModelProvider && c.status === "verified" && !ready ? (
                    <Pill tone="warning">No model</Pill>
                  ) : null}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                  {c.keyHint ? (
                    <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">{c.keyHint}</span>
                  ) : null}
                  {model ? (
                    <span className="inline-flex items-center gap-1">
                      <span className="text-muted-foreground/60">model</span>
                      <span className="font-mono text-[11.5px] text-foreground/80">{model}</span>
                    </span>
                  ) : null}
                  {c.lastVerifiedAt ? <span>· verified {relTime(c.lastVerifiedAt)}</span> : null}
                </div>
                {c.statusReason && c.status !== "verified" ? (
                  <div className="mt-1 text-[11.5px] text-destructive">{c.statusReason}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void verify(c.id)}
                  title="Re-verify this key against the provider"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span className="ml-1.5 hidden sm:inline">Verify</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void disconnect(c.id)}
                  title="Disconnect and remove this key"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="sr-only">Disconnect</span>
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Add-key footer / form. */}
      <div className="mt-auto border-t border-border/50 px-5 py-3.5">
        {connected && !formOpen ? (
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setFormOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            <span className="ml-1.5">Add another key</span>
          </Button>
        ) : formOpen ? (
          <div className="grid gap-3">
            <Field label="API key" required htmlFor={`${provider}-key`}>
              <Input
                id={`${provider}-key`}
                type="password"
                autoComplete="off"
                placeholder={meta.keyPlaceholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Field>

            {provider === "daytona" ? (
              <Field label="API URL" hint="Optional — defaults to https://app.daytona.io/api" htmlFor={`${provider}-url`}>
                <Input
                  id={`${provider}-url`}
                  placeholder="https://app.daytona.io/api"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Field>
            ) : null}

            {isModelProvider ? (
              <>
                <Field
                  label="Default model"
                  required={modelRequired}
                  hint={
                    modelRequired
                      ? `${meta.name} has no built-in default — dispatch needs a model id to route chat.`
                      : "Optional — pins a model for dispatch (else the provider default is used)."
                  }
                  htmlFor={`${provider}-model`}
                >
                  <Input
                    id={`${provider}-model`}
                    placeholder={meta.modelPlaceholder || "model id"}
                    value={defaultModel}
                    onChange={(e) => setDefaultModel(e.target.value)}
                  />
                </Field>
                <Field label="Base URL" hint="Optional — for an OpenAI-compatible gateway." htmlFor={`${provider}-base`}>
                  <Input
                    id={`${provider}-base`}
                    placeholder="https://…/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </Field>
              </>
            ) : null}

            <div className="flex items-center gap-2 pt-0.5">
              <Button size="sm" disabled={busy || !canConnect} onClick={() => void connect()}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={resetForm}>
                <X className="h-3.5 w-3.5" />
                <span className="ml-1">Cancel</span>
              </Button>
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <Check className="h-3 w-3" />
                Stored write-only
              </span>
            </div>
          </div>
        ) : (
          <p className="text-[11.5px] text-muted-foreground">Keys are stored write-only in the workspace secret manager.</p>
        )}
      </div>
    </div>
  );
}

/** Labeled form field: 11px caption + optional required star + hint below. */
function Field({
  label,
  required,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="flex items-center gap-1 text-[12px] font-medium">
        {label}
        {required ? <span className="text-destructive">*</span> : null}
      </Label>
      {children}
      {hint ? <p className={cn("text-[11.5px] leading-relaxed text-muted-foreground")}>{hint}</p> : null}
    </div>
  );
}
