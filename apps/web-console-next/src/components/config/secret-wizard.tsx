"use client";

/**
 * The outcome-first secret wizard — the DEFAULT authoring surface
 * (saas-integration-registry IR4, design §7 "Secret creation v2").
 *
 * The shipped dialog was mechanism-first (mode tab → connection → template →
 * params). Operators think outcome-first, so the wizard inverts the order:
 *
 *   1. What do you need?      — use-case cards from the provider's ACTIVE
 *                               scope templates (custom org templates too)
 *   2. Where will it be used? — scope rung + connection + template params
 *   3. How should it live?    — brokered vs rotated; SKIPPED entirely for
 *                               single-mode providers
 *   4. Review & create        — smart key default, plain-language summary,
 *                               one governed write
 *
 * Built ENTIRELY on the SP1 authoring primitives and the frozen write hooks
 * (`authoring.tsx`) — the substrate still performs the governed write and
 * owns every validation rule (`bind-secret-flow.ts`). Nothing here touches
 * ciphertext. Pure step logic lives in `secret-wizard-lib.ts`.
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
  useCreateBrokeredSecret,
  useCreateRotatedSecret,
  type AuthoringConnectionOption,
} from "./authoring";
import {
  activeTemplates,
  defaultSecretKey,
  forcedMode,
  nextStepId,
  prevStepId,
  scopeRungLabel,
  seedTemplateId,
  summaryLine,
  whereStepErrors,
  wizardSteps,
  type WizardStepId,
} from "./secret-wizard-lib";

/** The props every authoring surface (default or custom) receives (SP1). */
export interface AuthoringSurfaceProps {
  /** The scope the mounting surface starts the wizard at; the wizard's
   *  "Where" step lets the operator re-pick the rung before the write. */
  scope: ConfigScope;
  orgId: string;
  enabled: boolean;
  /** The INITIAL lifecycle: "binding" = brokered (minted at resolve, no
   *  stored value, IH7); "rotated" = provider-rotated (stored + re-minted on
   *  the cadence, RS1). The wizard owns the final choice on its lifecycle
   *  step, so an external toggle is redundant-safe (IR4). */
  mode: "binding" | "rotated";
  onCreated: () => void;
  onCancel: () => void;
  /** IH8: when the create flow was launched from a connection's detail page,
   *  the connection is pre-selected and locked. */
  initialConnectionId?: string | undefined;
  /** SP2: a provider space passes its provider id to pin the surface to that
   *  provider's connections + templates. Absent on the generalized dialog. */
  providerId?: string | undefined;
  /** IR4 (`?create=1&template=…` deep link): pre-seeds the Step 1 use-case
   *  card and advances to Step 2. Unknown / retired ids are ignored. */
  initialTemplateId?: string | undefined;
}

/** Display name for a picked connection (structural — SDK-agnostic). */
function connectionLabel(c: AuthoringConnectionOption): string {
  return c.displayName ?? c.externalAccountLogin ?? c.provider;
}

