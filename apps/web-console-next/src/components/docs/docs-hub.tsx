"use client";

/**
 * The Docs hub (saas-catalog-docs CD5) — the org-wide library of every
 * git-authored catalog doc: the doc sets entities attach via `docs.overview` +
 * `docs.pages`, indexed at projection (state.catalog_docs) and rendered by
 * digest. A library, not a wiki: browse by entity kind and role, search by
 * title/path/entity, open in the reader. The console never authors any of it —
 * the empty state teaches the manifest, never offers a textbox
 * (design.md §2/§6).
 *
 * Data: the full org doc index, keyset-paged into one client cache (the same
 * fetch-all + client-filter idiom the catalog portal uses), grouped kind →
 * entity so an entity's set reads as one shelf.
 */

import * as React from "react";
import Link from "next/link";
import { BookOpen, Search } from "lucide-react";
import type { CatalogDoc } from "@saas/contracts/state";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { encodeEntityKey } from "@/lib/catalog-entity-key";
import { KINDS } from "@/lib/catalog-kind";
import { docRoleIcon, shortCommit } from "@/components/catalog/docs/entity-docs";
import { PathIcon } from "@/components/catalog/portal/icon";
import { DOC_ICON, iconForKind } from "@/lib/catalog-portal/icons";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

/** Fetch the whole org doc index (bounded), one cache entry per org. */
function useOrgDocs(orgId: string) {
  const { client } = useSession();
  return useApiQuery(qk.orgDocs(orgId), () =>
    wrap(async () => {
      const all: CatalogDoc[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await client.state.listCatalogDocs(orgId, {
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...page.docs);
        if (!page.nextCursor) break;
        cursor = `${page.nextCursor.createdAt}|${page.nextCursor.id}`;
      }
      return all;
    }),
  );
}

/** The well-known role chips, in shelf order. Unknown roles fold into the
 *  trailing "other" bucket rather than exploding the chip row. */
const ROLE_CHIPS = ["overview", "guide", "architecture", "runbook", "adr", "reference", "changelog", "faq", "onboarding"];

export function DocsHub({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const docsQuery = useOrgDocs(orgId);
  const [kind, setKind] = React.useState<string | null>(null);
  const [role, setRole] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");

  const docs = docsQuery.data ?? [];
  const kinds = React.useMemo(() => {
    const present = new Set(docs.map((d) => d.entityKind));
    // Known kinds first in canonical order, then anything novel.
    const ordered = KINDS.filter((k) => present.has(k));
    for (const k of present) if (!ordered.includes(k)) ordered.push(k);
    return ordered;
  }, [docs]);
  const roles = React.useMemo(() => {
    const present = new Set(docs.map((d) => d.role));
    return ROLE_CHIPS.filter((r) => present.has(r));
  }, [docs]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return docs.filter((d) => {
      if (kind && d.entityKind !== kind) return false;
      if (role && d.role !== role) return false;
      if (!needle) return true;
      return (
        d.title.toLowerCase().includes(needle) ||
        d.path.toLowerCase().includes(needle) ||
        d.entityName.toLowerCase().includes(needle)
      );
    });
  }, [docs, kind, role, q]);

  // kind → entityRef → shelf (sorted by position; entities by name).
  const grouped = React.useMemo(() => {
    const byKind = new Map<string, Map<string, CatalogDoc[]>>();
    for (const d of filtered) {
      const entities = byKind.get(d.entityKind) ?? new Map<string, CatalogDoc[]>();
      const shelf = entities.get(d.entityRef) ?? [];
      shelf.push(d);
      entities.set(d.entityRef, shelf);
      byKind.set(d.entityKind, entities);
    }
    for (const entities of byKind.values()) {
      for (const shelf of entities.values()) {
        shelf.sort((a, b) => a.position - b.position || a.docKey.localeCompare(b.docKey));
      }
    }
    return byKind;
  }, [filtered]);

  if (docsQuery.loading && !docsQuery.data) {
    return (
      <div className="space-y-4 p-1">
        <Skeleton className="h-8 w-56 bg-muted" />
        <Skeleton className="h-24 w-full bg-muted" />
        <Skeleton className="h-24 w-full bg-muted" />
      </div>
    );
  }

  if (docs.length === 0) {
    return <HubEmptyState />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* header + search */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-lg font-semibold tracking-tight">Docs</h1>
        <span className="rounded-md border border-input px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {docs.length}
        </span>
        <div className="relative ml-auto w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title, path, or entity…"
            className="h-9 w-full rounded-lg border border-border bg-card pl-8 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/50 focus:border-input"
          />
        </div>
      </div>

      {/* filter chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip label="All kinds" active={kind === null} onClick={() => setKind(null)} />
        {kinds.map((k) => (
          <FilterChip key={k} label={k} active={kind === k} onClick={() => setKind(kind === k ? null : k)} />
        ))}
        {roles.length > 1 ? <span className="mx-1 h-4 w-px bg-border" /> : null}
        {roles.map((r) => (
          <FilterChip key={r} label={r} active={role === r} onClick={() => setRole(role === r ? null : r)} muted />
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No docs match"
          description="Clear the search or filters to see the full library."
        />
      ) : (
        [...grouped.entries()].map(([k, entities]) => (
          <section key={k} className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2 pt-1">
              <PathIcon d={iconForKind(k)} size={14} strokeWidth={1.8} className="text-muted-foreground/70" />
              <h2 className="m-0 text-[13px] font-semibold text-foreground/90">{k}</h2>
              <span className="font-mono text-[11px] text-muted-foreground/60">{entities.size}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {[...entities.entries()]
                .sort((a, b) => a[1][0]!.entityName.localeCompare(b[1][0]!.entityName))
                .map(([ref, shelf]) => (
                  <EntityShelfCard key={ref} orgSlug={orgSlug} shelf={shelf} />
                ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  muted,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-full border px-3 text-[12px] transition-colors"
      style={{
        borderColor: active ? "hsl(var(--primary) / 0.45)" : "hsl(var(--border))",
        background: active ? "hsl(var(--primary) / 0.08)" : "transparent",
        color: active ? "hsl(var(--foreground))" : muted ? "hsl(var(--muted-foreground) / 0.8)" : "hsl(var(--muted-foreground))",
      }}
    >
      {label}
    </button>
  );
}

/** One entity's shelf: the entity header + its docs, each row into the reader. */
function EntityShelfCard({ orgSlug, shelf }: { orgSlug: string; shelf: CatalogDoc[] }) {
  const first = shelf[0]!;
  const entityKey = encodeEntityKey({
    sourceProjectId: first.projectId,
    sourceEnvironment: first.sourceEnvironment,
    entityRef: first.entityRef,
  });
  return (
    <div className="rounded-[13px] border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Link
          href={`/orgs/${orgSlug}/catalog/${entityKey}`}
          className="truncate text-[13px] font-medium text-foreground/90 hover:text-foreground"
        >
          {first.entityName}
        </Link>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground/60">
          {shelf.length} doc{shelf.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="p-1.5">
        {shelf.map((d) => {
          const commit = shortCommit(d.commitSha);
          return (
            <Link
              key={d.docKey}
              href={`/orgs/${orgSlug}/docs/${entityKey}/${encodeURIComponent(d.docKey)}`}
              className="flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 transition-colors hover:bg-foreground/[0.03]"
            >
              <PathIcon
                d={d.docKey === "overview" ? DOC_ICON.file : docRoleIcon(d.role)}
                size={14}
                strokeWidth={1.7}
                className="shrink-0 text-muted-foreground/80"
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{d.title}</span>
              <span className="hidden shrink-0 rounded-[5px] border border-input px-1.5 py-px text-[10px] text-muted-foreground/70 sm:inline">
                {d.docKey === "overview" ? "front page" : d.role}
              </span>
              <span className="hidden shrink-0 font-mono text-[10.5px] text-muted-foreground/50 md:inline">
                {d.path}
                {commit ? ` @ ${commit}` : ""}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Zero docs org-wide: the worked example — one screen, copy-paste, done. */
function HubEmptyState() {
  const snippet = [
    "# component.yaml (or the repo: block in intent.yaml)",
    "spec:",
    "  docs:",
    "    overview: docs/overview.md",
    "    pages:",
    "      - { path: docs/architecture.md, role: architecture }",
    "      - { path: docs/runbook.md, role: runbook }",
  ].join("\n");
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-border bg-muted">
        <BookOpen className="h-6 w-6 text-muted-foreground" />
      </span>
      <div>
        <h1 className="m-0 text-lg font-semibold tracking-tight">Documentation, from the repo</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          Point any entity&apos;s <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">docs</code> block
          at markdown files in its repo. The next{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">orun plan</code> carries them into the
          catalog — pinned to the commit, rendered here, browsable by kind and role. No CMS, no sync job, no drift.
        </p>
      </div>
      <pre className="w-full overflow-x-auto rounded-lg border border-border bg-muted p-4 text-left font-mono text-[12px] leading-[1.55] text-foreground/85">
        {snippet}
      </pre>
    </div>
  );
}
