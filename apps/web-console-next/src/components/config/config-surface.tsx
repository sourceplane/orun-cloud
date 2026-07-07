"use client";

import * as React from "react";
import { z } from "zod";
import { Plus, SlidersHorizontal, Flag, ScrollText } from "lucide-react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { ConfigScope } from "@saas/sdk";
import type {
  PublicSetting,
  PublicFeatureFlag,
} from "@saas/contracts/config";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ZodForm } from "@/components/ui/zod-form";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { parseConfigValueInput, formatConfigValue, configScopeKey } from "./value";
import { ListSkeleton, LoadError } from "./config-shared";
import { SecretsPanel } from "./secrets-panel";
import { SecretPoliciesPanel } from "./secret-policies-panel";

/**
 * Bridge for the Secrets page's PageHeader "New secret" button: the console
 * writes an opener into this ref, the Secrets panel populates it with its own
 * create-dialog trigger. Absent (null) on the project-config and environment
 * pages that also render `ConfigSurface`, so their behaviour is untouched.
 */
export const NewSecretContext = React.createContext<React.MutableRefObject<(() => void) | null> | null>(
  null,
);

/**
 * The console face of config-worker: secrets, feature flags, settings, and
 * policies at any of the three scopes (organization / project / environment).
 * One shared surface so all scopes behave identically; the parent supplies the
 * scope (the Secrets console owns scope selection).
 *
 * Reads secrets-first: the tab order leads with Secrets (the default) so the
 * surface reads as secret-management-first, with feature flags in their own
 * clearly-separated home.
 *
 * Secrets are write-only on the wire: list/read responses carry metadata
 * only, and this surface never renders secret material after the create /
 * rotate dialog closes.
 */
export function ConfigSurface({ scope }: { scope: ConfigScope }) {
  const scopeKey = configScopeKey(scope);
  // SecretPolicy documents are org/project-scoped only — no policies tab at env.
  const showPolicies = scope.kind !== "environment";
  return (
    <Tabs defaultValue="secrets">
      <TabsList>
        <TabsTrigger value="secrets">Secrets</TabsTrigger>
        <TabsTrigger value="flags">Feature flags</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        {showPolicies ? <TabsTrigger value="policies">Policies</TabsTrigger> : null}
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="secrets" className="pt-5">
        <SecretsPanel scope={scope} scopeKey={scopeKey} />
      </TabsContent>
      <TabsContent value="flags" className="pt-5">
        <FlagsTab scope={scope} scopeKey={scopeKey} />
      </TabsContent>
      <TabsContent value="settings" className="pt-5">
        <SettingsTab scope={scope} scopeKey={scopeKey} />
      </TabsContent>
      {showPolicies ? (
        <TabsContent value="policies" className="pt-5">
          <SecretPoliciesPanel scope={scope} scopeKey={scopeKey} />
        </TabsContent>
      ) : null}
      <TabsContent value="activity" className="pt-5">
        <SecretActivityTab />
      </TabsContent>
    </Tabs>
  );
}

/**
 * Activity tab — a prominent doorway into the secret audit stream
 * (`subjectKind=secret`) already wired on the org audit log. Rendered as a link
 * rather than an embedded table so the full audit surface (filters, pagination,
 * every subject) stays the one source of truth.
 */
function SecretActivityTab() {
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";
  return (
    <EmptyState
      icon={ScrollText}
      title="Secret activity is audited"
      description="Every create, rotate, revoke, and break-glass reveal is recorded. Open the audit log filtered to secret events for the full history."
      primaryAction={{
        label: "Open secret audit log",
        href: `/orgs/${orgSlug}/settings/audit?subjectKind=secret`,
      }}
    />
  );
}

/** Shared header for a config tab: a lede line + a right-aligned "New …" button. */
function TabHeader({
  lede,
  actionLabel,
  onAction,
}: {
  lede: React.ReactNode;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <p className="max-w-[560px] text-[12.5px] leading-normal text-muted-foreground">{lede}</p>
      <Button size="sm" className="shrink-0" onClick={onAction}>
        <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.8} /> {actionLabel}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().min(1),
  description: z.string().max(256).optional(),
});
const settingEditSchema = settingSchema.omit({ key: true });

