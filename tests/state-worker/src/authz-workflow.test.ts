// OV3.2b — state-worker authorizes a workflow actor by its token-bound scope.
// The OIDC exchange already verified + gated the credential, so a workflow grant
// is exactly "request (org, project) == token-bound (org, project)" — with NO
// membership/policy lookup (a workflow has no roles). A mismatch hides as 404.

import { authorizeRun } from "@state-worker/authz";
import type { ActorContext } from "@state-worker/router";
import type { Env } from "@state-worker/env";
import { asUuid } from "@saas/db";

const ORG = asUuid("11111111-1111-4111-8111-111111111111");
const PROJECT = asUuid("44444444-4444-4444-8444-444444444444");
const OTHER = asUuid("99999999-9999-4999-8999-999999999999");

// An env whose authz service bindings THROW if touched — proves the workflow
// path never calls membership-worker / policy-worker.
function envThatRejectsAuthzCalls(): Env {
  const throwing = {
    fetch: () => {
      throw new Error("authz services must not be called for a workflow actor");
    },
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
  return { ENVIRONMENT: "test", MEMBERSHIP_WORKER: throwing, POLICY_WORKER: throwing } as unknown as Env;
}

function workflowActor(over?: Partial<ActorContext>): ActorContext {
  return {
    subjectId: "repo:acme/platform:ref:refs/heads/main",
    subjectType: "workflow",
    boundOrgId: ORG,
    boundProjectId: PROJECT,
    ...over,
  };
}

describe("authorizeRun — workflow actor (OV3.2b)", () => {
  it("grants when the bound (org, project) matches the request, without any authz hop", async () => {
    const res = await authorizeRun(
      envThatRejectsAuthzCalls(),
      "req_1",
      workflowActor(),
      ORG,
      PROJECT,
      "state.run.write",
    );
    expect(res.ok).toBe(true);
  });

  it("denies (404) when the bound org differs from the request org", async () => {
    const res = await authorizeRun(
      envThatRejectsAuthzCalls(),
      "req_2",
      workflowActor({ boundOrgId: OTHER }),
      ORG,
      PROJECT,
      "state.run.write",
    );
    expect(res.ok).toBe(false);
  });

  it("denies (404) when the bound project differs from the request project", async () => {
    const res = await authorizeRun(
      envThatRejectsAuthzCalls(),
      "req_3",
      workflowActor({ boundProjectId: OTHER }),
      ORG,
      PROJECT,
      "state.object.write",
    );
    expect(res.ok).toBe(false);
  });

  it("denies (404) a workflow token with no bound scope", async () => {
    const noBound: ActorContext = {
      subjectId: "repo:acme/platform:ref:refs/heads/main",
      subjectType: "workflow",
    };
    const res = await authorizeRun(envThatRejectsAuthzCalls(), "req_4", noBound, ORG, PROJECT, "state.run.read");
    expect(res.ok).toBe(false);
  });
});
