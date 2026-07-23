"use client";

/**
 * Cloudflare's CUSTOM authoring surface (saas-secrets-platform SP2,
 * capability-contract §6 "custom plugin").
 *
 * The integration owns its create experience: account (connection) selection
 * with Cloudflare-specific copy, a richer template panel (grants, params, max
 * TTL — the honest-breadth statement, IH R5), and posture notes (child tokens
 * are account-owned; deny-by-default template ⊆ parent grant). It is built
 * ENTIRELY on the SP1 authoring primitives and the frozen write hooks — the
 * substrate still performs the governed write and owns lifecycle. Nothing
 * here touches ciphertext or the policy checks.
 */

import * as React from "react";
import type { PublicConnection } from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import {
  brokerConnections,
  templatesForProvider,
  validateBindingForm,
  validateRotationForm,
} from "@/components/config/bind-secret-flow";
import {
  AuthoringErrorBox,
  ConnectionPicker,
  DeliverTargetField,
  DisplayNameField,
  GraceSecondsField,
  RotationPolicyControl,
  SecretKeyField,
  TemplateParamFields,
  TemplatePicker,
  useCreateBrokeredSecret,
  useCreateRotatedSecret,
} from "@/components/config/authoring";
import type { AuthoringSurfaceProps } from "@/components/config/authoring-surface";

function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}

export function CloudflareAuthoringSurface({
  scope,
  orgId,
  enabled,
  mode,
  onCreated,
  onCancel,
  initialConnectionId,
}: AuthoringSurfaceProps) {
  const rotated = mode === "rotated";
  const { client } = useSession();

  const integrations = useApiQuery(
    qk.integrations(orgId),
    () => wrap(async () => (await client.integrations.list(orgId)).connections),
    { enabled },
  );
  const capabilitiesQuery = useApiQuery(
    qk.secretsCapabilities(orgId),
    () => wrap(async () => (await client.integrations.listSecretsCapabilities(orgId)).capabilities),
    { enabled, staleTime: 10 * 60_000 },
  );
  const capabilities = React.useMemo(() => capabilitiesQuery.data ?? [], [capabilitiesQuery.data]);
  // Cloudflare's surface is pinned to Cloudflare accounts by construction.
  const connections = React.useMemo(
    () =>
      brokerConnections<PublicConnection>(
        integrations.data ?? [],
        capabilities,
        rotated ? "rotated" : "brokered",
      ).filter((c) => c.provider === "cloudflare"),
    [integrations.data, capabilities, rotated],
  );

  const [connectionId, setConnectionId] = React.useState("");
  const [templateId, setTemplateId] = React.useState("");
  const [paramInputs, setParamInputs] = React.useState<Record<string, string>>({});
  const [secretKey, setSecretKey] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [rotationPolicy, setRotationPolicy] = React.useState("");
  const [graceSeconds, setGraceSeconds] = React.useState("");
  const [deliverTarget, setDeliverTarget] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const brokeredWrite = useCreateBrokeredSecret(scope);
  const rotatedWrite = useCreateRotatedSecret(scope);
  const write = rotated ? rotatedWrite : brokeredWrite;

  const templates = templatesForProvider(capabilities, "cloudflare");
  const selected = connections.find((c) => c.id === connectionId) ?? null;
  const template = templates.find((t) => t.id === templateId) ?? null;

  const pickConnection = React.useCallback(
    (id: string) => {
      setConnectionId(id);
      setTemplateId(templates[0]?.id ?? "");
      setParamInputs({});
      setErrors({});
      brokeredWrite.reset();
      rotatedWrite.reset();
    },
    // reset fns are stable useCallbacks
    [templates, brokeredWrite.reset, rotatedWrite.reset],
  );

  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !initialConnectionId) return;
    if (connections.some((c) => c.id === initialConnectionId)) {
      seeded.current = true;
      pickConnection(initialConnectionId);
    }
  }, [initialConnectionId, connections, pickConnection]);
  const locked = Boolean(initialConnectionId) && selected?.id === initialConnectionId;

  const submit = async () => {
    if (rotated) {
      const v = validateRotationForm(
        { secretKey, displayName, connectionId, template: templateId, params: paramInputs, rotationPolicy, graceSeconds, deliverTarget },
        templates,
      );
      if (!v.ok) return setErrors(v.errors);
      setErrors({});
      if (await rotatedWrite.submit(v.request)) onCreated();
      return;
    }
    const v = validateBindingForm(
      { secretKey, displayName, connectionId, template: templateId, params: paramInputs, rotationPolicy },
      templates,
    );
    if (!v.ok) return setErrors(v.errors);
    setErrors({});
    if (await brokeredWrite.submit(v.request)) onCreated();
  };

  if (integrations.loading || capabilitiesQuery.loading) {
    return <p className="text-sm text-muted-foreground">Loading Cloudflare accounts…</p>;
  }
  if (capabilitiesQuery.error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Cloudflare&apos;s secret capability is unavailable right now — try again shortly.
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (connections.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          No Cloudflare account is connected{rotated ? " (rotation needs a connected account)" : ""}.
          Connect Cloudflare from the Integrations hub first — paste an account API token once and it
          becomes the org-owned parent every scoped credential is minted from.
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ConnectionPicker
        connections={connections}
        value={connectionId}
        onPick={pickConnection}
        locked={locked}
        lockedHint={
          rotated
            ? "Minting the stored value from this account's parent token."
            : "Binding a scoped credential to this account."
        }
        error={errors.connectionId}
      />

      {selected ? (
        <>
          <TemplatePicker
            templates={templates}
            value={templateId}
            onChange={(id) => {
              setTemplateId(id);
              setParamInputs({});
              setErrors({});
            }}
            error={errors.template}
          />

          {/* Cloudflare-owned template detail: the honest-breadth statement
              (IH R5) — what the child token can DO, its params, its ceiling. */}
          {template ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
              <div>{template.description}</div>
              <div className="mt-1.5 font-mono text-[11px]">
                {template.params.length > 0 ? `params: ${template.params.join(", ")} · ` : ""}
                max TTL {formatTtl(template.maxTtlSeconds)}
              </div>
              <div className="mt-1.5">
                Child tokens are minted account-owned from the connected parent, deny-by-default — a
                template never exceeds the parent grant.
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <TemplateParamFields
        template={template}
        values={paramInputs}
        onChange={(name, value) => setParamInputs((p) => ({ ...p, [name]: value }))}
        errors={errors}
      />

      <SecretKeyField value={secretKey} onChange={setSecretKey} error={errors.secretKey} />

      <RotationPolicyControl
        value={rotationPolicy}
        onChange={setRotationPolicy}
        rotated={rotated}
        error={errors.rotationPolicy}
      />

      {rotated ? (
        <>
          <GraceSecondsField value={graceSeconds} onChange={setGraceSeconds} error={errors.graceSeconds} />
          <DeliverTargetField value={deliverTarget} onChange={setDeliverTarget} />
        </>
      ) : null}

      <DisplayNameField value={displayName} onChange={setDisplayName} error={errors.displayName} />

      <AuthoringErrorBox error={write.error} />

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" loading={write.busy} onClick={() => void submit()}>
          {rotated ? "Create rotated secret" : "Create scoped credential"}
        </Button>
      </div>
    </div>
  );
}
