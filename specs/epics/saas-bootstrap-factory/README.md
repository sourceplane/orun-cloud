# Epic: saas-bootstrap-factory

**Make this repo instantiable.** Raise the starter to the quality bar where a
new multi-tenant SaaS on Cloudflare + Supabase can be produced from a values
file: `instantiate --values instance.yaml` → `orun plan` / `orun run` →
deployed product. Every milestone is an independent quality improvement to
*this* repo first; bootstrappability falls out at the end rather than being a
big-bang generator bolted on top.

> **Update (consolidation — the factory engine moved to the orun binary).**
> The Blueprint/Instance contracts and the instantiator that were **BF10–BF14**
> are **superseded** and now live as a single orun-binary feature in
> `orun/specs/orun-scaffolding/` (the unified "scaffolding & instantiation"
> epic: one engine, one `kind: Blueprint` language, covering a single component,
> a full repo, or several baselines at once). This epic **keeps BF0–BF9** — the
> infra/identity/wiring quality work that shrinks the per-instance surface — as
> its (mostly shipped) scope. Its remaining forward work is no longer "build an
> instantiator" but **"author this repo's `blueprint.yaml` + declared hooks
> against orun's contract"** (tracked as orun **SCF7**). The
> `tooling/fork/components.mjs` ordering and `tooling/rebrand/rebrand.mjs` rename
> map fold into that blueprint; orun's own DAG + object store replace them.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft (not started)** |
| Cluster | **BF** (BF0–BF9 here; **BF10–BF14 moved → `orun/specs/orun-scaffolding/`**) |
| Owner(s) | `stack-tectonic/`, `infra/terraform/*`, all `wrangler.jsonc` surfaces, `apps/api-edge`, `apps/web-console-next`, `specs/core/` (the instantiator engine is orun's; this repo authors `blueprint.yaml`) |
| Target branch | `main` |
| Builds on | `core/orun-golden-path.md`, `core/constitution.md`, `core/access-and-infra.md`, `stack-tectonic` publish-stack |
| End-state target | A second live SaaS instance (scratch "acme") deployed to its own Cloudflare/Supabase/AWS accounts from `instance.yaml` only, via `orun instantiate` (engine: `orun/specs/orun-scaffolding/`), with an `orun … upgrade` path back to this golden repo |

## Thesis

The platform is production-grade but **instance-bound**: identity values
(`sourceplane`, `orun.dev`, the workers.dev subdomain), resource IDs
(Hyperdrive, KV), the Supabase org, and the AWS account are hardcoded across
`wrangler.jsonc` files, source constants, Terraform, and even Stack Tectonic
job templates. Terraform *creates* Hyperdrive/KV resources but nothing injects
their IDs back into Worker bindings — that loop is manual, and it is the single
hard blocker for any push-button bootstrap.

The fix is not a templating pass over the whole tree. It is a sequence of
quality improvements that shrink the per-instance surface until it is tiny:

1. **Truth + typed parameters** — docs match code; every identity value lives
   in `intent.yaml` / composition schemas, never in job templates or `.tf`
   literals (BF0–BF2).
2. **Config indirection over source templating** — app code reads identity
   from one generated config module; binding names are generic (BF3–BF4).
3. **Deploy-time wiring** — infra publishes a wiring manifest; the worker
   compositions resolve bindings from it at deploy time, so no resource ID is
   ever committed (BF5–BF6). *This is the keystone.*
4. **Infra completeness** — domain re-import, a foundation component for fresh
   accounts, and a preflight doctor for every external prerequisite (BF7–BF9).
5. **The factory** — published OCI stack consumption, then *authoring this
   repo's `blueprint.yaml`* and instantiating/upgrading it with the orun binary.
   The Blueprint/Instance contracts and the instantiator engine are **orun's**
   (`orun/specs/orun-scaffolding/`, SCF4–SCF7); this repo's residual work is the
   blueprint + declared hooks + the acme rehearsal (was BF10–BF14).

After BF6 the repo is *already* dramatically better for this instance (no
hand-pasted IDs, real dependency DAG, account-agnostic stack). The reuse layer
on top is now delivered by `orun instantiate`.

## Read order

1. `README.md` (this file).
2. `implementation-plan.md` — BF0–BF14 with scope, "done when", and human-help
   flags (the normative detail).
3. `risks-and-open-questions.md` — decision points + the consolidated
   human-help register.

## Milestones at a glance

| ID | Milestone | Human help? | Status |
|----|-----------|-------------|--------|
| BF0 | Truth pass: docs match code reality | No | ✅ Shipped |
| BF1 | Encode the real infra dependency DAG | No | ✅ Shipped |
| BF2 | Parameterize the Terraform + stack identity surface | No | ✅ Shipped |
| BF3 | App identity via config indirection | No | ✅ Shipped |
| BF4 | Generalize runtime binding names | No | ✅ Shipped |
| BF5 | Wiring manifest from Terraform outputs | No | ✅ Shipped |
| BF6 | Deploy-time wiring in worker compositions (keystone) | Deploy approvals only | 🛠️ In progress (api-edge pilot shipped; fleet rollout = BF6b) |
| BF7 | Finish cloudflare-domain v5 re-import (0085b) | Deploy approvals; registrar access if DNS changes | 🗓️ Planned |
| BF8 | Foundation component for fresh AWS accounts | **Yes — AWS admin creds (one-time)** | 🗓️ Planned |
| BF9 | Preflight doctor for external prerequisites | No (humans supply the secrets it checks) | 🗓️ Planned |
| BF10 | Consume the published OCI stack | GHCR package perms if not already granted | 🗓️ Planned (feeds orun SCF4 `oci` source) |
| ~~BF11~~ | ~~Blueprint + Instance contracts~~ → **orun SCF3–SCF5** (the `kind: Blueprint` contract + `inputs`/modules is orun's) | — | ↗️ Moved to `orun/specs/orun-scaffolding/` |
| ~~BF12~~ | ~~Instantiator v1 + provenance + idempotence~~ → **orun SCF5–SCF6** | — | ↗️ Moved to `orun/specs/orun-scaffolding/` |
| BF13 | First real instantiation rehearsal ("acme") via `orun instantiate` | **Yes — new accounts, domain, OAuth apps, billing products** | 🗓️ Planned (consumes orun SCF7) |
| ~~BF14~~ | ~~Upgrade path~~ → **orun SCF6** (`orun … upgrade`); conformance pack stays a repo `turbo-package` test | — | ↗️ Engine moved; conformance stays here |
