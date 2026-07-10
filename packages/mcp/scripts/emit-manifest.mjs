#!/usr/bin/env node
// MCP9 emitter: regenerate `packages/mcp/tool-manifest.json` from the live
// registry (`pnpm --filter @saas/mcp manifest`).
//
// Like the CLI's `scripts/bundle.mjs`, this bundles from TypeScript sources
// with esbuild first: workspace packages export raw `.ts` (and `src` uses
// `.js`-suffixed relative imports), which Node ESM cannot load unaided. tsc is
// reserved for type-checking; the throwaway emitter bundle lands in `dist/`
// (gitignored) and is imported once to serialize the manifest.
//
// Output is `serializeToolManifest()` VERBATIM — deterministic (sorted keys,
// registry order, 2-space indent, trailing newline), so re-running is
// byte-stable and the vitest freshness test can compare byte-for-byte.

import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const entry = resolve(pkgRoot, "src/manifest.ts");
const bundle = resolve(pkgRoot, "dist/manifest-emitter.mjs");
const out = resolve(pkgRoot, "tool-manifest.json");

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: bundle,
  legalComments: "none",
  minify: false,
  sourcemap: false,
  logLevel: "warning",
});

const { serializeToolManifest } = await import(pathToFileURL(bundle).href);
writeFileSync(out, serializeToolManifest());
console.log(`wrote ${out}`);
