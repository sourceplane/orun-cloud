#!/usr/bin/env node
// Fork/rebrand renamer for the multi-tenant SaaS baseline (zero-dependency).
//
// Rewrites every *instance identity* literal in the repo — repo name, product
// domain, product/display name, SDK class name, CLI bin, worker-name prefix,
// wire-visible user agents, workers.dev subdomain — to the values supplied in
// a values file, leaving *org-owned* identity untouched (GitHub org, orun
// state backend, `sourceplane.io` manifest apiVersion, S3 state buckets,
// company email addresses). The rename map is the codified form of the
// transformation log from the first real instantiation (orun-cloud,
// `ai/context/fork-from-baseline.md` there); FORKING.md is the playbook.
//
// Usage (from the repo root, on a clean tree):
//   node tooling/rebrand/rebrand.mjs --values my-brand.json [--dry-run]
//   node tooling/rebrand/rebrand.mjs --verify
//
// Values file (see tooling/rebrand/values.example.json):
//   {
//     "repoName":            "acme-cloud",          // required — repo slug
//     "productName":         "Acme Cloud",          // required — display name
//     "productDomain":       "acme.dev",            // required — product domain
//     "pascalName":          "AcmeCloud",           // default: productName, non-alnum stripped
//     "brandSlug":           "acme",                // default: repoName
//     "cliBin":              "acme",                // default: repoName
//     "apiBaseUrl":          "https://api.acme.dev",// default: https://api.<productDomain>
//     "workersDevSubdomain": "my-subdomain",        // default: "your-workers-subdomain"
//     "salesEmail":          "sales@acme.dev"       // optional: keeps baseline mailbox if absent
//   }
//
// Modes:
//   (default)   apply the rename map in place, then run the leftover sweep
//   --dry-run   report per-pair match counts and files; change nothing
//   --verify    only run the leftover sweep (non-zero exit on residue)

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

// ── Inputs ─────────────────────────────────────────────────────

function flag(name) {
  return process.argv.includes(`--${name}`);
}
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dryRun = flag("dry-run");
const verifyOnly = flag("verify");

let values = {};
if (!verifyOnly) {
  const valuesPath = arg("values");
  if (!valuesPath) {
    console.error("usage: rebrand.mjs --values <file> [--dry-run] | --verify");
    process.exit(2);
  }
  values = JSON.parse(fs.readFileSync(valuesPath, "utf8"));
  for (const required of ["repoName", "productName", "productDomain"]) {
    if (typeof values[required] !== "string" || values[required].length === 0) {
      console.error(`rebrand: values file is missing required field "${required}"`);
      process.exit(2);
    }
  }
}

// All fields are unused under --verify; the fallbacks keep derivation total.
const repoName = values.repoName ?? "";
const productName = values.productName ?? "";
const productDomain = values.productDomain ?? "";
const pascalName = values.pascalName ?? productName.replace(/[^A-Za-z0-9]/g, "");
const brandSlug = values.brandSlug ?? repoName;
const cliBin = values.cliBin ?? repoName;
const apiBaseUrl = values.apiBaseUrl ?? `https://api.${productDomain}`;
const workersDevSubdomain = values.workersDevSubdomain ?? "your-workers-subdomain";
const salesEmail = values.salesEmail; // optional
// Derived code-shaped forms.
const camelName = pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
const envPrefix = cliBin.toUpperCase().replace(/-/g, "_");

if (!verifyOnly && /[^a-z0-9-]/.test(`${repoName}${brandSlug}${cliBin}`)) {
  console.error("rebrand: repoName/brandSlug/cliBin must be lowercase slugs ([a-z0-9-])");
  process.exit(2);
}

// In-place rewrite of the whole tree: insist on a clean checkout so the
// result is reviewable as one diff (and trivially revertible).
if (!verifyOnly && !dryRun && !flag("allow-dirty")) {
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (status.trim().length > 0) {
    console.error("rebrand: working tree is not clean — commit/stash first (or pass --allow-dirty)");
    process.exit(2);
  }
}

