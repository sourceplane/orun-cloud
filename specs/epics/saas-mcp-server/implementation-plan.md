# saas-mcp-server — Implementation Plan (MCP0–MCP10)

Status: ✅ Complete — all milestones MCP0–MCP8 shipped, plus the unification
phase MCP9–MCP10 (as-built record in `IMPLEMENTATION-STATUS.md`; orun-side
UM3 release in flight). Original sequencing rationale, for the record:
milestones are PR-sized coherent units; MCP0–MCP2 are human-independent and
ride entirely on shipped surfaces (SDK, state plane, OP1 auth, `sk_` API keys,
ES events, CD catalog docs) — **and are a named dependency of `saas-agents`
(AG6's in-sandbox runtime calls this server), so they led the queue**. The
spine was **MCP0 → MCP1 → MCP2**; MCP3 unlocked interactive remote clients,
everything else attached.

## MCP0 — Tool-plane foundation (`packages/mcp`) — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

The registry and the read-only core toolset, transport-agnostic.

- New `packages/mcp` (turbo-package `component.yaml`; deps: `@saas/sdk`,
  `@saas/contracts`, `@modelcontextprotocol/sdk`, `zod`).
- Registry: `defineTool({ name, description, inputSchema, outputSchema,
  annotations, handler })`; handlers receive `{ sdk, scope, limits }` — nothing
  else (the client-not-service invariant enforced by the type).
- Zod input/output schemas `satisfies`-checked against `@saas/contracts` types
  (design §5); tool descriptions written for model consumption.
- Scope resolver: explicit `workspace` (`ws_` | slug | `org_`) / `project`
  arguments; defaulting hook for transports that carry ambient context.
- Error mapper: SDK typed errors → MCP tool errors preserving the platform
  `code` set; `rate_limited` carries retry-after.
- The read toolset from design §4: `whoami`, `workspaces_list`,
  `projects_list`, `catalog_search`, `catalog_get_entity`, `catalog_read_doc`
  (CD's `listCatalogDocs`/`readCatalogDoc`), `runs_list`, `runs_get`,
  `runs_read_logs`, `audit_search`, `events_search` (ES's typed explorer),
  `security_events_list`, `access_explain`, `usage_summary`, `quota_check`,
  `billing_summary`, `config_read`, `secrets_list` (metadata only),
  `webhook_deliveries_list`.
- Output discipline: structured JSON + short text summary; cursors passed
  through; size caps on logs/docs with explicit truncation notices.
- Unit tests against a mocked transport; contract tests pinning each tool's
  wrapped route + DTO.

**Done when:** `packages/mcp` builds in the workspace with the full read
toolset registered; every tool's schemas compile `satisfies` the contract
types; a fixture-driven test suite exercises each tool's happy path, a
`forbidden` path, and a pagination path; no tool imports anything but the SDK;
typecheck/lint/test green.

## MCP1 — Local stdio server in the CLI — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- `orun-cloud mcp` command group in `packages/cli` (router registration in
  `cli-runner.ts`): `mcp serve` (stdio, default), `mcp tools` (list for
  humans), `--read-only`, `--workspace` override.
- Credential: the existing token store (keychain/file) — no new auth; a clear
  error pointing at `orun-cloud login` when absent.
- Ambient default: active org from `context/store.ts` pre-fills `workspace`
  defaults (still overridable per call).
- Docs: per-client install snippets (Claude Code `claude mcp add`, Cursor,
  VS Code) in `packages/cli/README.md`.

**Done when:** `orun-cloud mcp serve` speaks MCP over stdio against stage;
Claude Code configured with the snippet can answer "who owns <entity>?" and
"why did the last run fail?" end-to-end on a seeded org; `--read-only` is a
no-op for now (no write tools exist) but plumbs through; CLI tests cover
command registration + auth-missing behavior.

## MCP2 — Remote server (`apps/mcp-worker`) — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- New `apps/mcp-worker` (`cloudflare-worker-turbo` component; own hostname
  `mcp.<domain>`; stage + prod subscriptions; wrangler template per BF
  conventions — no hardcoded IDs).
- Streamable HTTP transport, **stateless-first** (no session DO; revisit only
  if subscriptions/server-push demand it — risks D5).
- Auth: `Authorization: Bearer` accepted and forwarded verbatim to api-edge via
  the SDK — `sk_` API keys work day one, and **AG6 agent-session tokens work by
  the same construction** (they are bearers for `sp_` principals; nothing to
  special-case). Unauthenticated requests get a 401 with `WWW-Authenticate`
  pointing at the (MCP3) resource metadata.
- Connection-level cap per principal (design §8); health route; structured
  request logs consistent with the other workers.
- `tests/mcp` component: conformance smoke against the worker in verify lanes.

**Done when:** an MCP client pointed at `mcp.<stage-domain>` with an org
API key lists tools and executes the read toolset; RBAC is demonstrably
enforced (a viewer-role key is `forbidden` on gated reads); the worker deploys
via `orun run` like every other component; no service bindings besides none —
the worker's only egress is the public api-edge URL.

## MCP3 — OAuth 2.1 for interactive remote clients — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- `apps/mcp-worker`: `/.well-known/oauth-protected-resource` (RFC 9728)
  naming identity-worker as the authorization server; bearer-token validation
  unchanged (the token is opaque to the worker — api-edge resolves it).
- `apps/identity-worker`: authorization-server metadata (RFC 8414),
  authorization endpoint with console-rendered consent (org selection =
  explicit tenancy), token + refresh endpoints reusing OP1 issuance/rotation
  (short-lived access JWT, rotating refresh, reuse-detection), PKCE S256
  mandatory.
- Client registration per the D1 decision (**decided 2026-07-09: Option A** —
  vetted public-client allow-list in `@saas/contracts`; no open DCR).
- Security events + audit entries for grants/revocations; console session
  security page lists MCP grants next to CLI sessions.

**Done when:** Claude (web) or another OAuth-capable MCP client completes the
authorization flow against stage without a pasted key; tokens expire and
refresh per OP1 semantics; revocation from the console kills the session;
`orun-cloud` CLI flows are untouched. *(Stage E2E with a live MCP client is a
deploy-lane follow-up, as with MCP1/MCP2 — the full flow is exercised in
tests end-to-end over the service layer.)*

## MCP4 — Resources & prompts — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- Resources: `catalog://{workspace}/{entityKey}` (overview markdown +
  identity/relations) and `runs://{workspace}/{project}/{runId}` (design §6).
