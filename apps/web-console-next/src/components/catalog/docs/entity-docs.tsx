"use client";

/**
 * Shared entity doc-set components (saas-catalog-docs CD4/CD5): the shelf
 * (an entity's ordered doc list from the org doc index) and the body (one doc's
 * git-authored markdown, fetched by content digest and rendered through the
 * sanitizing pipeline). Used by the service page's Docs tab (CD4) and the Docs
 * hub reader (CD5) so the two surfaces cannot drift.
 *
 * The honesty rule (design.md §4): everything rendered here is git-authored and
 * carries its provenance line (`path @ short-commit`); computed content lives
 * in the caller's badged derived card, never in these components.
 */

import * as React from "react";
import type { CatalogDoc } from "@saas/contracts/state";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { Markdown } from "@/components/overview/markdown";
import { resolveSiblingDoc, docReaderHref } from "@/lib/doc-links";
import { PathIcon } from "@/components/catalog/portal/icon";
import { DOC_ICON } from "@/lib/catalog-portal/icons";
import { Skeleton } from "@/components/ui/skeleton";

/** Role → shelf icon path. Well-known roles get their glyph; unknown roles
 *  render the neutral file icon (free taxonomy, styled neutrally). */
export function docRoleIcon(role: string): string {
  switch (role) {
    case "runbook":
      return DOC_ICON.runbook;
    case "architecture":
    case "guide":
    case "onboarding":
      return DOC_ICON.book;
    case "reference":
    case "adr":
      return DOC_ICON.api;
    default:
      return DOC_ICON.file;
  }
}

/** Fetch one entity's doc set from the org doc index, in shelf order
 *  (overview first, then declared position). */
export function useEntityDocs(orgId: string, entityRef: string | null) {
  const { client } = useSession();
  const query = useApiQuery(
    qk.entityDocs(orgId, entityRef ?? ""),
    () => wrap(() => client.state.listCatalogDocs(orgId, { entityRef: entityRef!, limit: 100 })),
    { enabled: !!entityRef },
  );
  const docs = React.useMemo(() => {
    const items = (query.data?.docs ?? []).slice();
    items.sort((a, b) => a.position - b.position || a.docKey.localeCompare(b.docKey));
    return items;
  }, [query.data]);
  return { docs, loading: query.loading, error: query.error };
}

export function shortCommit(sha: string | null): string | null {
  if (!sha) return null;
  return sha.length > 10 ? sha.slice(0, 10) : sha;
}

/** The provenance line every git-authored doc renders under (never absent —
 *  the honesty rule's visible half). */
export function DocProvenance({ doc }: { doc: CatalogDoc }) {
  const commit = shortCommit(doc.commitSha);
  return (
    <span className="font-mono text-[11px] text-muted-foreground/70">
      {doc.path}
      {commit ? ` @ ${commit}` : ""}
    </span>
  );
}

export { resolveSiblingDoc, docReaderHref };

/** One doc's body: fetched by content digest (immutable → cached indefinitely)
 *  and rendered through the sanitizing markdown pipeline. With `orgSlug` +
 *  `siblings`, relative links between the entity's attached docs navigate
 *  in-app (CD6). */
export function DocBody({
  orgId,
  doc,
  orgSlug,
  siblings,
}: {
  orgId: string;
  doc: CatalogDoc;
  orgSlug?: string;
  siblings?: CatalogDoc[];
}) {
  const { client } = useSession();
  const body = useApiQuery(
    qk.docBody(orgId, doc.digest),
    () => wrap(() => client.state.readCatalogDoc(orgId, doc.digest)),
    { staleTime: Infinity },
  );
  const resolveLink = React.useCallback(
    (href: string): string | null => {
      if (!orgSlug || !siblings || siblings.length === 0) return null;
      const hit = resolveSiblingDoc(href, doc.path, siblings);
      return hit ? docReaderHref(orgSlug, hit) : null;
    },
    [orgSlug, siblings, doc.path],
  );
  if (body.loading && body.data == null) {
    return (
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-4 w-2/5 bg-muted" />
        <Skeleton className="h-3 w-full bg-muted" />
        <Skeleton className="h-3 w-11/12 bg-muted" />
        <Skeleton className="h-3 w-3/5 bg-muted" />
      </div>
    );
  }
  if (body.error || body.data == null) {
    return (
      <p className="text-[13px] text-muted-foreground">
        This document could not be loaded. It may have been superseded by a newer catalog push — refresh to pick up
        the current head.
      </p>
    );
  }
  return <Markdown resolveLink={resolveLink}>{body.data}</Markdown>;
}

/** The shelf: an entity's ordered doc list. Pure presentation — selection state
 *  belongs to the caller (tab state on the service page; the route in the hub
 *  reader). */
export function DocShelf({
  docs,
  activeKey,
  onSelect,
}: {
  docs: CatalogDoc[];
  activeKey: string;
  onSelect: (docKey: string) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[12px] border border-border bg-card p-2">
      <div className="px-2 pb-2 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
        Documents
      </div>
      {docs.map((d) => {
        const on = d.docKey === activeKey;
        return (
          <button
            key={d.docKey}
            type="button"
            onClick={() => onSelect(d.docKey)}
            className="flex w-full items-center gap-[9px] rounded-[8px] px-[9px] py-2 text-left"
            style={{
              background: on ? "hsl(var(--primary) / 0.07)" : "transparent",
              border: `1px solid ${on ? "hsl(var(--input))" : "transparent"}`,
            }}
          >
            <PathIcon
              d={d.docKey === "overview" ? DOC_ICON.file : docRoleIcon(d.role)}
              size={14}
              strokeWidth={1.7}
              className="shrink-0 text-muted-foreground/80"
            />
            <span className="flex min-w-0 flex-col gap-px">
              <span
                className="truncate text-[12.5px] font-medium"
                style={{ color: on ? "hsl(var(--foreground))" : "hsl(var(--muted-foreground))" }}
              >
                {d.title}
              </span>
              <span className="truncate text-[10.5px] text-muted-foreground/60">
                {d.docKey === "overview" ? "front page" : d.role}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
