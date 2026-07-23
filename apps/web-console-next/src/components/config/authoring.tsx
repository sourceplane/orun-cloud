"use client";

/**
 * The Secret Authoring Interface — headless UI primitives + write hooks
 * (saas-secrets-platform SP1, capability-contract §5).
 *
 * These are the governed pieces an integration space composes into its own
 * create surface. The substrate owns every one of them: an integration author
 * never touches ciphertext, an encryption path, or the scope/policy checks —
 * it renders these primitives and calls the write hooks, and the substrate
 * performs the governed write (`create-secret.ts` gates brokered/rotated
 * creation behind `secret.write` + `credential.issue`).
 *
 * The default authoring surface (`authoring-surface.tsx`) is itself built
 * from exactly these primitives — a custom surface (SP2) gets nothing the
 * default doesn't have.
 */

import * as React from "react";
import type {
  CreateBrokeredSecretRequest,
  CreateRotatedSecretRequest,
} from "@saas/contracts/config";
import type { ConfigScope } from "@saas/sdk";
import type { IntegrationScopeTemplate } from "@saas/contracts/integrations";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { brokeredCreateErrorMessage } from "./bind-secret-flow";

// ---------------------------------------------------------------------------
// Shared field chrome
// ---------------------------------------------------------------------------

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <span className="block text-xs font-normal text-destructive">{message}</span>;
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <span className="block text-xs font-normal text-muted-foreground">{children}</span>;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Key grammar input (same rule as the static-value schema: 1..128 after trim). */
export function SecretKeyField({
  value,
  onChange,
  error,
  placeholder = "CLOUDFLARE_API_TOKEN",
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  placeholder?: string;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      Key
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
        aria-invalid={error ? true : undefined}
      />
      <FieldError message={error} />
    </label>
  );
}

/** Minimal connection shape the picker renders (structural, SDK-agnostic). */
export interface AuthoringConnectionOption {
  id: string;
  provider: string;
  displayName?: string | null | undefined;
  externalAccountLogin?: string | null | undefined;
}

/** The connection picker; `locked` pins a pre-selected connection (deep-link). */
export function ConnectionPicker({
  connections,
  value,
  onPick,
  locked = false,
  lockedHint,
  error,
}: {
  connections: readonly AuthoringConnectionOption[];
  value: string;
  onPick: (connectionId: string) => void;
  locked?: boolean;
  lockedHint?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      Connection
      <select
        value={value}
        onChange={(e) => onPick(e.target.value)}
        disabled={locked}
        className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal disabled:opacity-70"
        aria-invalid={error ? true : undefined}
      >
        <option value="">Select a connection…</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.provider}
            {c.displayName ? ` — ${c.displayName}` : c.externalAccountLogin ? ` — ${c.externalAccountLogin}` : ""}
          </option>
        ))}
      </select>
      {locked && lockedHint ? <FieldHint>{lockedHint}</FieldHint> : null}
      <FieldError message={error} />
    </label>
  );
}

/** Scope-template picker rendered from a capability's declared templates (SP0). */
export function TemplatePicker({
  templates,
  value,
  onChange,
  error,
}: {
  templates: readonly IntegrationScopeTemplate[];
  value: string;
  onChange: (templateId: string) => void;
  error?: string | undefined;
}) {
  const selected = templates.find((t) => t.id === value) ?? null;
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      Scope template
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
        aria-invalid={error ? true : undefined}
      >
        <option value="">Select a template…</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.displayName}
          </option>
        ))}
      </select>
      {selected ? <FieldHint>{selected.description}</FieldHint> : null}
      <FieldError message={error} />
    </label>
  );
}

/** One input per param the chosen template declares; errors keyed by param name. */
export function TemplateParamFields({
  template,
  values,
  onChange,
  errors,
}: {
  template: Pick<IntegrationScopeTemplate, "params"> | null;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
  errors: Record<string, string>;
}) {
  if (!template) return null;
  return (
    <>
      {template.params.map((name) => (
        <label key={name} className="block space-y-1.5 text-sm font-medium">
          <span className="font-mono text-xs">{name}</span>
          <input
            value={values[name] ?? ""}
            onChange={(e) => onChange(name, e.target.value)}
            className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
            aria-invalid={errors[name] ? true : undefined}
          />
          <FieldError message={errors[name]} />
        </label>
      ))}
    </>
  );
}