function SettingsTab({ scope, scopeKey }: { scope: ConfigScope; scopeKey: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const settings = useApiQuery(qk.configSettings(scopeKey), () =>
    wrap(async () => (await client.config.listSettings(scope)).settings),
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PublicSetting | null>(null);

  return (
    <div className="space-y-4">
      <TabHeader
        lede="Key–value configuration. Values accept JSON literals or plain strings."
        actionLabel="New setting"
        onAction={() => setCreateOpen(true)}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create setting</DialogTitle>
            <DialogDescription>Scoped to this {scope.kind}.</DialogDescription>
          </DialogHeader>
          <ZodForm
            schema={settingSchema}
            defaultValues={{ key: "", value: "", description: "" }}
            fields={[
              { name: "key", label: "Key", placeholder: "default_region" },
              { name: "value", label: "Value", placeholder: '"eu-west-1" or {"a":1} or 42', hint: "Valid JSON is stored typed; anything else as a string." },
              { name: "description", label: "Description", placeholder: "Optional" },
            ]}
            submitLabel="Create setting"
            cancel={{ label: "Cancel", onClick: () => setCreateOpen(false) }}
            onSubmit={async (v) => {
              const r = await wrap(() =>
                client.config.createSetting(scope, {
                  key: v.key,
                  value: parseConfigValueInput(v.value),
                  description: v.description || null,
                }),
              );
              if (!r.ok) {
                toast({ kind: "error", title: "Create failed", description: r.error.message });
                return;
              }
              setCreateOpen(false);
              toast({ kind: "success", title: "Setting created" });
              settings.reload();
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit setting</DialogTitle>
            <DialogDescription className="font-mono text-xs">{editing?.key}</DialogDescription>
          </DialogHeader>
          {editing ? (
            <ZodForm
              schema={settingEditSchema}
              defaultValues={{
                value: formatConfigValue(editing.value),
                description: editing.description ?? "",
              }}
              fields={[
                { name: "value", label: "Value" },
                { name: "description", label: "Description" },
              ]}
              submitLabel="Save changes"
              cancel={{ label: "Cancel", onClick: () => setEditing(null) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  // Item routes address by public id (set_…), not key — the
                  // worker's parseSettingPublicId rejects bare keys (live 404).
                  client.config.updateSetting(scope, editing.id, {
                    value: parseConfigValueInput(v.value),
                    description: v.description || null,
                  }),
                );
                if (!r.ok) {
                  toast({ kind: "error", title: "Save failed", description: r.error.message });
                  return;
                }
                setEditing(null);
                toast({ kind: "success", title: "Setting updated" });
                settings.reload();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {settings.loading ? (
        <ListSkeleton />
      ) : settings.error ? (
        <LoadError title="Failed to load settings" message={settings.error.message} />
      ) : !settings.data || settings.data.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No settings yet"
          description="Create your first key–value setting for this scope. Available instantly via the API and SDK."
          primaryAction={{ label: "New setting", onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <div
              className="grid min-w-[560px] items-center gap-3 border-b border-border/70 px-[22px] py-[10px] text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80"
              style={{ gridTemplateColumns: "minmax(160px,1fr) minmax(160px,1.2fr) 1fr 90px 88px" }}
            >
              <span>Key</span>
              <span>Value</span>
              <span>Description</span>
              <span>Updated</span>
              <span className="text-right">Actions</span>
            </div>
            {settings.data.map((s) => (
              <div
                key={s.id}
                className="grid min-w-[560px] items-center gap-3 border-t border-border/50 px-[22px] py-[13px] first:border-t-0"
                style={{ gridTemplateColumns: "minmax(160px,1fr) minmax(160px,1.2fr) 1fr 90px 88px" }}
              >
                <span className="truncate font-mono text-[12.5px] font-medium">{s.key}</span>
                <span className="truncate font-mono text-[12px] text-secondary-foreground">
                  {formatConfigValue(s.value)}
                </span>
                <span className="truncate text-[12px] text-muted-foreground">{s.description ?? "—"}</span>
                <span className="text-[12px] text-muted-foreground">
                  {new Date(s.updatedAt).toLocaleDateString()}
                </span>
                <span className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

const flagSchema = z.object({
  flagKey: z.string().min(1).max(128),
  description: z.string().max(256).optional(),
});

function FlagsTab({ scope, scopeKey }: { scope: ConfigScope; scopeKey: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = qk.configFlags(scopeKey);
  const flags = useApiQuery(key, () =>
    wrap(async () => (await client.config.listFeatureFlags(scope)).featureFlags),
  );
  const [createOpen, setCreateOpen] = React.useState(false);

  // Optimistic toggle: flip in cache, roll back on error.
  const toggle = async (flag: PublicFeatureFlag, enabled: boolean) => {
    const previous = qc.getQueryData<PublicFeatureFlag[]>(key);
    qc.setQueryData<PublicFeatureFlag[]>(key, (cur) =>
      (cur ?? []).map((f) => (f.id === flag.id ? { ...f, enabled } : f)),
    );
    // Address by public id (flg_…): the worker's item route rejects bare keys.
    const r = await wrap(() => client.config.updateFeatureFlag(scope, flag.id, { enabled }));
    if (!r.ok) {
      qc.setQueryData<PublicFeatureFlag[]>(key, previous);
      toast({ kind: "error", title: "Toggle failed", description: r.error.message });
    }
  };

  return (
    <div className="space-y-4">
      <TabHeader
        lede="Toggles your product reads at runtime. Changes apply immediately."
        actionLabel="New flag"
        onAction={() => setCreateOpen(true)}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create feature flag</DialogTitle>
            <DialogDescription>Created disabled; flip it on when ready.</DialogDescription>
          </DialogHeader>
          <ZodForm
            schema={flagSchema}
            defaultValues={{ flagKey: "", description: "" }}
            fields={[
              { name: "flagKey", label: "Flag key", placeholder: "new_dashboard" },
              { name: "description", label: "Description", placeholder: "Optional" },
            ]}
            submitLabel="Create flag"
            cancel={{ label: "Cancel", onClick: () => setCreateOpen(false) }}
            onSubmit={async (v) => {
              const r = await wrap(() =>
                client.config.createFeatureFlag(scope, {
                  flagKey: v.flagKey,
                  enabled: false,
                  description: v.description || null,
                }),
              );
              if (!r.ok) {
                toast({ kind: "error", title: "Create failed", description: r.error.message });
                return;
              }
              setCreateOpen(false);
              toast({ kind: "success", title: "Flag created" });
              flags.reload();
            }}
          />
        </DialogContent>
      </Dialog>

      {flags.loading ? (
        <ListSkeleton />
      ) : flags.error ? (
        <LoadError title="Failed to load feature flags" message={flags.error.message} />
      ) : !flags.data || flags.data.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="No feature flags yet"
          description="Gate features per organization, repo, or environment — flip them without a deploy."
          primaryAction={{ label: "New flag", onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <div
              className="grid min-w-[480px] items-center gap-3 border-b border-border/70 px-[22px] py-[10px] text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80"
              style={{ gridTemplateColumns: "56px minmax(160px,1fr) 1.2fr 100px" }}
            >
              <span>On</span>
              <span>Flag</span>
              <span>Description</span>
              <span>Updated</span>
            </div>
            {flags.data.map((f) => (
              <div
                key={f.id}
                className="grid min-w-[480px] items-center gap-3 border-t border-border/50 px-[22px] py-[13px] first:border-t-0"
                style={{ gridTemplateColumns: "56px minmax(160px,1fr) 1.2fr 100px" }}
              >
                <Switch
                  checked={f.enabled}
                  onCheckedChange={(on) => void toggle(f, on)}
                  aria-label={`Toggle ${f.flagKey}`}
                />
                <span className="truncate font-mono text-[12.5px] font-medium">{f.flagKey}</span>
                <span className="truncate text-[12px] text-muted-foreground">{f.description ?? "—"}</span>
                <span className="text-[12px] text-muted-foreground">
                  {new Date(f.updatedAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
