"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { KeyRound, Lock, UserRound, TriangleAlert } from "lucide-react";
import type { ConfigScope } from "@saas/sdk";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { configScopeKey } from "./value";
import { ConfigSurface } from "./config-surface";
import { secretHealthStats, type SecretHealthStats } from "./secrets-view";

/**
 * The world-class Secrets & Config home (saas-secret-manager). One org-scoped
 * page from which an operator can browse the secret chain at ANY rung —
 * Workspace, a Project, or an Environment — without navigating repo → tab → env.
 *
 * Scope selection lives in the URL query (`?project=<slug>&env=<slug>`) so a
 * view is shareable/bookmarkable; the default (no params) is Workspace scope.
 * The selection drives a single `ConfigScope` handed to `ConfigSurface`.
 *
 * Write-only discipline is preserved end-to-end: this surface derives its
 * health tiles purely from list metadata and never reads a secret value.
 */
export function SecretsConsole({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const projectSlug = searchParams.get("project");
  const envSlug = searchParams.get("env");

  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const selectedProject = projectSlug
    ? (projects.data?.find((p) => p.slug === projectSlug) ?? null)
    : null;

  const environments = useApiQuery(
    qk.environments(orgId, selectedProject?.id ?? ""),
    () =>
      wrap(async () => (await client.environments.list(orgId, selectedProject!.id)).environments),
    { enabled: !!selectedProject },
  );
  const selectedEnv =
    selectedProject && envSlug
      ? (environments.data?.find((e) => e.slug === envSlug) ?? null)
      : null;

  // Rewrite the URL query as scope changes — never local state — so the scope
  // stays shareable and back/forward navigable. `scroll: false` keeps the page
  // from jumping to the top on a scope switch.
  const setQuery = React.useCallback(
    (next: { project?: string | null; env?: string | null }) => {
      const params = new URLSearchParams(searchParams.toString());
      if ("project" in next) {
        if (next.project) params.set("project", next.project);
        else params.delete("project");
        // Changing (or clearing) the project always invalidates the env.
        params.delete("env");
      }
      if ("env" in next) {
        if (next.env) params.set("env", next.env);
        else params.delete("env");
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Resolve the effective ConfigScope from the selection. Falls back up the
  // chain while the selected slugs are still resolving (or point at nothing).
  const scope: ConfigScope =
    selectedProject && selectedEnv
      ? { kind: "environment", orgId, projectId: selectedProject.id, environmentId: selectedEnv.id }
      : selectedProject
        ? { kind: "project", orgId, projectId: selectedProject.id }
        : { kind: "organization", orgId };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Secrets &amp; Config</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Manage secrets, feature flags, settings, and policies across the inheritance chain —
          personal → environment → project → workspace. Pick a scope to browse any rung.
        </p>
      </header>

      <ScopeSelector
        projectValue={projectSlug}
        envValue={envSlug}
        projects={projects.data ?? []}
        projectsLoading={projects.loading}
        environments={environments.data ?? []}
        envLoading={!!selectedProject && environments.loading}
        canPickEnv={!!selectedProject}
        onProject={(slug) => setQuery({ project: slug })}
        onEnv={(slug) => setQuery({ env: slug })}
      />

      <HealthStrip scope={scope} scopeKey={configScopeKey(scope)} />

      <ConfigSurface scope={scope} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scope selector
// ---------------------------------------------------------------------------

/** Sentinel select values (radix forbids the empty string as an item value). */
const WORKSPACE = "__workspace__";
const ALL_ENVS = "__all_envs__";

function ScopeSelector({
  projectValue,
  envValue,
  projects,
  projectsLoading,
  environments,
  envLoading,
  canPickEnv,
  onProject,
  onEnv,
}: {
  projectValue: string | null;
  envValue: string | null;
  projects: { id: string; slug: string; name: string }[];
  projectsLoading: boolean;
  environments: { id: string; slug: string; name: string }[];
  envLoading: boolean;
  canPickEnv: boolean;
  onProject: (slug: string | null) => void;
  onEnv: (slug: string | null) => void;
}) {
  return (
    <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-end">
      <ScopeField label="Project" hint="Workspace-wide by default">
        <Select
          value={projectValue ?? WORKSPACE}
          onValueChange={(v) => onProject(v === WORKSPACE ? null : v)}
          disabled={projectsLoading}
        >
          <SelectTrigger aria-label="Scope: project">
            <SelectValue placeholder="Workspace" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={WORKSPACE}>Workspace (all repos)</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.slug}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ScopeField>

      <ScopeField label="Environment" hint={canPickEnv ? "Serving chain for this env" : "Pick a project first"}>
        <Select
          value={envValue ?? ALL_ENVS}
          onValueChange={(v) => onEnv(v === ALL_ENVS ? null : v)}
          disabled={!canPickEnv || envLoading}
        >
          <SelectTrigger aria-label="Scope: environment">
            <SelectValue placeholder="All environments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ENVS}>Project-wide</SelectItem>
            {environments.map((e) => (
              <SelectItem key={e.id} value={e.slug}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ScopeField>
    </Card>
  );
}

function ScopeField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="truncate text-[11px] text-muted-foreground">{hint}</span>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health overview
// ---------------------------------------------------------------------------

/**
 * Glanceable health tiles derived purely from the secrets list/chain metadata.
 * Shares the exact `qk.configSecrets` cache the panel uses (same key + fetch),
 * so it never double-fetches. NO value is read here.
 */
function HealthStrip({ scope, scopeKey }: { scope: ConfigScope; scopeKey: string }) {
  const { client } = useSession();
  const isEnv = scope.kind === "environment";
  const secrets = useApiQuery(qk.configSecrets(scopeKey), () =>
    wrap(async () =>
      isEnv
        ? (await client.config.listSecretChain(scope)).secrets
        : (await client.config.listSecretMetadata(scope)).secrets,
    ),
  );
  const now = React.useMemo(() => new Date(), [secrets.data]);

  if (secrets.loading) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] w-full" />
        ))}
      </div>
    );
  }
  // Fail quiet: the panel below surfaces the load error; the strip just hides.
  if (secrets.error || !secrets.data || secrets.data.length === 0) return null;

  const stats: SecretHealthStats = secretHealthStats(secrets.data, now);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile icon={KeyRound} label="Secrets" value={stats.total} tone="default" />
      <StatTile
        icon={TriangleAlert}
        label="Rotation due"
        value={stats.rotationDue}
        tone={stats.rotationDue > 0 ? "warning" : "default"}
      />
      <StatTile icon={Lock} label="Locked" value={stats.locked} tone="default" />
      <StatTile icon={UserRound} label="Personal overlays" value={stats.personal} tone="default" />
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof KeyRound;
  label: string;
  value: number;
  tone: "default" | "warning";
}) {
  return (
    <Card className="flex items-center gap-3 p-3">
      <span
        className={
          tone === "warning"
            ? "grid h-9 w-9 shrink-0 place-items-center rounded-md bg-warning/10 text-warning"
            : "grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
        }
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-lg font-semibold leading-none tabular-nums">{value}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}