// ── File set ───────────────────────────────────────────────────

// Tracked text files only. Exclusions are either generated/locked artifacts,
// this tool itself, or files that intentionally keep baseline-provenance
// literals (FORKING.md documents the baseline by name).
const EXCLUDE_RE = new RegExp(
  [
    "^tooling/rebrand/",
    "^FORKING\\.md$",
    "^ai/context/fork-from-baseline\\.md$",
    "^pnpm-lock\\.yaml$",
    "^kiox\\.lock$",
    "\\.(png|jpg|jpeg|ico|gif|woff2?|ttf|eot)$",
  ].join("|"),
);

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.length > 0 && !EXCLUDE_RE.test(f));
}

// ── Protected literals (org-owned identity, never rewritten) ───
//
// Masked before the pair sweep and restored after, so broad pairs like
// "sourceplane.ai" cannot touch them. Mirrors the orun-cloud fork's
// "intentionally NOT changed" register.

const PROTECTED = [
  /https:\/\/orun-api\.sourceplane\.ai/g, // orun state backend (intent.yaml)
  /sourceplane\.io/g, // manifest apiVersion, owned by the orun tooling
  /[A-Za-z0-9._%+-]+@sourceplane\.ai/g, // company mailboxes
];

const MASK = (i, j) => `\u0000REBRAND_PROTECTED_${i}_${j}\u0000`;

// ── Rename map (ordered, most specific first) ──────────────────

