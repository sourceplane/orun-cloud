// saas-integration-registry IR8: manifest governance.
//
// Two gates:
// 1. **Additive evolution** — the committed surface snapshot pins every
//    manifest's externally visible shape (capabilities, connect kinds, tabs,
//    modules, entitlement, cli paths). Removing or repurposing anything at
//    the SAME version fails; evolving requires a version bump + a conscious
//    snapshot regeneration. Deleting a manifest id outright always fails.
// 2. **Docs freshness** — the web-docs catalog page is generated from the
//    manifests; this test renders it and compares byte-for-byte.
//
// Regenerate both artifacts after an intentional change:
//   REGENERATE_INTEGRATION_DOCS=1 pnpm --filter ./tests/integrations-worker test -- manifest-governance

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INTEGRATION_MANIFEST_MODULES } from "@integrations-worker/providers/manifests/index";
import { renderIntegrationCatalogMarkdown } from "@integrations-worker/providers/manifests/docs";

const REGEN = process.env.REGENERATE_INTEGRATION_DOCS === "1";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(HERE, "__fixtures__/manifest-surface.json");
const CATALOG_PATH = resolve(HERE, "../../../apps/web-docs/docs/platform/integrations/catalog.md");

interface ManifestSurface {
  version: number;
  category: string;
  connect: string[];
  multiConnection: boolean;
  capabilities: string[];
  tabs: string[];
  modules: string[];
  authoring: string;
  entitlement: string;
  status: string;
  cliPaths: string[];
}

function currentSurface(): Record<string, ManifestSurface> {
  const surface: Record<string, ManifestSurface> = {};
  for (const { manifest } of INTEGRATION_MANIFEST_MODULES) {
    surface[manifest.id] = {
      version: manifest.version,
      category: manifest.category,
      connect: manifest.connect.map((m) => m.kind),
      multiConnection: manifest.multiConnection,
      capabilities: [...manifest.capabilities].sort(),
      tabs: [...manifest.space.tabs],
      modules: [...manifest.space.modules],
      authoring: manifest.space.authoring,
      entitlement: manifest.entitlement,
      status: manifest.status,
      cliPaths: (manifest.cli?.verbs ?? []).map((v) => v.path.join(" ")).sort(),
    };
  }
  return surface;
}

describe("manifest additive-evolution gate (IR8)", () => {
  it("the committed surface snapshot matches (bump `version` + regenerate to evolve)", () => {
    const current = currentSurface();
    if (REGEN) {
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as Record<
      string,
      ManifestSurface
    >;
    // A manifest id may never disappear (a retired provider flips status —
    // it does not vanish; consumers depend on the id resolving).
    for (const id of Object.keys(committed)) {
      expect(current[id]).toBeDefined();
    }
    for (const [id, surface] of Object.entries(current)) {
      const pinned = committed[id];
      if (!pinned) {
        // A NEW manifest: additive, allowed — but it must be snapshotted.
        throw new Error(
          `manifest "${id}" is not in the surface snapshot — run the REGENERATE command in this file's header`,
        );
      }
      if (surface.version === pinned.version) {
        // Same version ⇒ identical surface. Any change requires a bump.
        expect(surface).toEqual(pinned);
      } else {
        // Version bumped ⇒ evolution must still be additive.
        expect(surface.version).toBeGreaterThan(pinned.version);
        for (const kind of pinned.connect) expect(surface.connect).toContain(kind);
        for (const cap of pinned.capabilities) expect(surface.capabilities).toContain(cap);
        for (const tab of pinned.tabs) expect(surface.tabs).toContain(tab);
        throw new Error(
          `manifest "${id}" evolved (v${pinned.version} → v${surface.version}) — regenerate the snapshot to accept`,
        );
      }
    }
  });
});

describe("generated integration catalog (IR8)", () => {
  it("the committed web-docs catalog page is fresh", () => {
    const rendered = renderIntegrationCatalogMarkdown();
    if (REGEN) {
      writeFileSync(CATALOG_PATH, `${rendered}\n`);
      return;
    }
    const committed = readFileSync(CATALOG_PATH, "utf-8");
    expect(committed).toBe(`${rendered}\n`);
  });
});
