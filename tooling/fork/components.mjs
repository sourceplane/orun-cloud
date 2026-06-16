#!/usr/bin/env node
// Per-component fork helper (zero-dependency).
//
// Builds the *complete* component prerequisite graph — declared `dependsOn`
// edges, wrangler service bindings (deploy-time prerequisites Cloudflare
// enforces), deploy-time wiring inputs (`wiringComponents`), workspace
// package dependencies, and the tests-follow-their-subject convention — and
// uses it to make copying the baseline into a fork a few components at a
// time safe and ordered. Binding cycles (billing <-> membership;
// membership -> notifications -> events -> membership) are grouped into
// atomic batches via strongly-connected components.
//
// Modes (run from a repo root):
//   --order              print the copy order as numbered batches
//   --check              verify every dependency of every component present
//                        in *this* tree is also present (closure check);
//                        non-zero exit + precise "copy X first" report
//   --copy a,b --from D  copy components a,b (+ their tests) from baseline
//                        checkout D into this tree, resync pnpm-lock.yaml
//                        (`pnpm install --lockfile-only`), then --check
//
// The lockfile rule this encodes: worker CI installs with
// `pnpm install --frozen-lockfile`, and pnpm requires the lockfile's
// importer set to exactly match the workspace packages on disk — so every
// batch that adds/removes components must resync the lockfile. The
// `--lockfile-only` resync keeps all dependency resolutions pinned as in
// the baseline; only the importer set changes.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const DISCOVERY_ROOTS = ["apps", "infra", "packages", "tests"];

function flag(name) {
  return process.argv.includes(`--${name}`);
}
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ── Graph construction ─────────────────────────────────────────

function* componentYamls(root) {
  for (const dr of DISCOVERY_ROOTS) {
    const base = path.join(root, dr);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop();
      const cy = path.join(dir, "component.yaml");
      if (fs.existsSync(cy)) {
        yield cy;
        continue; // components do not nest
      }
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== "node_modules") stack.push(path.join(dir, e.name));
      }
    }
  }
}

/** name -> { name, dir, type, edges:Set<string> } for a checkout. */
function buildGraph(root) {
  const components = new Map();
  const pkgNameToComponent = new Map(); // @saas/x -> component name
  const dirToComponent = new Map(); // apps/x -> component name

  for (const cy of componentYamls(root)) {
    const dir = path.relative(root, path.dirname(cy));
    const src = fs.readFileSync(cy, "utf8");
    const name = /metadata:\s*\n\s+name: ([a-z0-9-]+)/.exec(src)?.[1];
    const type = /\n\s+type: ([a-z-]+)/.exec(src)?.[1] ?? "unknown";
    if (!name) continue;
    const edges = new Set();
    // Declared DAG edges.
    for (const m of src.matchAll(/component: ([a-z0-9-]+)/g)) edges.add(m[1]);
    // Deploy-time wiring inputs (the BF5 manifest publishers).
    const wiring = /wiringComponents: "([a-z0-9,-]+)"/.exec(src)?.[1];
    if (wiring) for (const w of wiring.split(",")) edges.add(w.trim());
    components.set(name, { name, dir, type, edges });
    dirToComponent.set(dir, name);
    const pj = path.join(root, dir, "package.json");
    if (fs.existsSync(pj)) {
      const pkgName = JSON.parse(fs.readFileSync(pj, "utf8")).name;
      if (pkgName) pkgNameToComponent.set(pkgName, name);
    }
  }

  for (const c of components.values()) {
    // Wrangler service bindings: deploy-time prerequisites.
    for (const wf of ["wrangler.template.jsonc", "wrangler.jsonc"]) {
      const p = path.join(root, c.dir, wf);
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      for (const m of raw.matchAll(/"service":\s*"([a-z0-9-]+?)-(?:dev|stage|prod)"/g)) {
        if (components.has(m[1])) c.edges.add(m[1]);
      }
      break;
    }
    // Workspace package deps + jest path mappings into other components.
    const pj = path.join(root, c.dir, "package.json");
    if (fs.existsSync(pj)) {
      const raw = fs.readFileSync(pj, "utf8");
      const parsed = JSON.parse(raw);
      for (const deps of [parsed.dependencies, parsed.devDependencies]) {
        for (const dep of Object.keys(deps ?? {})) {
          const target = pkgNameToComponent.get(dep);
          if (target && target !== c.name) c.edges.add(target);
        }
      }
      for (const m of raw.matchAll(/\.\.\/\.\.\/((?:apps|packages)\/[a-z0-9-]+)\//g)) {
        const target = dirToComponent.get(m[1]);
        if (target && target !== c.name) c.edges.add(target);
      }
    }
    // Tests follow their subject (tests/x -> the component living at apps/x
    // or packages/x).
    if (c.dir.startsWith("tests/")) {
      const subject = c.dir.slice("tests/".length);
      for (const where of [`apps/${subject}`, `packages/${subject}`]) {
        const target = dirToComponent.get(where);
        if (target) c.edges.add(target);
      }
    }
    // Drop edges to things that are not components (e.g. tooling packages).
    for (const e of [...c.edges]) if (!components.has(e)) c.edges.delete(e);
  }
  return components;
}

// ── SCC condensation + topological batches ─────────────────────

function sccBatches(components) {
  // Tarjan over the dependency graph (edge a->b means "a needs b").
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  function strongconnect(v) {
    idx.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of components.get(v).edges) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc.sort());
    }
  }
  for (const v of components.keys()) if (!idx.has(v)) strongconnect(v);

  // Tarjan emits SCCs in reverse topological order of the condensation for
  // edge direction "needs" — i.e. dependencies first. That is the copy order.
  return sccs;
}

