#!/usr/bin/env node
// SS6 integration-document projector (zero-dependency, no cloud access).
//
// integrations.manifest.json is the source of truth: per-integration documents
// in Secrets Manager, each holding config + secret(s) for one provider, plus a
// single platform-secrets document for non-integration secrets. This tool
// projects that storage model into the per-worker views the rest of the
// pipeline already consumes:
//   - per-worker SECRETS  → the shape sync.mjs / check.mjs use (secrets-live)
//   - per-worker CONFIG   → non-secret vars rendered into wrangler configs
//
// Modes:
//   --project-manifest --out <file>
//       Regenerate the per-worker secret manifest (secrets.manifest.json shape)
//       from integrations.manifest.json. Deterministic; no cloud data. The
//       committed secrets.manifest.json must equal this output (asserted in
//       tests) so the shipped check.mjs/sync.mjs contract stays a true
//       projection.
//
//   --env <env> --docs-dir <dir> --out-secrets <file> --out-config <file>
//       Read one JSON document per integration (<name>.json) and the platform
//       doc (platform.json) from <dir> (fetched from Secrets Manager by the
//       composition), validate completeness against the manifest, and emit the
//       per-worker secrets and config projections. Secret values are never
//       printed; config values may be.
//
//   --list-docs --env <env>
//       Emit one tab-separated `<name>\t<secret-id>` line per document the
//       deploy lane needs to fetch for this env (active integration docs +
//       platform doc when it has any non-deferred consumer). Fully-deferred
//       integrations are skipped. Consumed by the SS6b secrets-live step.
//
// Exit codes: 0 ok · 1 validation failure (all listed) · 2 usage/config.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const manifestPath =
  arg("manifest") ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "integrations.manifest.json");

