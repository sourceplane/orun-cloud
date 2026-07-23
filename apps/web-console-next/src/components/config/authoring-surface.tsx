"use client";

/**
 * The DEFAULT authoring surface (saas-secrets-platform SP1, capability-contract
 * §6): the generalized create form a declarative provider gets for free,
 * rendered from the SP0 capability (connections + declared templates + modes)
 * and composed ENTIRELY from the SP1 authoring primitives (`authoring.tsx`).
 *
 * This is the former `BindSecretForm` (secrets-panel.tsx) extracted verbatim
 * in behavior: pick a capability-declared connection → scope template →
 * params → key + policy (+ rotated extras) → governed write via the frozen
 * SDK authoring contract. A custom surface (SP2) replaces the composition,
 * never the primitives or the write path.
 */

import * as React from "react";
import type { ConfigScope } from "@saas/sdk";
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
} from "./bind-secret-flow";
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
} from "./authoring";

/** The props every authoring surface (default or custom) receives (SP1). */
export interface AuthoringSurfaceProps {
  scope: ConfigScope;
  orgId: string;
  enabled: boolean;
  /** "binding" = a brokered secret (minted at resolve, no stored value, IH7).
   *  "rotated" = a provider-rotated secret (value minted once + re-minted on
   *  the cadence, stored, provider-rotated-secrets RS1). */
  mode: "binding" | "rotated";
  onCreated: () => void;
  onCancel: () => void;
  /** IH8: when the create flow was launched from a connection's detail page,
   *  the connection is pre-selected and locked. */
  initialConnectionId?: string | undefined;
  /** SP2: a provider space passes its provider id to pin the surface to that
   *  provider's connections + templates. Absent on the generalized dialog. */
  providerId?: string | undefined;
}

export function DefaultAuthoringSurface({
  scope,
  orgId,
  enabled,
  mode,
  onCreated,
  onCancel,
  initialConnectionId,
  providerId,
}: AuthoringSurfaceProps) {
  const rotated = mode === "rotated";
  const { client } = useSession();

  const integrations = useApiQuery(
    qk.integrations(orgId),
    () => wrap(async () => (await client.integrations.list(orgId)).connections),
    { enabled },
  );
  // SP0c (SP-A1): provider eligibility + templates derive from the bulk
  // capability read — never a hardcoded list. Static per deploy → cache long.
  const capabilitiesQuery = useApiQuery(
    qk.secretsCapabilities(orgId),
    () => wrap(async () => (await client.integrations.listSecretsCapabilities(orgId)).capabilities),
    { enabled, staleTime: 10 * 60_000 },
  );
  const capabilities = React.useMemo(() => capabilitiesQuery.data ?? [], [capabilitiesQuery.data]);
  const connections = React.useMemo(() => {
    const eligible = brokerConnections<PublicConnection>(
      integrations.data ?? [],
      capabilities,
      rotated ? "rotated" : "brokered",
    );
    return providerId ? eligible.filter((c) => c.provider === providerId) : eligible;
  }, [integrations.data, capabilities, rotated, providerId]);

  const [connectionId, setConnectionId] = React.useState("");
  const [templateId, setTemplateId] = React.useState("");
  const [paramInputs, setParamInputs] = React.useState<Record<string, string>>({});
  const [secretKey, setSecretKey] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [rotationPolicy, setRotationPolicy] = React.useState("");
  // Rotated-only extras (provider-rotated-secrets RS4).
  const [graceSeconds, setGraceSeconds] = React.useState("");
  const [deliverTarget, setDeliverTarget] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const brokeredWrite = useCreateBrokeredSecret(scope);
  const rotatedWrite = useCreateRotatedSecret(scope);
  const write = rotated ? rotatedWrite : brokeredWrite;

  const selected = connections.find((c) => c.id === connectionId) ?? null;
  const templates = selected ? templatesForProvider(capabilities, selected.provider) : [];
  const template = templates.find((t) => t.id === templateId) ?? null;

  const pickConnection = React.useCallback(
    (id: string) => {
      setConnectionId(id);
      const conn = connections.find((c) => c.id === id);
      const first = conn ? templatesForProvider(capabilities, conn.provider)[0] : undefined;
      setTemplateId(first?.id ?? "");
      setParamInputs({});
      setErrors({});
      brokeredWrite.reset();
      rotatedWrite.reset();
    },
    // reset fns are stable useCallbacks; listing them would re-create the picker
    [connections, capabilities, brokeredWrite.reset, rotatedWrite.reset],
  );

  // Seed the locked connection once it appears in the eligible list.
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
      if (!v.ok) {
        setErrors(v.errors);
        return;
      }
      setErrors({});
      if (await rotatedWrite.submit(v.request)) onCreated();
      return;
    }
    const v = validateBindingForm(
      { secretKey, displayName, connectionId, template: templateId, params: paramInputs, rotationPolicy },
      templates,
    );
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    if (await brokeredWrite.submit(v.request)) onCreated();
  };

  if (integrations.loading || capabilitiesQuery.loading) {
    return <p className="text-sm text-muted-foreground">Loading connections…</p>;
  }
  // SP-A5: capability reads degrade progressively — when the read fails, say
  // so; never fall back to a hardcoded provider list.
  if (capabilitiesQuery.error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Provider capabilities are unavailable right now, so integration-backed secrets can&apos;t be
          created. Static secrets are unaffected — try again shortly.
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
          {rotated
            ? "No connection from a rotation-capable provider is available. Connect one from the Integrations hub, then mint rotated secrets from it here."
            : "No broker-capable connection is available. Connect a provider from the Integrations hub, then bind secrets to it here."}
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
            ? "Minting the stored value from this connection."
            : "Binding a scoped credential to this connection."
        }
        error={errors.connectionId}
      />

      {selected ? (
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
          {rotated ? "Create rotated secret" : "Bind secret"}
        </Button>
      </div>
    </div>
  );
}
