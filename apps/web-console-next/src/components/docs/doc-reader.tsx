"use client";

/**
 * The doc reader (saas-catalog-docs CD5) — one git-authored document, deep-
 * linkable at `/orgs/{slug}/docs/{entityKey}/{docKey}`. Identity-addressed
 * (`(entity, key)`, model.md §2c) so links survive content changes; the body
 * always renders the digest currently projected for that identity, through the
 * sanitizing pipeline, under its provenance line.
 *
 * Northwind layout (doc-detail.html): breadcrumb (Docs / entity / title), then
 * a reading column — role pill + mono path, serif 34px title, provenance meta
 * line, serif body prose — with a sticky right rail: "On this page" TOC
 * (headings lifted from the already-cached markdown source), the entity
 * backlink card, and the sibling-doc shelf (the same DocShelf the service page
 * embeds — the two surfaces cannot drift).
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpen } from "lucide-react";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { decodeEntityKey, parseEntityRef } from "@/lib/catalog-entity-key";
import { formatRelative } from "@/lib/runs-portal/model";
import {
  DocBody,
  DocShelf,
  docRoleColor,
  docRoleLabel,
  shortCommit,
  useEntityDocs,
} from "@/components/catalog/docs/entity-docs";
import { Breadcrumbs, Screen } from "@/components/ui/northwind";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

/** Reader prose (doc-detail.html): serif 16.5px/1.75 body, serif 23px h2s,
 *  ink code blocks, amber callout blockquotes. Merged over the sanitized
 *  markdown container's default console prose (cn/tailwind-merge resolves the
 *  conflicting groups in this override's favor). */
