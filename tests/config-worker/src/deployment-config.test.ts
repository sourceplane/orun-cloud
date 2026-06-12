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

// Known verified Hyperdrive IDs
const STAGE_HYPERDRIVE_ID = "08f7c6055f544a3890a585d88fd92348";
const PROD_HYPERDRIVE_ID = "ab2c21c2db6245a59c91588fcac7107a";

// ── Workers that use Hyperdrive ────────────────────────────────

const HYPERDRIVE_WORKERS = [
  "apps/api-edge/wrangler.jsonc",
  "apps/config-worker/wrangler.jsonc",
  "apps/projects-worker/wrangler.jsonc",
  "apps/events-worker/wrangler.jsonc",
  "apps/membership-worker/wrangler.jsonc",
  "apps/identity-worker/wrangler.jsonc",
];

// ── config-worker Hyperdrive tests ─────────────────────────────

describe("config-worker wrangler.jsonc Hyperdrive bindings", () => {
  const wrangler = readJsonc("apps/config-worker/wrangler.jsonc") as {
    env: Record<string, { hyperdrive?: Array<{ binding: string; id: string }> }>;
  };

  test("stage PLATFORM_DB is the verified stage Hyperdrive ID", () => {
    const hd = wrangler.env.stage?.hyperdrive ?? [];
    const db = hd.find((h) => h.binding === "PLATFORM_DB");
    expect(db).toBeDefined();
    expect(db!.id).toBe(STAGE_HYPERDRIVE_ID);
  });

  test("prod PLATFORM_DB is the verified prod Hyperdrive ID", () => {
    const hd = wrangler.env.prod?.hyperdrive ?? [];
    const db = hd.find((h) => h.binding === "PLATFORM_DB");
    expect(db).toBeDefined();
    expect(db!.id).toBe(PROD_HYPERDRIVE_ID);
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

describe("no placeholder Hyperdrive IDs in any Worker config", () => {
  for (const wranglerPath of HYPERDRIVE_WORKERS) {
    const fullPath = path.join(ROOT, wranglerPath);
    if (!fs.existsSync(fullPath)) continue;

    test(`${wranglerPath} has no PLACEHOLDER IDs`, () => {
      // Scan config values only — strip `//` comments so benign prose (e.g. the
      // identity-worker OAuth setup notes that mention "placeholders") doesn't
      // false-positive. The intent is to catch placeholder Hyperdrive *IDs*.
      const stripped = fs.readFileSync(fullPath, "utf-8").replace(/\/\/.*$/gm, "");
      expect(stripped).not.toMatch(PLACEHOLDER_RE);
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
