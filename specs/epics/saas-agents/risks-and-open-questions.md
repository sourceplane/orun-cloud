# saas-agents — Risks & Open Questions

The gate items behind the README's `Gate` row, the decisions already made,
and the standing risks. Resolved items migrate from the first table to the
second.

## ⛔ Still open — confirm before building

| # | Question | Default lean |
|---|----------|--------------|
| A1 | **Daytona commercial/credential posture.** Which Daytona org + plan per environment (stage/prod)? Is a self-hosted Daytona (or the `local-docker` adapter hardened) acceptable as a fallback if the vendor relationship changes? | One managed Daytona org per environment, credential escrowed via `saas-secrets-sync`; keep the seam honest by maintaining the dev adapter's conformance parity so a second provider is an adapter, not a rescue project. |
| A2 | **Free-vs-paid line.** Is any agent usage in the free tier (e.g. N session-minutes/month) or is `feature.agents` paid-only from day one? Interacts with the MCP6 free-vs-paid decision. | Small free allowance (enough to feel the loop once: one design run + one implementation run), paid beyond; concurrency > 1 is paid. |
| A3 | **Autonomy ceiling.** May a workspace waive the human contract-ack gate (true `full` autonomy: spec created → agents design, ack their own contracts, implement)? | No in v1 — the contract ack is the one human gate autonomy never skips; revisit with eval data. The ladder's `full` still auto-spawns everything but blocks on ack. |
| A4 | **Model credential ownership.** Tenant-supplied model keys only (current design), or a platform-provided model pool with margin (Copilot-style premium requests)? | Tenant-supplied in v1 (zero platform model spend, no margin accounting); the metering seam (AG8) is where a pooled offering would bolt on later. |
| A5 | **Session data residency/retention.** Transcript chunks (R2) and session events: retention window, tenant-configurable purge, and whether suspended snapshots at the provider count as tenant data needing contractual cover. | 90-day default retention, org-configurable down to 7; snapshots destroyed at `expired`; provider DPA reviewed before prod (pairs with A1). |
| A6 | **Sidebar placement.** Agents after Activities (design §5) vs. adjacent to the future Work tab as one "delivery" cluster once WP1 ships. | After Activities now; revisit rail grouping when the Work tab lands (a nav-items reshuffle is cheap and test-covered). |

## ✅ Decisions made

| # | Decision | Resolution |
|---|----------|------------|
| D0 | **Runtime location (the v2 decision)** | The agent runtime is the **orun binary** (`orun/specs/orun-agents/`, AG0–AG4), not this worker. `apps/agents-worker` provisions/relays/dispatches; it does not supervise the agent. v1's `packages/agent-runner` cloud supervisor is deleted. A cloud session is `orun agent serve` in a box. |
| D1 | Compute location | External sandbox provider behind `SandboxProvider`; Daytona first; never on Cloudflare Workers. Dev adapter (`local-docker`) + recorded fixtures keep CI vendor-free. |
| D2 | Agent identity | Existing membership service principals with a mandatory responsible owner; **no new identity or token plane** — session tokens are short-TTL bearers for the principal with a `sessionId` claim, lease-coupled refresh (OP1 + workflow-token patterns composed). |
| D3 | Platform access path | Sessions are clients: everything re-enters api-edge / mcp-worker with the session credential. The runtime holds no policy logic and proxies no privileged calls. |
| D4 | Work-plane contact surface | Exactly the four agent tools + `assign` (dispatch) + observations from git. No status writes, no new mutators, no work-schema changes. Autonomy policy lives in the agents context, not in work truth. |
| D5 | Session state vs. work state | Control-plane session states (provisioning/running/suspended/…) are stored infrastructure facts, categorically distinct from derived work rungs; the UI renders them side by side, never merged. |
| D6 | Harness / driver | The pluggable driver seam (`AgentDriver`, Claude Code first) and its conformance oracle live in the **runtime** (orun AG4), not here — this epic consumes whatever the base snapshot ships. |
| D7 | Streaming/partition architecture | Per-session Durable Object as live **relay** + partition unit (not a supervisor); it mirrors orun's streamed session events to R2 + `session_relay` for console reads and carries the steer/approval return queue. The system of record is the sealed `AgentSessionSnapshot` in orun's graph; the DO is reconstructible from storage. |
| D8 | Repo write path | IG4 token-broker installation tokens; PRs authored by the GitHub App, responsible owner attributed; task-keyed branches so WP2's claim join needs no new protocol. |
| D9 | Secrets | Only through the SM3 lease-bound resolve with `how: agent-session`; nothing baked in snapshots; redaction at capture (SD-8); credentials never survive suspend. |

## Risks

| Risk | Mitigation |
|------|------------|
| **Provider coupling** — Daytona API drift or outage strands the plane. | Narrow six-method seam; adapter conformance fixtures run against both adapters; sessions are cattle (event log + snapshots), so a provider outage kills liveness, not history; degradation is "cannot spawn/resume," never data loss. |
| **Prompt injection via repo content or work items** — a hostile README steers the agent. | Layered containment (design §10): egress allowlist ∩ deny-by-default RBAC ∩ tool policy asks ∩ no status surface ∩ PR review + gates. Injection fixtures are a CI gate (AG9). Residual risk is bounded to "bad PR opened," which the human gate already absorbs. |
| **Cost runaway** — looping agent burns sandbox minutes/tokens. | Leases + sweeps, concurrency caps, per-task retry budgets with park-and-comment, live cost on the session page, one-click kill revoking the refresh chain. |
| **Cross-repo runtime dependency** — the cloud control plane (AG5–AG11) can't host anything until the orun runtime (AG0–AG4) exists. | The runtime is entirely human-independent and demoable on a laptop with no cloud, so it can land first and fast; the cloud team integrates against `orun agent serve`, a binary they can run locally (the seam is testable without Daytona). Track the runtime in `orun/specs/orun-agents/`, not duplicated here. |
| **Cross-epic schedule coupling** — AG8/AG9 depend on WP1/WP2/WP4/WP5 and MCP0–MCP2 landing elsewhere. | The plan fronts AG5–AG7 (hosted interactive sessions, no WP/MCP dependency, independently demoable); AG8+ tracks the WP/MCP epics' own registers rather than duplicating their milestones here. |
| **Trust gap** — buyers fear an autonomous agent with workspace access. | The informed-consent spawn dialog (exact principal, scopes, secrets, tools); everything attributable (responsible owner in every audit row); the work plane's structural honesty ("agents cannot assert progress") as the headline property, not a footnote. |
| **Two agent surfaces confuse users** — platform-run sessions (this epic) vs. bring-your-own MCP clients (`saas-mcp-server`). | One console story: the MCP7 "Connect an agent" page and the Agents tab cross-link; vocabulary keeps *running* (sessions, here) distinct from *connecting* (MCP, there). |

## Non-blocking notes

- The repo's own `agents/` + `ai/` orchestration loop is the standing
  prototype; AG6/AG7 eval fixtures should be distilled from its real
  transcripts rather than invented.
- Warm per-repo snapshots (dependency-installed) are a deliberate
  later optimization — the base-snapshot contract (§2.2) already permits
  them without interface change.
- A `fix run` on flaky gates could thrash; the retry budget plus WP's
  gate-evidence reads make "flaky vs. red" distinguishable later — park
  until evidence exists.
