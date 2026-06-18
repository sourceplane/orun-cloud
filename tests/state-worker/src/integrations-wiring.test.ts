// IG D1 / OV5 live-path wiring guard. The GitHub App write-back path is only as
// live as its config: state-worker must bind INTEGRATIONS_WORKER (so
// run-writeback.ts:185 doesn't go dormant) for stage AND prod, and the deploy
// must provision the App secrets the integrations-worker write-back proxy reads.
// These configs are operational and easy to drop in a refactor; this test fails
// the moment the live path is silently un-wired.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

describe("IG D1 / OV5 write-back wiring", () => {
  const template = read("apps/state-worker/wrangler.template.jsonc");

  it("state-worker binds INTEGRATIONS_WORKER for stage and prod", () => {
    expect(template).toContain('"binding": "INTEGRATIONS_WORKER"');
    expect(template).toContain('"service": "integrations-worker-stage"');
    expect(template).toContain('"service": "integrations-worker-prod"');
  });

  it("the secrets manifest requires the App credentials the write-back proxy reads", () => {
    const manifest = JSON.parse(read("tooling/secrets-sync/secrets.manifest.json")) as {
      workers: Record<string, { required: string[] }>;
    };
    const required = manifest.workers["integrations-worker"]?.required ?? [];
    // mintScoped (integrations-worker/src/writeback.ts) needs these; the webhook
    // verifier needs the secret. Without them the proxy skips, write-back dies.
    for (const secret of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET"]) {
      expect(required).toContain(secret);
    }
  });
});
