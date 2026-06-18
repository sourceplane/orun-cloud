# saas-integrations — Implementation Status

As-built record. Epic promoted from the P5 holding register on 2026-06-11
(#302) after a verified-live stage walkthrough confirmed the rails (B1 OAuth,
B5 outbound webhooks, B11 entitlements, console shell).

## Summary

| ID | Status |
|----|--------|
| IG0 | ✅ Shipped (#307) — dormant foundation: spec 17, contracts, `180_integrations_foundation`, repo layer, worker skeleton; stage `/health` + migration apply verified post-merge |
| IG1 | ✅ Code complete (task 0139) — full connect machinery + console surface; live path 412-parks on D1 (GitHub App per environment) and unparks via secrets only, no code changes |
| IG2 | ✅ Code complete (task 0140) — full inbound pipeline, fixture-verified; cron attach waits on a freed Cloudflare cron slot, live traffic on D1 |
| IG3 | ✅ Code complete (task 0141) — repo links, branch→env maps, per-project event enrichment, console Git tab; live browsing on D1 + SECRET_ENCRYPTION_KEY |
| IG4 | ✅ Code complete (task 0142) — broker endpoint, SDK/CLI, recipes; live mint on D1 |
| IG5 | 🗓️ Planned |
| IG6 | 🗓️ Planned |
| IG7 | 🗓️ Planned (optional tail) |
| IG8 | 🗓️ Planned — inbound projection fields for the state bridge (additive `scm.*` slice; pairs with `saas-orun-platform` OV4) |
| IG9 | ✅ Code complete — write-back proxy (`integrations-worker /internal/github/writeback`: check-run / commit-status), driven by state-worker cron Phase 3 (`run-writeback.ts`); pairs with OV5. Live once D1 secrets are present. |

## Notes

- 2026-06-11: IG0 deploy follow-up — the first main-push deploy failed
  attaching the worker's cron schedule: the Cloudflare account is at its
  **5-cron-trigger limit** (webhooks-worker + metering-worker × stage/prod).
  Cron removed from `wrangler.jsonc` (the IG0 worker is dormant and does not
  need it). **The IG2 inbox drain requires a cron slot** — operator must
  upgrade the Workers plan or free a slot before IG2 ships.
  **RESOLVED 2026-06-11**: account upgraded to Workers Paid; the drain cron
  is attached. D1 stage secrets are provisioned (App registered, all eight
  worker secrets set) — stage live path unparked.

- **2026-06-18: D1 complete — GitHub App registered in prod too.** All eight
  `integrations-worker` secrets are now provisioned in stage AND prod, so every
  live GitHub path unparks in all environments with no code change:
  IG1 connect, IG2 inbound drain, IG3 repo links, IG4 token broker, and IG9/OV5
  write-back (state-worker already binds `INTEGRATIONS_WORKER` for stage+prod).
  Operational confirmation: `GET /health` on the prod integrations-worker
  reports `githubApp.configured: true`, and a PR on an installed repo produces a
  Check Run (OV5 done-when). OV4 object-graph authorship (Source/Catalog
  materialization) stays deferred to IG8 — it is NOT part of the D1 gate.

- 2026-06-11: IG0 (#307, task 0138) landed the bounded context with zero live
  behavior. No public route beyond `/health`; provider credentials are
  per-environment worker secrets (all unset — worker reports
  `githubApp.configured: false` on `/health`). Migration applies via the
  standard db-migrate apply profile on main push.
- Human gates: **D1** App registration per environment — ✅ **SATISFIED**
  (stage + prod, 2026-06-18); **D2** App permission set — ✅ satisfied as a
  registration prerequisite (`checks:write` / `statuses:write`). Still open:
  **D3** broker exposure posture (IG4), and **D4** plan placement for
  `feature.integrations.github` / `limit.repo_links` (until decided, the
  integration entitlement gate defaults closed, so the *connect* flow is denied
  until an org is explicitly granted — this gates onboarding, not the OV5
  write-back read-path for already-linked repos).
