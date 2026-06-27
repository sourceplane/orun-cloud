/**
 * Promotion-tier ranking for environments.
 *
 * Orun environments form a promotion DAG (e.g. dev → stage → prod, declared via
 * `promotion.dependsOn` in a project's intent.yaml). The console's environment
 * projection has no per-env rank column, so we approximate the "highest" (most
 * production-like) environment by name. Used to pick the Activities surface's
 * default environment when the operator hasn't chosen one — the most important
 * environment's activity is the most useful thing to land on.
 *
 * Dependency-free and pure so it is trivially unit-testable.
 */

// Most-specific patterns first; the first match wins. Exact-name matches outrank
// substring matches so `prod` beats a `nonprod` that merely contains "prod".
const TIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(prod|production|prd|live)$/i, 100],
  [/^(stage|staging|stg|preprod|pre-?prod|preproduction)$/i, 80],
  [/^(uat|qa|test|sit)$/i, 60],
  [/^(preview|pr|ephemeral)$/i, 40],
  [/^(dev|develop|development|int|integration)$/i, 20],
  [/^(local|sandbox|sbx)$/i, 10],
  [/(prod|production)/i, 90],
  [/(stage|staging|preprod)/i, 70],
  [/(uat|qa)/i, 55],
  [/(preview)/i, 35],
  [/(dev)/i, 15],
];

/** Rank an environment slug by promotion tier; higher = more production-like. */
export function rankEnvironment(slug: string): number {
  for (const [re, rank] of TIERS) if (re.test(slug)) return rank;
  // An unrecognized custom environment ranks above dev-tier but below qa-tier,
  // so a bespoke name is still a reasonable default over an explicit "dev".
  return 50;
}

/**
 * Pick the highest-tier (most production-like) environment from a set, or null
 * when the set is empty. Ties resolve to the first one seen.
 */
export function defaultEnvironment(envs: readonly string[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const e of envs) {
    if (!e) continue;
    const r = rankEnvironment(e);
    if (r > bestRank) {
      bestRank = r;
      best = e;
    }
  }
  return best;
}
