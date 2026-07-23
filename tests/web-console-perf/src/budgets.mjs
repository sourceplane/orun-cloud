// IC9 — the console's perf budgets, enforced per PR (saas-instant-console).
//
// Two classes of assertion, per the epic's risk note ("timing assertions in
// shared CI runners flake; fetch-count assertions carry the
// regression-catching weight"):
//
//  DETERMINISTIC (hard, no tolerance):
//   - one boot, one fetch (IC2): exactly one GET /v1/auth/profile and one
//     GET /v1/organizations per boot; zero boot-window profile PATCHes;
//     no identical org-scoped GET issued twice concurrently.
//   - persisted-cache revisit (IC3): a second full load issues ≤ 4 requests.
//   - per-route fetch counts: warm-navigating a sidebar surface issues each
//     endpoint at most once (client-side N+1 / dup regression guard).
//   - ⌘K (IC7): typing an existing service name surfaces its entity; the
//     lazy prime fires at most once.
//   - big lists (IC8): 1,000-entity catalog renders ≤ 80 [data-row] nodes;
//     rows are real links (href present).
//
//  TIMING (median of ≥3 runs, CI tolerance band = spec target × BAND — the
//  spec numbers are the product targets on end-user hardware; shared CI
//  runners get headroom, and regressions still trip because the guarded
//  quantity is the same):
//   - cold FCP: spec 1500ms → budget 1500ms (localhost serves no real
//     network, so even CI clears the real-world target).
//   - warm route-to-content (cached surface): spec 300ms → 300 × BAND.
//   - palette open→interactive: spec 100ms → 100 × BAND.
//
// The mock API answers every endpoint the surfaces touch with well-shaped
// empty payloads (latency: boot 30ms, org reads 60ms) so counts are exact
// and retries never fire.

import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BAND = Number(process.env.PERF_BAND ?? 3); // CI headroom multiplier
const RUNS = 3;

const ORG = { id: "org_11111111111111111111111111111111", name: "Acme", slug: "acme", workspaceRef: "ws_1", createdAt: "2026-01-01T00:00:00.000Z" };
const USER = { id: "usr_1", email: "u@test.com", displayName: "U", lastOrgSlug: "acme" };
const meta = { requestId: "req_mock", cursor: null };

