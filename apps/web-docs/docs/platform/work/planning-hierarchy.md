---
title: The planning hierarchy
description: Initiative → Design → Epic → Milestone → Task — authored intent with human-only approval and sealed briefs, derived delivery nobody can edit, and a console that drills down all five levels.
---

Work in Orun Cloud has five nouns:
**Initiative → Design → Epic → Milestone → Task** (orun-work v4).

One rule governs the whole model — **split by truth source**:

- **Decisions are authored.** Review requests and verdicts, approval,
  design adoption — attributed coordination events, some of them
  human-only, all of them visible in the timeline.
- **Facts are derived.** Progress, execution, drift, and health are folds
  over the logs. No derived value on any page accepts input.

The delivery lifecycle from the [work overview](/platform/work/overview)
is untouched underneath: tasks still earn their rungs from observed PRs,
merges, and gates.

## The five nouns

| Noun | What it is | Lifecycle |
| --- | --- | --- |
| **Initiative** | A durable outcome ("payments GA") owning epics; created by humans | Health is **derived** — on-track / at-risk / off-track with named evidence |
| **Design** | A proposal performed *on an initiative* against sealed context (catalog digest + log cursors): a document plus a structured mint tree of epics → milestones → task skeletons. Several designs can compete | Draft → In Review → **Adopted** \| Superseded (authored) |
| **Epic** | A shippable body of work with a spec document; minted by adopting a design, or authored directly | Intent: Draft → In Review → **Approved@revision** → ApprovedDrifted (authored) · Execution: derived from its tasks |
| **Milestone** | An epic-scoped ladder rung (`<epic>#WH2`) with Goal / Done-when — the unit an agent plans and regenerates | Progress derived from its tasks |
| **Task** | The v2 atom: a contract (Goal / Done-when / Gates) whose rung the delivery fold derives | Fully derived |

## Approval seals a brief

Approving an epic is **human-only** — agent and automation actors are
rejected at write time in the model, again at the API, and no MCP approve
tool exists. Approval requires at least one milestone and the *current* doc
revision, and — in the same transaction — seals an **EpicSnapshot**: the
epic envelope and doc revision, the milestone ladder and its hash, the task
contracts as informative context, the adopted design revision, the approval
record, and the log cursors it reflects.

The snapshot is **content-addressed**: its id is the SHA-256 of its
canonical bytes, and every consumer — the console, `orun epic pull`, the
MCP's `epic_brief` — verifies the digest rather than trusting the
transport. It is the "implement against exactly this" artifact an agent
executes from.

**Drift is visible, never blocking.** Editing the epic doc or the milestone
ladder after approval moves the epic to **ApprovedDrifted**, rendered with
both revision digests and a diff link; only re-approval clears it. Task
churn under a milestone never drifts approval — tasks are implementation
detail, and agents re-plan them freely (flagged, reviewed) without
invalidating the human decision.

## Execution handoff

Dispatching an agent into an epic that is not Approved (or has drifted)
returns a structured refusal. A human can override — attributed, with a
note — but an agent can never override, self-approve, or approve. Once
dispatched, the agent works from the sealed brief: it plans tasks per
milestone (`task_regenerate` cancels planned tasks, spares in-flight ones,
and flags every contract for review), and its progress is observed through
the unchanged delivery fold — PRs, merges, gates — like anyone else's.

## The drill-down console

Every level is a page, and every page follows one grammar — header ·
properties rail · children · timeline:

- **Portfolio** — every initiative's derived health, with evidence.
  Nothing on this page is enterable.
- **Initiative** — its epics with intent + execution chips, and the
  Designs rail (compare two proposals side by side, adopt one).
- **Epic** — the approval panel (request review, verdicts, approve/revoke,
  drift), the milestone ladder, and tasks grouped by milestone.
- **Milestone** — goal, done-when, and its tasks with derived rungs.
- **Task** — the v2 page: contract, evidence, unified timeline.

Breadcrumbs deep-link at every level; boards gain epic/milestone scope
pills with drag semantics unchanged (dragging mints an attributed pin,
never a status write).

## Where things are decided vs. observed

| Gesture | Kind | Who |
| --- | --- | --- |
| Request review, submit a verdict | Authored event | Humans and agents |
| Approve an epic, revoke approval | Authored event | **Humans only** |
| Adopt or supersede a design | Authored event | **Humans only** |
| Edit docs, milestones, contracts | Authored event | Humans; agents applied-and-flagged |
| Rung, progress, execution, drift, health | Derived fold | Nobody — computed |

## Related

- [Work overview](/platform/work/overview) — the two logs and the derived
  lifecycle underneath all of this
- [MCP](/developers/mcp) — the agent tool surface (`epic_brief`,
  `design_propose`, `task_regenerate`, …)
- The [orun CLI docs](https://orun-docs.pages.dev) — `orun work import`,
  `orun epic pull`, and the v2.25.0 release notes
