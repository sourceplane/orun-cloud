/**
 * Unit tests for the CD6 sibling-link resolver (saas-catalog-docs model.md §6):
 * relative links between an entity's attached docs resolve within the pinned
 * doc set; everything else keeps the sanitized external treatment.
 */

import type { CatalogDoc } from "@saas/contracts/state";
import { resolveSiblingDoc, docReaderHref } from "@web-console-next/lib/doc-links";
import { decodeEntityKey } from "@web-console-next/lib/catalog-entity-key";

function doc(over: Partial<CatalogDoc>): CatalogDoc {
  return {
    orgId: "org_x",
    projectId: "prj_x",
    sourceEnvironment: null,
    entityRef: "acme/repo/api",
    entityKind: "Component",
    entityName: "api",
    docKey: "overview",
    title: "Overview",
    role: "overview",
    path: "apps/api/docs/overview.md",
    commitSha: "c0ffee",
    digest: "sha256:" + "1".repeat(64),
    sizeBytes: 10,
    position: 0,
    headDigest: "sha256:" + "f".repeat(64),
    syncedAt: "2026-07-05T00:00:00.000Z",
    ...over,
  };
}

const overview = doc({});
const runbook = doc({ docKey: "runbook", role: "runbook", path: "apps/api/docs/runbook.md", position: 1 });
const shared = doc({ docKey: "shared", role: "guide", path: "docs/shared.md", position: 2 });
const siblings = [overview, runbook, shared];

describe("resolveSiblingDoc", () => {
  it("resolves same-directory relative links", () => {
    expect(resolveSiblingDoc("runbook.md", overview.path, siblings)).toBe(runbook);
    expect(resolveSiblingDoc("./runbook.md", overview.path, siblings)).toBe(runbook);
  });

  it("resolves parent-relative links within the repo", () => {
    expect(resolveSiblingDoc("../../../docs/shared.md", overview.path, siblings)).toBe(shared);
  });

  it("keeps external treatment for schemed, anchored, and absolute hrefs", () => {
    expect(resolveSiblingDoc("https://example.com/runbook.md", overview.path, siblings)).toBeNull();
    expect(resolveSiblingDoc("#section", overview.path, siblings)).toBeNull();
    expect(resolveSiblingDoc("/apps/api/docs/runbook.md", overview.path, siblings)).toBeNull();
    expect(resolveSiblingDoc("mailto:x@y.z", overview.path, siblings)).toBeNull();
  });

  it("ignores links that escape the repo or miss the attached set", () => {
    expect(resolveSiblingDoc("../".repeat(9) + "etc/passwd", overview.path, siblings)).toBeNull();
    expect(resolveSiblingDoc("not-attached.md", overview.path, siblings)).toBeNull();
  });

  it("drops anchors and query strings before resolving", () => {
    expect(resolveSiblingDoc("runbook.md#alerts", overview.path, siblings)).toBe(runbook);
    expect(resolveSiblingDoc("runbook.md?x=1", overview.path, siblings)).toBe(runbook);
  });
});

describe("docReaderHref", () => {
  it("builds an identity-addressed reader route the codec round-trips", () => {
    const href = docReaderHref("acme", runbook);
    const m = href.match(/^\/orgs\/acme\/docs\/([^/]+)\/runbook$/);
    expect(m).not.toBeNull();
    expect(decodeEntityKey(m![1]!)).toEqual({
      sourceProjectId: "prj_x",
      sourceEnvironment: null,
      entityRef: "acme/repo/api",
    });
  });
});
