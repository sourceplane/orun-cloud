import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolDir = path.resolve(here, "../../../tooling/secrets-sync");
const assembleScript = path.join(toolDir, "assemble.mjs");
const integrationsManifestPath = path.join(toolDir, "integrations.manifest.json");
const integrationsFixturePath = path.join(toolDir, "integrations.fixture.json");
const secretsManifestPath = path.join(toolDir, "secrets.manifest.json");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): RunResult {
  try {
    return { status: 0, stdout: execFileSync("node", [assembleScript, ...args], { encoding: "utf8" }), stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr) };
  }
}

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

function w(map: Record<string, Record<string, string>>, name: string): Record<string, string> {
  const entry = map[name];
  if (!entry) throw new Error(`expected worker ${name} in projection`);
  return entry;
}

interface IntegrationSpec {
  config: string[];
  secret: string[];
  consumers: string[];
  deferred?: boolean;
}
interface IntegrationsManifest {
  environments: string[];
  deferredConsumers: string[];
  integrations: Record<string, IntegrationSpec>;
  platform: { secret: Record<string, string[]> };
}
const im = readJson(integrationsManifestPath) as unknown as IntegrationsManifest;

function tmpFile(value: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "as-")), "f.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function assembleStage(fixture: string): { secrets: Record<string, Record<string, string>>; config: Record<string, Record<string, string>>; result: RunResult } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-out-"));
  const outS = path.join(dir, "s.json");
  const outC = path.join(dir, "c.json");
  const result = run(["--env", "stage", "--fixture", fixture, "--out-secrets", outS, "--out-config", outC]);
  return {
    secrets: result.status === 0 ? (readJson(outS) as Record<string, Record<string, string>>) : {},
    config: result.status === 0 ? (readJson(outC) as Record<string, Record<string, string>>) : {},
    result,
  };
}

describe("integrations manifest projection (SS6)", () => {
  it("the committed secrets.manifest.json equals the projection of integrations.manifest.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-proj-"));
    const out = path.join(dir, "projected.json");
    expect(run(["--project-manifest", "--out", out]).status).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe(fs.readFileSync(secretsManifestPath, "utf8"));
  });

  it("the fixture covers every config and secret key the manifest declares (stage + prod)", () => {
    const fixture = readJson(integrationsFixturePath) as Record<string, Record<string, Record<string, string>>>;
    const deferred = new Set(im.deferredConsumers);
    for (const env of im.environments) {
      for (const [name, spec] of Object.entries(im.integrations)) {
        // Fully-deferred integrations (all consumers deferred) are not seeded
        // yet, so the fixture legitimately omits their documents.
        if (spec.consumers.every((c) => deferred.has(c))) continue;
        const doc = fixture[env]?.[name] ?? {};
        for (const key of [...spec.config, ...spec.secret]) {
          expect(typeof doc[key]).toBe("string");
        }
      }
      const platform = fixture[env]?.["platform"] ?? {};
      for (const key of Object.keys(im.platform.secret)) {
        expect(typeof platform[key]).toBe("string");
      }
    }
  });
});

describe("--list-docs (SS6b deploy-lane fetch list)", () => {
  function listDocs(env: string): { lines: [string, string][]; result: RunResult } {
    const result = run(["--list-docs", "--env", env]);
    const lines = result.stdout
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        const [name, id] = l.split("\t");
        if (!name || !id) throw new Error(`malformed line: ${JSON.stringify(l)}`);
        return [name, id] as [string, string];
      });
    return { lines, result };
  }

  it("emits one tab-separated <name>\\t<secret-id> line per active doc for stage", () => {
    const { lines, result } = listDocs("stage");
    expect(result.status).toBe(0);
    const map = new Map(lines);
    expect(map.get("github-oauth")).toBe(
      "sourceplane/orun-cloud/integrations/github-oauth/stage",
    );
    expect(map.get("google-oauth")).toBe(
      "sourceplane/orun-cloud/integrations/google-oauth/stage",
    );
    expect(map.get("polar")).toBe("sourceplane/orun-cloud/integrations/polar/stage");
    expect(map.get("cloudflare-email")).toBe(
      "sourceplane/orun-cloud/integrations/cloudflare-email/stage",
    );
    expect(map.get("platform")).toBe("sourceplane/orun-cloud/platform-secrets/stage");
  });

  it("includes the now-active github-app integration doc (integrations-worker activated)", () => {
    const { lines } = listDocs("stage");
    const map = new Map(lines);
    expect(map.get("github-app")).toBe(
      "sourceplane/orun-cloud/integrations/github-app/stage",
    );
  });

  it("includes the IH9-lifted slack-app and supabase-oauth integration docs", () => {
    const { lines } = listDocs("stage");
    const map = new Map(lines);
    expect(map.get("slack-app")).toBe(
      "sourceplane/orun-cloud/integrations/slack-app/stage",
    );
    expect(map.get("supabase-oauth")).toBe(
      "sourceplane/orun-cloud/integrations/supabase-oauth/stage",
    );
  });

  it("works for prod as well, swapping only the env segment", () => {
    const { lines: stage } = listDocs("stage");
    const { lines: prod } = listDocs("prod");
    const stageNames = stage.map(([n]) => n).sort();
    const prodNames = prod.map(([n]) => n).sort();
    expect(prodNames).toEqual(stageNames);
    for (const [, id] of prod) expect(id.endsWith("/prod")).toBe(true);
    for (const [, id] of stage) expect(id.endsWith("/stage")).toBe(true);
  });

  it("rejects an undeclared environment with a usage error", () => {
    const { result } = listDocs("does-not-exist");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not declared in the manifest");
  });
});

