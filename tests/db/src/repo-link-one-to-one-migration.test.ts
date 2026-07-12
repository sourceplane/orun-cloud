import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";
import { createStateRepository } from "@saas/db/state";
import { asUuid } from "@saas/db";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("740_repo_link_one_to_one migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "740_repo_link_one_to_one");
  const sql = entry ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8") : "";

  it("exists in manifest with context state, ordered after 640", () => {
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("state");
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("740_repo_link_one_to_one")).toBeGreaterThan(
      ids.indexOf("640_event_lifecycle"),
    );
  });

  it("dedupes existing double-claims FIRST, first claim wins, soft-unlink", () => {
    // The dedupe UPDATE must precede the unique index so the index cannot fail
    // on live data.
    expect(sql.indexOf("UPDATE state.workspace_links")).toBeLessThan(
      sql.indexOf("CREATE UNIQUE INDEX"),
    );
    // Soft-unlink, never DELETE: later claims flip to 'unlinked' like an
    // explicit unlink would.
    expect(sql).toContain("SET status = 'unlinked'");
    expect(sql).toContain("updated_at = now()");
    expect(sql).not.toMatch(/DELETE FROM/);
    // First claim wins: an earlier active sibling (created_at, tiebreak id)
    // demotes the row.
    expect(sql).toContain("first_claim.created_at < wl.created_at");
    expect(sql).toContain("first_claim.created_at = wl.created_at AND first_claim.id < wl.id");
    // Only rows carrying a rename-stable provider identity participate.
    expect(sql).toContain("wl.provider_repo_id IS NOT NULL");
  });

  it("adds the partial unique one-to-one claim index, commented", () => {
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_state_workspace_link_provider_repo",
    );
    expect(sql).toContain("ON state.workspace_links (provider, provider_repo_id)");
    expect(sql).toContain("WHERE status = 'active' AND provider_repo_id IS NOT NULL");
    expect(sql).toContain("COMMENT ON INDEX state.uq_state_workspace_link_provider_repo");
  });

  it("is idempotent, same-context, and drops nothing", () => {
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).not.toMatch(/DROP TABLE/);
    expect(sql).not.toMatch(/DROP COLUMN/);
    expect(sql).not.toMatch(/DROP INDEX/);
    expect(sql).not.toContain("REFERENCES integrations.");
    expect(sql).not.toContain("REFERENCES membership.");
    expect(sql).not.toContain("REFERENCES projects.");
    // Idempotent dedupe: once each group holds a single active row the EXISTS
    // finds no earlier active sibling — re-running matches nothing. The guard
    // that makes that true is filtering on active rows on BOTH sides.
    expect(sql).toContain("wl.status = 'active'");
    expect(sql).toContain("first_claim.status = 'active'");
  });

  it("declares a checksum matching the on-disk up.sql (gen:migrations-lock contract)", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sql));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(entry!.checksum).toBe(hex);
  });
});

// The repo-layer half of the one-to-one rule: the unique index surfaces as a
// distinguishable conflict so the state-worker can map a cross-org claim race
// to its generic 409 without leaking which org holds the claim.
describe("StateRepository.createWorkspaceLink — one-to-one claim conflicts", () => {
  const ORG_ID = asUuid("00000000-0000-4000-8000-000000000001");
  const PROJECT_ID = asUuid("00000000-0000-4000-8000-000000000003");
  const LINK_ID = asUuid("00000000-0000-4000-8000-000000000004");

  function throwingExecutor(error: unknown): SqlExecutor {
    return {
      async execute<T extends SqlRow = SqlRow>(): Promise<SqlExecutorResult<T>> {
        throw error;
      },
    };
  }

  const input = {
    id: LINK_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    remoteUrl: "github.com/acme/storefront",
    provider: {
      provider: "github",
      providerRepoId: "777001",
      providerOwnerId: "42",
      providerOwnerLogin: "acme",
    },
  };

  it("maps a uq_state_workspace_link_provider_repo violation to conflict/provider_repo_claim", async () => {
    const repo = createStateRepository(
      throwingExecutor({ code: "23505", constraint: "uq_state_workspace_link_provider_repo" }),
    );
    const result = await repo.createWorkspaceLink(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "conflict", entity: "provider_repo_claim" });
    }
  });

  it("keeps mapping the (org, remote) idempotency violation to conflict/workspace_link", async () => {
    const repo = createStateRepository(
      throwingExecutor({ code: "23505", constraint: "uq_state_workspace_link_remote" }),
    );
    const result = await repo.createWorkspaceLink(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "conflict", entity: "workspace_link" });
    }
  });
});
