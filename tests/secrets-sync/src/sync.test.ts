import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const toolDir = path.resolve(here, "../../../tooling/secrets-sync");
const syncScript = path.join(toolDir, "sync.mjs");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface SyncFiles {
  bulk: string;
  record: string;
}

function runSync(args: {
  worker: string;
  env: string;
  escrow: unknown;
  record?: unknown;
}): RunResult & SyncFiles {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-sync-"));
  const escrowFile = path.join(dir, "escrow.json");
  const recordFile = path.join(dir, "record.json");
  const bulkFile = path.join(dir, "bulk.json");
  const recordOutFile = path.join(dir, "record.next.json");
  fs.writeFileSync(escrowFile, JSON.stringify(args.escrow));
  fs.writeFileSync(recordFile, JSON.stringify(args.record ?? {}));
  const argv = [
    syncScript,
    "--worker", args.worker,
    "--env", args.env,
    "--escrow", escrowFile,
    "--record", recordFile,
    "--out-bulk", bulkFile,
    "--out-record", recordOutFile,
  ];
  try {
    const stdout = execFileSync("node", argv, { encoding: "utf8" });
    return { status: 0, stdout, stderr: "", bulk: bulkFile, record: recordOutFile };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return {
      status: e.status,
      stdout: String(e.stdout),
      stderr: String(e.stderr),
      bulk: bulkFile,
      record: recordOutFile,
    };
  }
}

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

const billingEscrow = {
  "billing-worker": {
    POLAR_ACCESS_TOKEN: "polar-token-value",
    POLAR_WEBHOOK_SECRET: "polar-webhook-value",
  },
};

describe("secrets-sync sync.mjs (SS2)", () => {
  it("first run pushes everything and writes the fingerprint record", () => {
    const result = runSync({ worker: "billing-worker", env: "stage", escrow: billingEscrow });
    expect(result.status).toBe(0);
    expect(readJson(result.bulk)).toEqual(billingEscrow["billing-worker"]);
    const record = readJson(result.record) as Record<string, Record<string, string>>;
    expect(Object.keys(record["billing-worker"] ?? {}).sort()).toEqual([
      "POLAR_ACCESS_TOKEN",
      "POLAR_WEBHOOK_SECRET",
    ]);
  });

  it("is a no-op when fingerprints match the record", () => {
    const first = runSync({ worker: "billing-worker", env: "stage", escrow: billingEscrow });
    const second = runSync({
      worker: "billing-worker",
      env: "stage",
      escrow: billingEscrow,
      record: readJson(first.record),
    });
    expect(second.status).toBe(0);
    expect(readJson(second.bulk)).toEqual({});
    expect(second.stdout).toContain("in sync — nothing to push");
  });

  it("pushes on any value change", () => {
    const first = runSync({ worker: "billing-worker", env: "stage", escrow: billingEscrow });
    const rotated = {
      "billing-worker": { ...billingEscrow["billing-worker"], POLAR_ACCESS_TOKEN: "rotated" },
    };
    const second = runSync({
      worker: "billing-worker",
      env: "stage",
      escrow: rotated,
      record: readJson(first.record),
    });
    expect(second.status).toBe(0);
    expect(readJson(second.bulk)).toEqual(rotated["billing-worker"]);
    expect(second.stdout).toContain("POLAR_ACCESS_TOKEN");
    expect(second.stdout).toContain("(changed)");
  });

  it("fails closed when the escrow exists but misses a required secret", () => {
    const result = runSync({
      worker: "billing-worker",
      env: "stage",
      escrow: { "billing-worker": { POLAR_ACCESS_TOKEN: "only-one" } },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing POLAR_WEBHOOK_SECRET");
  });

  it("rejects workers not declared in the manifest", () => {
    const result = runSync({ worker: "unknown-worker", env: "stage", escrow: {} });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not declared");
  });

  it("preserves other workers' fingerprint entries in the record", () => {
    const result = runSync({
      worker: "billing-worker",
      env: "stage",
      escrow: billingEscrow,
      record: { "identity-worker": { OAUTH_STATE_SECRET: "deadbeefdeadbeef" } },
    });
    const record = readJson(result.record) as Record<string, Record<string, string>>;
    expect(record["identity-worker"]).toEqual({ OAUTH_STATE_SECRET: "deadbeefdeadbeef" });
    expect(record["billing-worker"]).toBeDefined();
  });

  it("never prints secret values", () => {
    const result = runSync({ worker: "billing-worker", env: "stage", escrow: billingEscrow });
    for (const value of Object.values(billingEscrow["billing-worker"])) {
      expect(result.stdout).not.toContain(value);
      expect(result.stderr).not.toContain(value);
    }
  });
});
