# saas-agents-live — Risks & open questions

## Risks

| # | Risk | Mitigation |
|---|---|---|
| L1 | **Protocol drift between repos.** The Go body and the TS relay/head disagree on frame semantics after independent evolution. | The fixtures are the contract: vendored files, byte-identical round-trip tests both sides, version bump = new fixture set. A semantic change without a fixture change is unrepresentable in CI. |
| L2 | **DO/SSE limits under delta load.** Streaming text × attached heads through one DO; Cloudflare SSE connection and message-rate ceilings. | Deltas are contractually droppable (P§2): the DO sheds them first per-head, never buffers them, and a shed head degrades to turn-final rendering. Sealed events are small and bounded by the existing ≤100/batch ingest. Load fixture in AL6 tests the shed path explicitly. |
| L3 | **The input queue as an attack surface.** Steer/verdict frames are the first *write* path from browsers into a running agent. | `agent.session.interact` deny-by-default; edge-stamped principal (self-declared identity dropped); the body validates against pending state (stale verdicts no-op); frames opaque to the relay; everything lands attributed in the tamper-evident log. |
| L4 | **Long-poll return path latency.** Body long-poll adds up to one poll interval to verdict delivery — an agent blocked on approval waits that much longer. | Poll interval is short (seconds) and the wait is human-dominated anyway; the binding is explicitly swappable to a bidirectional stream without protocol change (P§6.3) if felt latency warrants it. |
| L5 | **Two heads, two renderers, one contract — silently diverging UX.** | The fixture parity suite (AL7) renders identical sessions in both heads' tests; divergence is a diff, not a bug report. The contract documents folding rules, not pixels. |
| L6 | **Suspend/resume across harness versions.** A snapshot resumes onto a newer orun/claude binary whose `--resume` refuses the old session. | The snapshot pins the base image version; resume uses the pinned image (boxes are cattle, images are pinned); a genuinely un-resumable session fails loud into `failed(resume_incompatible)` and the sealed log is intact. |

## Open questions

| # | Question | Current lean |
|---|---|---|
| LQ1 | **Who may interact?** Default `interact` grant: session spawner + profile owner only, or any workspace member with session read? | Spawner + profile owner + org admins by default; a workspace policy toggle widens it. Approval authority especially should start narrow. |
| LQ2 | **Presence granularity.** Do we show *who* is watching (privacy consideration) or just a count? | Show principals to interact-grant holders (they can already act); count-only for read-only viewers. Revisit with design. |
| LQ3 | **Input frames and metering.** Should heavy steering (agent-as-chat) eventually meter? | Not in v1 (§6); revisit if interactive runKind sessions dominate token spend — the meter would be tokens anyway, already counted. |
| LQ4 | **Web composer for design runs.** AL7 gives every session a composer — does the Work tab want an inline mini-head (chat in the spec pane) rather than navigating to the session page? | Ship the session page first; the mini-head is a component extraction later (the head is already a component by construction). |
| LQ5 | **Local→cloud migration** (push a laptop session into a box). | Mirrors orun Q1: out of v1, revisit post-AL8 with harness-resume data in hand. |
