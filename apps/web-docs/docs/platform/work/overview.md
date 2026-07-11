---
title: Work (the delivery-derived tracker)
description: Orun Cloud's work plane — lifecycle as a derived query over two append-only logs, pins beside truth, and one mutator surface shared by the console, CLI, and MCP.
---

The **work plane** is Orun Cloud's work tracker, built on one refusal:
**lifecycle is a derived query, not a stored status**. There is no status
column anywhere in the schema — a task's rung (Draft → Ready → In Progress →
In Review → Done → Released) is computed by folding two append-only logs, so
nobody — human or agent — can *set* a status. The console has no status
dropdown, the CLI has no `set-status`, the MCP has no status tool, and all
three absences are asserted by tests.

## The two logs

- **The coordination log** — what people (and agents) *said*: item and
  contract edits, comments, assignments, claims, pins, reviews, approvals.
  Every event carries a mandatory, typed actor (`user` / `agent` /
  `automation`) — attribution is structural, not convention.
- **The observation log** — what the world *did*: branches, pull requests,
  merges, gate verdicts, live revisions, observed by the platform (e.g. the
  [GitHub integration](/platform/integrations/github)) and never written by
  hand.

The fold joins them: intent from the first, facts from the second. Every
rendered rung comes **with the evidence that put it there** ("In Review —
PR #123 open @ abc1234"), and the same fold serves the console, `orun work
list`, and the MCP — there is exactly one truth function.

## Pins beside truth

When reality and judgment disagree, a human can **pin** an item to a rung.
A pin never replaces the derived value — the UI renders both ("pinned Done
· observed In Review"), the pin is attributed and logged, and agents cannot
pin (rejected at the model *and* the API — defense in depth). Overrides are
public, never quiet.

## One mutator surface

Every write path — console, `orun` CLI, MCP tools, import — goes through
the same audited mutators, which append exactly one coordination event per
mutation (documented transactional batches aside) and return structured
verdicts (`422` with a machine-readable reason, never a silent drop).
Agent-proposed contract changes are applied **and flagged** into a triage
lane for human review: an agent cannot quietly redefine its own definition
of done.

## The planning hierarchy

As of orun-work v4, the work plane has a shape above tasks:
**Initiative → Design → Epic → Milestone → Task**, with authored *intent*
(reviews, human-only approval, sealed epic briefs) governed separately from
derived *delivery*. That model — the two ladders, approval and drift,
designs, and the drill-down console — has its own page:
[The planning hierarchy](/platform/work/planning-hierarchy).

## Getting work in

`orun work import` maps a repository's `specs/` tree onto the hierarchy —
epic folders to epics, implementation-plan headings to milestones,
checklists to tasks, roadmap clusters to initiatives — idempotently and
without ever importing a status. See the
[orun CLI docs](https://orun-docs.pages.dev) (`orun work`) for the mapping
and flags.
