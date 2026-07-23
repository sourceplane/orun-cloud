# Architect Roadmap — Program Register

Status: Normative direction. Sequencing is the Orchestrator's call.

## Purpose

This is the **cross-epic index** for the Orun Cloud SaaS starter. It groups the
forward direction into clusters — **Baseline SaaS (B)**, **UI / Design (U)**,
**Product Areas (P)**, and **Performance (PERF)** — and points at the epic folders
that own the per-milestone detail. Read this to understand which leg a candidate
task belongs to and where its durable plan lives.

The per-milestone bodies, status, and as-built records now live under
[`epics/`](./epics/) (one folder per cluster). This file keeps only the one-line
index + cross-epic sequencing. The per-component contracts under
[`components/`](./components/) remain the contract; the architectural rules live in
[`core/`](./core/).

The architect-style ground rules:

- Trust code reality over stale docs.
- Prefer the largest coherent reviewable unit with one primary outcome.
- Bounded contexts are non-negotiable; deployment count is.
- Every product surface must look credible to an external buyer before being
  declared done.
- Every internal seam must be extraction-safe before being declared done.

## Epic index

| Cluster | Epic | Status | What it owns |
|---------|------|--------|--------------|
| **B** | [`epics/saas-baseline/`](./epics/saas-baseline/) | In progress | B1 auth · B2 notifications · B3 idempotency/rate-limit · B4 SDK/CLI · B5 webhooks · B6 billing UX · B7 audit UX · B8 admin · B9 entitlement observability · B10 SSO/SCIM |
| **U** | [`epics/saas-console-ux/`](./epics/saas-console-ux/) | In progress | U1 App Router · U2 design system · U3 URL scope · U4 empty states · U5 Cmd-K · U6 forms · U7 upgrade UX · U8 skeleton/optimistic · U9 white-label · U10 SDK client · U11 Vercel-standard completion |
| **PERF** | [`epics/saas-performance/`](./epics/saas-performance/) | In progress | PERF1–PERF14 latency ladder (PERF1–5 + PERF6 core shipped + verified; PERF6b/PERF7–9 planned; PERF10–14 added by the 2026-06-08 second full-surface audit). Measurement record + RCA + cost notes in the epic's `design.md`. |
| **P2** | [`epics/saas-resources-runtime/`](./epics/saas-resources-runtime/) | Draft (not started) | The moat: manifest-driven resources + runtime orchestration (components 06 + 08). |
| **B** (billing platform) | [`epics/saas-multi-org-billing/`](./epics/saas-multi-org-billing/) | In progress | Datadog-style multi-org ownership (default single org; more orgs purchased; billing from the default/parent org) + the `billing-provider-abstraction` sub-epic (Polar first, Stripe/others by config). Extends B6 + B11. |
| **BF** | [`epics/saas-bootstrap-factory/`](./epics/saas-bootstrap-factory/) | Draft (not started) | Make the starter instantiable: BF0–BF2 truth + typed params · BF3–BF6 config indirection + deploy-time wiring (no committed resource IDs) · BF7–BF9 domain/foundation/preflight · BF10 OCI stack consumption · BF13 acme rehearsal. **The Blueprint/Instance contracts + instantiator + upgrade engine (was BF11/BF12/BF14) moved to the orun binary → `orun/specs/orun-scaffolding/`** (unified scaffolding & instantiation); this repo now only authors its `blueprint.yaml` (orun SCF7). |
| **PX** | [`epics/saas-product-experience/`](./epics/saas-product-experience/) | In progress | Close the backend-ahead-of-surface gap: PX1 console truth/papercuts · PX2 config/flags/secrets UI · PX3 notification preferences e2e · PX4 rename lifecycle · PX5 first-run onboarding · PX6 Cmd-K resource search. All human-independent. |
| **SI** | [`epics/_archive/saas-settings-ia/`](./epics/_archive/saas-settings-ia/) | ✅ Shipped (archived) | Console **information architecture** — made navigation mirror the shipped `You → Account → Workspace` scope model: SI1 re-file the mis-scoped surfaces (Billing→Account · Sessions→personal · disambiguate the two Notifications) · SI2 doorways (settings follow the switcher) · SI3 one **People & Access** surface (Members·Pending·Roles·Access; invitations become Pending; inline role edit; access provenance) · SI4 Roles as a permission-matrix destination (custom-roles seam for **TG**) · SI5 end the tenant/person "account" collision (`/account`→`/you`). Relabel & regroup only — no tables, no tenancy change. SI1–SI5 shipped (PRs #365–#369). |
| **IG** | [`epics/saas-integrations/`](./epics/saas-integrations/) | Draft | Pluggable integrations platform (promotes P5), GitHub App first: IG0 foundation · IG1 connect flow · IG2 inbound `scm.*` events · IG3 repo links · IG4 token broker · IG5 console · IG6 lifecycle hardening · IG7 pluggability/instance proof · IG8 inbound projection fields · IG9 write-back proxy (the Orun Cloud v2 state bridge — `epics/saas-integrations/bridge-to-state.md`). |
| **IH** | [`epics/saas-integration-hub/`](./epics/saas-integration-hub/) | Draft | The ghost cards become real — three providers, three archetypes, one capability-typed seam over IG: IH0 foundation (capability seam + `700_integration_hub_foundation`: parent-credential custody, mint ledger, provider facts) · IH1 Slack OAuth connect (`team_id ↔ org_id` keystone) · IH2 `slack_app` channel (picker, event-group message *updating*) · IH3 Slack inbound (`messaging.*`, `/orun` command, ack/mute actions) · IH4 provider-generic credential broker (scope templates, mint ledger; IG4 re-expressed) · IH5 Cloudflare (parent-token custody → short-TTL scoped child tokens) · IH6 Supabase (OAuth → short-lived access) · IH7 **brokered secrets** (mint-at-resolve on the SM3 lease-bound path; zero orun-CLI change) · IH8 marketplace console · IH9 hardening/reconcile/BF params · IH10 dormant AWS/Discord proof. |
| **ES** | [`epics/saas-event-streaming/`](./epics/saas-event-streaming/) | In progress | Datadog-grade event pipeline over the canonical `event_log` (pays spec 09's router debt; no new worker, no queues): ES0 typed event catalog + foundation · ES1 shared cursor lanes + dead-letter/replay (webhooks lane adopts) · ES2 notification rules (globs · severity · attribute filters · throttling) · ES3 channel seam + Slack (incoming webhooks) + async retry · ES4 dedup/correlation into event groups (`scm.*` × `state.run.*`) · ES5 custom event ingest + SDK/CLI · ES6 console Events explorer + rules/channels UX · ES7 retention/fairness/storm breaker. |
| **SS** | [`epics/saas-secrets-sync/`](./epics/saas-secrets-sync/) | Draft (SS0/SS1 in progress) | One write path for every secret: SS0 escrow convention + manifest · SS1 drift checker enforced in verify lanes · SS2 deploy-lane sync · SS3 escrow seeding (human-gated) · SS4 Secrets Store for shared keys · SS5 rotation runbook + BF9 preflight. |
| **RF** | [`epics/saas-repo-federation/`](./epics/saas-repo-federation/) | Draft (not started) | Many repos, one golden path — federate the monorepo without any repo ceasing to be an Orun golden-path repo: RF0 publish `stack-tectonic` to GHCR + flip `intent.yaml` composition source `dir→oci` (BF10) · RF1 versioned `@saas/*` kernel (ends `workspace:*`-only) · RF2 federation contract (cross-repo wiring guard + SCC-safe topology + `components.mjs` per-repo scaffolder) · RF3 extract frontend (public-API-only) · RF4 extract infra · RF5 extract commerce group (billing·metering·notifications·webhooks; SCC intact) · RF6 reusable CI workflow + per-repo state + upstream-sync (BF11–14). Extract the substrate, keep the platform forkable. |
| **BM** | [`epics/saas-orun-backend-merge/`](./epics/saas-orun-backend-merge/) | Ready | Replace `orun-backend`'s relational coordination plane with **native event-sourced coordination** (DO-sharded per run, Postgres projection, content-addressed `job-result` memoization), cross-repo with `orun` (**NC**): BM0 contract v2 + vendor · BM1 object kinds + memoization · BM2 per-run Durable-Object event log (conditional append) · BM3 projections · BM4 CLI adoption · BM5 auth/quota · BM6 cutover · BM7 decommission. Greenfield (no permanent backcompat); `orun-backend` is the parity reference. Extends OP/OV. |
| **SC** | [`epics/saas-service-catalog/`](./epics/saas-service-catalog/) | Draft | Org catalog → internal developer portal: SC0 drill-down foundation (entity route + contextual sidebar + drawer) · SC1 dependency graph · SC2 deployments · SC3 activity · SC4 insights · SC5 scorecards · SC6 ownership/on-call · SC7 golden-path scaffolder · SC8 index polish. Every enrichment is a computed overlay, git-authored snapshot, separated operational annotation, or git-writing scaffolder — never console-authored catalog content (`components/18-state.md`). |
| **WID** | [`epics/saas-workspace-id/`](./epics/saas-workspace-id/) | Draft | Durable public **Workspace ID** (`ws_` + Crockford base32, immutable `public_ref`) + the **Account-layer** evolution: WID1 id/glossary · WID2 schema+mint · WID3 resolver (`ws_\|slug\|org_`) · WID4 public surface + `accountId`/`kind` + `api-guidelines` D2/D4 amend · WID5 SDK/CLI/console/tokens/`intent.yaml` · WID6 account RBAC (`scope_kind='account'` + cascade) · WID7 scope-resolution chain + override/locked config · WID8 first-class `accounts` entity (Stage 2, deferred). Additive over **WS**/**MO**; `org_<hex>` retained indefinitely. |
| **TM** | [`epics/saas-teams/`](./epics/saas-teams/) | Draft | Account-owned **Teams as principals** (the access-grant slice of the `teams-*` program): TM1 model (`teams`+`team_members`) · TM2 grants via `role_assignments` (`subject_type='team'`) · TM3 authz-context fact expansion (engine unchanged) · TM4 management surfaces + `team.*` RBAC + audit · TM5 PERF note (actor cache holds no team data) · TM6 effective-access + provenance. Account-scope grants cascade to all (incl. future) workspaces. Principal-group, **not** a hierarchy level. Builds on **WID6** (shipped). |
| **TEAMS** | [`epics/teams-platform/`](./epics/teams-platform/) | Draft (program) | **World-class Teams** program over **TM** — Team as the product's organizing primitive across three planes, no tenancy remodel. **TF** teams-foundation (entity + handle + team-roles + provenance) · **TO** teams-ownership (owner→team **resolver** respecting `18-state`; My Teams/My Services) · **TH** teams-hub (Account Hub surface + Team Page + cross-workspace fan-out) · **TC** teams-collaboration (team notification target + `@team` + on-call defaults) · **TG** teams-governance (SCIM group→team ⛔B10 · restriction/ABAC decision · custom roles · access reviews). Keystones: the ownership resolver + thickening the account **surface** (not the tree). Sequencing: TF→TO→{TH,TC}→TG. |
| **MCP** | [`epics/saas-mcp-server/`](./epics/saas-mcp-server/) | ✅ Shipped (MCP0–MCP10; **AG** dependency live) · **unification phase** (D7: local distribution → the orun binary; pairs `orun/specs/orun-mcp/`): **MCP9–MCP10 shipped; orun UM0–UM2 shipped; UM3 release in flight** | The AI-agent client surface (promotes the agent-surface half of P7; the **platform MCP**, distinct from orun's shipped work MCP): MCP0 tool plane (`packages/mcp`, 25/25 task-shaped tools over SDK, CI-guarded budget) · MCP1 stdio via CLI · MCP2 remote worker (`sk_` keys) · MCP3 OAuth 2.1 over OP1 · MCP4 resources/prompts · MCP5 gated writes (idempotent, annotated, audited) · MCP6 metering + `feature.mcp_server` (D3 free-vs-paid still open; shipped open-gate) · MCP7 console Connect page · MCP8 conformance + agent evals (`tests/mcp`) · MCP9 tool-manifest export (orun vendors it verbatim) · MCP10 docs flip (orun binary primary — `orun mcp serve`, 25 platform + 9 work tools in one server; node CLI the labeled reference implementation). Invariant held: a client of the public API, never a fourth plane — RBAC/rate-limits/audit unchanged. Deploy-lane follow-ups: `mcp.<domain>` hostname, live-stage E2E smokes. |
| **AG** | [`epics/saas-agents/`](./epics/saas-agents/) + [`orun/specs/orun-agents/`](../../orun/specs/orun-agents/) | Draft | The agent framework, cross-repo. **orun owns the runtime (AG0–AG4):** the `AgentType`/`AgentSession` object kinds (`agents/*.md` sealed like `SpecSnapshot`), the `internal/agent` delegation loop, the `AgentDriver` seam (Claude Code first), base literacy, the TUI Agent mode, `orun agent run/serve`. **orun-cloud owns the control plane (AG5–AG11):** AG5 sandbox plane (Daytona + dev adapter) · AG6 session identity + `orun agent serve` ↔ per-session DO relay · AG7 console Agents tab · AG8 design runs (Spec → epic files + contracts via `catalog affected`) · AG9 dispatch-is-assignment autonomy ladder · AG10 metering/entitlement · AG11 hardening + evals. |
| **P1, P3–P7** | [`epics/saas-product-areas/`](./epics/saas-product-areas/) | Holding register | P1 promote-flow · P3 observability · P4 notification inbox · P5 marketplace (⬆ promoted → `saas-integrations`) · P6 changelog/status · P7 AI-native. |

For the status legend (`Draft → In progress → ✅ Shipped → ⛔ Blocked → Closed`),
see [`README.md`](./README.md).

## Cross-epic sequencing notes for the Orchestrator

- **B1 + B2 are the highest-leverage baseline pair** — together they kill the
  "demo-only auth" problem and unblock invitations + billing receipts + alerts.
  Order is **B2 → B1** because B1 needs real email. (Both currently have
  human-blocked tails — see the `saas-baseline` risks.)
- **U-track** is structurally complete (U1–U11) and continues as incremental
  polish under `saas-console-ux`; after U10, the SDK client is in place.
- **P2 is the differentiator and the largest single program.** Do not start it
  before **B4 (SDK)** — the resources contract should ship as a typed client
  surface from day one.
- **B6 (Stripe)** waited on **U7** (shipped) so upgrade CTAs have somewhere to go;
  it is now blocked only on Stripe creds. Its provider work is being generalized
  into the **`saas-multi-org-billing` / `billing-provider-abstraction`** sub-epic:
  a swappable provider adapter shipping **Polar first**, switchable to Stripe (or
  others) by config rather than rewrite.
- **`saas-multi-org-billing`** is a new billing-platform epic (not part of the
  B1–B10 ladder). Its **MO1** dormant seam is human-independent and safe to land
  early; paid multi-org (MO2+) is gated on the product/credential decisions in
  the epic's `risks-and-open-questions.md`. Build the Polar adapter (sub-epic
  BP0/BP1) in parallel with MO1.
- **Prefer B / U over P** until baseline buyer-credibility is reached. The
  platform's defining bet is in P2, but a customer cannot reach P2 without B1–B4
  being credible.
- **PERF** is orthogonal and ongoing; PERF5 took warm org-scoped reads/writes to
  ~55–65ms p50 on prod and the PERF6 core made the edge gate measurable. Next is
  PERF7 (cold starts), with PERF6b (AE dashboards) as a cheap follow-on.
- **PX (product experience)** is the highest-leverage human-independent cluster
  while B1/B6/B10 stay credential-blocked: every PX milestone turns an
  already-live backend capability into buyer-visible product (config/flags UI,
  notification preferences, rename, onboarding). PX1 (truth/papercuts) goes
  first to set the visual bar; PX2/PX3 ride on live backends; nothing in PX
  competes with BF or PERF for files.
- **IG (integrations)** promotes P5 without waiting for P2: a repo link is a
  plain record now, re-projectable as a manifested resource when P2 lands. It
  rides shipped rails (B1 OAuth patterns, B5 event_log→webhooks fan-out, B11
  entitlements) and adds the platform's first unauthenticated edge ingress
  (design §5) — the only genuinely new trust path. IG0 (foundation) and IG2's
  worker-side fixtures are human-independent; live paths are gated on
  per-environment GitHub App registration (the epic's D1, same
  park-and-continue posture as the Polar/Stripe credential gates).
- **ES (event streaming)** is the read-side twin of IG's intake and the payoff
  of spec 09's deferred router: intake is already solved (one canonical
  `event_log`; IG2 lands `scm.*` on it), so ES builds everything downstream —
  catalog, lanes, rules, Slack, dedup/correlation, explorer. The whole spine is
  human-independent (Slack ships via credential-free incoming webhooks; the
  OAuth Slack App and pricing tiers are the only parked decisions). ES0/ES1
  also retire two latent defects (the notifications→events silent-404 emit;
  the private webhooks cursor becoming the shared lane contract). Sequencing:
  after IG2 is live, ES is the highest-leverage way to make integration events
  *visible and actionable*; TC's team notification targets plug into ES's rule
  engine rather than building their own.
- **IH (integration hub)** is the payoff milestone for three shipped programs
  at once: it promotes IG's dormant pluggability proof into live providers,
  resolves ES's parked D1 (the OAuth Slack App) as the additive `slack_app`
  channel kind ES designed for, and gives the secret manager's reserved
  `provider`-envelope seam its first real occupant (brokered secrets:
  Cloudflare/Supabase credentials minted at lease-bound resolve, zero orun-CLI
  change). Two parallel spines after IH0: messaging (IH1→IH3, gated on Slack
  App registration per env) and broker (IH4→IH7; Cloudflare first — no OAuth
  app needed, fastest path to the "deploy a Worker with no stored key" e2e).
  IH7's live path waits on SM3 (the resolve endpoint) — sequence the
  `saas-secret-manager` spine accordingly; everything else is fixture-first
  and park-and-continue, the IG/Polar posture. Tenancy (IT scope/share-mode)
  and entitlement gating are consumed as-is; no new tenancy machinery, no new
  delivery engine, no queues.
- **SC (service catalog)** evolves OP's shipped OV7 catalog into an internal
  developer portal without touching the read-model contract: SC0–SC4 (drill-down
  route + contextual sidebar + drawer, dependency graph, deployments/activity
  tabs, computed insights) are human-independent and ride on shipped data or
  computed-on-read overlays. SC5 (scorecards) and SC6 (ownership/on-call) carry
  product decisions (rule format; ownership source) but stay invariant-safe as
  sibling overlays. SC7 (golden-path scaffolder) is the detachable, highest-lift
  tail — it writes git via IG4, never the catalog, and is a sub-epic candidate.
  Highest-leverage first slice: **SC0 + SC1 + SC4**.
- **BM (orun-backend merge)** is a **greenfield, cross-repo** redesign, not a
  compat exercise: it replaces `orun-backend`'s relational `runs/jobs/claim`
  plane with coordination native to the content-addressed store — a run is an
  append-only **event stream** rooted at `planDigest → sourceHash`, claims are
  **conditional appends** sharded **per run on a Durable Object**, and Postgres
  becomes a **delayed projection**. This is also the scaling answer (the per-run
  DO is the partition unit; heartbeats/claims leave the shared primary) and the
  provenance answer (`sourceHash → plan → job → result` Merkle chain, with
  content-addressed `job-result` memoization). It **pairs with `orun`'s NC
  cluster** on one vendored contract (`coordination-api.md`); the CLI moves to an
  append/fold/read-the-log client, so there is **no permanent backward-compat
  surface** — only a transient read-only drain bridge at BM6 cutover.
  `orun-backend` is the parity reference for the claim/lease invariants, never
  lifted in. BM0–BM3 (contract, object kinds, the DO event log, projections) are
  the human-independent server spine; BM4 co-develops with NC; only BM6 (cutover)
  and BM7 (decommission) need an operator call. Open product/security calls: D1
  memoization scope (per-project → org-shared → global) and D2 `jobInputHash`
  definition.
- **MCP (agent client surface)** is additive and rides entirely on shipped
  rails: MCP0–MCP2 (tool plane over the SDK, stdio via the CLI, remote worker on
  `sk_` keys) are human-independent and deliver the highest-leverage slice — a
  local agent that can query the catalog and diagnose a failed run. MCP3 (OAuth)
  reuses OP1 issuance (no second token plane — the epic's R5), MCP6's
  entitlement seam mirrors the SC scorecards gate, and `catalog_get_entity`
  coordinates with SC0 (whichever lands second adapts — MCP risks D2). Nothing
  in MCP competes with B/U/PERF for files; it turns already-live backend
  capability into a new client population, the same posture as PX. **AG has
  made MCP0–MCP2 critical-path** (the in-sandbox runtime calls the platform
  MCP with its AG6 session token); ES/CD shipping gave the toolset richer
  backends (`events_search`, `catalog_read_doc`), and the work-plane boundary
  is settled: work tools live in orun's work MCP, never here (MCP decision 8).
- **AG (agents)** is the platform's agent bet and the consumer that makes the
  object model + WP + MCP compound — and its defining decision is **where the
  runtime lives**. The runtime is the **orun binary**, not a cloud worker
  (obeying orun's local-first constitution): `agents/*.md` seals to a
  content-addressed `AgentTypeSnapshot` in the same object graph as sources,
  catalogs, and specs; the delegation loop, the `AgentDriver` seam (Claude Code
  first, any binary via a conformance oracle), and session sealing are all in
  `internal/agent`. A cloud session is that same binary (`orun agent serve`) in
  a Daytona box; a laptop session (`orun agent`, a new TUI mode) is the whole
  framework with no cloud. So sequencing is: **orun AG0–AG4 (the runtime) land
  first and entirely human-independently** (a local agent runs against a local
  `.orun/` with the env model key); the **cloud AG5–AG11** host and govern it —
  AG5–AG7 (sandbox + identity + console) need no WP/MCP progress, only AG8/AG9
  (design/dispatch) wait on WP1/WP2/WP4/WP5 and MCP0–MCP2. AG1's snapshot seal
  shares plumbing with WP4's `spec pull` — co-develop them. Credential gates
  (Daytona, model keys) block live paths only; the `local-docker` dev adapter +
  fixtures keep the cloud milestones mergeable (the IG/Polar park-and-continue
  posture). This is the moat spend: a Merkle chain from intent to production
  with the agent's inputs and actions as content, which no bolt-on agent
  product can copy without orun's graph underneath.
- **BF (bootstrap factory)** is orthogonal to B/U/P and mostly human-independent:
  BF0–BF2 (docs truth, infra `dependsOn` edges, parameterizing the Terraform +
  stack identity surface) are safe to schedule any time and improve this
  instance on their own. The keystone is BF5/BF6 (Terraform wiring manifest +
  deploy-time binding resolution — removes all committed resource IDs). Only
  BF8 (fresh-account foundation) and BF13 (acme rehearsal) are human-gated; park
  them per the deferred-decision protocol until the epic's human-help register
  is supplied.

## What this document is not

- Not a delivery-date list and not a Gantt chart.
- Not the per-milestone plan — that lives in each `epics/<epic>/implementation-plan.md`.
- Not a substitute for the per-component contracts under
  [`components/*.md`](./components/) — those remain the contract.
- Not the as-built record — that lives in each `epics/<epic>/IMPLEMENTATION-STATUS.md`.
- Not a frozen plan. The Orchestrator may propose reordering, splits, merges, or
  new epics via the spec-change-proposal flow in `agents/orchestrator.md`.