/** The `<n>[hdwmy]` rotation-cadence select (30/60/90/180d presets). */
export function RotationPolicyControl({
  value,
  onChange,
  rotated,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  /** true = provider-rotated (stored + re-minted); false = brokered cadence. */
  rotated: boolean;
  error?: string | undefined;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      Rotation policy
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
      >
        <option value="">{rotated ? "Default (every 30 days)" : "No scheduled rotation"}</option>
        <option value="30d">Every 30 days</option>
        <option value="60d">Every 60 days</option>
        <option value="90d">Every 90 days</option>
        <option value="180d">Every 180 days</option>
      </select>
      <FieldHint>
        {rotated
          ? "The value is minted once from the connected parent and stored. On this cadence Orun re-mints a fresh token as a new version and retires the old one after a grace overlap."
          : "When set, Orun rolls this connection's org-owned source credential on the cadence. Every run still resolves a fresh short-lived value regardless."}
      </FieldHint>
      <FieldError message={error} />
    </label>
  );
}

/** Rotated-only: the grace-overlap input (seconds; server default 24h). */
export function GraceSecondsField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      Grace overlap (seconds)
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Optional — default 86400 (24h)"
        inputMode="numeric"
        className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
        aria-invalid={error ? true : undefined}
      />
      <FieldHint>How long the prior token stays valid after a rotation, so in-flight work keeps working.</FieldHint>
      <FieldError message={error} />
    </label>
  );
}

/** Rotated-only: the materialize deliver-target input (RS deliver). */
export function DeliverTargetField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      Deliver target
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Optional — e.g. cloudflare-worker:api-prod"
        className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
      />
      <FieldHint>
        A long-lived consumer that HOLDS the value and must be re-delivered on rotation. Leave blank for
        per-run consumers that resolve the current version each run.
      </FieldHint>
    </label>
  );
}

/** Optional display-name input (≤128). */
export function DisplayNameField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium">
      Display name
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Optional"
        className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
        aria-invalid={error ? true : undefined}
      />
      <FieldError message={error} />
    </label>
  );
}

/** Typed inline write error (412 entitlement gates included) with requestId —
 *  never a silent toast (capability-contract §5 `<EntitlementError>`). */
export function AuthoringErrorBox({
  error,
}: {
  error: { message: string; requestId: string | null } | null;
}) {
  if (!error) return null;
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive-soft p-3 text-xs text-destructive">
      <div>{error.message}</div>
      {error.requestId ? (
        <div className="mt-1 font-mono text-[11px] opacity-80">requestId: {error.requestId}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Write hooks — the programmatic authoring contract (frozen SDK calls)
// ---------------------------------------------------------------------------

export interface AuthoringWriteError {
  message: string;
  requestId: string | null;
}

export interface AuthoringWrite<Req> {
  /** Perform the governed write; resolves true on success. */
  submit: (request: Req) => Promise<boolean>;
  busy: boolean;
  error: AuthoringWriteError | null;
  reset: () => void;
}

function useAuthoringWrite<Req>(
  perform: (request: Req) => Promise<unknown>,
): AuthoringWrite<Req> {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<AuthoringWriteError | null>(null);
  const submit = React.useCallback(
    async (request: Req) => {
      setBusy(true);
      setError(null);
      const r = await wrap(() => perform(request));
      setBusy(false);
      if (!r.ok) {
        setError({
          // 412s are the entitlement gates — surface the typed message.
          message: r.status === 412 ? brokeredCreateErrorMessage(r.error) : r.error.message,
          requestId: r.error.requestId ?? null,
        });
        return false;
      }
      return true;
    },
    [perform],
  );
  const reset = React.useCallback(() => setError(null), []);
  return { submit, busy, error, reset };
}

/** `client.config.createBrokeredSecret` as an authoring write (SP1 contract). */
export function useCreateBrokeredSecret(scope: ConfigScope): AuthoringWrite<CreateBrokeredSecretRequest> {
  const { client } = useSession();
  const perform = React.useCallback(
    (request: CreateBrokeredSecretRequest) => client.config.createBrokeredSecret(scope, request),
    [client, scope],
  );
  return useAuthoringWrite(perform);
}

/** `client.config.createRotatedSecret` as an authoring write (SP1 contract). */
export function useCreateRotatedSecret(scope: ConfigScope): AuthoringWrite<CreateRotatedSecretRequest> {
  const { client } = useSession();
  const perform = React.useCallback(
    (request: CreateRotatedSecretRequest) => client.config.createRotatedSecret(scope, request),
    [client, scope],
  );
  return useAuthoringWrite(perform);
}
