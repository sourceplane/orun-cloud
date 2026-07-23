# Adding an integration — the runbook (IR9)

Status: Normative once IR9 lands. This replaces the scattered per-epic notes
(IG7/IH10/SP6) as the one answer to "what does provider N+1 touch?".

The registry's whole bet is that this list is SHORT and every plane derives.
The pluggability proof (the dormant AWS manifest) holds the bar: a served CLI
verb tree, hub roadmap card, space chrome, secrets-capability listing, and
docs-catalog entry all light up from the manifest + adapter files alone.

## The files a new provider touches (target: ≤ 6 + fixtures)

| # | File | What goes there |
|---|------|-----------------|
| 1 | `packages/contracts/src/integrations.ts` | Widen `IntegrationProviderId`; add the `INTEGRATION_PROVIDER_DESCRIPTORS` entry + entitlement key. (One file, three additive edits.) |
| 2 | `apps/integrations-worker/src/providers/{id}.ts` | The adapter: core lifecycle + whichever capability objects the provider implements (`inbound` / `broker` / `secrets` / `messaging` / `provision` / `verifyApiKey`). Scope-template grammar and connect recipes live HERE — nowhere else, ever. |
| 3 | `apps/integrations-worker/src/providers/manifests/{id}.ts` | The manifest: identity, category, connect methods, capabilities, space tabs+modules, optional `cli` verbs, entitlement, version, status. |
| 4 | `apps/integrations-worker/src/providers/registry.ts` | One `case` in `getConfiguredProvider` (the env-gate a human should see) + the id in `KNOWN_PROVIDER_IDS`; `manifests/index.ts` registration. |
| 5 | `tests/integrations-worker/src/…` | Conformance fixtures: the manifest-conformance suite picks the provider up automatically; add provider-specific fixture tests (verify probe, mint, ingress) as capabilities warrant. Regenerate the governance artifacts (`REGENERATE_INTEGRATION_DOCS=1 … -- manifest-governance`). |
| 6 | Worker env plumbing (`env.ts`, `wrangler.template.jsonc`, escrow) | Only when the provider needs per-environment platform credentials (OAuth client, app secrets). Token/apikey-paste providers skip this entirely. |

Everything else derives:

- **Hub card, space chrome, connect dialog** — rendered from the descriptor;
  zero console edits unless the provider ships a bespoke space module (IR6's
  graft) or a custom wizard step (SP1's graft) — both additive component
  registrations, never substrate edits.
- **Secrets surface + wizard** — from the `secrets` capability declaration.
- **orun CLI namespace** — standard verbs from capabilities; extra verbs from
  the manifest `cli` block (ops restricted to the compiled allowlist —
  `tests/integrations-worker/src/cli-projection.test.ts` mirrors
  `orun/internal/integrationscli/ops.go`; change them together).
- **Docs catalog** — regenerated from the manifests (IR8); write hand-prose
  (`apps/web-docs/docs/platform/integrations/{id}.md`) only when the provider
  earns a narrative page.

## The gates that keep it honest

1. `manifest-conformance.test.ts` — manifest ⊆ adapter; liveness honesty;
   tabs as a pure function of capabilities; recipes derived, never mirrored.
2. `cli-projection.test.ts` — served verbs stay inside the two-sided op
   allowlist.
3. `manifest-governance.test.ts` — additive evolution (same version ⇒
   identical surface; evolution ⇒ version bump + conscious snapshot
   regeneration; ids never disappear) + docs freshness.

## Checklist

- [ ] Contracts widened (id, descriptor, entitlement) — additive only
- [ ] Adapter beside its manifest; grammar/recipes only in the adapter
- [ ] Manifest declares exactly what the adapter implements
- [ ] `getConfiguredProvider` case + registrations
- [ ] Conformance + fixture tests green; governance artifacts regenerated
- [ ] Entitlement key placed in billing plans (or deliberately ungated)
- [ ] If inbound: edge ingress route + HMAC verify + inbox discipline (IG §5)
- [ ] If broker: templates versioned; mints ledgered; revoke path; TTL clamp