describe("assemble projection from documents (SS6)", () => {
  it("projects per-worker secrets matching the sync.mjs input contract", () => {
    const { secrets } = assembleStage(integrationsFixturePath);
    expect(Object.keys(w(secrets,"identity-worker")).sort()).toEqual([
      "CLI_JWT_SIGNING_KEY",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "OAUTH_STATE_SECRET",
    ]);
    expect(Object.keys(w(secrets,"billing-worker")).sort()).toEqual([
      "POLAR_ACCESS_TOKEN",
      "POLAR_WEBHOOK_SECRET",
    ]);
    // SECRET_ENCRYPTION_KEY fans out from the single platform doc to both workers.
    expect(w(secrets,"webhooks-worker")["SECRET_ENCRYPTION_KEY"]).toBeDefined();
    expect(w(secrets,"config-worker")["SECRET_ENCRYPTION_KEY"]).toBeDefined();
  });

  it("projects per-worker config and keeps it disjoint from secrets", () => {
    const { secrets, config } = assembleStage(integrationsFixturePath);
    expect(w(config,"identity-worker")["GITHUB_OAUTH_CLIENT_ID"]).toBeDefined();
    expect(w(config,"billing-worker")["POLAR_PRODUCT_MAP"]).toBeDefined();
    expect(w(config,"notifications-worker")["EMAIL_FROM_ADDRESS"]).toBeDefined();
    // No secret name leaks into config, no config name into secrets.
    const allSecretNames = new Set<string>();
    for (const spec of Object.values(im.integrations)) for (const s of spec.secret) allSecretNames.add(s);
    for (const s of Object.keys(im.platform.secret)) allSecretNames.add(s);
    for (const worker of Object.values(config)) {
      for (const key of Object.keys(worker)) expect(allSecretNames.has(key)).toBe(false);
    }
    const allConfigNames = new Set<string>();
    for (const spec of Object.values(im.integrations)) for (const c of spec.config) allConfigNames.add(c);
    for (const worker of Object.values(secrets)) {
      for (const key of Object.keys(worker)) expect(allConfigNames.has(key)).toBe(false);
    }
  });

  it("excludes deferred consumers entirely (state-worker has no projected secrets)", () => {
    const { secrets, config } = assembleStage(integrationsFixturePath);
    expect(secrets["state-worker"]).toBeUndefined();
    expect(config["state-worker"]).toBeUndefined();
  });

  it("projects the now-active integrations-worker GitHub App secrets", () => {
    const { secrets, config } = assembleStage(integrationsFixturePath);
    // All GitHub App keys (incl. the non-sensitive ID/SLUG/CLIENT_ID) are
    // classified as secrets so the secrets-live pipeline delivers them; the
    // worker therefore has no separate config projection.
    expect(Object.keys(w(secrets, "integrations-worker")).sort()).toEqual([
      "CLOUDFLARE_OAUTH_CLIENT_ID",
      "CLOUDFLARE_OAUTH_CLIENT_SECRET",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_CLIENT_SECRET",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_WEBHOOK_SECRET",
      "INTEGRATIONS_STATE_SECRET",
      "SECRET_ENCRYPTION_KEY",
      "SLACK_APP_CLIENT_ID",
      "SLACK_APP_CLIENT_SECRET",
      "SLACK_APP_SIGNING_SECRET",
      "SUPABASE_OAUTH_CLIENT_ID",
      "SUPABASE_OAUTH_CLIENT_SECRET",
    ]);
    expect(config["integrations-worker"]).toBeUndefined();
  });

  it("projects the IH9-lifted Slack App and Supabase OAuth credentials from their own docs", () => {
    const { secrets } = assembleStage(integrationsFixturePath);
    const worker = w(secrets, "integrations-worker");
    // slack-app doc → integrations-worker (IH1 connect + IH3 signature verify).
    expect(worker["SLACK_APP_CLIENT_ID"]).toBe("fixture-slack-app-client-id-stage");
    expect(worker["SLACK_APP_CLIENT_SECRET"]).toBe("fixture-slack-app-client-secret-stage");
    expect(worker["SLACK_APP_SIGNING_SECRET"]).toBe("fixture-slack-app-signing-stage");
    // supabase-oauth doc → integrations-worker (IH6 connect + refresh).
    expect(worker["SUPABASE_OAUTH_CLIENT_ID"]).toBe("fixture-supabase-oauth-client-id-stage");
    expect(worker["SUPABASE_OAUTH_CLIENT_SECRET"]).toBe(
      "fixture-supabase-oauth-client-secret-stage",
    );
  });

  it.each(["slack-app", "supabase-oauth"])(
    "fails closed when the now-active %s document is absent (app registered → required)",
    (doc) => {
      // Both provider apps are registered and their secrets are required, so a
      // missing document must hard fail rather than silently deploy
      // integrations-worker without the credentials.
      const fixture = readJson(integrationsFixturePath) as Record<string, Record<string, unknown>>;
      const stage = fixture["stage"];
      if (!stage) throw new Error("fixture missing stage");
      delete stage[doc];
      const { result } = assembleStage(tmpFile(fixture));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${doc}.json not fetched`);
    },
  );

  it("still tolerates an absent doc marked deferred in the manifest (per-integration deferral mechanism)", () => {
    // No live doc is deferred anymore (both provider apps are activated), but
    // the mechanism must keep working for the next dormant provider: a doc with
    // `"deferred": true` whose escrow document is absent is skipped, not a
    // violation. Proven against a synthetic manifest + fixture.
    const manifest = JSON.parse(JSON.stringify(im)) as IntegrationsManifest;
    manifest.integrations["supabase-oauth"]!.deferred = true; // assemble.mjs checks === true
    const manifestFile = tmpFile(manifest);

    const fixture = readJson(integrationsFixturePath) as Record<string, Record<string, unknown>>;
    delete fixture["stage"]!["supabase-oauth"]; // deferred + absent → tolerated
    const fixtureFile = tmpFile(fixture);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "as-def-"));
    const result = run([
      "--env", "stage", "--manifest", manifestFile, "--fixture", fixtureFile,
      "--out-secrets", path.join(dir, "s.json"), "--out-config", path.join(dir, "c.json"),
    ]);
    expect(result.status).toBe(0);
    const secrets = readJson(path.join(dir, "s.json")) as Record<string, Record<string, string>>;
    expect(secrets["integrations-worker"]?.["GITHUB_APP_ID"]).toBeDefined();
    expect(secrets["integrations-worker"]?.["SUPABASE_OAUTH_CLIENT_ID"]).toBeUndefined();
  });

  it("fails closed when an integration document is absent", () => {
    const fixture = readJson(integrationsFixturePath) as Record<string, Record<string, unknown>>;
    const stage = fixture["stage"];
    if (!stage) throw new Error("fixture missing stage");
    delete stage["polar"];
    const { result } = assembleStage(tmpFile(fixture));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("polar.json not fetched");
  });

  it("fails closed when a required key is empty", () => {
    const fixture = readJson(integrationsFixturePath) as Record<string, Record<string, Record<string, string>>>;
    const stage = fixture["stage"];
    if (!stage?.["platform"]) throw new Error("fixture missing stage/platform");
    stage["platform"]["SECRET_ENCRYPTION_KEY"] = "";
    const { result } = assembleStage(tmpFile(fixture));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("platform: secret SECRET_ENCRYPTION_KEY missing or empty");
  });

  it("never prints secret values (config values are allowed)", () => {
    const { result } = assembleStage(integrationsFixturePath);
    const fixture = readJson(integrationsFixturePath) as Record<string, Record<string, Record<string, string>>>;
    const secretValues: string[] = [];
    for (const [name, spec] of Object.entries(im.integrations)) {
      for (const key of spec.secret) {
        const v = fixture["stage"]?.[name]?.[key];
        if (v) secretValues.push(v);
      }
    }
    for (const key of Object.keys(im.platform.secret)) {
      const v = fixture["stage"]?.["platform"]?.[key];
      if (v) secretValues.push(v);
    }
    for (const value of secretValues) expect(result.stdout).not.toContain(value);
  });
});
