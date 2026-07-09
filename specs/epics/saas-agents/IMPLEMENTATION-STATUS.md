# saas-agents — Implementation Status (as-built)

The as-built record, kept distinct from the design/plan docs. The runtime half
(AG0–AG4) is complete in `sourceplane/orun` (`orun/specs/orun-agents/`); this
file tracks the orun-cloud control plane (AG5–AG11).

| Milestone | Status | As-built |
|-----------|--------|----------|
| AG5 — Sandbox provider plane | 🏗️ Foundation shipped | **Dormant substrate landed** (the OP0 posture — everything typed/migrated, nothing serving). `packages/contracts/src/agents.ts`: wire types (`AgentProfile`/`AgentSession`/`AgentSessionEventWire`), closed vocabularies (session states, run kinds, autonomy, the 11-kind event vocab — no status kind), error codes, and the **`SandboxProvider`** + `SandboxSpec`/`SandboxRef` seam (types only; dependency-free). `packages/db/src/agents/`: `model.ts` (vocabularies + guarded transition table + validators — mandatory responsible owner), `types.ts` (`AgentsRepository`), `repository.ts` (Postgres over the schema; `FOR UPDATE` transition guard, `ON CONFLICT (session_id,seq)` relay dedupe), `memory.ts` (test double + executable contract), `index.ts`; migration **`650_agents_foundation`** (schema `agents`: `agent_profiles`, `agent_sessions`, `session_events` relay, `autonomy_policies`; CHECK'd vocabularies, partial lease index, workspace-scoped) registered in `types.ts`/`manifest.ts`/`package.json` + lock. `apps/agents-worker/`: dormant Cloudflare Worker (`/health` only, component.yaml, wrangler template + fixture, bindings declared for AG6). Verified: db typecheck + 855 db tests (incl. 7 new agents-repository tests) + lint green; worker typecheck + `wrangler deploy --dry-run` (bindings resolve) + lint green; contracts typecheck + lint green. **Live paths** — the Daytona adapter, the `local-docker` dev adapter, and the base snapshot — are AG5's remaining slice, credential-gated. |
| AG6 — Session identity + DO relay | 🗓️ Not started | — |
| AG7 — Console Agents tab | 🗓️ Not started | — |
| AG8 — Design runs | 🗓️ Not started | — |
| AG9 — Dispatch + autonomy | 🗓️ Not started | — |
| AG10 — Metering + entitlement | 🗓️ Not started | — |
| AG11 — Hardening + evals | 🗓️ Not started | — |