function readJson(file, fallback) {
  if (fallback !== undefined && !fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`assemble: cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
}

const manifest = readJson(manifestPath);
const integrations = manifest.integrations ?? {};
const platform = manifest.platform ?? { secret: {} };
const deferredConsumers = new Set(manifest.deferredConsumers ?? []);
const allWorkers = () => {
  const set = new Set();
  for (const spec of Object.values(integrations)) for (const c of spec.consumers) set.add(c);
  for (const consumers of Object.values(platform.secret ?? {})) for (const c of consumers) set.add(c);
  return [...set].sort();
};

// Per-worker required secret names (active) and deferred secret names.
// Deferral is either coarse (a whole worker in manifest.deferredConsumers) or
// fine-grained (an integration doc with `"deferred": true`) — the latter lets
// a live consumer (integrations-worker owns GitHub) defer only the secrets of
// a not-yet-registered provider (Slack/Supabase apps, IH risks D1/D4) so
// secrets-live does not hard-fail requiring them before the app exists.
function projectSecretManifest() {
  const workers = {};
  for (const worker of allWorkers()) workers[worker] = { required: [], deferredNames: [] };
  const place = (worker, name, deferred) => {
    const w = workers[worker];
    if (deferred || deferredConsumers.has(worker)) {
      // Deferred placement: skip if a live consumer already requires it
      // (required wins), else record it as deferred.
      if (!w.required.includes(name) && !w.deferredNames.includes(name)) w.deferredNames.push(name);
    } else {
      // Required placement wins over any prior deferred copy of the same name.
      if (!w.required.includes(name)) w.required.push(name);
      const di = w.deferredNames.indexOf(name);
      if (di !== -1) w.deferredNames.splice(di, 1);
    }
  };
  for (const spec of Object.values(integrations)) {
    for (const name of spec.secret ?? []) for (const w of spec.consumers) place(w, name, spec.deferred === true);
  }
  for (const [name, consumers] of Object.entries(platform.secret ?? {})) {
    for (const w of consumers) place(w, name);
  }
  const out = {};
  for (const [worker, { required, deferredNames }] of Object.entries(workers)) {
    out[worker] = { required: required.sort() };
    if (deferredNames.length > 0) {
      out[worker].deferred = {
        reason:
          "deferred secrets — secrets-live does not require them; activate by clearing the integration doc's `deferred` flag (or removing the worker from manifest.deferredConsumers), then seeding the escrow doc",
        names: deferredNames.sort(),
      };
    }
  }
  return out;
}

if (has("list-docs")) {
  const env = arg("env");
  if (!env) {
    console.error("usage: assemble.mjs --list-docs --env <env>");
    process.exit(2);
  }
  if (!(manifest.environments ?? []).includes(env)) {
    console.error(`assemble: environment ${env} is not declared in the manifest`);
    process.exit(2);
  }
  const root = manifest.escrowRoot;
  for (const [name, spec] of Object.entries(integrations)) {
    if (spec.consumers.every((w) => deferredConsumers.has(w))) continue;
    const id = `${root}/${spec.doc.replace("<env>", env)}`;
    process.stdout.write(`${name}\t${id}\n`);
  }
  const platformHasActive = Object.values(platform.secret ?? {}).some((consumers) =>
    consumers.some((w) => !deferredConsumers.has(w)),
  );
  if (platformHasActive) {
    const id = `${root}/${platform.doc.replace("<env>", env)}`;
    process.stdout.write(`platform\t${id}\n`);
  }
  process.exit(0);
}

if (has("project-manifest")) {
  const outFile = arg("out");
  if (!outFile) {
    console.error("usage: assemble.mjs --project-manifest --out <file>");
    process.exit(2);
  }
  const projected = {
    $comment:
      "GENERATED from integrations.manifest.json by assemble.mjs --project-manifest. Do not edit by hand; edit integrations.manifest.json and regenerate. Per-worker secret view consumed by check.mjs (and historically sync.mjs; SS6b sync.mjs reads the assemble.mjs projection directly).",
    storage: `${manifest.escrowRoot}/integrations/<name>/<env> + ${manifest.escrowRoot}/${manifest.platform?.doc ?? "platform-secrets/<env>"}`,
    environments: manifest.environments,
    workers: projectSecretManifest(),
  };
  fs.writeFileSync(outFile, JSON.stringify(projected, null, 2) + "\n");
  console.log(`assemble: wrote per-worker secret manifest to ${outFile}`);
  process.exit(0);
}

// --- projection from live/fixture documents ---
const env = arg("env");
const docsDir = arg("docs-dir");
const fixturePath = arg("fixture");
const outSecrets = arg("out-secrets");
const outConfig = arg("out-config");
if (!env || (!docsDir && !fixturePath) || !outSecrets || !outConfig) {
  console.error(
    "usage: assemble.mjs --env <env> (--docs-dir <dir> | --fixture <file>) --out-secrets <file> --out-config <file>",
  );
  process.exit(2);
}
if (!(manifest.environments ?? []).includes(env)) {
  console.error(`assemble: environment ${env} is not declared in the manifest`);
  process.exit(2);
}

// In fixture mode, documents come from fixture[env][<name>]; otherwise from
// <docs-dir>/<name>.json (one file per document, fetched from Secrets Manager).
const fixtureDocs = fixturePath ? (readJson(fixturePath)[env] ?? {}) : null;

const violations = [];
const workerSecrets = {};
const workerConfig = {};
const ensure = (map, worker) => (map[worker] ??= {});

function readDoc(name) {
  if (fixtureDocs) return fixtureDocs[name];
  const file = path.join(docsDir, `${name}.json`);
  if (!fs.existsSync(file)) return undefined;
  return readJson(file);
}

for (const [name, spec] of Object.entries(integrations)) {
  const consumersActive = spec.consumers.filter((w) => !deferredConsumers.has(w));
  const doc = readDoc(name);
  if (consumersActive.length === 0) continue; // fully deferred integration (all consumers deferred)
  if (doc === undefined) {
    // A per-integration-deferred doc (an unregistered provider app, e.g. the
    // Slack/Supabase apps behind IH risks D1/D4) is OPTIONAL: tolerate its
    // absence so secrets-live does not hard-fail before the app exists. When
    // an operator seeds it and clears `deferred`, it becomes required.
    if (spec.deferred === true) continue;
    violations.push(`${env}: integration document ${name}.json not fetched (doc ${spec.doc})`);
    continue;
  }
  for (const key of spec.config ?? []) {
    const value = doc[key];
    if (typeof value !== "string" || value.length === 0)
      violations.push(`${env}/${name}: config ${key} missing or empty`);
    else for (const w of consumersActive) ensure(workerConfig, w)[key] = value;
  }
  for (const key of spec.secret ?? []) {
    const value = doc[key];
    if (typeof value !== "string" || value.length === 0)
      violations.push(`${env}/${name}: secret ${key} missing or empty`);
    else for (const w of consumersActive) ensure(workerSecrets, w)[key] = value;
  }
}

const platformDoc = readDoc("platform");
const platformActive = Object.entries(platform.secret ?? {}).filter(([, consumers]) =>
  consumers.some((w) => !deferredConsumers.has(w)),
);
if (platformActive.length > 0) {
  if (platformDoc === undefined) {
    violations.push(`${env}: platform document platform.json not fetched (doc ${platform.doc})`);
  } else {
    for (const [name, consumers] of platformActive) {
      const value = platformDoc[name];
      if (typeof value !== "string" || value.length === 0) {
        violations.push(`${env}/platform: secret ${name} missing or empty`);
      } else {
        for (const w of consumers) if (!deferredConsumers.has(w)) ensure(workerSecrets, w)[name] = value;
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`assemble: ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

fs.writeFileSync(outSecrets, JSON.stringify(workerSecrets));
fs.writeFileSync(outConfig, JSON.stringify(workerConfig));
const configKeys = Object.values(workerConfig).reduce((n, c) => n + Object.keys(c).length, 0);
const secretWorkers = Object.keys(workerSecrets).length;
console.log(
  `assemble: ${env}: projected secrets for ${secretWorkers} worker(s), ${configKeys} config value(s) across ${Object.keys(workerConfig).length} worker(s)`,
);
