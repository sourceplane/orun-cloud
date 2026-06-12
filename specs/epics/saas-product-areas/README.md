# Epic: saas-product-areas (holding register)

The differentiation backlog beyond the moat — roadmap **P1, P3–P7**. This is a
**holding/register epic**: each leg lives as a one-liner until it is picked up,
then it is **promoted** to its own `saas-<slug>/` folder with a full doc set
(mirroring how `saas-resources-runtime` carries P2 and how Orun promotes
`orun-env-scoping` / `orun-affected-worker`).

## Status

| Field | Value |
|-------|-------|
| Status | **Holding register** (P1 is the next likely human-independent leg) |
| Cluster | **P** (P1, P3–P7; P2 has its own epic) |
| Target branch | `main` |
| Promote rule | When a leg is scoped, create `epics/saas-<slug>/` with `README.md` + `design.md` + `implementation-plan.md`, and replace its row here with a link. |

## The legs

| ID | Leg | Status | Depends on | One-liner |
|----|-----|--------|-----------|-----------|
| **P1** | Per-environment env vars + promote | 🗓️ Next-likely | config-worker (partly done) | Per-env config surface + "promote stage → prod" flow with a diff and explicit confirmation; audit records both states. Owner: config-worker + console. |
| **P3** | Observability tab per project | 🗓️ Planned | thin observability-worker read API | Live logs, errors, request rates per project from edge + workers; time-series in Analytics Engine; query surface in console. Operational, distinct from audit (B7). |
| **P4** | Notification inbox + delivery preferences UX | 🗓️ Planned | **B2** | In-app inbox surfacing what notifications-worker delivered; per-channel preferences per identity; mark-as-read. (Console *preferences* page is also tracked in `saas-console-ux` once the edge facade lands.) |
| **P5** | Integration marketplace primitives | ⬆ **Promoted** → [`../saas-integrations/`](../saas-integrations/) | B1 (shipped), B5 (shipped), B11 | Promoted 2026-06-11 as the **IG** epic: pluggable integrations platform, GitHub App first (connect, repo links, normalized `scm.*` inbound events, token broker). The P2 dependency was dropped — repo links are plain records now, forward-compatible with manifested resources. |
| **P6** | Hosted changelog + status page | 🗓️ Planned | P3 (status), U9 (white-label) | Per-product changelog from a content source; hosted status page reading observability + uptime. |
| **P7** | AI-native affordances | 🗓️ Planned | P3 + B9 (data) | NL audit search, anomaly detection on usage curves, NL → entitlement query, NL → webhook filter. Separate sub-tasks once P3/B9 give the data. |

## Sequencing note

P1 (promote-flow) is the most likely next human-independent leg — verify against
code before committing. P5/P6/P7 each depend on earlier data/infrastructure
(P2/P3/B9) and should not start before their prerequisites are stable. Prefer B/U
work over P until baseline buyer-credibility is reached.
