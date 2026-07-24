# saas-agent-supervision — Implementation Status

**Status: SV0–SV1 landed.** Design complete (this doc set). This file is the
as-built record as SV0+ land — deltas from `design.md`, recorded amendments,
and tails, in the house convention.

| Milestone | Status | PRs | Notes |
|-----------|--------|-----|-------|
| SV0 — Origin taint | **done** | (this PR) | `origin {kind,ref?,label?,backfilled?}` on `AgentSession` (contracts + db model) and `agent_sessions.origin` JSONB (migration `920_agents_origin`, NOT NULL default `{kind:human}`, backfill infers parent⇒session / routine⇒routine / work⇒work / else human, all `backfilled:true`; expression index `(org_id, kind, ref)` backing the SV1 fold). Recorded at the AG9 door from the authenticated caller's context — never a body `origin` field. **Delta from design §2.2:** the door cannot structurally tell a Work-surface dispatch from a dispatcher-thread dispatch (both hit `POST /dispatch` with `{taskKey}`); resolved by a narrow first-party hint — chat-worker's `session_spawn` stamps `dispatchRef` (its `ch_…`) + `dispatchLabel`, its presence ⇒ `dispatch`, absence ⇒ `work`. Origin carries no authority (nothing gates on it), so the hint is cosmetic-only; `session`/`routine`/`human` stay door-authoritative and unforgeable via the body. **Delta:** backfill also infers `routine` (design §2.2 listed session/work/human only) — a `routine_id` row is more truthfully `routine` than `work`/`human`. Chip renders on fleet rows (non-linked — the row is already a link) and the cockpit header (deep-links to thread/work/parent). |
| SV1 — The roster fold | **done** | (this PR) | `GET …/agents/chats/:chatId/implementers` — a per-viewer, `session.read`-gated fold over sessions where `origin={kind:"dispatch", ref:chatId}`, split active/terminal, each active entry carrying its delegation tier (from the profile `interface`) and the AF6 needs-you fact (reused via `foldAttention` over the thread's own sessions). Returns `{chatId, active[], running, needsYou, done}` — the numerals the panel and the SV7 roll-up both read (one truth). SDK `agents.chatImplementers`. Console: `RosterPanel` side rail on the thread page (`workspace-chat.tsx` → two-column grid), snapshot-first + `refetchInterval` poll (the #607–609 liveness discipline), cards deep-link to the cockpit; terminal implementers fold to the `done` count only (they live on Implementers, SV4). **Delta from design §7.2:** "last-event age" is approximated by `startedAt ?? createdAt` (same as the fleet row) rather than a per-session events read — a precise last-event timestamp can come with SV3's digest. |
| SV2 — The dispatcher principal | not started | — | — |
| SV3 — The supervision loop | not started | — | — |
| SV4 — The IA (Agents / Implementers) | not started | — | — |
| SV5 — Takeover (control protocol) | not started | — | — |
| SV6 — Executor-agnostic supervision | not started | — | — |
| SV7 — Foreman brief + hardening | not started | — | — |
