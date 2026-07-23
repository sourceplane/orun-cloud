# saas-integration-registry — Risks & Open Questions

## Decisions needing a human (IR-D#)

| # | Decision | Default recommendation |
|---|----------|------------------------|
| **IR-D1** | Canonical route segment: `/integrations/{provider}` with shape-resolved `[slug]` (provider ids vs `int_…`), or keep `/integrations/providers/{id}` as canonical to avoid the dual-shape segment? | **Shape-resolved `[slug]`.** Provider ids are a closed, lint-guarded set that can never collide with the `int_` prefix; the shorter URL is the one users will type/share for years. The resolver is ~20 lines and fully testable. |
| **IR-D2** | Does the hub keep an "All connections" flat view (ops-style table across providers) in addition to category cards? | **Yes, as a toggle** — cheap (one table over the existing list read) and it preserves the operational view `connection-detail` links relied on. |
| **IR-D3** | IR5 migration window: redirect `settings/ai-providers` immediately or run both surfaces for a release? | **Redirect immediately** (the shipped `settings/integrations` stub precedent). The panel and the space call the same endpoints post-migration; running both risks divergent writes. Needs product sign-off because it moves a settings surface users may have bookmarked in onboarding docs. |
| **IR-D4** | Re-homed AI connections inherit IT tenancy — should account-shared AI keys be *offered* at migration, or default workspace-private with share as opt-in? | **Workspace-private default, share opt-in.** Sharing an org-wide Anthropic key is a real cost/quota decision; make it explicit. |
| **IR-D5** | CLI verb trees: is the offline cache per-org under `.orun/` acceptable (staleness vs offline help), and what TTL? | **Cache with 24h soft TTL** + `orun integrations sync`; invocation always server-validates, so staleness affects help text only. |
| **IR-D6** | Do `roadmap` manifests render in the hub for all orgs, or per-plan? | **All orgs** — the roadmap strip is marketing surface; entitlement gating applies only at `live`. |

## Engineering risks (R#)

- **R1 — Registry read on the console critical path.** The hub now blocks on
  one more read. Mitigations: ETag + long staleTime, descriptor payload kept
  lean (no template bodies — templates stay on their own read), SP-A5
  degradation (disabled entry points, never a fallback catalog), and the
  read rides the existing api-edge facade (no new hop). Perf budget: the
  read must stay under the IC list-hygiene budgets; measured in IR1.
- **R2 — The `[slug]` resolver becomes a junk drawer.** Guard: the resolver
  handles exactly two shapes (provider id set from contracts; `int_` prefix)
  and 404s everything else; a route test enumerates the full provider-id set
  against reserved next segments (`connections`, and nothing else).
- **R3 — IR5 double-write/divergence during re-home.** The migration turns
  `agents.provider_connections` into facts *in the same PR* that re-points
  agents-worker reads through the compat view; the danger window is a
  deploy-order race (worker deployed before migration). Mitigation: view is
  created by the migration first, worker reads tolerate both shapes for one
  release (dual-read, single-write), rollback documented as view-flip.
  Custody rows are never rewritten — checksummed before/after.
- **R4 — Wizard regression risk on shipped SP flows.** The SP2/SP4 surfaces
  are days old with fresh muscle memory. Mitigation: the wizard reuses the
  SP1 primitives and write hooks unchanged (contract-tested), ships behind a
  per-org flag for one release, and the old dialog remains mountable in
  storybook fixtures until removal.
- **R5 — Manifest/adapter drift** — the exact disease this epic cures could
  recur one level up. The conformance lint (IR0) is therefore a *milestone
  gate*, not an afterthought: no manifest merges without it. CI also greps
  the console for provider-id literals outside contracts/fixtures.
- **R6 — CLI descriptor abuse surface.** A malicious/buggy manifest could
  try to bind verbs to unintended operations. Guards: `invoke.op` allowlist
  is compile-time in this repo (IR7 test), the orun renderer refuses ops
  outside its generated SDK surface, and descriptors cannot express raw
  URLs, headers, or exec.
- **R7 — Route-collision with future top-level integration pages.** Reserved
  segment list lives beside the provider-id enum in contracts; adding a
  provider id that collides with a reserved word fails the same lint.

## Explicitly deferred

- Inbound events for Cloudflare/Supabase (`infra.*`) — still parked per IH.
- Brokered-secret materialization — still resolve-only (SP posture).
- Per-user AI keys (personal overlays for provider keys) — belongs with the
  personal-overlay secrets model; named, not designed.
- Marketplace metadata (pricing, publisher, install counts) on manifests —
  the manifest gets them only when a real marketplace program exists.
- Slack per-user identity mapping (IH D6) — unchanged by IR.