// ── Modes ──────────────────────────────────────────────────────

if (flag("order")) {
  const components = buildGraph(ROOT);
  const batches = sccBatches(components);
  // Tests ride with their subject ("tests follow their subject"); fold each
  // tests/<x> component into the batch that carries <x>.
  const testsOf = new Map();
  for (const c of components.values()) {
    if (!c.dir.startsWith("tests/")) continue;
    const subject = [...c.edges].find((e) => {
      const d = components.get(e)?.dir;
      return d === `apps/${c.dir.slice(6)}` || d === `packages/${c.dir.slice(6)}`;
    });
    if (subject) testsOf.set(subject, c.name);
  }
  const folded = new Set(testsOf.values());
  // The foundation packages ship as one batch: they are cheap (verify-only,
  // no cloud), and the test suites' cross-package dependencies (e.g.
  // tests/contracts -> @saas/testing) make finer slicing not worth it.
  const pkgComponents = [...components.values()]
    .filter((c) => c.dir.startsWith("packages/"))
    .map((c) => c.name)
    .sort();
  console.log(
    `  1. ${pkgComponents.join(" + ")} (+ all their tests) [turbo-package]  (foundation — copy as one batch)`,
  );
  let n = 1;
  for (const scc of batches) {
    const members = scc.filter(
      (s) => !folded.has(s) && !components.get(s).dir.startsWith("packages/"),
    );
    if (members.length === 0) continue;
    n++;
    const label = members
      .map((s) => {
        const t = testsOf.get(s);
        return `${s}${t ? ` (+ ${t})` : ""} [${components.get(s).type}]`;
      })
      .join(" + ");
    const cycle = scc.length > 1 ? "  (binding cycle — copy & deploy together)" : "";
    console.log(`${String(n).padStart(3)}. ${label}${cycle}`);
  }
  process.exit(0);
}

