# saas-repo-federation — Risks & Open Questions

Live register. Remove entries when resolved; record the decision in
`IMPLEMENTATION-STATUS.md`.

## ⛔ Human-input gates (do NOT auto-pick)

| Item | Blocking decision | Unblock signal |
|------|-------------------|----------------|
| **RF5 — first runtime extraction** | A bounded-context group leaves the monorepo only when it has a real owning team and an independent release cadence. Repo boundaries that don't match team boundaries are net-negative (Conway's law). | Named owner + a stated cadence reason (blast-radius isolation, compliance, or throughput) for the commerce group. |
| **Repo creation + org identity** | New GitHub repos, GHCR publish scope for the stack/kernel, per-repo GitHub-OIDC AWS roles (`<env>-github-<org>-<repo>-{plan,production-deploy}`), and Cloudflare/Supabase access are org-owned (`aws-admin`). | Owner provisions repos, OIDC roles, and secrets per the FORKING §4 operator checklist, per new repo. |
| **`stage`/`prod` deploy approvals** | Every extracted repo keeps `requireApproval: true` on deploy lanes; someone must approve each repo's promotions. | Approvers assigned per repo. |

## Open design questions

| Item | Question | Current lean |
|------|----------|--------------|
| Kernel distribution | Versioned `@saas/*` on GHCR npm (clean, explicit, adds bump friction) vs co-locating the kernel in each runtime repo via `components.mjs --copy` (no registry, but drift risk) vs submodule/subtree (avoid). | **Versioned publish** (RF1). Contract changes *should* be explicit and versioned — that is the point of a seam. |
| SCC placement | Does `commerce` absorb `membership`+`events` to keep the SCC whole in one repo, or do they stay in `core-runtime` and the SCC edges cross the boundary as name-based bindings? | Keep `membership`/`events` in `core-runtime`; treat commerce→core as stable name bindings (RF2 contract). Revisit if the cycle proves too chatty to bootstrap cross-repo. |
| Cross-repo ordering | Orun orders within a plan; a lost cross-repo `dependsOn` becomes what? | An **async gate**: version pin (consumer pins producer's published contract/stack), the wiring manifest as the coupling point (producer publishes IDs, consumer resolves at its own deploy), or keep the hard edge inside one repo. Never a synchronous cross-repo edge. |
| `contracts` change blast radius | In-repo, a contract change re-scopes dependents in `--changed` (`dependsOn[].input`). Cross-repo, what forces dependents to re-verify? | A version bump + the RF2 wiring/contract guard test; consider a scheduled "latest-contracts" canary in each consumer repo. |
| How many repos | Stop at service groups, or eventually per-context? | Service groups (≤ ~7). Per-context only if a single context grows its own team. |
| Monorepo as product | The baseline is a *forkable* artifact. Does federation degrade "fork one repo"? | Keep one primary golden-path platform repo + shared substrate; federation targets internal cadence and large forks, not the default fork DX. |

## Standing risks

- **BF10 dependency.** RF0 relies on Orun's OCI composition-*consumption* path
  (the publish side already exists via `publish-stack`). If the pinned runtime
  (`kiox.yaml`) doesn't yet consume an `oci` composition source, RF0 is gated on
  the BF10 runtime bump; verify against the pin before starting and sequence the
  `kiox` upgrade first if needed.
- **Lockfile importer drift.** Worker CI installs with `--frozen-lockfile`, and
  pnpm requires the lockfile importer set to match the workspace exactly. Every
  extraction must resync `pnpm-lock.yaml` (the `components.mjs --copy` rule);
  RF1's dual-mode overlay must not desync resolutions.
- **Distributed first-boot.** The binding-cycle seed and "re-run the full
  workflow, never failed-jobs-only" footguns (FORKING §5) get *worse* across
  repos: a cross-repo SCC has no single plan to converge it. Mitigated by never
  splitting an SCC (RF2 validator) and by name-based bindings tolerating
  out-of-order first deploys.
- **Golden-path drift.** N copies of `ci.yml`/`intent.yaml` scaffolding will
  drift. Mitigated by RF6's reusable workflow + shared intent fragment + doctor
  preflight; until RF6, treat scaffolds as generated, never hand-edited.
- **Upstream-sync debt.** Snapshot forks already have no shared history
  (FORKING §6); federation multiplies the surface to keep current. RF6 must land
  the `factory upgrade`/provenance-lock tie-in alongside the first split, not
  after.
- **Secrets/wiring account coupling.** Cross-repo service bindings and wiring
  resolution assume one Cloudflare account and one Secrets Manager namespace
  convention. Splitting *accounts* (not just repos) is out of scope here and
  would reopen the wiring contract.