export function SecretWizardSurface({
  scope,
  orgId,
  enabled,
  mode: initialMode,
  onCreated,
  onCancel,
  initialConnectionId,
  providerId,
  initialTemplateId,
}: AuthoringSurfaceProps) {
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

  // ── Wizard state ──
  const [templateId, setTemplateId] = React.useState("");
  const [connectionId, setConnectionId] = React.useState("");
  const [paramInputs, setParamInputs] = React.useState<Record<string, string>>({});
  const [mode, setMode] = React.useState<"binding" | "rotated">(initialMode);
  const [rotationPolicy, setRotationPolicy] = React.useState("");
  const [graceSeconds, setGraceSeconds] = React.useState("");
  const [deliverTarget, setDeliverTarget] = React.useState("");
  // Smart key default: seeded from the provider, editable. null = untouched.
  const [secretKeyInput, setSecretKeyInput] = React.useState<string | null>(null);
  const [displayName, setDisplayName] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [stepId, setStepId] = React.useState<WizardStepId>("use-case");

  // ── Provider derivations ──
  // Without a pinned providerId (generalized dialog), the provider follows
  // the chosen use-case card.
  const connections = React.useMemo(() => {
    const eligible = brokerConnections<PublicConnection>(integrations.data ?? [], capabilities);
    return providerId ? eligible.filter((c) => c.provider === providerId) : eligible;
  }, [integrations.data, capabilities, providerId]);
  const cardTemplates = React.useMemo(() => {
    const declared = providerId
      ? templatesForProvider(capabilities, providerId)
      : capabilities.flatMap((c) => c.scopeTemplates);
    return activeTemplates(declared);
  }, [capabilities, providerId]);
  const template = cardTemplates.find((t) => t.id === templateId) ?? null;
  const effectiveProvider = providerId ?? template?.provider ?? null;
  const capability = capabilities.find((c) => c.provider === effectiveProvider) ?? null;
  const supportedModes = capability?.supportedModes ?? ["brokered", "rotated"];
  const templates = effectiveProvider
    ? activeTemplates(templatesForProvider(capabilities, effectiveProvider))
    : cardTemplates;
  const providerConnections = React.useMemo(
    () => (effectiveProvider ? connections.filter((c) => c.provider === effectiveProvider) : connections),
    [connections, effectiveProvider],
  );

  // Single-mode providers skip the lifecycle step; their mode is forced.
  const steps = wizardSteps(supportedModes);
  const forced = forcedMode(supportedModes);
  const effectiveMode = forced ?? mode;
  const rotated = effectiveMode === "rotated";

  // ── Scope rung (workspace / project / environment), seeded from the prop ──
  const [projectId, setProjectId] = React.useState(scope.kind !== "organization" ? scope.projectId : "");
  const [environmentId, setEnvironmentId] = React.useState(
    scope.kind === "environment" ? scope.environmentId : "",
  );
  const projects = useApiQuery(
    qk.projects(orgId),
    () => wrap(async () => (await client.projects.list(orgId)).projects),
    { enabled },
  );
  const environments = useApiQuery(
    qk.environments(orgId, projectId),
    () => wrap(async () => (await client.environments.list(orgId, projectId)).environments),
    { enabled: enabled && !!projectId },
  );
  const chosenScope: ConfigScope =
    projectId && environmentId
      ? { kind: "environment", orgId, projectId, environmentId }
      : projectId
        ? { kind: "project", orgId, projectId }
        : { kind: "organization", orgId };

  // ── The frozen SP1 write hooks — the only write path ──
  const brokeredWrite = useCreateBrokeredSecret(chosenScope);
  const rotatedWrite = useCreateRotatedSecret(chosenScope);
  const write = rotated ? rotatedWrite : brokeredWrite;

  // ── Seeds ──
  // Deep-linked template (`?template=`): pre-select the card, advance once.
  const templateSeeded = React.useRef(false);
  React.useEffect(() => {
    if (templateSeeded.current || !initialTemplateId || cardTemplates.length === 0) return;
    templateSeeded.current = true;
    const seeded = seedTemplateId(cardTemplates, initialTemplateId);
    if (seeded) {
      setTemplateId(seeded);
      setStepId("where");
    }
  }, [initialTemplateId, cardTemplates]);
  // Locked connection (IH8 deep link) once it appears in the eligible list;
  // otherwise auto-select when the provider has exactly one connection.
  const connectionSeeded = React.useRef(false);
  React.useEffect(() => {
    if (connectionSeeded.current) return;
    if (initialConnectionId) {
      if (connections.some((c) => c.id === initialConnectionId)) {
        connectionSeeded.current = true;
        setConnectionId(initialConnectionId);
      }
      return;
    }
    if (providerConnections.length === 1) {
      connectionSeeded.current = true;
      setConnectionId(providerConnections[0]!.id);
    }
  }, [initialConnectionId, connections, providerConnections]);
  const selected = providerConnections.find((c) => c.id === connectionId) ?? null;
  const locked = Boolean(initialConnectionId) && selected?.id === initialConnectionId;

  // ── A11y: focus lands on the step heading on every advance/back ──
  const headingRef = React.useRef<HTMLHeadingElement | null>(null);
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [stepId]);

  const stepIndex = steps.findIndex((s) => s.id === stepId);
  const step = steps[stepIndex] ?? steps[0]!;

  const goBack = () => {
    const prev = prevStepId(steps, step.id);
    if (prev) {
      setErrors({});
      setStepId(prev);
    }
  };
  const goNext = () => {
    if (step.id === "where") {
      const stepErrors = whereStepErrors({ connectionId, template: templateId, params: paramInputs }, templates);
      if (Object.keys(stepErrors).length > 0) {
        setErrors(stepErrors);
        return;
      }
    }
    const next = nextStepId(steps, step.id);
    if (next) {
      setErrors({});
      setStepId(next);
    }
  };
  const pickCard = (id: string) => {
    if (id !== templateId) {
      setParamInputs({});
      // Generalized dialog (no pinned provider): a card from a different
      // provider invalidates the picked connection.
      const card = cardTemplates.find((t) => t.id === id);
      if (!providerId && card && selected && selected.provider !== card.provider) {
        setConnectionId("");
      }
    }
    setTemplateId(id);
    setErrors({});
    brokeredWrite.reset();
    rotatedWrite.reset();
    setStepId("where");
  };

  const secretKey = secretKeyInput ?? defaultSecretKey(effectiveProvider);

  // Failed create-validation errors that belong to the "Where" step send the
  // operator back there (the review step doesn't render those inputs).
  const failValidation = (formErrors: Record<string, string>) => {
    setErrors(formErrors);
    const whereKeys = new Set(["connectionId", "template", ...(template?.params ?? [])]);
    if (Object.keys(formErrors).some((k) => whereKeys.has(k))) setStepId("where");
  };

  const create = async () => {
    const common = {
      secretKey,
      displayName,
      connectionId,
      template: templateId,
      params: paramInputs,
      rotationPolicy,
    };
    if (rotated) {
      const v = validateRotationForm({ ...common, graceSeconds, deliverTarget }, templates);
      if (!v.ok) return failValidation(v.errors);
      setErrors({});
      if (await rotatedWrite.submit(v.request)) onCreated();
      return;
    }
    const v = validateBindingForm(common, templates);
    if (!v.ok) return failValidation(v.errors);
    setErrors({});
    if (await brokeredWrite.submit(v.request)) onCreated();
  };

  // ── Degenerate states (SP-A5: capability reads degrade honestly) ──
  if (integrations.loading || capabilitiesQuery.loading) {
    return <p className="text-sm text-muted-foreground">Loading connections…</p>;
  }
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
          No capable connection is available. Connect a provider from the Integrations hub, then
          create secrets from it here.
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (cardTemplates.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This provider declares no active scope templates, so there is nothing to create yet.
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
    <div className="space-y-4">
      {/* ── Progress: a labeled step list (a11y: aria-current marks the step) ── */}
      <ol aria-label="Secret creation steps" className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {steps.map((s, i) => (
          <li
            key={s.id}
            aria-current={s.id === step.id ? "step" : undefined}
            className={
              s.id === step.id ? "font-semibold text-foreground" : "text-muted-foreground"
            }
          >
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>

      <h3 ref={headingRef} tabIndex={-1} className="text-sm font-semibold outline-none">
        {step.label}
      </h3>

      {/* ── Step 1: use-case cards from the active template catalog ── */}
      {step.id === "use-case" ? (
        <ul aria-label="Use cases" className="grid list-none gap-2 p-0">
          {cardTemplates.map((t) => (
            <li key={`${t.provider}:${t.id}`}>
              <button
                type="button"
                onClick={() => pickCard(t.id)}
                aria-pressed={t.id === templateId}
                className={`w-full rounded-lg border px-4 py-3 text-left hover:bg-muted/40 ${
                  t.id === templateId ? "border-foreground" : ""
                }`}
              >
                <span className="block text-sm font-medium">
                  {t.displayName}
                  {t.origin === "custom" ? (
                    <span className="ml-2 text-[11px] font-normal text-muted-foreground">custom</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ── Step 2: scope rung + connection + template params ── */}
      {step.id === "where" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block space-y-1.5 text-sm font-medium">
              Scope
              <select
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  setEnvironmentId("");
                }}
                className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
                aria-label="Project scope"
              >
                <option value="">Workspace scope</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {projectId ? (
              <select
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                className="h-9 rounded-md border bg-card px-2 text-sm"
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

          <ConnectionPicker
            connections={providerConnections}
            value={connectionId}
            onPick={(id) => {
              setConnectionId(id);
              setErrors({});
              brokeredWrite.reset();
              rotatedWrite.reset();
            }}
            locked={locked}
            lockedHint="This secret is created from the connection you came from."
            error={errors.connectionId}
          />

          <TemplateParamFields
            template={template}
            values={paramInputs}
            onChange={(name, value) => setParamInputs((p) => ({ ...p, [name]: value }))}
            errors={errors}
          />
        </div>
      ) : null}

      {/* ── Step 3: lifecycle — ONLY when the provider declares both modes ── */}
      {step.id === "lifecycle" ? (
        <fieldset className="space-y-2">
          <legend className="sr-only">How should it live?</legend>
          <label
            className={`block cursor-pointer rounded-lg border px-4 py-3 ${!rotated ? "border-foreground" : ""}`}
          >
            <input
              type="radio"
              name="secret-lifecycle"
              className="mr-2 align-middle"
              checked={!rotated}
              onChange={() => setMode("binding")}
            />
            <span className="text-sm font-medium">Fresh per run</span>
            <span className="ml-2 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              recommended
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Nothing is stored — a short-lived credential is minted from the connection just-in-time
              at resolve
              {template ? ` (valid at most ${formatTtl(template.maxTtlSeconds)})` : ""}.
            </span>
          </label>
          <label
            className={`block cursor-pointer rounded-lg border px-4 py-3 ${rotated ? "border-foreground" : ""}`}
          >
            <input
              type="radio"
              name="secret-lifecycle"
              className="mr-2 align-middle"
              checked={rotated}
              onChange={() => setMode("rotated")}
            />
            <span className="text-sm font-medium">Managed &amp; rotated</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              The value is minted once, stored encrypted, and re-minted on a schedule.
            </span>
          </label>

          {rotated ? (
            <div className="space-y-3 pt-1">
              <RotationPolicyControl
                value={rotationPolicy}
                onChange={setRotationPolicy}
                rotated
                error={errors.rotationPolicy}
              />
              <GraceSecondsField value={graceSeconds} onChange={setGraceSeconds} error={errors.graceSeconds} />
              {capability && capability.deliveryTargets.length > 0 ? (
                <>
                  <DeliverTargetField value={deliverTarget} onChange={setDeliverTarget} />
                  <p className="text-xs text-muted-foreground">
                    This provider delivers to: {capability.deliveryTargets.join(", ")}.
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {/* ── Step 4: review & create ── */}
      {step.id === "review" ? (
        <div className="space-y-3">
          <SecretKeyField
            value={secretKey}
            onChange={setSecretKeyInput}
            error={errors.secretKey}
            placeholder={defaultSecretKey(effectiveProvider)}
          />
          <DisplayNameField value={displayName} onChange={setDisplayName} error={errors.displayName} />
          <p className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            {summaryLine({
              template,
              connectionName: selected ? connectionLabel(selected) : null,
              scopeLabel: scopeRungLabel(chosenScope),
              mode: effectiveMode,
            })}
          </p>
          <AuthoringErrorBox error={write.error} />
        </div>
      ) : null}

      {/* ── Footer ── */}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {stepIndex > 0 ? (
          <Button type="button" variant="outline" onClick={goBack}>
            Back
          </Button>
        ) : null}
        {step.id === "review" ? (
          <Button type="button" loading={write.busy} onClick={() => void create()}>
            {rotated ? "Create rotated secret" : "Create scoped credential"}
          </Button>
        ) : step.id !== "use-case" ? (
          <Button type="button" onClick={goNext}>
            Next
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}