- Prompts: `investigate_failed_run`, `access_review`, `usage_review`,
  `service_snapshot` — each a tested template over existing tools.

**Done when:** a client that supports resources can attach an entity overview
as context; each packaged prompt, run against a seeded org, produces a correct
walkthrough using only registered tools; prompt text lives in `packages/mcp`
with snapshot tests.

## MCP5 — Write tools (gated) — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- The §4 write set: `project_create`, `environment_create`, `flag_set`,
  `webhook_create`, `webhook_delivery_replay`, `member_invite`.
- Auto `Idempotency-Key` per logical attempt; caller-supplied keys accepted.
- Full MCP annotations on every tool (read-only tools included, retroactively).
- `--read-only` / per-connection read-only now excludes write tools from
  `tools/list`, not just execution.
- `x-client-surface: mcp` provenance header on all SDK calls (read + write);
  audit queries can segment agent traffic.

**Done when:** each write tool round-trips on stage under a builder-role key
and is `forbidden` under viewer; a duplicate call with the same idempotency key
replays instead of double-creating; read-only connections cannot see write
tools; every write lands in the audit log with mcp provenance visible.

## MCP6 — Metering + entitlement — ✅ Shipped (see IMPLEMENTATION-STATUS.md; D3 default posture: gate OPEN)

- `mcp.tool_call` usage events (org, tool, transport dimensions) through the
  standard metering ingestion; visible in usage summaries (dogfood:
  `usage_summary` reports MCP usage).
