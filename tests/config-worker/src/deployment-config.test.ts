/**
 * Deployment-config regression tests for config-worker and api-edge.
 *
 * BF6/BF6b: resource IDs are never committed. The committed artifact per
 * worker is wrangler.template.jsonc carrying @@wiring(...)@@ tokens; the
 * deployable wrangler.jsonc is rendered by tooling/wire/render.mjs (from
 * wiring.fixture.json offline, from the Secrets Manager manifest live).
 * These tests assert on the committed templates and on an offline fixture
 * render they perform themselves, so they are hermetic on a fresh checkout.
 *
 * Task 0057 — introduced after main CI run 26568163207 failed because
 * config-worker stage used PLACEHOLDER_STAGE_HYPERDRIVE_ID.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Helpers ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..", "..");

function parseJsonc(raw: string): Record<string, unknown> {
  // Strip single-line // comments (good enough for our wrangler files)
  const stripped = raw.replace(/\/\/.*$/gm, "");
  return JSON.parse(stripped);
}

function readJsonc(relPath: string): Record<string, unknown> {
  return parseJsonc(fs.readFileSync(path.join(ROOT, relPath), "utf-8"));
}

function readYaml(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), "utf-8");
}

/**
 * Offline fixture render of a worker's committed template, exactly as the
 * composition's wire-fixture step does it (same script, same fixture).
 */
function renderFromFixture(appDir: string): Record<string, unknown> {
  const outFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "wire-render-")),
    "wrangler.jsonc",
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "tooling", "wire", "render.mjs"),
      "--template",
      path.join(ROOT, appDir, "wrangler.template.jsonc"),
      "--out",
      outFile,
      "--map",
      path.join(ROOT, appDir, "wiring.fixture.json"),
    ],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`wire render failed for ${appDir}: ${result.stderr}`);
  }
  return parseJsonc(fs.readFileSync(outFile, "utf-8"));
}

// Valid Cloudflare Hyperdrive ID: 32 hex chars
const HYPERDRIVE_ID_RE = /^[0-9a-f]{32}$/;
const PLACEHOLDER_RE = /PLACEHOLDER/i;
const WIRING_TOKEN_RE = /^@@wiring\(cloudflare-hyperdrive\/(stage|prod):hyperdrive_id\)@@$/;

// ── Workers that use Hyperdrive ────────────────────────────────

const HYPERDRIVE_WORKER_TEMPLATES = [
  "apps/api-edge/wrangler.template.jsonc",
  "apps/admin-worker/wrangler.template.jsonc",
  "apps/billing-worker/wrangler.template.jsonc",
  "apps/config-worker/wrangler.template.jsonc",
  "apps/events-worker/wrangler.template.jsonc",
  "apps/identity-worker/wrangler.template.jsonc",
  "apps/integrations-worker/wrangler.template.jsonc",
  "apps/membership-worker/wrangler.template.jsonc",
  "apps/metering-worker/wrangler.template.jsonc",
  "apps/notifications-worker/wrangler.template.jsonc",
  "apps/projects-worker/wrangler.template.jsonc",
  "apps/webhooks-worker/wrangler.template.jsonc",
];

// ── config-worker Hyperdrive wiring ────────────────────────────

describe("config-worker Hyperdrive wiring", () => {
  type WranglerEnvs = {
    env: Record<string, { hyperdrive?: Array<{ binding: string; id: string }> }>;
  };

  const template = readJsonc("apps/config-worker/wrangler.template.jsonc") as WranglerEnvs;
  const rendered = renderFromFixture("apps/config-worker") as unknown as WranglerEnvs;

  test("committed template carries wiring tokens, not literal IDs", () => {
    for (const envName of ["stage", "prod"]) {
      const hd = template.env[envName]?.hyperdrive ?? [];
      const db = hd.find((h) => h.binding === "PLATFORM_DB");
      expect(db).toBeDefined();
      expect(db!.id).toMatch(WIRING_TOKEN_RE);
      expect(db!.id).not.toMatch(HYPERDRIVE_ID_RE);
    }
  });

  test("fixture render binds stage PLATFORM_DB to a valid Hyperdrive ID", () => {
    const hd = rendered.env.stage?.hyperdrive ?? [];
    const db = hd.find((h) => h.binding === "PLATFORM_DB");
    expect(db).toBeDefined();
    expect(db!.id).toMatch(HYPERDRIVE_ID_RE);
  });

  test("fixture render binds prod PLATFORM_DB to a valid ID distinct from stage", () => {
    const stageDb = (rendered.env.stage?.hyperdrive ?? []).find((h) => h.binding === "PLATFORM_DB");
    const prodDb = (rendered.env.prod?.hyperdrive ?? []).find((h) => h.binding === "PLATFORM_DB");
    expect(prodDb).toBeDefined();
    expect(prodDb!.id).toMatch(HYPERDRIVE_ID_RE);
    expect(prodDb!.id).not.toBe(stageDb!.id);
  });

  test("no placeholder Hyperdrive IDs in any rendered environment", () => {
    for (const envName of Object.keys(rendered.env)) {
      const hd = rendered.env[envName]?.hyperdrive ?? [];
      for (const entry of hd) {
        expect(entry.id).not.toMatch(PLACEHOLDER_RE);
      }
    }
  });

  test("all rendered Hyperdrive IDs are valid 32-hex-char format", () => {
    for (const envName of Object.keys(rendered.env)) {
      const hd = rendered.env[envName]?.hyperdrive ?? [];
      for (const entry of hd) {
        expect(entry.id).toMatch(HYPERDRIVE_ID_RE);
      }
    }
  });
});

// ── Cross-worker template scan ─────────────────────────────────

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
  const rendered = renderFromFixture("apps/api-edge") as unknown as {
    env: Record<string, { services?: Array<{ binding: string; service: string }> }>;
  };

  test("stage binds CONFIG_WORKER to config-worker-stage", () => {
    const svc = rendered.env.stage?.services ?? [];
    const cw = svc.find((s) => s.binding === "CONFIG_WORKER");
    expect(cw).toBeDefined();
    expect(cw!.service).toBe("config-worker-stage");
  });

  test("prod binds CONFIG_WORKER to config-worker-prod", () => {
    const svc = rendered.env.prod?.services ?? [];
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
