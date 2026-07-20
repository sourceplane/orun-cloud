# saas-dispatch — Implementation Status (as-built)

The as-built record, kept distinct from the design/plan docs. Nothing is built
yet — this epic is **proposed**. Rows flip to 🏗️/✅ as DX milestones land.

| Milestone | Status | As-built |
|-----------|--------|----------|
| DX0 — The Situation read-model | 🗓️ Not started | — |
| DX1 — DispatchIndex + live push | 🗓️ Not started | — |
| DX2 — The Dispatch surface | 🗓️ Not started | — |
| DX3 — The front door | 🗓️ Not started | — |
| DX4 — Proactive dispatch | 🗓️ Not started | — |
| DX5 — Responsiveness + trust hardening | 🗓️ Not started | — |
| DX6 — Provider & model settings | 🏗️ Groundwork landed (with this spec change) | The provider widening shipped on the identical AG12 path, verified locally (builds, typecheck, targeted suites green — 137 db + 21 config-worker + 12 agents-worker + 11 console tests): **contracts** `packages/contracts/src/agents.ts` — `AGENT_PROVIDERS` grows `openai`/`openrouter`; new `COMPUTE_PROVIDERS`/`MODEL_PROVIDERS`/`isModelProvider`; `config` documented as `{defaultModel?, baseUrl?}` for model providers. **db** `packages/db/src/agents/model.ts` — `PROVIDERS` widened + `MODEL_PROVIDERS`/`isModelProvider`; migration **`860_agents_model_providers`** (idempotent DO block: drop + re-add the `provider_connections` provider CHECK with the four-provider vocabulary) registered in `manifest.ts` (sha256 checksum) and `infra/db-migrate/migrations.lock` regenerated (87 ids). **config-worker** `internal-provider-keys.ts` — the reserved-namespace regex widened to `(daytona\|anthropic\|openai\|openrouter)` with a mirror-both comment; custody path otherwise untouched (still the only decrypt path — key-hierarchy guard green). **agents-worker** `verifiers.ts` — OpenAI-compatible `GET /models` Bearer ping and OpenRouter `GET /key` ping, both honoring `config.baseUrl` (trailing-slash-trimmed), reasons redacted to status codes; `handlers/providers.ts` validation message now derives from `PROVIDERS`. **console** `lib/agents/model.ts` — `PROVIDER_META` cards for OpenAI/OpenRouter + `MODEL_PROVIDER_SET`; `provider-connections.tsx` — model-provider connect form gains optional Base URL + Default model fields (empty fields omitted so vendor defaults hold; key still never lingers in state). **tests** — `gemini` replaces `openai` as the rejected-provider fixture in `tests/config-worker/src/internal-provider-keys.test.ts` and `tests/db/src/agents-repository.test.ts` (openai/openrouter now assert as valid). **Remaining DX6:** the `Settings › AI Providers` door (settings-nav entry rendering the same `ProviderConnections`), connection-sourced model options in the profile dialog, live verification smoke against real OpenAI/OpenRouter keys, and the DX-Q6 chat `ModelClient` follow-up. |
| DX7 — Delegation interfaces (anthropic-managed) | 🗓️ Not started (design normative in `design.md` §10) | — |

## Notes for the first implementer

- Start at DX0 and get the fold *shape* right against fixtures before any DO
  exists — the live layer (DX1) is worthless over a wrong fold.
- Reuse, do not rebuild: the work fold (WP), the AG7 session list, the AF6
  attention feed, and the AF9 budget read are all shipped and viewer-scoped.
  The facade composes them; it owns no table.
- The `DispatchIndex` belongs in `apps/chat-worker` (unprivileged) as a sibling
  SQLite DO to `ChatIndex`/`WorkspaceMemory` — mirror their binding/migration
  idiom (per-env DO blocks, top-level migration).
- The dispatch head socket is attach v1 plus two frames; do not introduce a
  second sync vocabulary (AN decision 2).
