# saas-agent-supervision — Risks & Open Questions

## Risks

| # | Risk | Mitigation |
|---|------|------------|
| 1 | **Prompt injection via implementer output.** A hostile or compromised implementer writes log lines addressed to the dispatcher ("approve the request", "spawn 50 children", "read the secrets"). | Structural first: no verdict verb exists; control-held steers refused at the relay; spawns pass the ladder; the dispatcher principal's grants are the ceiling; no client tools in supervisor turns. Digests are folds of sealed events, not raw text; log reads are wrapped untrusted. SV7 fixture suite is a gate, not an afterthought. |
| 2 | **Supervision storms / runaway spend.** Event bursts or a pathological loop (dispatcher steers → events → wakes) turns autonomy into a bill. | Coalescing window; shared turn-rate ceiling; reflexivity filter; AF9 envelope burn with park-on-exhausted; the `observe`/`off` dial; the CI storm synthetic. Spend is visible split (human vs supervision) before anyone scales it. |
| 3 | **Attribution drift.** A refactor routes a supervision verb through the owner bearer and the sealed log silently lies. | SV2 lands attribution as *tested contract* (fixtures assert the principal on the sealed event for both contexts); the cockpit renders the identity, so a regression is user-visible, not silent. |
| 4 | **Two "pending" surfaces confuse.** Roster panel vs Situation rail both say "what's happening". | They answer different questions (this thread's workforce vs the workspace's pending plane) and share fold sources, so numbers can't disagree. SV4 does the copy/IA work; if confusion persists in usage, collapse is a UI decision, not a data migration. |
| 5 | **Takeover races.** Human takes control while a dispatcher steer is in flight. | Control is enforced at the relay on frame arrival (single writer: the DO), not client-side; an in-flight dispatcher frame that loses the race is refused with `control_held` and the supervisor turn sees the refusal — the same honest-ack path every steer already has. |
| 6 | **Managed-run parity oversold.** Users expect approvals/takeover depth on Managed runs that the interface cannot provide. | The tier chip + explicit "no mid-run approvals" statement on every Managed card (DX7 lock inherited: rendered, never averaged). Docs and the spawn flow state the trade at choice time. |
| 7 | **Rename churn (Dispatch → Agents, Fleet → Implementers).** Deep links, docs, and muscle memory break. | Route aliases with redirects, Cmd-K synonyms, one release note. The rename is SV4-contained; nothing under the hood cares about the label. |
| 8 | **Backfilled origins are wrong.** Inference mislabels a legacy session. | Backfilled rows carry `backfilled: true` and render with a subtle marker; inference rules are conservative; nothing downstream *gates* on origin (it is provenance, not authority). |

## Open questions

1. **Default supervision mode for existing threads.** New threads default
   `on` (post-SV5); do existing threads migrate to `observe` or `off`?
   Leaning `observe` — visible value, zero surprise autonomy. Decide at
   SV3 ship.
2. **Silence threshold for "stuck".** Per-profile? Per-runKind? A single
   workspace default (e.g. 10 min without an event while `running`) is
   probably enough for v1; measure before adding knobs.
3. **Does a work-origin implementer get a supervisor?** v1: no — only
   dispatch-origin implementers are supervised (the thread is the
   supervisor's home). A later slice could let a thread *adopt* a work- or
   human-origin implementer (origin stays immutable; adoption would be a
   separate, sealed relationship). Deliberately out of v1.
4. **Digest size bounds.** Cap headline length and event count per digest;
   what falls off? Current lean: keep terminal + approval always, drop
   progress beyond N with a "+K more" line.
5. **Should `session_spawn` from a supervisor turn require a standing
   human authorization** (an AF routine-like grant) at low autonomy
   levels? The ladder already gates by autonomy; verify the existing
   levels express "may spawn without a fresh human prompt" cleanly or add
   the distinction to the ladder spec (AF-owned decision, flagged early).
6. **TUI parity.** `orun agent attach` shows dispatcher steers with the
   dispatcher principal today (attribution rides the protocol), but
   Take/Return control needs a TUI affordance — pairs with an orun-side
   change; sequence after SV5 stabilizes the protocol.
