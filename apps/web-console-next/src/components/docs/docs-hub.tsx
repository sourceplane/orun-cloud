"use client";

/**
 * The Docs hub (saas-catalog-docs CD5) — the org-wide library of every
 * git-authored catalog doc: the doc sets entities attach via `docs.overview` +
 * `docs.pages`, indexed at projection (state.catalog_docs) and rendered by
 * digest. A library, not a wiki: browse by role, search by title/path/entity,
 * open in the reader. The console never authors any of it — the empty state
 * teaches the manifest, never offers a textbox (design.md §2/§6).
 *
 * Northwind layout (docs.html): serif page header with a 230px search on the
 * right, role filter chips with a trailing "N docs · M entities" count, then
 * one shelf per entity — shelf header (name + mono ref + doc count) over a
 * 3-column grid of doc cards — closed by the dashed authoring footnote.
 *
 * Data: the full org doc index, keyset-paged into one client cache (the same
 * fetch-all + client-filter idiom the catalog portal uses), grouped into
 * per-entity shelves ordered kind → entity name.
 */

import * as React from "react";
import Link from "next/link";
import { BookOpen, Search } from "lucide-react";
import type { CatalogDoc } from "@saas/contracts/state";
import { encodeEntityKey } from "@/lib/catalog-entity-key";
import { KINDS } from "@/lib/catalog-kind";
import {
  docRoleColor,
  docRoleLabel,
  shortCommit,
  useOrgDocs,
} from "@/components/catalog/docs/entity-docs";
import { Chip, ChipRow, DashedNote, MonoRef, PageHeader, Screen } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";

/** The well-known role chips, in shelf order. Unknown roles still render on
 *  cards (neutrally) — they just don't get a dedicated chip. */
const ROLE_CHIPS = ["overview", "guide", "runbook", "adr", "architecture", "reference", "changelog", "faq", "onboarding"];

export function DocsHub({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const docsQuery = useOrgDocs(orgId);
  const [role, setRole] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");

  const docs = docsQuery.data ?? [];
  const roles = React.useMemo(() => {
    const present = new Set(docs.map((d) => d.role));
    return ROLE_CHIPS.filter((r) => present.has(r));
  }, [docs]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return docs.filter((d) => {
      if (role && d.role !== role) return false;
      if (!needle) return true;
      return (
        d.title.toLowerCase().includes(needle) ||
        d.path.toLowerCase().includes(needle) ||
        d.entityName.toLowerCase().includes(needle)
      );
    });
  }, [docs, role, q]);

  // Per-entity shelves (docs in declared position), ordered kind → entity name
  // so the library keeps the catalog's canonical kind grouping.
  const shelves = React.useMemo(() => {
    const byRef = new Map<string, CatalogDoc[]>();
    for (const d of filtered) {
      const shelf = byRef.get(d.entityRef) ?? [];
      shelf.push(d);
      byRef.set(d.entityRef, shelf);
    }
    for (const shelf of byRef.values()) {
      shelf.sort((a, b) => a.position - b.position || a.docKey.localeCompare(b.docKey));
    }
    const kindOrder = new Map(KINDS.map((k, i) => [k, i] as const));
    return [...byRef.values()].sort((a, b) => {
      const ka = kindOrder.get(a[0]!.entityKind) ?? KINDS.length;
      const kb = kindOrder.get(b[0]!.entityKind) ?? KINDS.length;
      return ka - kb || a[0]!.entityName.localeCompare(b[0]!.entityName);
    });
  }, [filtered]);

  const loading = docsQuery.loading && !docsQuery.data;
  const empty = !loading && docs.length === 0;

  return (
    <Screen>
      <PageHeader
        title="Docs"
        description="The library of every git-authored catalog doc. Written next to the code, indexed on push — browsed here, never edited here."
        actions={
          empty || loading ? undefined : (
            <div className="relative w-full sm:w-[230px]">
              <Search
                strokeWidth={2}
                className="pointer-events-none absolute left-3 top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-muted-foreground/70"
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search title, path, entity…"
                className="h-[33px] w-full rounded-[9px] border border-border bg-card pl-8 pr-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-foreground/30"
              />
            </div>
          )
        }
      />

      {loading ? (
        <HubSkeleton />
      ) : empty ? (
        <HubEmptyState />
      ) : (
        <>
          {/* role filter chips + library count */}
          <ChipRow className="mt-[26px]">
            <Chip active={role === null} onClick={() => setRole(null)}>
              All roles
            </Chip>
            {roles.map((r) => (
              <Chip key={r} active={role === r} onClick={() => setRole(role === r ? null : r)}>
                {docRoleLabel(r)}
              </Chip>
            ))}
            <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground/80 sm:inline">
              {filtered.length} {filtered.length === 1 ? "doc" : "docs"} · {shelves.length}{" "}
              {shelves.length === 1 ? "entity" : "entities"}
            </span>
          </ChipRow>

          {filtered.length === 0 ? (
            <div className="mt-7 rounded-xl border bg-card px-5 py-12 text-center">
              <div className="text-[13.5px] font-medium">No docs match</div>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                Clear the search or role filter to see the full library.
              </p>
            </div>
          ) : (
            shelves.map((shelf) => (
              <EntityShelf key={shelf[0]!.entityRef} orgSlug={orgSlug} shelf={shelf} />
            ))
          )}

          <DashedNote className="mt-8">
            Docs live in your repositories under{" "}
            <span className="font-mono text-xs text-secondary-foreground">docs.overview</span> and{" "}
            <span className="font-mono text-xs text-secondary-foreground">docs.pages</span> in the entity manifest.
            Push to publish — the library reflects the latest projection.
          </DashedNote>
        </>
      )}
    </Screen>
  );
}

