# saas-mcp-server — Implementation Status (as-built)

What actually shipped, kept distinct from the design/plan docs per
`../README.md` § Lifecycle & conventions.

| ID | Milestone | Status | As-built |
|----|-----------|--------|----------|
| MCP0 | Tool-plane foundation (`packages/mcp`) | ✅ Shipped | `@saas/mcp` turbo-package: transport-agnostic registry (`defineTool` in `tool.ts`, public surface `registry.ts` — split to avoid an ESM cycle), `createMcpServer({ sdk, readOnly?, limits? })` over `@modelcontextprotocol/sdk` ^1.29 (spec rev 2025-06-18, risk D6 marker in `server.ts`), SDK-error→tool-error mapper preserving the platform `code` set, workspace/project scope fragments, UTF-8-safe 64 KiB truncation. **19 read-only tools** (≤ 25 budget): whoami, workspaces_list, projects_list, catalog_search, catalog_get_entity (emulates via OV6 list — D2, SC0 still unshipped), catalog_read_doc (CD), runs_list/runs_get/runs_read_logs (OV7), audit_search, events_search (ES), security_events_list, access_explain, usage_summary, quota_check, billing_summary, config_read, secrets_list (metadata-only with a fail-loud value guard + test), webhook_deliveries_list. 65 vitest tests incl. an `InMemoryTransport` end-to-end. Component intent: `dependsOn` build-input edges on `contracts` + `sdk`. |
| MCP1 | Local stdio server via CLI | 🗓️ Planned | — |
| MCP2 | Remote `apps/mcp-worker` | 🗓️ Planned | — |
| MCP3 | OAuth 2.1 | 🗓️ Planned | — |
| MCP4 | Resources & prompts | 🗓️ Planned | — |
| MCP5 | Write tools (gated) | 🗓️ Planned | — |
| MCP6 | Metering + entitlement | 🗓️ Planned | — |
| MCP7 | Console Connect surface | 🗓️ Planned | — |
| MCP8 | Conformance + agent evals | 🗓️ Planned | — |

## Notes for later milestones

- State-plane cursors surface as the `createdAt|id` string the endpoints
  accept (matches the console's encoding); opaque cursors (audit, events,
  security-events, webhooks) pass through verbatim; all paginated tools return
  `data.meta.cursor`.
- The SDK does not export its query option types; `packages/mcp` derives them
  via `Parameters<StateClient[...]>` so they stay pinned to real signatures —
  if the SDK exports them later, switch.
- `webhook_deliveries_list` with no `endpoint` argument lists the workspace's
  endpoints (delivery attempts are per-endpoint; no separate endpoints tool —
  budget).