function pairs() {
  const list = [];
  // Optional mailbox retarget runs before emails are masked.
  if (salesEmail) {
    list.push(["sales@sourceplane.ai", salesEmail, "sales mailbox (console seam)"]);
  }
  list.push(
    // Repo-derived values: intent metadata.name + per-env repo: params,
    // component.yaml repo: fields, Secrets Manager paths, OIDC role names,
    // Supabase project names, docs.
    ["multi-tenant-saas", repoName, "repo slug"],
    // Deploy names: console worker/Pages prefix (covers the -next variant and
    // the legacy pages.dev fixtures in the CORS tests).
    ["sourceplane-web-console", `${brandSlug}-web-console`, "console worker prefix"],
    // Wire-visible user agents (test assertions update in lockstep).
    ["sourceplane-identity-worker", `${brandSlug}-identity-worker`, "identity UA"],
    ["sourceplane-integrations-worker", `${brandSlug}-integrations-worker`, "integrations UA"],
    ["Sourceplane-Webhooks", `${pascalName}-Webhooks`, "webhooks UA"],
    // CLI default API base (brand seam).
    ["https://api.sourceplane.dev", apiBaseUrl, "CLI default API base"],
    ["api.sourceplane.dev", apiBaseUrl.replace(/^https?:\/\//, ""), "CLI API host (bare)"],
    // Product domain wherever it is the *product* (BASE_DOMAIN, console
    // custom domains, Polar success URLs, OAuth origins, CORS tests, docs).
    // The orun backend URL and company mailboxes are masked above.
    ["sourceplane.ai", productDomain, "product domain"],
    // Display-name seams keep the human-readable name even in .ts files.
    ['PRODUCT_NAME = "Sourceplane"', `PRODUCT_NAME = "${productName}"`, "product-name seams"],
    // Console localStorage namespace (console app-config seam).
    ['STORAGE_PREFIX = "sourceplane.next"', `STORAGE_PREFIX = "${brandSlug}.next"`, "storage prefix"],
    // Workers.dev subdomain (app-config seams, console component, identity template).
    ["rahulvarghesepullely", workersDevSubdomain, "workers.dev subdomain"],
    // SDK usage examples (integrations README): the client variable and the
    // product-namespaced check-run name.
    ["const sourceplane = new", `const ${camelName} = new`, "SDK example variable (decl)"],
    ["await sourceplane.integrations", `await ${camelName}.integrations`, "SDK example variable (use)"],
    ['"sourceplane/verify"', `"${brandSlug}/verify"`, "check-run name example"],
    // CLI config-dir references in docs.
    [".config/sourceplane/", `.config/${cliBin}/`, "CLI config dir (docs)"],
    // CLI command examples in docs: `sourceplane ...` / `sourceplane`.
    ["`sourceplane ", `\`${cliBin} `, "CLI bin (doc examples, open)"],
    ["`sourceplane`", `\`${cliBin}\``, "CLI bin (doc examples, closed)"],
  );
  return list;
}

// ── `Sourceplane` (display name vs. code identifier) ───────────
//
// The `@saas/sdk` client class (`Sourceplane`, `SourceplaneError`) is a code
// identifier; prose references are the display name. This is the BF12
// "blueprint rename map" boundary recorded in packages/cli/src/brand.ts:
//   - code files (.ts/.js/...)            → pascalName
//   - markdown code fences + inline code  → pascalName
//   - everything else (prose, yaml, json) → productName

function replaceBrandWord(file, text, count) {
  const sub = (chunk, to) =>
    chunk.replace(/Sourceplane/g, () => {
      count();
      return to;
    });

  if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file)) return sub(text, pascalName);
  if (!/\.(md|markdown)$/.test(file)) return sub(text, productName);

  // Markdown: fenced blocks keep the identifier form …
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part) => {
      if (part.startsWith("```")) return sub(part, pascalName);
      // … as do inline code spans; bare prose gets the display name.
      return part
        .split(/(`[^`\n]+`)/)
        .map((span) =>
          span.startsWith("`") && span.endsWith("`")
            ? sub(span, pascalName)
            : sub(span, productName),
        )
        .join("");
    })
    .join("");
}

// Scoped, regex-based pairs applied after the literal map.
function scopedPairs() {
  return [
    // Branded env-var names: the real CONFIG_DIR override (brand.ts derives
    // it from CLI_BIN, so tests/docs must rename in lockstep) plus doc
    // placeholders like SOURCEPLANE_TOKEN / SOURCEPLANE_API_KEY /
    // SOURCEPLANE_WEBHOOK_SECRET, and historical SOURCEPLANE_DB mentions.
    {
      re: /SOURCEPLANE_(?=[A-Z])/g,
      replacement: () => `${envPrefix}_`,
      label: "branded env-var prefix",
    },
    // CLI bin: usage strings, keychain/config-dir derivations, package bin.
    // Lowercase `sourceplane` outside packages/cli is the GitHub org — never
    // rewritten. Inside packages/cli the org never appears bare (the masked
    // sourceplane.io/backend forms aside), so a word-boundary replace is safe.
    {
      re: /\bsourceplane\b/g,
      replacement: () => cliBin,
      label: "CLI bin (packages/cli)",
      fileFilter: (file) => file.startsWith("packages/cli/"),
    },
  ];
}

// ── Leftover sweep ─────────────────────────────────────────────
//
// After a rebrand (or under --verify) every remaining baseline-identity
// literal is residue: either org-owned (allowed, enumerated below) or a
// missed rename (reported, non-zero exit).

const RESIDUE_RE =
  /multi-tenant-saas|rahulvarghesepullely|Sourceplane|sourceplane\.ai|api\.sourceplane\.dev|sourceplane-web-console|sourceplane\.next|SOURCEPLANE_/g;

const ALLOWED_RESIDUE = [
  /https:\/\/orun-api\.sourceplane\.ai/, // orun state backend
  /[A-Za-z0-9._%+-]+@sourceplane\.ai/, // company mailboxes
];

function sweep(files) {
  const residue = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      // Strip allowed (org-owned) forms first; whatever still matches is residue.
      const cleaned = ALLOWED_RESIDUE.reduce(
        (l, re) => l.replace(new RegExp(re.source, "g"), ""),
        line,
      );
      if (new RegExp(RESIDUE_RE.source).test(cleaned)) {
        residue.push(`${file}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  return residue;
}

// ── Main ───────────────────────────────────────────────────────

const files = trackedFiles();

if (verifyOnly) {
  const residue = sweep(files);
  if (residue.length > 0) {
    console.error(`rebrand --verify: ${residue.length} baseline-identity leftover(s):`);
    for (const r of residue) console.error(`  ${r}`);
    process.exit(1);
  }
  console.log("rebrand --verify: no baseline-identity leftovers.");
  process.exit(0);
}

const literalPairs = pairs();
const regexPairs = scopedPairs();
const counts = new Map();
const touched = new Set();

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue; // unreadable/deleted — not our concern
  }
  if (text.includes("\0")) continue; // binary safety net
  const original = text;

  // Mask org-owned literals.
  const masks = [];
  PROTECTED.forEach((re, i) => {
    text = text.replace(re, (m) => {
      const token = MASK(i, masks.length);
      masks.push([token, m]);
      return token;
    });
  });

  for (const [from, to, label] of literalPairs) {
    const n = text.split(from).length - 1;
    if (n > 0) {
      counts.set(label, (counts.get(label) ?? 0) + n);
      text = text.split(from).join(to);
    }
  }
  const brandLabel = "Sourceplane (class name in code, display name in prose)";
  text = replaceBrandWord(file, text, () =>
    counts.set(brandLabel, (counts.get(brandLabel) ?? 0) + 1),
  );

  for (const { re, replacement, label, fileFilter } of regexPairs) {
    if (fileFilter && !fileFilter(file)) continue;
    const to = replacement(file);
    text = text.replace(re, () => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
      return to;
    });
  }

  // Restore org-owned literals.
  for (const [token, value] of masks) text = text.split(token).join(value);

  if (text !== original) {
    touched.add(file);
    if (!dryRun) fs.writeFileSync(file, text);
  }
}

