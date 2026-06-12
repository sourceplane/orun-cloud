/**
 * Deployment-config regression tests for config-worker and api-edge.
 *
 * These tests read the committed wrangler.jsonc / component.yaml files and
 * assert that placeholder Hyperdrive IDs, malformed IDs, and missing
 * service-binding dependencies cannot slip through undetected.
 *
 * Task 0057 — introduced after main CI run 26568163207 failed because
 * config-worker stage used PLACEHOLDER_STAGE_HYPERDRIVE_ID.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Helpers ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..", "..");

function readJsonc(relPath: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(ROOT, relPath), "utf-8");
  // Strip single-line // comments (good enough for our wrangler files)
  const stripped = raw.replace(/\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

function readYaml(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

// Valid Cloudflare Hyperdrive ID: 32 hex chars
const HYPERDRIVE_ID_RE = /^[0-9a-f]{32}$/;
const PLACEHOLDER_RE = /PLACEHOLDER/i;

// BF6b: Hyperdrive IDs are never committed. The committed artifact is
// wrangler.template.jsonc carrying @@wiring(...)@@ tokens; wrangler.jsonc is
// rendered by tooling/wire/render.mjs (fixture offline, Secrets Manager live).
const WIRING_TOKEN_RE = /^@@wiring\(cloudflare-hyperdrive\/(stage|prod):hyperdrive_id\)@@$/;

// ── Workers that use Hyperdrive ────────────────────────────────

const HYPERDRIVE_WORKER_TEMPLATES = [
  "apps/api-edge/wrangler.template.jsonc",
  "apps/config-worker/wrangler.template.jsonc",
  "apps/projects-worker/wrangler.template.jsonc",
  "apps/events-worker/wrangler.template.jsonc",
  "apps/membership-worker/wrangler.template.jsonc",
  "apps/identity-worker/wrangler.template.jsonc",
];

// ── config-worker Hyperdrive tests ─────────────────────────────

describe("config-worker wrangler.jsonc Hyperdrive bindings", () => {
  const wrangler = readJsonc("apps/config-worker/wrangler.jsonc") as {
    env: Record<string, { hyperdrive?: Array<{ binding: string; id: string }> }>;
  };

  test("stage PLATFORM_DB is bound to a rendered Hyperdrive ID", () => {
    const hd = wrangler.env.stage?.hyperdrive ?? [];
    const db = hd.find((h) => h.binding === "PLATFORM_DB");
    expect(db).toBeDefined();
    expect(db!.id).toMatch(HYPERDRIVE_ID_RE);
  });

  test("prod PLATFORM_DB is bound to a rendered Hyperdrive ID distinct from stage", () => {
    const stageDb = (wrangler.env.stage?.hyperdrive ?? []).find((h) => h.binding === "PLATFORM_DB");
    const prodDb = (wrangler.env.prod?.hyperdrive ?? []).find((h) => h.binding === "PLATFORM_DB");
    expect(prodDb).toBeDefined();
    expect(prodDb!.id).toMatch(HYPERDRIVE_ID_RE);
    expect(prodDb!.id).not.toBe(stageDb!.id);
  });

  test("committed template carries wiring tokens, not literal IDs", () => {
    const template = readJsonc("apps/config-worker/wrangler.template.jsonc") as {
      env: Record<string, { hyperdrive?: Array<{ binding: string; id: string }> }>;
    };
    for (const envName of ["stage", "prod"]) {
      const hd = template.env[envName]?.hyperdrive ?? [];
      const db = hd.find((h) => h.binding === "PLATFORM_DB");
      expect(db).toBeDefined();
      expect(db!.id).toMatch(WIRING_TOKEN_RE);
      expect(db!.id).not.toMatch(HYPERDRIVE_ID_RE);
    }
  });

  test("no placeholder Hyperdrive IDs in any environment", () => {
    for (const envName of Object.keys(wrangler.env)) {
      const hd = wrangler.env[envName]?.hyperdrive ?? [];
      for (const entry of hd) {
        expect(entry.id).not.toMatch(PLACEHOLDER_RE);
      }
    }
  });

  test("all Hyperdrive IDs are valid 32-hex-char format", () => {
    for (const envName of Object.keys(wrangler.env)) {
      const hd = wrangler.env[envName]?.hyperdrive ?? [];
      for (const entry of hd) {
        expect(entry.id).toMatch(HYPERDRIVE_ID_RE);
      }
    }
  });
});

// ── Cross-worker placeholder scan ──────────────────────────────

describe("no placeholder or committed Hyperdrive IDs in any Worker template", () => {
  for (const templatePath of HYPERDRIVE_WORKER_TEMPLATES) {
    const fullPath = path.join(ROOT, templatePath);
    // BF6b rolls out in batches; skip workers not yet templated.
    if (!fs.existsSync(fullPath)) continue;

    test(`${templatePath} has no PLACEHOLDER or committed 32-hex IDs`, () => {
      // Scan config values only — strip `//` comments so benign prose (e.g. the
      // identity-worker OAuth setup notes that mention "placeholders") doesn't
      // false-positive. The intent is to catch placeholder Hyperdrive *IDs*.
      const stripped = fs.readFileSync(fullPath, "utf-8").replace(/\/\/.*$/gm, "");
      expect(stripped).not.toMatch(PLACEHOLDER_RE);
      // BF6 guard (mirrors the composition's verify-worker-structure step):
      // templates must never carry committed resource IDs.
      expect(stripped).not.toMatch(/"id":\s*"[0-9a-f]{32}"/);
    });
  }
});

// ── api-edge CONFIG_WORKER service bindings ────────────────────

describe("api-edge CONFIG_WORKER service bindings", () => {
  const wrangler = readJsonc("apps/api-edge/wrangler.jsonc") as {
    env: Record<string, { services?: Array<{ binding: string; service: string }> }>;
  };

  test("stage binds CONFIG_WORKER to config-worker-stage", () => {
    const svc = wrangler.env.stage?.services ?? [];
    const cw = svc.find((s) => s.binding === "CONFIG_WORKER");
    expect(cw).toBeDefined();
    expect(cw!.service).toBe("config-worker-stage");
  });

  test("prod binds CONFIG_WORKER to config-worker-prod", () => {
    const svc = wrangler.env.prod?.services ?? [];
    const cw = svc.find((s) => s.binding === "CONFIG_WORKER");
    expect(cw).toBeDefined();
    expect(cw!.service).toBe("config-worker-prod");
  });
});

// ── api-edge component.yaml depends on config-worker ───────────

describe("api-edge component.yaml dependency on config-worker", () => {
  test("dependsOn includes config-worker", () => {
    const yaml = readYaml("apps/api-edge/component.yaml");
    expect(yaml).toContain("component: config-worker");
  });
});
