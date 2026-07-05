/**
 * Doc-link helpers (saas-catalog-docs CD6) — pure, dependency-light, unit-
 * tested in isolation.
 *
 * `resolveSiblingDoc` implements model.md §6: a relative markdown link whose
 * repo-relative resolution (against the current doc's directory, at the pinned
 * snapshot) equals another ATTACHED page's path resolves to that sibling;
 * everything else (absolute, anchored, schemed, repo-escaping, or simply not
 * attached) stays on the sanitized external treatment. Never a render-time
 * git call — the doc set IS the resolution space.
 */

import type { CatalogDoc } from "@saas/contracts/state";
import { encodeEntityKey } from "./catalog-entity-key";

export function resolveSiblingDoc(href: string, currentPath: string, siblings: CatalogDoc[]): CatalogDoc | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return null;
  const clean = href.split("#")[0]!.split("?")[0]!;
  if (!clean) return null;
  const parts = currentPath.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null; // escapes the repo — not a sibling
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  const resolved = parts.join("/");
  return siblings.find((d) => d.path === resolved) ?? null;
}

/** The reader route for one doc (identity-addressed — survives content edits). */
export function docReaderHref(orgSlug: string, doc: CatalogDoc): string {
  const entityKey = encodeEntityKey({
    sourceProjectId: doc.projectId,
    sourceEnvironment: doc.sourceEnvironment,
    entityRef: doc.entityRef,
  });
  return `/orgs/${orgSlug}/docs/${entityKey}/${encodeURIComponent(doc.docKey)}`;
}
