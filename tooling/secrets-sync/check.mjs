#!/usr/bin/env node
// SS1 secrets drift detector (zero-dependency).
//
// Validates worker runtime secrets against the committed manifest
// (secrets.manifest.json) without ever printing a secret value — output is
// names and truncated SHA-256 fingerprints only.
//
// Sources (exactly one required):
//   --fixture <file>       committed escrow.fixture.json keyed by env — offline
//                          PR verify lanes
//   --escrow-dir <dir>     one JSON file per env named worker-secrets__<env>.json,
//                          each the escrow payload fetched from AWS Secrets
//                          Manager by the composition's secrets step
//   --deployed-dir <dir>   one JSON file per worker/env named <worker>__<env>.json
//                          containing `wrangler secret list` output (array of
//                          { "name": ... }) — checks deployed names only
//
// Options:
//   --manifest <file>      defaults to secrets.manifest.json next to this script
//   --strict               deferred secrets count as required
//
// Exit codes: 0 in sync · 1 violations (all listed) · 2 usage/IO error.
//
// Usage:
//   node check.mjs --fixture escrow.fixture.json
//   node check.mjs --escrow-dir /tmp/escrow
//   node check.mjs --deployed-dir /tmp/deployed --strict

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(`--${name}`);

const fixturePath = arg("fixture");
const escrowDir = arg("escrow-dir");
const deployedDir = arg("deployed-dir");
const strict = flag("strict");
const manifestPath =
  arg("manifest") ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "secrets.manifest.json");

const sources = [fixturePath, escrowDir, deployedDir].filter(Boolean);
if (sources.length !== 1) {
  console.error(
    "usage: check.mjs (--fixture <file> | --escrow-dir <dir> | --deployed-dir <dir>) [--manifest <file>] [--strict]",
  );
  process.exit(2);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`secrets-check: cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
}

const manifest = readJson(manifestPath);
const environments = manifest.environments ?? [];
const workers = manifest.workers ?? {};
const fingerprint = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

// expected: env -> worker -> Set of required names (deferred folded in under --strict)
function expectedNames(worker) {
  const spec = workers[worker] ?? {};
  const names = [...(spec.required ?? [])];
  if (strict) names.push(...(spec.deferred?.names ?? []));
  return names;
}

const violations = [];
const notes = [];

function checkPayload(env, payload, { values }) {
  for (const worker of Object.keys(workers)) {
    const expected = expectedNames(worker);
    const actual = payload[worker] ?? {};
    const actualNames = new Set(Object.keys(actual));

    for (const name of expected) {
      if (!actualNames.has(name)) {
        violations.push(`${env}/${worker}: missing ${name}`);
      } else if (values) {
        const value = actual[name];
        if (typeof value !== "string" || value.length === 0) {
          violations.push(`${env}/${worker}: ${name} is empty or not a string`);
        } else {
          notes.push(`${env}/${worker}: ${name} sha256:${fingerprint(value)}`);
        }
      }
    }

    const known = new Set([
      ...(workers[worker]?.required ?? []),
      ...(workers[worker]?.deferred?.names ?? []),
    ]);
    for (const name of actualNames) {
      if (!known.has(name)) {
        violations.push(`${env}/${worker}: unknown secret ${name} (typo, or add it to the manifest)`);
      }
    }
  }
  for (const worker of Object.keys(payload)) {
    if (worker.startsWith("$")) continue;
    if (!(worker in workers)) {
      violations.push(`${env}: unknown worker ${worker} in payload`);
    }
  }
}

if (fixturePath) {
  const fixture = readJson(fixturePath);
  for (const env of environments) {
    if (!(env in fixture)) {
      violations.push(`${env}: missing from fixture`);
      continue;
    }
    checkPayload(env, fixture[env], { values: true });
  }
} else if (escrowDir) {
  for (const env of environments) {
    const file = path.join(escrowDir, `worker-secrets__${env}.json`);
    if (!fs.existsSync(file)) {
      violations.push(`${env}: escrow payload ${file} not fetched`);
      continue;
    }
    checkPayload(env, readJson(file), { values: true });
  }
} else {
  // deployed-dir: `wrangler secret list` output per worker/env — names only.
  for (const env of environments) {
    for (const worker of Object.keys(workers)) {
      const expected = expectedNames(worker);
      if (expected.length === 0) continue;
      const file = path.join(deployedDir, `${worker}__${env}.json`);
      if (!fs.existsSync(file)) {
        violations.push(`${env}/${worker}: deployed secret list ${file} not fetched`);
        continue;
      }
      const deployed = new Set(readJson(file).map((s) => s.name));
      for (const name of expected) {
        if (!deployed.has(name)) {
          violations.push(`${env}/${worker}: ${name} not deployed`);
        }
      }
    }
  }
}

for (const note of notes) console.log(`secrets-check: ${note}`);
if (violations.length > 0) {
  console.error(`secrets-check: ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(
  `secrets-check: in sync (${environments.join(", ")}; ${strict ? "strict" : "deferred excluded"})`,
);
