// Generates infra/db-migrate/migrations.lock from the migration manifest.
//
// WHY THIS EXISTS: orun's `--changed` planner decides whether to schedule the
// `db-migrate` component (plan on PR, apply on merge) based on changes to the
// component's OWN directory (infra/db-migrate/), NOT its spec.path
// (packages/db/src/migrations). So a PR that only adds a migration under
// packages/db/ never plans db-migrate, and the migration silently never reaches
// the live database (this bit migrations 180/190 and 220/230 historically).
//
// This lock file lives inside infra/db-migrate/ and mirrors the manifest's
// migration ids, so adding a migration changes a file in that directory and the
// planner picks db-migrate up automatically. tests/db/src/migrations.test.ts
// fails if the lock drifts, so it can't be forgotten.
//
// Source of truth is packages/db/src/manifest.ts (the same list the runner
// applies); ids are parsed from it directly so this stays dependency-free.
//
// Regenerate + commit after adding a migration:
//   pnpm --filter @saas/db gen:migrations-lock

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, "../src/manifest.ts");
const lockPath = resolve(here, "../../../infra/db-migrate/migrations.lock");

/** Ordered list of migration ids, parsed from manifest.ts (the runner's source of truth). */
export function migrationIds() {
  const src = readFileSync(manifestPath, "utf8");
  return [...src.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
}

const HEADER = `# AUTO-GENERATED — do not edit by hand.
#
# Mirrors the migration ids in packages/db/src/manifest.ts so that adding a
# migration changes a file inside this component's directory. orun's --changed
# planner keys db-migrate off THIS directory (not packages/db), so without this
# stamp a new migration never schedules the plan/apply and never reaches the
# live database. Regenerate with: pnpm --filter @saas/db gen:migrations-lock
# Enforced by tests/db/src/migrations.test.ts.
`;

export function renderLock() {
  return HEADER + migrationIds().join("\n") + "\n";
}

// Direct invocation: write the file. (Importable for the verify test.)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = renderLock();
  const prev = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "";
  if (prev === next) {
    console.log("migrations.lock already up to date");
  } else {
    writeFileSync(lockPath, next);
    console.log(`wrote ${lockPath} (${migrationIds().length} migrations)`);
  }
}
