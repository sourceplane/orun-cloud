#!/usr/bin/env node
// SS2 secrets-live decision tool (zero-dependency, no cloud access).
//
// Given the committed manifest, one environment's escrow payload (fetched
// from AWS Secrets Manager by the composition's secrets-live step), and the
// previous fingerprint record, decide what to push to Cloudflare for one
// worker. Emits:
//   --out-bulk <file>     JSON map { SECRET_NAME: value } for `wrangler
//                         secret bulk` — `{}` when nothing changed
//   --out-record <file>   updated fingerprint record (worker's entry replaced;
//                         other workers' entries preserved)
//
// Stdout reports names and truncated SHA-256 fingerprints only — never values.
// The escrow payload existing but missing a required secret is a hard error:
// it blocks the deploy rather than shipping a worker with stale/absent
// secrets. (The step itself skips cleanly when no escrow document exists at
// all — that is the pre-SS3 state.)
//
// Usage:
//   node sync.mjs --worker identity-worker --env stage \
//     --escrow /tmp/escrow.json --record /tmp/record.json \
//     --out-bulk /tmp/bulk.json --out-record /tmp/record.out.json \
//     [--manifest secrets.manifest.json]
//
// Exit codes: 0 ok (bulk may be empty) · 1 escrow violations · 2 usage/config.

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const worker = arg("worker");
const env = arg("env");
const escrowPath = arg("escrow");
const recordPath = arg("record");
const outBulkPath = arg("out-bulk");
const outRecordPath = arg("out-record");
const manifestPath =
  arg("manifest") ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "secrets.manifest.json");

if (!worker || !env || !escrowPath || !recordPath || !outBulkPath || !outRecordPath) {
  console.error(
    "usage: sync.mjs --worker <name> --env <env> --escrow <file> --record <file> --out-bulk <file> --out-record <file> [--manifest <file>]",
  );
  process.exit(2);
}

function readJson(file, fallback) {
  if (fallback !== undefined && !fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`secrets-sync: cannot read ${file}: ${err.message}`);
    process.exit(2);
  }
}

const manifest = readJson(manifestPath);
const spec = manifest.workers?.[worker];
if (!spec) {
  console.error(
    `secrets-sync: worker ${worker} is not declared in ${manifestPath} — set the component's secretsWorker to a manifest key or add the worker to the manifest`,
  );
  process.exit(2);
}
if (!(manifest.environments ?? []).includes(env)) {
  console.error(`secrets-sync: environment ${env} is not declared in the manifest`);
  process.exit(2);
}

const required = spec.required ?? [];
const escrow = readJson(escrowPath);
const record = readJson(recordPath, {});
const payload = escrow[worker] ?? {};
const fingerprint = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

const violations = [];
for (const name of required) {
  const value = payload[name];
  if (value === undefined) violations.push(`missing ${name} in escrow ${env}/${worker}`);
  else if (typeof value !== "string" || value.length === 0)
    violations.push(`${name} is empty or not a string in escrow ${env}/${worker}`);
}
if (violations.length > 0) {
  console.error(`secrets-sync: ${violations.length} escrow violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

const fingerprints = Object.fromEntries(
  required.map((name) => [name, fingerprint(payload[name])]),
);
const previous = record[worker] ?? {};
const changed = required.filter((name) => previous[name] !== fingerprints[name]);

for (const name of required) {
  const marker = changed.includes(name) ? "changed" : "unchanged";
  console.log(`secrets-sync: ${env}/${worker}: ${name} sha256:${fingerprints[name]} (${marker})`);
}

const bulk =
  changed.length === 0
    ? {}
    : Object.fromEntries(required.map((name) => [name, payload[name]]));
fs.writeFileSync(outBulkPath, JSON.stringify(bulk));
fs.writeFileSync(
  outRecordPath,
  JSON.stringify({ ...record, [worker]: fingerprints }, null, 2),
);
console.log(
  changed.length === 0
    ? `secrets-sync: ${env}/${worker}: in sync — nothing to push`
    : `secrets-sync: ${env}/${worker}: ${changed.length} change(s) — pushing ${required.length} secret(s)`,
);
