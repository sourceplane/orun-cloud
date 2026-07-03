"use client";

import * as React from "react";
import { z } from "zod";
import { Plus, SlidersHorizontal, Flag } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConfigScope } from "@saas/sdk";
import type {
  PublicSetting,
  PublicFeatureFlag,
} from "@saas/contracts/config";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
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
 * The console face of config-worker: settings, feature flags, and secrets at
 * any of the three scopes (organization / project / environment). One shared
 * surface so all scopes behave identically; the page supplies the scope.
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
    <Tabs defaultValue="settings">
      <TabsList>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="flags">Feature flags</TabsTrigger>
        <TabsTrigger value="secrets">Secrets</TabsTrigger>
        {showPolicies ? <TabsTrigger value="policies">Policies</TabsTrigger> : null}
      </TabsList>
      <TabsContent value="settings" className="pt-4">
        <SettingsTab scope={scope} scopeKey={scopeKey} />
      </TabsContent>
      <TabsContent value="flags" className="pt-4">
        <FlagsTab scope={scope} scopeKey={scopeKey} />
      </TabsContent>
      <TabsContent value="secrets" className="pt-4">
        <SecretsPanel scope={scope} scopeKey={scopeKey} />
      </TabsContent>
      {showPolicies ? (
        <TabsContent value="policies" className="pt-4">
          <SecretPoliciesPanel scope={scope} scopeKey={scopeKey} />
        </TabsContent>
      ) : null}
    </Tabs>
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
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Key–value configuration. Values accept JSON literals or plain strings.
        </p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New setting
          </Button>
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
      </div>

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
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="hidden md:table-cell">Description</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settings.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.key}</TableCell>
                  <TableCell className="max-w-[260px] truncate font-mono text-xs">
                    {formatConfigValue(s.value)}
                  </TableCell>
                  <TableCell className="hidden max-w-[220px] truncate text-xs text-muted-foreground md:table-cell">
                    {s.description ?? "—"}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {new Date(s.updatedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
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
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Toggles your product reads at runtime. Changes apply immediately.
        </p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New flag
          </Button>
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
      </div>

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
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px]">On</TableHead>
                <TableHead>Flag</TableHead>
                <TableHead className="hidden md:table-cell">Description</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.data.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <Switch
                      checked={f.enabled}
                      onCheckedChange={(on) => void toggle(f, on)}
                      aria-label={`Toggle ${f.flagKey}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{f.flagKey}</TableCell>
                  <TableCell className="hidden max-w-[260px] truncate text-xs text-muted-foreground md:table-cell">
                    {f.description ?? "—"}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {new Date(f.updatedAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

