/**
 * Pure navigation model for the catalog entity sidebar (saas-service-catalog
 * SC0). Dependency-free (no React, no icons) so the composition is unit-testable
 * and shared by the desktop sidebar and the mobile nav drawer, mirroring
 * `nav-items.ts`. Icon resolution and rendering happen in `sidebar.tsx`.
 *
 * Selecting a catalog entity swaps the whole left rail to this contextual nav —
 * the same rail-swap mechanism the Settings panel uses (`settings-nav.ts`).
 */

import { decodeEntityKey, parseEntityRef } from "@/lib/catalog-entity-key";

export interface EntityNavLink {
  href: string;
  label: string;
}

export interface EntityNavModel {
  /** Back to the catalog index (the rail's "‹ Catalog" row). */
  backHref: string;
  /** Display name, derived from the entity ref. */
  name: string;
  /** Display kind (Component | API | …), derived from the entity ref. */
  kind: string;
  /** Tab links for this entity. SC0 ships Overview; later milestones add more. */
  links: EntityNavLink[];
}

/**
 * Build the contextual sidebar model for a catalog entity URL. Returns null when
 * the key is malformed (the caller then falls back to the product nav). The
 * identity is recovered from the URL key alone — no fetch — so the rail can
 * render instantly on navigation.
 */
export function buildEntityNav(orgSlug: string, entityKey: string): EntityNavModel | null {
  const id = decodeEntityKey(entityKey);
  if (!id) return null;
  const { kind, name } = parseEntityRef(id.entityRef);
  const base = `/orgs/${orgSlug}/catalog/${entityKey}`;
  return {
    backHref: `/orgs/${orgSlug}/catalog`,
    name: name || id.entityRef,
    kind,
    links: [{ href: base, label: "Overview" }],
  };
}

/**
 * Extract the catalog entity key from a pathname, or null when the path is not a
 * catalog entity route. `/orgs/{org}/catalog` (the index) returns null; only
 * `/orgs/{org}/catalog/{key}` (and deeper) yields a key.
 */
export function entityKeyFromPath(orgSlug: string, pathname: string | null): string | null {
  if (!pathname) return null;
  const prefix = `/orgs/${orgSlug}/catalog/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const key = rest.split("/")[0] ?? "";
  return key || null;
}