const READER_PROSE = [
  "font-serif text-[16.5px] leading-[1.75] text-[#333333] dark:text-foreground/90",
  "[&_p]:my-3 [&_p:first-child]:mt-0",
  "[&_h1]:mb-3 [&_h1]:mt-8 [&_h1]:text-[26px] [&_h1]:font-medium [&_h1]:tracking-[-0.01em]",
  "[&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:text-[23px] [&_h2]:font-medium [&_h2]:leading-snug [&_h2]:tracking-[-0.01em]",
  "[&_h3]:mb-2 [&_h3]:mt-7 [&_h3]:text-[18px] [&_h3]:font-medium [&_h3]:tracking-[-0.005em]",
  "[&_a]:border-b [&_a]:border-[#BDD2F0] [&_a]:text-[#2563C9] [&_a]:no-underline",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-px [&_code]:text-[13px] [&_code]:text-secondary-foreground",
  "[&_pre]:my-[18px] [&_pre]:rounded-[10px] [&_pre]:border-0 [&_pre]:bg-[#171717] [&_pre]:p-4 [&_pre]:px-5 [&_pre]:font-mono [&_pre]:text-[12.5px] [&_pre]:leading-[1.7] [&_pre]:text-[#D4D4D4]",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[12.5px] [&_pre_code]:text-[#D4D4D4]",
  "[&_blockquote]:my-6 [&_blockquote]:rounded-[10px] [&_blockquote]:border [&_blockquote]:border-l [&_blockquote]:border-warning-accent/40 [&_blockquote]:bg-warning-wash [&_blockquote]:px-5 [&_blockquote]:py-4 [&_blockquote]:text-[15px] [&_blockquote]:leading-[1.65] [&_blockquote]:text-[#7A6C4E] dark:[&_blockquote]:text-warning",
  "[&_blockquote_p]:my-1",
  "[&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1.5",
].join(" ");

const WORDS_PER_MINUTE = 200;

/** Lift the h2/h3 outline from the markdown source (skipping fenced code) —
 *  the body is already in the query cache by digest, so this costs nothing. */
function extractHeadings(md: string | null | undefined): { level: number; text: string }[] {
  if (!md) return [];
  const out: { level: number; text: string }[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.replace(/[`*_]/g, "") });
  }
  return out.slice(0, 16);
}

export function DocReader({
  orgId,
  orgSlug,
  entityKey,
  docKey,
}: {
  orgId: string;
  orgSlug: string;
  entityKey: string;
  docKey: string;
}) {
  const router = useRouter();
  const { client } = useSession();
  const now = React.useMemo(() => Date.now(), []);
  const identity = React.useMemo(() => decodeEntityKey(entityKey), [entityKey]);
  const { docs, loading } = useEntityDocs(orgId, identity?.entityRef ?? null);
  const active = docs.find((d) => d.docKey === docKey) ?? null;

  // The same digest-addressed read DocBody performs (shared cache entry) —
  // reused here only to derive the outline and the read-time estimate.
  const body = useApiQuery(
    qk.docBody(orgId, active?.digest ?? ""),
    () => wrap(() => client.state.readCatalogDoc(orgId, active!.digest)),
    { enabled: !!active, staleTime: Infinity },
  );
  const headings = React.useMemo(() => extractHeadings(body.data), [body.data]);
  const minRead = React.useMemo(() => {
    if (!body.data) return null;
    return Math.max(1, Math.round(body.data.split(/\s+/).filter(Boolean).length / WORDS_PER_MINUTE));
  }, [body.data]);

  const bodyRef = React.useRef<HTMLDivElement>(null);
  const scrollToHeading = React.useCallback((index: number) => {
    const els = bodyRef.current?.querySelectorAll("h2, h3");
    els?.[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (!identity) {
    return (
      <Screen detail>
        <EmptyState
          icon={BookOpen}
          title="Document not found"
          description="This link doesn't resolve to a catalog entity."
          primaryAction={{ label: "All docs", href: `/orgs/${orgSlug}/docs` }}
        />
      </Screen>
    );
  }

  if (loading && docs.length === 0) {
    return (
      <Screen detail aria-hidden>
        <Skeleton className="mb-7 h-3.5 w-64" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-4 h-9 w-96 max-w-full" />
        <Skeleton className="mt-4 h-3.5 w-72" />
        <div className="mt-8 space-y-3">
          <Skeleton className="h-3.5 w-full max-w-[660px]" />
          <Skeleton className="h-3.5 w-full max-w-[620px]" />
          <Skeleton className="h-3.5 w-full max-w-[520px]" />
        </div>
      </Screen>
    );
  }

  const entityName = active?.entityName ?? parseEntityRef(identity.entityRef).name ?? identity.entityRef;

  if (!active) {
    return (
      <Screen detail>
        <EmptyState
          icon={BookOpen}
          title="Document not found"
          description={`${entityName} has no “${docKey}” document at the current catalog head. It may have been renamed or removed in the repo.`}
          primaryAction={{ label: "All docs", href: `/orgs/${orgSlug}/docs` }}
        />
      </Screen>
    );
  }

  const role = docRoleColor(active.role);
  const commit = shortCommit(active.commitSha);

  return (
    <Screen detail>
      <Breadcrumbs
        items={[
          { label: "Docs", href: `/orgs/${orgSlug}/docs` },
          { label: entityName, href: `/orgs/${orgSlug}/catalog/${entityKey}` },
          { label: active.title },
        ]}
      />

      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_200px] lg:gap-12">
        <article className="min-w-0 max-w-[660px]">
          <div className="flex flex-wrap items-center gap-[9px]">
            <span
              className="rounded-[10px] px-2.5 py-[3px] text-[10.5px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: role.fg, background: role.bg }}
            >
              {docRoleLabel(active.role)}
            </span>
            <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground/80">{active.path}</span>
          </div>

          <h1 className="mt-3.5 font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] sm:text-[34px]">
            {active.title}
          </h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground/90">
            {commit ? (
              <span>
                Rendered from <span className="font-mono">{commit}</span>
              </span>
            ) : (
              <span>Rendered from the current catalog head</span>
            )}
            {active.syncedAt ? (
              <>
                <span aria-hidden>·</span>
                <span>updated {formatRelative(active.syncedAt, now)}</span>
              </>
            ) : null}
            {minRead ? (
              <>
                <span aria-hidden>·</span>
                <span>{minRead} min read</span>
              </>
            ) : null}
          </div>

          <div ref={bodyRef} className="mt-7">
            <DocBody
              orgId={orgId}
              doc={active}
              orgSlug={orgSlug}
              siblings={docs}
              proseClassName={READER_PROSE}
            />
          </div>
        </article>

        {/* right rail: outline, entity backlink, sibling docs */}
        <aside className="min-w-0 lg:sticky lg:top-10 lg:pt-24">
          {headings.length > 0 ? (
            <div className="hidden lg:block">
              <div className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/80">
                On this page
              </div>
              <div className="flex flex-col gap-[7px] border-l border-border pl-3.5 text-[12.5px]">
                {headings.map((h, i) => (
                  <button
                    key={`${i}-${h.text}`}
                    type="button"
                    onClick={() => scrollToHeading(i)}
                    className={cn(
                      "truncate text-left text-muted-foreground transition-colors hover:text-foreground",
                      h.level === 3 && "pl-3",
                    )}
                  >
                    {h.text}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className={cn("rounded-[10px] border border-border bg-card px-[15px] py-[13px]", headings.length > 0 && "lg:mt-6")}>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
              Entity
            </div>
            <Link
              href={`/orgs/${orgSlug}/catalog/${entityKey}`}
              className="mt-[7px] block truncate font-mono text-xs text-secondary-foreground transition-colors hover:text-foreground"
            >
              {entityName} →
            </Link>
          </div>

          {docs.length > 1 ? (
            <div className="mt-3">
              <DocShelf
                docs={docs}
                activeKey={active.docKey}
                onSelect={(key) => router.push(`/orgs/${orgSlug}/docs/${entityKey}/${encodeURIComponent(key)}`)}
              />
            </div>
          ) : null}
        </aside>
      </div>
    </Screen>
  );
}