/** One entity's shelf: header (name + mono ref + count) over the doc cards. */
function EntityShelf({ orgSlug, shelf }: { orgSlug: string; shelf: CatalogDoc[] }) {
  const first = shelf[0]!;
  const entityKey = encodeEntityKey({
    sourceProjectId: first.projectId,
    sourceEnvironment: first.sourceEnvironment,
    entityRef: first.entityRef,
  });
  return (
    <section className="mt-7">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <Link
          href={`/orgs/${orgSlug}/catalog/${entityKey}`}
          className="text-[13.5px] font-semibold transition-colors hover:text-foreground/80"
        >
          {first.entityName}
        </Link>
        <MonoRef className="min-w-0 truncate text-muted-foreground/70">{first.entityRef}</MonoRef>
        <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground/80">
          {shelf.length} doc{shelf.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shelf.map((d) => (
          <DocCard key={d.docKey} orgSlug={orgSlug} entityKey={entityKey} doc={d} />
        ))}
      </div>
    </section>
  );
}

/** One doc card: colored role label, title, mono "path · sha" provenance. */
function DocCard({ orgSlug, entityKey, doc }: { orgSlug: string; entityKey: string; doc: CatalogDoc }) {
  const commit = shortCommit(doc.commitSha);
  return (
    <Link
      href={`/orgs/${orgSlug}/docs/${entityKey}/${encodeURIComponent(doc.docKey)}`}
      className="block rounded-[11px] border border-border bg-card px-[17px] py-[15px] transition-colors duration-100 hover:border-foreground/20 hover:bg-muted"
    >
      <div
        className="text-[10.5px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: docRoleColor(doc.role).fg }}
      >
        {docRoleLabel(doc.role)}
      </div>
      <div className="mt-2 truncate text-[13.5px] font-medium leading-snug">{doc.title}</div>
      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">
        {doc.path}
        {commit ? ` · ${commit}` : ""}
      </div>
    </Link>
  );
}

function HubSkeleton() {
  return (
    <div aria-hidden className="mt-[26px]">
      <div className="flex gap-[7px]">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[29px] w-20 rounded-full" />
        ))}
      </div>
      {Array.from({ length: 2 }).map((_, s) => (
        <div key={s} className="mt-7">
          <Skeleton className="h-4 w-56" />
          <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] w-full rounded-[11px]" />
            ))}
          </div>
        </div>
      ))}
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
    <div className="mx-auto mt-4 flex max-w-xl flex-col items-center gap-4 py-14 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-border bg-muted">
        <BookOpen className="h-6 w-6 text-muted-foreground" strokeWidth={1.8} />
      </span>
      <div>
        <h2 className="m-0 font-serif text-[22px] font-medium tracking-[-0.01em]">
          Documentation, from the repo
        </h2>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          Point any entity&apos;s <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">docs</code> block
          at markdown files in its repo. The next{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">orun plan</code> carries them into the
          catalog — pinned to the commit, rendered here, browsable by role. No CMS, no sync job, no drift.
        </p>
      </div>
      <pre className="w-full overflow-x-auto rounded-[10px] border border-border bg-muted p-4 text-left font-mono text-[12px] leading-[1.55] text-foreground/85">
        {snippet}
      </pre>
    </div>
  );
}
