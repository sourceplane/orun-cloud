import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolDir = path.resolve(here, "../../../tooling/secrets-sync");
const checkScript = path.join(toolDir, "check.mjs");
const manifestPath = path.join(toolDir, "secrets.manifest.json");
const fixturePath = path.join(toolDir, "escrow.fixture.json");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCheck(args: string[]): RunResult {
  try {
    const stdout = execFileSync("node", [checkScript, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr) };
  }
}

function tmpJson(value: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ss-")), "payload.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

type Fixture = Record<string, Record<string, Record<string, string>>>;
const loadFixture = (): Fixture =>
  JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;

function workerSecrets(fixture: Fixture, env: string, worker: string): Record<string, string> {
  const secrets = fixture[env]?.[worker];
  if (!secrets) throw new Error(`fixture missing ${env}/${worker}`);
  return secrets;
}

interface Manifest {
  storage: string;
  environments: string[];
  workers: Record<string, { required: string[]; deferred?: { names: string[] } }>;
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;

describe("secrets manifest (SS0/SS6b)", () => {
  it("declares the SS6b storage layout under this repo's Secrets Manager namespace", () => {
    expect(manifest.storage).toBe(
      "sourceplane/orun-cloud/integrations/<name>/<env> + sourceplane/orun-cloud/platform-secrets/<env>",
    );
  });

  it("covers every worker template that documents a `wrangler secret put`", () => {
    const apps = path.resolve(here, "../../../apps");
    // The manifest is a projection that also includes config-only consumers
    // (e.g. notifications-worker) with no secrets; the coverage invariant is
    // over workers that actually carry secrets (required or deferred).
    const withSecrets = Object.entries(
      manifest.workers as Record<string, { required: string[]; deferred?: unknown }>,
    )
      .filter(([, spec]) => spec.required.length > 0 || spec.deferred !== undefined)
      .map(([name]) => name)
      .sort();
    const fromTemplates = fs
      .readdirSync(apps)
      .filter((app) => {
        const template = path.join(apps, app, "wrangler.template.jsonc");
        return (
          fs.existsSync(template) &&
          fs.readFileSync(template, "utf8").includes("secret put")
        );
      })
      .sort();
    expect(withSecrets).toEqual(fromTemplates);
  });

  it("never contains secret-looking values, only names", () => {
    const raw = fs.readFileSync(manifestPath, "utf8");
    expect(raw).not.toMatch(/[A-Za-z0-9+/]{40,}/);
  });
});

describe("secrets-check (SS1)", () => {
  it("passes against the committed fixture", () => {
    const result = runCheck(["--fixture", fixturePath]);
    expect(result.stdout).toContain("in sync");
    expect(result.status).toBe(0);
  });

  it("fails listing a missing required secret", () => {
    const broken = loadFixture();
    delete workerSecrets(broken, "stage", "identity-worker")["OAUTH_STATE_SECRET"];
    const result = runCheck(["--fixture", tmpJson(broken)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stage/identity-worker: missing OAUTH_STATE_SECRET");
  });

  it("fails on unknown secret names (typo detection)", () => {
    const broken = loadFixture();
    workerSecrets(broken, "prod", "billing-worker")["POLAR_ACCESS_TOKEN_TYPO"] = "x";
    const result = runCheck(["--fixture", tmpJson(broken)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown secret POLAR_ACCESS_TOKEN_TYPO");
  });

  it("fails on empty values", () => {
    const broken = loadFixture();
    workerSecrets(broken, "stage", "billing-worker")["POLAR_ACCESS_TOKEN"] = "";
    const result = runCheck(["--fixture", tmpJson(broken)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("POLAR_ACCESS_TOKEN is empty");
  });

  it("treats deferred secrets as required only under --strict", () => {
    const relaxed = runCheck(["--fixture", fixturePath]);
    expect(relaxed.status).toBe(0);
    const strict = runCheck(["--fixture", fixturePath, "--strict"]);
    expect(strict.status).toBe(1);
    // state-worker is the remaining deferred consumer (STATE_ENCRYPTION_KEY),
    // so the escrow fixture omits it and --strict surfaces it as missing.
    expect(strict.stderr).toContain("state-worker: missing STATE_ENCRYPTION_KEY");
  });

  it("never prints secret values, only fingerprints", () => {
    const result = runCheck(["--fixture", fixturePath]);
    const fixture = loadFixture();
    const fixtureValues = manifest.environments
      .flatMap((env) => Object.values(fixture[env] ?? {}))
      .flatMap((worker) => Object.values(worker));
    for (const value of fixtureValues) {
      expect(result.stdout).not.toContain(value);
    }
    expect(result.stdout).toMatch(/sha256:[0-9a-f]{16}/);
  });

  it("validates deployed secret-name listings (wrangler secret list shape)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-deployed-"));
    for (const env of manifest.environments) {
      for (const [worker, spec] of Object.entries(manifest.workers)) {
        if (spec.required.length === 0) continue;
        fs.writeFileSync(
          path.join(dir, `${worker}__${env}.json`),
          JSON.stringify(spec.required.map((name) => ({ name }))),
        );
      }
    }
    expect(runCheck(["--deployed-dir", dir]).status).toBe(0);

    fs.writeFileSync(
      path.join(dir, "identity-worker__prod.json"),
      JSON.stringify([{ name: "GITHUB_OAUTH_CLIENT_SECRET" }]),
    );
    const result = runCheck(["--deployed-dir", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prod/identity-worker: OAUTH_STATE_SECRET not deployed");
  });
});
