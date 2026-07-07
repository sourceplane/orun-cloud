"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ConfigScope } from "@saas/sdk";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Chip,
  ChipDivider,
  ChipRow,
  PageHeader,
  Screen,
  StatusDot,
} from "@/components/ui/northwind";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { configScopeKey } from "./value";
import { ConfigSurface, NewSecretContext } from "./config-surface";
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
 * health chips purely from list metadata and never reads a secret value.
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

  // "New secret" lives in the PageHeader but the create dialog is owned by the
  // Secrets panel (scoped to `scope`). A ref bridges the two without lifting the
  // dialog state across `ConfigSurface` (shared by other pages).
  const newSecretRef = React.useRef<(() => void) | null>(null);
  const openNewSecret = React.useCallback(() => newSecretRef.current?.(), []);

  return (
    <Screen>
      <PageHeader
        title="Secrets"
        description="Write-only by design — values are set, rotated, and synced, never displayed. What you see here is metadata and health."
        actions={
          <Button size="sm" onClick={openNewSecret}>
            New secret
          </Button>
        }
      />

      <ScopeFilter
        scope={scope}
        scopeKey={configScopeKey(scope)}
        projectSlug={projectSlug}
        envSlug={envSlug}
        projects={projects.data ?? []}
        projectsLoading={projects.loading}
        environments={environments.data ?? []}
        canPickEnv={!!selectedProject}
        onProject={(slug) => setQuery({ project: slug })}
        onEnv={(slug) => setQuery({ env: slug })}
      />

      <div className="mt-3.5">
        <NewSecretContext.Provider value={newSecretRef}>
          <ConfigSurface scope={scope} />
        </NewSecretContext.Provider>
      </div>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Scope filter — the chip row that replaces the old scope-selector card.
// ---------------------------------------------------------------------------

/**
 * Scope chips ("All scopes" / project / env) plus the health strip on the right
 * ("Rotation due · N" + total count) — derived purely from the same
 * `qk.configSecrets` cache the panel reads, so nothing double-fetches and no
 * secret value is ever touched.
 */
function ScopeFilter({
  scope,
  scopeKey,
  projectSlug,
  envSlug,
  projects,
  projectsLoading,
  environments,
  canPickEnv,
  onProject,
  onEnv,
}: {
  scope: ConfigScope;
  scopeKey: string;
  projectSlug: string | null;
  envSlug: string | null;
  projects: { id: string; slug: string; name: string }[];
  projectsLoading: boolean;
  environments: { id: string; slug: string; name: string }[];
  canPickEnv: boolean;
  onProject: (slug: string | null) => void;
  onEnv: (slug: string | null) => void;
}) {
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
  const stats: SecretHealthStats | null =
    secrets.data && secrets.data.length > 0 ? secretHealthStats(secrets.data, now) : null;

  return (
    <div className="mt-[26px] flex flex-col gap-3 sm:flex-row sm:items-center">
      <ChipRow className="sm:flex-1">
        <Chip active={!projectSlug} onClick={() => onProject(null)}>
          All scopes
        </Chip>
        {projectsLoading && projects.length === 0 ? (
          <Skeleton className="h-[27px] w-24 rounded-full" />
        ) : (
          projects.map((p) => (
            <Chip key={p.id} active={projectSlug === p.slug} onClick={() => onProject(p.slug)}>
              {p.name}
            </Chip>
          ))
        )}

        {canPickEnv && environments.length > 0 ? (
          <>
            <ChipDivider />
            <Chip active={!envSlug} onClick={() => onEnv(null)}>
              Project-wide
            </Chip>
            {environments.map((e) => (
              <Chip key={e.id} active={envSlug === e.slug} onClick={() => onEnv(e.slug)}>
                {e.name}
              </Chip>
            ))}
          </>
        ) : null}

        {stats && stats.rotationDue > 0 ? (
          <>
            <ChipDivider />
            <Chip>
              <StatusDot tone="warning" />
              Rotation due · {stats.rotationDue}
            </Chip>
          </>
        ) : null}
      </ChipRow>

      {stats ? (
        <span className="shrink-0 text-[12px] text-muted-foreground/80">
          {stats.total} {stats.total === 1 ? "secret" : "secrets"}
        </span>
      ) : null}
    </div>
  );
}
