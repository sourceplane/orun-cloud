# saas-mcp-server — Risks & Open Questions

Status: Draft. Locked decisions live in `README.md` § Status; this file carries
what is genuinely open, plus the risks worth naming before they bite.

## Open decisions

### D1 — OAuth client registration posture (MCP3) — ✅ Decided: Option A (2026-07-09)

**Decided at MCP3 implementation start: Option A — vetted public-client
allow-list; NO open dynamic client registration.** Rationale: open DCR on a
multi-tenant identity plane is an abuse surface (unbounded client rows,
phishing-shaped consent screens) with no near-term payoff — the interactive
clients that matter (Claude, Cursor, VS Code, plus a loopback dev client) are
enumerable and vetted by code review. As built: the static table lives in
`@saas/contracts` (`OAUTH_PUBLIC_CLIENTS` in `src/auth.ts`) so identity-worker
enforces and the console consent page renders from the same source; redirect
URIs match exactly, with the RFC 8252 §7.3 loopback any-port carve-out; an
unknown `client_id` or unregistered `redirect_uri` is rejected and the user is
never redirected there. PKCE S256 is mandatory and consent always renders the
requesting client's identity. Option B (DCR behind rate limits + unused-client
GC) remains the documented later path if ecosystem pressure demands it — it
would be additive on top of the same authorize/token endpoints.

Original options, for the record:

- **A. Vetted allow-list first** (Claude, Cursor, VS Code, generic loopback) —
  smallest surface, unblocks MCP3, DCR added later behind rate limits. *Taken.*
- **B. Open DCR with hard rate limits + short-lived unused-client GC** — most
  compatible, most to defend.

### D2 — Where `catalog_get_entity` reads from

SC0 (`saas-service-catalog`) defines `state.getOrgCatalogEntity`. If SC0 lands
first, the tool wraps it; if this epic gets there first, the tool emulates via
the OV6 list endpoint's filters and migrates later (contract-compatible either
way). Coordinate in whichever PR lands second — do **not** add a parallel
endpoint from this epic. *(Rechecked 2026-07-09: SC0 has not landed —
`StateClient` still exposes only `listOrgCatalogEntities`; MCP0 emulates.)*

### D3 — The free-vs-paid line (MCP6)

Is MCP access a paid capability (`feature.mcp_server`, like scorecards), free
with metered quota, or free-read/paid-write? Product call with pricing
implications; the entitlement seam and metering ship identically under all
three. Default posture until decided: **entitlement granted to all plans**
(seam live, gate open) so adoption isn't throttled during the epic.

### D4 — Per-key tool scoping (MCP7)

Least-privilege agent keys ideally scope to a tool subset, not just a role.
That needs key metadata the identity model may not carry yet. Options: ride
role-based scoping only (v1), or extend `PublicApiKey` with a `toolScopes`
claim (contracts + identity-worker change — its own PR). Defer until MCP7;
role-based is acceptable v1.

### D5 — Remote session state (MCP2)

Stateless Streamable HTTP is locked as the start. If subscriptions or
server-initiated messages become product-relevant (e.g. "notify me when the
run finishes"), a per-session Durable Object is the natural home — but that is
a deliberate later decision, not a default. Revisit when a concrete feature
demands it.

### D6 — MCP spec revision pinning

The protocol is young and moving. Pin the implemented revision (2025-06-18 or
newer at MCP0 start) in `packages/mcp` and record compatibility explicitly;
track upgrades as ordinary PRs with conformance runs (MCP8), not silent bumps.

## Risks

- **R1 — Tool sprawl / context-budget erosion.** The failure mode of every MCP
  server: each contributor adds "one more tool" until agents drown. Mitigated
  structurally: the locked ≤ 25 default budget, MCP8's CI guard, and the rule
  that new tools must displace or justify against existing ones.
- **R2 — Prompt-injection via platform data.** Catalog docs, audit entries, and
  log lines are attacker-influenceable text that agents will read. The server
  cannot sanitize semantics, but it must not *amplify*: tool outputs clearly
  frame data as data (structured JSON first), never echo instructions as
  server guidance, and write tools + destructive annotations keep the
  human-confirmation loop on the client side. Document the model explicitly in
  `packages/mcp` docs.
- **R3 — Secret exfiltration pressure.** Agents will ask for secret values;
  the platform's write-only invariant is the defense and it must stay
  transport-level (no tool exists), not policy-level (nothing to misconfigure).
  Any future "agent needs a secret" story goes through
  `saas-secret-manager`'s lease-bound run-scoped resolve (SM3,
  `how: agent-session`), never through MCP reads.
- **R4 — Coupling drift between tools and contracts.** Plain-TS contracts mean
  no runtime source of truth; the `satisfies` discipline plus MCP8 contract
  tests are the guard. If contracts ever gain runtime schemas, migrate
  immediately (design §5).
- **R5 — Auth divergence.** MCP3 must not mint a second token plane. The locked
  posture (reuse OP1 issuance/rotation/revocation) needs enforcement in review
  — the tempting shortcut is a bespoke token table on mcp-worker, and it is
  wrong.
- **R6 — api-edge rate limits punishing agents.** Agent sessions burst (one
  question → 5 tool calls → 5 edge requests). The per-identity 60/min default
  is probably fine; if not, tune the `mcp`-relevant route families or add an
  agent-aware bucket — measured first (PERF discipline), not preemptively.
- **R7 — Cross-repo confusion with `orun`'s MCP servers.** *Materialized and
  resolved (2026-07-09):* `orun mcp serve` shipped as the **work MCP**
  (orun-work WP5 — work-plane reads-with-evidence + the four mutators), and
  the ecosystem vocabulary is now fixed across `saas-agents` and `orun-work-v3`:
  **work MCP = orun's; platform MCP = this epic** (locked decision 8). Residual
  risk is tool-name overlap when one agent connects to both servers — keep this
  server's tool names free of work-plane vocabulary (`work_*`, `task_*`,
  `spec_*`) and coordinate any future shared nouns in the paired specs.