console.log(`rebrand${dryRun ? " (dry-run)" : ""}: ${touched.size} file(s) affected`);
for (const [label, n] of counts) console.log(`  ${String(n).padStart(5)}  ${label}`);

if (dryRun) {
  process.exit(0);
}

// Provenance stub, mirroring the convention the first fork established.
const provenance = `# Fork tracking — ${repoName} from the baseline SaaS starter

Generated by \`tooling/rebrand/rebrand.mjs\`. This repo is an instantiation of
the reusable multi-tenant SaaS baseline (\`sourceplane/multi-tenant-saas\`) as
**${productName}**. Track every transformation applied on top of the baseline
here so the delta stays auditable.

Rebrand values:

| Field | Value |
|---|---|
| repoName | \`${repoName}\` |
| productName | ${productName} |
| pascalName | \`${pascalName}\` |
| brandSlug | \`${brandSlug}\` |
| productDomain | \`${productDomain}\` |
| apiBaseUrl | \`${apiBaseUrl}\` |
| cliBin | \`${cliBin}\` |
| workersDevSubdomain | \`${workersDevSubdomain}\` |
| salesEmail | ${salesEmail ?? "(baseline mailbox kept)"} |
| Rebranded on | ${new Date().toISOString().slice(0, 10)} |

See FORKING.md in the baseline for the operator checklist (cloud accounts,
secrets, OAuth apps, GitHub Apps) that no script can do for you.
`;
fs.mkdirSync("ai/context", { recursive: true });
fs.writeFileSync("ai/context/fork-from-baseline.md", provenance);
console.log("rebrand: wrote ai/context/fork-from-baseline.md (provenance)");

const residue = sweep(trackedFiles());
if (residue.length > 0) {
  console.error(`rebrand: ${residue.length} baseline-identity leftover(s) after rename:`);
  for (const r of residue) console.error(`  ${r}`);
  process.exit(1);
}
console.log("rebrand: leftover sweep clean. Next: FORKING.md operator checklist.");