- `feature.mcp_server` entitlement checked at connect/`tools/list`; gated orgs
  receive an upgrade-shaped error consistent with U7 (product decision D3
  places the line; the seam ships regardless).
- Optional quota (`mcp.tool_call` monthly) via the existing quota machinery.
  *(As built: deliberately not configured — the metric meters from day one and
  a quota row can be added through the existing quota machinery with zero MCP
  changes once D3 lands.)*

**Done when:** tool calls appear in the org's usage summary within the
metering SLO; flipping the entitlement off yields the gated experience without
redeploy; nothing in `packages/mcp` knows about billing (the gate lives at the
transport/entitlement seam).

## MCP7 — Console "Connect an agent" surface — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- Console page (org scope): per-client install snippets (Claude Code, Cursor,
  VS Code, generic), remote URL + OAuth hint, API-key minting shortcut with a
  suggested least-privilege role, connection/security status (active MCP grants,
  recent agent traffic from audit).
- Per-key tool scoping if/when key metadata supports it (risks D4); otherwise
  role-based guidance only. *(D4 decided 2026-07-09: role-based only in v1 —
  see risks doc.)*
- Docs page mirroring the console content.

**Done when:** a new user can go from console → configured local agent in
under two minutes without leaving the page; the page reflects live grant/usage
state; copy passes the buyer-credibility bar (U-track conventions).

## MCP8 — Conformance + agent-eval harness — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- `tests/mcp`: contract tests pinning tool schemas to `@saas/contracts` DTOs;
  MCP Inspector (or equivalent protocol conformance) smoke in verify lanes for
  both transports.
- Agent-task evals: scripted scenarios ("find the owner of X", "diagnose run
  Y", "is org Z near quota?") scored on tool-call traces against a seeded org —
  the regression net for tool descriptions and curation.
- Tool-budget guard: CI fails if the default `tools/list` exceeds the locked
  budget (≤ 25 v1) or if aggregate schema size crosses a context-cost
  threshold.

**Done when:** conformance runs green in CI for stdio + remote; the eval suite
runs on demand with recorded traces; a PR that adds a 26th default tool or
bloats schemas fails loudly.

---

# Unification phase (D7) — MCP9–MCP10

Paired with `orun/specs/orun-mcp/` (UM0–UM3): the local distribution moves to
the orun Go binary; this repo's half is the contract export and the docs flip.

## MCP9 — Tool-manifest export — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- `packages/mcp` gains a manifest emitter: `tool-manifest.json` — for every
  registry tool: name, title, description, JSON-Schema input (the wire shape
  clients see), annotations (readOnly/destructive/idempotent). Deterministic
  serialization (sorted keys) so diffs are meaningful.
- The manifest is a committed artifact (`packages/mcp/tool-manifest.json`)
  with a freshness test (regenerating must produce a byte-identical file) —
  the `tests/mcp` budget guard now also validates the manifest against the
  live registry.
- Reserved top-level fields for resources/prompts (orun U-D2 consumes later).

**Done when:** the manifest regenerates deterministically, CI fails on
staleness, and `orun` can vendor the file as-is (UM1's parity test consumes
it without transformation).

## MCP10 — Docs flip to the orun binary — ✅ Shipped (see IMPLEMENTATION-STATUS.md)

- Console Connect page: snippets become `claude mcp add orun -- orun mcp serve`
  (+ Cursor/VS Code equivalents); install prerequisite becomes the orun
  binary + `orun auth login`; node-CLI snippets move to a collapsed
  "reference implementation" note.
- `apps/web-docs` MCP page and `packages/cli/README.md` updated the same way
  (the CLI README's MCP section is explicitly labeled the node reference
  implementation).
- Epic register rows note the unified distribution.

**Done when:** no doc points a user at `orun-cloud mcp serve` as the primary
path; the Connect page's copy-paste flow works end-to-end against a released
orun binary (UM3).