if (flag("check")) {
  const components = buildGraph(ROOT);
  // In a partial tree the graph builder only sees present components, so
  // re-derive raw edge targets from a full edge pass against missing names:
  const problems = checkClosureAgainstRaw(ROOT, components);
  if (problems.length) {
    console.error(`fork --check: ${problems.length} unmet prerequisite(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`fork --check: ${components.size} component(s) present, dependency closure satisfied.`);
  process.exit(0);
}

const copyList = arg("copy");
const fromDir = arg("from");
if (copyList && fromDir) {
  const baseline = buildGraph(fromDir);
  const requested = copyList.split(",").map((s) => s.trim());
  for (const r of requested) {
    if (!baseline.has(r)) {
      console.error(`fork --copy: "${r}" is not a component in ${fromDir}`);
      process.exit(2);
    }
  }
  // Copy the component dirs plus their tests. Tests ride strictly with
  // their *subject* (tests/<x> ships with apps/<x> or packages/<x>) — never
  // by dependency edge, or copying `contracts` would drag in every suite
  // that merely imports it. The directory-name rule also covers the plain
  // workspace test packages that carry no component.yaml
  // (tests/events-worker, tests/webhooks-worker).
  const dirsToCopy = new Set();
  for (const r of requested) {
    const dir = baseline.get(r).dir;
    dirsToCopy.add(dir);
    const subject = /^(?:apps|packages)\/([a-z0-9-]+)$/.exec(dir)?.[1];
    if (subject && fs.existsSync(path.join(fromDir, "tests", subject))) {
      dirsToCopy.add(`tests/${subject}`);
    }
  }
  const SKIP = /(^|\/)(node_modules|dist|coverage|\.turbo|\.wrangler|\.open-next|\.next)(\/|$)/;
  for (const dir of dirsToCopy) {
    const src = path.join(fromDir, dir);
    const dst = path.join(ROOT, dir);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, {
      recursive: true,
      filter: (s) => !SKIP.test(path.relative(fromDir, s)),
    });
    console.log(`copied ${dir}`);
  }
  // Resync the shared lockfile to the new importer set, resolutions pinned.
  console.log("resyncing pnpm-lock.yaml (pnpm install --lockfile-only)…");
  try {
    execSync("pnpm install --lockfile-only", { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error(
      "fork --copy: lockfile resync failed — usually a copied package depends on a workspace package that is not present yet. Copy the missing component (see message above) and rerun.",
    );
    process.exit(1);
  }
  const problems = checkClosureAgainstRaw(ROOT, buildGraph(ROOT));
  if (problems.length) {
    console.error(`fork --copy: done, but ${problems.length} prerequisite(s) still unmet:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("fork --copy: done; dependency closure satisfied.");
  process.exit(0);
}

console.error(
  "usage: components.mjs --order | --check | --copy <a,b,...> --from <baseline-checkout>",
);
process.exit(2);

// ── helpers (hoisted) ──────────────────────────────────────────

/**
 * Closure check that also surfaces edges whose *target* is absent from the
 * tree entirely (buildGraph drops unknown names, which is correct for
 * scaffolding deps but would hide missing components in a partial fork).
 * It re-reads each present component's raw prerequisite sources and reports
 * any worker/package/infra target that is not present.
 */
function checkClosureAgainstRaw(root, components) {
  const present = new Set(components.keys());
  const problems = [];
  for (const c of components.values()) {
    const wants = new Set();
    const cy = fs.readFileSync(path.join(root, c.dir, "component.yaml"), "utf8");
    for (const m of cy.matchAll(/component: ([a-z0-9-]+)/g)) wants.add(m[1]);
    const wiring = /wiringComponents: "([a-z0-9,-]+)"/.exec(cy)?.[1];
    if (wiring) for (const w of wiring.split(",")) wants.add(w.trim());
    for (const wf of ["wrangler.template.jsonc", "wrangler.jsonc"]) {
      const p = path.join(root, c.dir, wf);
      if (!fs.existsSync(p)) continue;
      for (const m of fs
        .readFileSync(p, "utf8")
        .matchAll(/"service":\s*"([a-z0-9-]+?)-(?:dev|stage|prod)"/g)) {
        wants.add(m[1]);
      }
      break;
    }
    for (const w of wants) {
      if (!present.has(w)) {
        problems.push(`${c.name} (${c.dir}) needs "${w}" — copy it first`);
      }
    }
  }
  return problems;
}