const CATALOG_N = 1000;
const ENTITIES = Array.from({ length: CATALOG_N }, (_, i) => ({
  orgId: ORG.id,
  entityRef: i === 42 ? "component:default/api-edge" : `component:default/svc-${String(i).padStart(4, "0")}`,
  kind: "component",
  name: i === 42 ? "api-edge" : `svc-${String(i).padStart(4, "0")}`,
  owner: "team:platform",
  lifecycle: "production",
  relations: [],
  sourceProjectId: "prj_00000000000000000000000000000001",
  sourceEnvironment: null,
  sourceCommit: null,
  headDigest: "sha256:" + "a".repeat(64),
  description: null,
  system: null,
  language: null,
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

function mockBody(path) {
  if (path === "/v1/auth/profile") return { data: { user: USER }, meta };
  if (path === "/v1/organizations") return { data: { organizations: [ORG] }, meta };
  if (path === "/v1/me/invitations") return { data: { invitations: [] }, meta };
  if (path.includes("/catalog/entities")) return { data: { entities: ENTITIES, nextCursor: null }, meta };
  if (path.includes("/catalog/docs")) return { data: { docs: [], nextCursor: null }, meta };
  if (path.includes("/repo-facets")) return { data: { repoFacets: [] }, meta };
  if (path.includes("/state/runs")) return { data: { runs: [], nextCursor: null }, meta };
  if (path.includes("/state/usage")) return { data: {}, meta };
  if (path.includes("/resolve-owners")) return { data: { resolutions: [] }, meta };
  if (path.includes("/my-teams")) return { data: { teams: [] }, meta };
  if (path.endsWith("/teams")) return { data: { teams: [{ id: "team_1", name: "Platform", handle: "platform" }] }, meta };
  if (path.includes("/projects")) return { data: { projects: [] }, meta };
  if (path.includes("/agents/attention"))
    return { data: { running: 0, counts: { verdict: 0, budget: 0, parked: 0, failure: 0, stuck: 0 }, items: [] }, meta };
  if (path.includes("/agents/")) return { data: [], meta };
  if (path.includes("/work/summary")) return { data: { coordSeq: 0, items: [] }, meta };
  if (path.includes("/work/")) return { data: {}, meta };
  if (path.includes("/events")) return { data: { events: [], nextCursor: null }, meta };
  if (path.includes("/integrations")) return { data: { integrations: [] }, meta };
  if (path.includes("/cli/links")) return { data: { links: [] }, meta };
  return { data: {}, meta };
}

const failures = [];
function check(name, ok, detail) {
  const status = ok ? "PASS" : "FAIL";
  console.log(`[budget] ${status}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function newPage(base) {
  const dir = mkdtempSync(join(tmpdir(), "perf-budget-"));
  const ctx = await chromium.launchPersistentContext(dir, { viewport: { width: 1440, height: 900 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const log = [];
  await page.route("**://api-edge-*.oruncloud.workers.dev/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    log.push({ method: req.method(), path: url.pathname, body: req.postData() ?? "", at: Date.now() });
    const heavy = url.pathname.startsWith("/v1/organizations/");
    await new Promise((r) => setTimeout(r, heavy ? 60 : 30));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockBody(url.pathname)) });
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("orun.next.target", "prod");
    window.localStorage.setItem("orun.next.token", "tok_fake_test");
    window.localStorage.setItem("orun.next.last-org", "acme");
  });
  return { ctx, page, log };
}

/** No identical GET may be in flight twice concurrently (IC2 invariant).
 *  Approximation over the log: same method+path recorded twice within the
 *  round-trip window. Boot reads primed pre-hydration are one-shot-adopted,
 *  so a duplicate here is a real regression. */
function concurrentDuplicates(log, windowMs = 25) {
  const dups = [];
  const gets = log.filter((e) => e.method === "GET");
  for (let i = 0; i < gets.length; i++) {
    for (let j = i + 1; j < gets.length; j++) {
      if (gets[i].path === gets[j].path && Math.abs(gets[j].at - gets[i].at) <= windowMs) {
        dups.push(gets[i].path);
      }
    }
  }
  return dups;
}

export async function runBudgets(base) {
  console.log(`perf-budgets: base=${base} band=${BAND}× runs=${RUNS}`);

  // ── 1. Cold boot: FCP + one-boot-one-fetch ────────────────
  {
    const fcps = [];
    for (let r = 0; r < RUNS; r++) {
      const { ctx, page, log } = await newPage(base);
      await page.goto(`${base}/orgs/acme`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);
      const fcp = await page.evaluate(
        () => performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint")?.startTime ?? null,
      );
      if (fcp != null) fcps.push(Math.round(fcp));
      if (r === 0) {
        const profiles = log.filter((e) => e.method === "GET" && e.path === "/v1/auth/profile").length;
        const orgs = log.filter((e) => e.method === "GET" && e.path === "/v1/organizations").length;
        const patches = log.filter((e) => e.method === "PATCH" && e.path === "/v1/auth/profile").length;
        check("boot: exactly one GET /v1/auth/profile", profiles === 1, `saw ${profiles}`);
        check("boot: exactly one GET /v1/organizations", orgs === 1, `saw ${orgs}`);
        check("boot: zero boot-window profile PATCHes", patches === 0, `saw ${patches}`);
        const dups = concurrentDuplicates(log);
        check("boot: no identical GET in flight twice concurrently", dups.length === 0, dups.join(", ") || "clean");
      }
      await ctx.close();
    }
    check(`cold FCP median < 1500ms`, median(fcps) < 1500, `median ${median(fcps)}ms of [${fcps.join(", ")}]`);
  }

  // ── 2. Persisted-cache revisit + warm nav + palette + catalog ──
  {
    const { ctx, page, log } = await newPage(base);
    // Prime: cold boot.
    await page.goto(`${base}/orgs/acme`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);

    // Revisit: persisted cache serves; only the primed pair (+ tolerance).
    log.length = 0;
    await page.goto(`${base}/orgs/acme`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    check("revisit boot issues ≤ 4 requests (persisted cache)", log.length <= 4, `saw ${log.length}: ${[...new Set(log.map((e) => e.path))].join(", ")}`);

    // Warm nav to Activities (first visit): each endpoint at most once.
    log.length = 0;
    await page.click(`a[href="/orgs/acme/activities"]`);
    await page.waitForFunction(
      `location.pathname === '/orgs/acme/activities' && !!document.querySelector('main') && /No runs match the current selection/.test(document.querySelector('main').innerText)`,
      { timeout: 20000 },
    );
    await page.waitForTimeout(1500);
    {
      // Dup rule: identical (method, path, body). POST query-RPCs (e.g.
      // resolve-owners) legitimately re-fire when their inputs change — only
      // byte-identical repeats are regressions.
      const counts = new Map();
      for (const e of log) {
        const k = `${e.method} ${e.path} ${e.body}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const repeats = [...counts.entries()].filter(([, n]) => n > 1);
      check("Activities nav: no identical request issued more than once", repeats.length === 0, repeats.map(([k, n]) => `${k.split(" ").slice(0, 2).join(" ")}×${n}`).join(", ") || "clean");
    }

    // Cached warm nav (revisit Activities): timing budget, median of runs.
    const navMs = [];
    for (let r = 0; r < RUNS; r++) {
      await page.click(`a[href="/orgs/acme"]`);
      await page.waitForTimeout(1200);
      const t0 = Date.now();
      await page.click(`a[href="/orgs/acme/activities"]`);
      await page.waitForFunction(
        `location.pathname === '/orgs/acme/activities' && !!document.querySelector('main') && /No runs match the current selection/.test(document.querySelector('main').innerText) && !document.querySelector('main .animate-pulse')`,
        { timeout: 20000 },
      );
      navMs.push(Date.now() - t0);
    }
    check(`cached warm route-to-content median < ${300 * BAND}ms (target 300)`, median(navMs) < 300 * BAND, `median ${median(navMs)}ms of [${navMs.join(", ")}]`);

    // Palette: open→interactive + finds the entity + bounded lazy prime.
    log.length = 0;
    const openMs = [];
    for (let r = 0; r < RUNS; r++) {
      const t0 = Date.now();
      await page.keyboard.press("Meta+k");
      await page.waitForSelector("input[cmdk-input]", { state: "visible", timeout: 10000 });
      openMs.push(Date.now() - t0);
      if (r === 0) {
        await page.keyboard.type("api-edge");
        await page.waitForFunction(
          `[...document.querySelectorAll('[cmdk-item]')].some(el => el.textContent.includes('api-edge') && !el.textContent.includes('svc-'))`,
          { timeout: 15000 },
        );
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
    check("⌘K finds an existing service by name", true, `"api-edge" surfaced`);
    check(`⌘K open→interactive median < ${100 * BAND}ms (target 100)`, median(openMs) < 100 * BAND, `median ${median(openMs)}ms of [${openMs.join(", ")}]`);
    {
      const catalogPrimes = log.filter((e) => e.path.includes("/catalog/entities")).length;
      check("⌘K lazy prime fires at most once", catalogPrimes <= 1, `saw ${catalogPrimes}`);
    }

    // Catalog @1000: virtualization + link semantics.
    await page.goto(`${base}/orgs/acme/catalog`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(`document.querySelectorAll('[data-row]').length > 5`, { timeout: 30000 });
    await page.waitForTimeout(2500);
    const domRows = await page.evaluate(() => document.querySelectorAll("[data-row]").length);
    const href = await page.evaluate(() => document.querySelector("[data-row]")?.getAttribute("href"));
    check(`catalog @${CATALOG_N}: ≤ 80 DOM rows (virtualized)`, domRows <= 80, `saw ${domRows}`);
    check("catalog rows are real links", typeof href === "string" && href.includes("/catalog/"), href ?? "(none)");

    await ctx.close();
  }

  console.log(failures.length === 0 ? "perf-budgets: ALL BUDGETS PASS" : `perf-budgets: ${failures.length} FAILED → ${failures.join(" | ")}`);
  return failures.length === 0 ? 0 : 1;
}
