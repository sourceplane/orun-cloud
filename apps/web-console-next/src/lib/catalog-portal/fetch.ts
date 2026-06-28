/**
 * Catalog-portal data loading (saas-catalog-portal · PERF C1/C2).
 *
 * The portal filters/sorts/groups client-side, so it needs the full org graph.
 * The platform endpoint is keyset/cursor paginated at a server-enforced max of
 * 100 rows per page, so "load everything" means walking the cursor to the end.
 *
 * The walk is factored out here — pure but for the injected `fetchPage` — so the
 * paging logic (cursor threading, the page cap, progressive emission) is
 * unit-testable without a live SDK client, and so both the cached query fetcher
 * and any future streamed loader share one implementation.
 */

import type { OrgCatalogEntity, StateCursor } from "@saas/contracts/state";

/** The server's max page size; a larger `limit` is rejected as validation_failed. */
export const CATALOG_PAGE_SIZE = 100;

/** Worst-case page cap — bounds the walk for very large orgs (100 × 50 = 5000). */
export const CATALOG_MAX_PAGES = 50;

/** One page of the keyset listing — the shape the SDK returns. */
export interface CatalogPage {
  entities: OrgCatalogEntity[];
  nextCursor: StateCursor | null;
}

/** The keyset query the endpoint accepts (limit + opaque cursor string). */
export interface CatalogPageQuery {
  limit: number;
  cursor?: string;
}

/** Encode a keyset cursor into the `createdAt|id` string the endpoint expects. */
export function encodeCursor(c: StateCursor): string {
  return `${c.createdAt}|${c.id}`;
}

export interface CollectOptions {
  pageSize?: number;
  maxPages?: number;
  /**
   * Called after each page with the accumulated entities so far (a fresh array
   * copy). Lets a caller paint progressively instead of waiting for the whole
   * walk (PERF C2). Optional — omit for a plain "collect to completion".
   */
  onPage?: (soFar: OrgCatalogEntity[]) => void;
}

/**
 * Walk the keyset catalog endpoint to completion (or `maxPages`), returning the
 * merged entity list. `fetchPage` is injected so this is testable in isolation;
 * it may throw, in which case the rejection propagates to the caller (the cache
 * fetcher wraps it into the `ApiResult` error envelope).
 */
export async function collectOrgCatalog(
  fetchPage: (query: CatalogPageQuery) => Promise<CatalogPage>,
  opts: CollectOptions = {},
): Promise<OrgCatalogEntity[]> {
  const pageSize = opts.pageSize ?? CATALOG_PAGE_SIZE;
  const maxPages = opts.maxPages ?? CATALOG_MAX_PAGES;
  const all: OrgCatalogEntity[] = [];
  let cursor: StateCursor | null = null;

  for (let page = 0; page < maxPages; page++) {
    const query: CatalogPageQuery = { limit: pageSize };
    if (cursor) query.cursor = encodeCursor(cursor);
    const res = await fetchPage(query);
    all.push(...res.entities);
    cursor = res.nextCursor;
    if (opts.onPage) opts.onPage(all.slice());
    if (!cursor) break;
  }

  return all;
}
