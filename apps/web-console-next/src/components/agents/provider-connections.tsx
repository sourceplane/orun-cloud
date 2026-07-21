"use client";

// BYO provider connections (saas-agents AG12, design §10.5) — the "add your
// AI provider keys" surface. One component, two doors: the Agents tab renders
// it beside where sessions spawn; the Integrations hub renders it among the
// provider cards. Key display is write-only-with-hint — the value is never
// readable back, so the card shows `…last4` and the verified state only.

import * as React from "react";
import type { AgentProvider, ProviderConnection } from "@saas/contracts/agents";
import { AGENT_PROVIDERS } from "@saas/contracts/agents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pill, ListCard, ListCardHeader, ListRow, StatusText } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";
import { connectionTone, PROVIDER_META, MODEL_PROVIDER_SET } from "@/lib/agents/model";
import { Skeleton } from "@/components/ui/skeleton";

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
      setApiKey("");
      setApiUrl("");
      setBaseUrl("");
      setDefaultModel("");
      setFormOpen(false);
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

  return (
    <ListCard>
      <ListCardHeader
        title={
          <span className="flex items-center gap-2">
            {meta.name}
            {connections.length === 0 ? <Pill tone="neutral">Not connected</Pill> : null}
          </span>
        }
        action={
          connections.length === 0 && !formOpen ? (
            <Button size="sm" onClick={() => setFormOpen(true)}>
              Connect
            </Button>
          ) : undefined
        }
      />
      <p className="px-5 pb-3 text-[12.5px] leading-relaxed text-muted-foreground">{meta.blurb}</p>

      {connections.map((c) => (
        <ListRow key={c.id}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{c.name}</span>
              <Pill tone={connectionTone(c.status)}>{c.status}</Pill>
            </div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {c.keyHint ? <span className="font-mono">{c.keyHint}</span> : null}
              {c.statusReason ? <span> · {c.statusReason}</span> : null}
              {c.lastVerifiedAt ? <span> · verified {new Date(c.lastVerifiedAt).toLocaleString()}</span> : null}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void verify(c.id)}>
              Verify
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect(c.id)}>
              Disconnect
            </Button>
          </div>
        </ListRow>
      ))}

      {(formOpen || connections.length > 0) && (
        <div className="border-t border-border/50 px-5 py-4">
          {connections.length > 0 && !formOpen ? (
            <Button size="sm" variant="ghost" onClick={() => setFormOpen(true)}>
              Add another key…
            </Button>
          ) : (
            <div className="grid gap-2">
              <Input
                type="password"
                autoComplete="off"
                placeholder={`API key (${meta.keyPlaceholder})`}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {provider === "daytona" ? (
                <Input
                  placeholder="API URL (optional — default https://app.daytona.io/api)"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              ) : null}
              {isModelProvider ? (
                <>
                  <Input
                    placeholder="Base URL (optional — for an OpenAI-compatible gateway)"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                  <Input
                    placeholder={
                      modelRequired
                        ? `Default model (required — e.g. ${meta.modelPlaceholder})`
                        : "Default model (optional)"
                    }
                    value={defaultModel}
                    onChange={(e) => setDefaultModel(e.target.value)}
                  />
                  {modelRequired ? (
                    <StatusText tone="neutral" className="text-[11.5px]">
                      {meta.name} has no built-in default — dispatch needs a model id to route chat.
                    </StatusText>
                  ) : null}
                </>
              ) : null}
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy || !canConnect} onClick={() => void connect()}>
                  {busy ? "Connecting…" : "Connect"}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setFormOpen(false)}>
                  Cancel
                </Button>
                <StatusText tone="neutral" className="text-[11.5px]">
                  Stored write-only in the workspace secret manager.
                </StatusText>
              </div>
            </div>
          )}
        </div>
      )}
    </ListCard>
  );
}
