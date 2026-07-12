# saas-agents-fleet — Implementation Status (as-built)

The as-built record for the cloud half (AF4–AF9), kept distinct from the
design/plan docs. The runtime half (AF0–AF3) is tracked in
`orun/specs/orun-agents-fleet/`.

| Milestone | Status | As-built |
|-----------|--------|----------|
| AF4 — The delegation plane | 🗓️ Not started | — |
| AF5 — The attention plane | 🏗️ Core shipped | **The needs-you fold + the fleet home queue.** `@saas/contracts/agents`: the closed `ATTENTION_KINDS` vocabulary (enum-complete from day one — `budget`/`routine_parked` fold to zero until AF8/AF6), `ATTENTION_RANK`, `AttentionItem` (provenance-carrying) + `AttentionSummary`. `apps/agents-worker/src/handlers/attention.ts`: `foldAttention` — a pure computed read over session rows + relayed events (verdict from the latest unresolved `approval_requested`; `stuck` from a lapsed lease not yet swept; `failed_retryable` from task-bound failures inside a 24h window), ranked by kind then oldest fact; `GET …/agents/attention` read-gated (`agent.session.read`), routed + forwarded by the api-edge facade; SDK `agents.attention()`. Console: the fleet home (`agents-workbench.tsx`) rebuilt to the Northwind Agents mock order — stat pair (`running` / `need a verdict`, warn ink when nonzero, both from the same fold), the **Needs you queue** (`attention-queue.tsx`: verdict cards answer Approve/Deny in place by posting the same attach-v1 `verdict` frame the session page posts — the fleet home is a head; no dismiss affordance exists), Active/Recent session split with compact age column + honest failure lines, profiles with the truth caption, providers last; presentation model (`lib/agents/attention.ts`) pure + tested. Tests: 10 attention (fold + route + gates), facade route match, SDK URL shape, 5 presentation-model. **Remaining AF5:** the org-topbar/sidebar attention badge (needs a shell-level live query — the nav model is deliberately pure), the daily digest via notifications-worker, quick-spawn card (rides AG8's spawn surfaces). |
| AF6 — Routines | 🗓️ Not started | — |
| AF7 — Track record & earned autonomy | 🗓️ Not started | — |
| AF8 — Budgets | 🗓️ Not started | — |
| AF9 — Hardening + evals | 🗓️ Not started | — |
