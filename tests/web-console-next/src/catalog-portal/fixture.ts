/**
 * Shared fixtures for the catalog-portal view-model tests.
 * Builders for OrgCatalogEntity and the normalized CatalogService.
 */

import type { OrgCatalogEntity } from "@saas/contracts/state";
import type { CatalogService } from "@web-console-next/lib/catalog-portal/model";
import { toService } from "@web-console-next/lib/catalog-portal/model";

export function entity(over: Partial<OrgCatalogEntity> & { entityRef: string }): OrgCatalogEntity {
  return {
    orgId: "org_1",
    kind: "Component",
    name: over.entityRef.split("/").pop() ?? over.entityRef,
    owner: null,
    lifecycle: null,
    relations: [],
    sourceProjectId: "prj_1",
    sourceEnvironment: null,
    sourceCommit: null,
    headDigest: "sha256:deadbeef",
    ...over,
  };
}

/** Build a normalized service with optional runtime-signal overrides. */
export function service(
  over: Partial<OrgCatalogEntity> & { entityRef: string },
  signals: Partial<CatalogService> = {},
): CatalogService {
  return { ...toService(entity(over)), ...signals };
}
