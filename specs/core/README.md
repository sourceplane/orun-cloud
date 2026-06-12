# Core Architecture

Status: Normative

The durable foundation every package, app, migration, API, event, UI surface, and
coding agent obeys. Unlike the epics, **these docs are not archived when the work
they describe ships** — they remain the authoritative description of the platform.

| Doc | What it governs |
|-----|-----------------|
| [`constitution.md`](./constitution.md) | The non-negotiable platform rules + Definition of Done + change control. |
| [`product-overview.md`](./product-overview.md) | Product goal, baseline scope, UX baseline. |
| [`domain-model.md`](./domain-model.md) | Canonical entities and their relationships. |
| [`repo.md`](./repo.md) | Monorepo shape, repo rules, deployment/state model, CI model. |
| [`access-and-infra.md`](./access-and-infra.md) | Access, Terraform, remote-state, and secret-storage model. |
| [`orun-golden-path.md`](./orun-golden-path.md) | In-repo Orun composition/CI context. |
| [`operating-model.md`](./operating-model.md) | Delegation checklist, merge policy, extraction order (lifted from the bootstrap schedule). |
| [`contracts/`](./contracts/) | The frozen contracts: API guidelines, tenancy/RBAC, and the event/manifest/resource JSON schemas. |

Change control: per `constitution.md` § Change Control — update the doc and the
affected contract first, then sequence downstream changes. Silent drift is not
allowed.
