// Integration catalog docs generation (saas-integration-registry IR8).
//
// The LAST hand-mirrored copy dies here: the web-docs catalog page is
// RENDERED from the manifests (connect posture, capabilities, recipes,
// entitlements) instead of hand-written. The committed page
// (`apps/web-docs/docs/platform/integrations/catalog.md`) is pinned by a
// freshness test (manifest-governance.test.ts); regenerate with
//   REGENERATE_INTEGRATION_DOCS=1 pnpm --filter ./tests/integrations-worker test -- manifest-governance
// Hand-written per-provider prose (github.md et al) stays hand-written —
// this generates the catalog/index, not the narratives.

import type { IntegrationManifest } from "@saas/contracts/integrations";
import type { IntegrationConnectMethod } from "@saas/contracts/integrations";
import type { Env } from "../../env.js";
import { INTEGRATION_MANIFEST_MODULES } from "./index.js";

const CATEGORY_LABELS: Record<string, string> = {
  "source-control": "Source control",
  messaging: "Messaging",
  infrastructure: "Infrastructure",
  "ai-provider": "AI providers",
  compute: "Compute",
};

const CONNECT_LABELS: Record<string, string> = {
  install: "app install",
  oauth: "OAuth",
  token: "token paste",
  apikey: "API key",
};

const STATUS_LABELS: Record<string, string> = {
  live: "Available",
  dormant: "Reserved",
  roadmap: "On the roadmap",
};

function connectSummary(manifest: IntegrationManifest, methods: readonly IntegrationConnectMethod[]): string {
  void manifest;
  return methods.map((m) => CONNECT_LABELS[m.kind] ?? m.kind).join(" · ");
}

/** Render the catalog page. Pure — no environment, no liveness (docs describe
 *  the product, not one deployment), recipes included where declared. */
export function renderIntegrationCatalogMarkdown(): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("title: Integration catalog");
  lines.push(
    "description: Every integration the platform coordinates — connect posture, capabilities, and entitlements — generated from the Integration Registry manifests.",
  );
  lines.push("---");
  lines.push("");
  lines.push(
    "<!-- GENERATED FILE — do not edit by hand. Rendered from the Integration",
  );
  lines.push(
    "     Registry manifests (apps/integrations-worker/src/providers/manifests/);",
  );
  lines.push(
    "     regenerate: REGENERATE_INTEGRATION_DOCS=1 pnpm --filter ./tests/integrations-worker test -- manifest-governance -->",
  );
  lines.push("");
  lines.push(
    "Every integration is declared by one **Integration Manifest** and served through the registry read (`GET /v1/organizations/{orgId}/integrations/registry`). The hub, each integration's page, the Secrets surface, and the `orun` CLI all derive from the same descriptors — this catalog is generated from them.",
  );
  lines.push("");
  lines.push("| Integration | Category | Connect | Capabilities | Status |");
  lines.push("|---|---|---|---|---|");
  for (const { manifest } of INTEGRATION_MANIFEST_MODULES) {
    lines.push(
      `| **${manifest.displayName}** | ${CATEGORY_LABELS[manifest.category] ?? manifest.category} | ${manifest.connect
        .map((m) => CONNECT_LABELS[m.kind] ?? m.kind)
        .join(" · ")} | ${manifest.capabilities.join(", ")} | ${STATUS_LABELS[manifest.status] ?? manifest.status} |`,
    );
  }
  lines.push("");

  for (const module of INTEGRATION_MANIFEST_MODULES) {
    const { manifest } = module;
    lines.push(`## ${manifest.displayName}`);
    lines.push("");
    lines.push(manifest.tagline);
    lines.push("");
    lines.push(
      `- **Category**: ${CATEGORY_LABELS[manifest.category] ?? manifest.category} · **Status**: ${STATUS_LABELS[manifest.status] ?? manifest.status} · **Manifest**: v${manifest.version}`,
    );
    lines.push(
      `- **Connect**: ${connectSummary(manifest, manifest.connect.map((m) => ({ ...m, live: false })))}${manifest.multiConnection ? " — multiple connections supported" : ""}`,
    );
    lines.push(`- **Capabilities**: ${manifest.capabilities.join(", ")}`);
    lines.push(`- **Entitlement**: \`${manifest.entitlement}\``);
    // Recipes are environment-independent guidance; render them where a
    // resolver declares one (pass an empty env — recipes don't depend on it).
    const served = module.resolveConnect({} as unknown as Env);
    for (const method of served) {
      if (!method.recipe) continue;
      lines.push("");
      lines.push(`### ${manifest.displayName} ${CONNECT_LABELS[method.kind] ?? method.kind} recipe`);
      lines.push("");
      lines.push(method.recipe.intro);
      lines.push("");
      for (const item of method.recipe.items) {
        lines.push(`- \`${item.name}\` — ${item.why}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
