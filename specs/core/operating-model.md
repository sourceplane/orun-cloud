# Operating Model

Status: Normative

The evergreen delivery rules for this monorepo. These were lifted verbatim from
the original 8-week bootstrap plan (now archived at
`specs/_archive/schedule.md`) because they outlive the bootstrap: they govern how
any task — bootstrap or not — is scoped, merged, and (eventually) extracted.

## Delegation Checklist Per Component

Before assigning a component to an autopilot agent:

- confirm its upstream dependencies are merged,
- point the agent to the exact component spec,
- point the agent to the shared contracts it must honor,
- define the PR boundary and write scope,
- confirm the task has one primary outcome,
- split the task if it spans unrelated components, contracts, infra, or product scope,
- confirm whether the component may add new contracts or must use existing ones only.

## Merge Policy

- Merge Orun repo bootstrap before foundation or domain component work.
- Merge one accepted task per PR.
- Merge foundation before any domain component.
- Merge contract changes before dependent implementations.
- Merge tenant core before starter operations.
- Merge audit/event contracts before webhooks, notifications, billing, and support depend on them.
- Merge metering before billing.
- Merge optional runtime after resources and events are stable enough to avoid duplicate contract churn.

## First Extraction Candidates

The components most likely to move out of the monorepo first after traction (see
`constitution.md` § Bounded contexts and `repo.md` § Extraction Model):

1. `billing-worker`
2. `metering-worker`
3. `webhooks-worker`
4. `notifications-worker`
5. `identity-worker`
6. `runtime-worker` — if optional resource orchestration becomes product-critical
