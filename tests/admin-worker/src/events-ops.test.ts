import {
  handleLaneHealth,
  handleDeadLetterCounts,
  handleRuleStorms,
} from "@admin-worker/handlers/events-ops";
import type { EventsOpsDeps } from "@admin-worker/handlers/events-ops";
import type { SupportRequestContext } from "@admin-worker/handlers/record-support-action";
import type { Env } from "@admin-worker/env";
import type { EventsAdminRepository } from "@saas/db/events";

function createFakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" } as unknown as Hyperdrive,
  };
}

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ORG_PUBLIC = `org_${ORG_UUID.replace(/-/g, "")}`;
const NOW = new Date("2026-07-05T00:00:00.000Z");

function deps(overrides?: Partial<EventsAdminRepository>): EventsOpsDeps {
  return {
    adminRepo: {
      async laneHealth() {
        return {
          ok: true,
          value: [
            {
              laneKey: "notifications",
              orgId: ORG_UUID,
              lastOccurredAt: NOW,
              headOccurredAt: NOW,
              lagSeconds: 1200,
            },
          ],
        };
      },
      async deadLetterCounts() {
        return { ok: true, value: [{ orgId: ORG_UUID, openCount: 3, terminalCount: 1 }] };
      },
      async listSuppressedRules() {
        return {
          ok: true,
          value: [
            {
              ruleId: "rule_abc",
              orgId: ORG_UUID,
              name: "PR storm",
              suppressedAt: NOW,
              suppressedReason: "storm_breaker:5_saturated_windows",
              saturatedWindowCount: 5,
            },
          ],
        };
      },
      ...overrides,
    } as EventsAdminRepository,
  };
}

function ctx(overrides: Partial<SupportRequestContext> = {}): SupportRequestContext {
  return {
    actor: { subjectId: "usr_agent", subjectType: "user" },
    supportRoleClaim: "support_admin",
    systemOverride: false,
    ...overrides,
  };
}

describe("admin-worker: events ops (ES7)", () => {
  it("returns lane health with public org ids for an authorized caller", async () => {
    const res = await handleLaneHealth(createFakeEnv(), "req_1", ctx(), undefined, deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { lanes: Array<Record<string, unknown>> } };
    expect(body.data.lanes[0]!.orgId).toBe(ORG_PUBLIC);
    expect(body.data.lanes[0]!.lagSeconds).toBe(1200);
  });

  it("returns dead-letter counts per org", async () => {
    const res = await handleDeadLetterCounts(createFakeEnv(), "req_1", ctx(), undefined, deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { orgs: Array<Record<string, unknown>> } };
    expect(body.data.orgs[0]!.openCount).toBe(3);
    expect(body.data.orgs[0]!.terminalCount).toBe(1);
  });

  it("returns the currently-suppressed rules for the storm audit", async () => {
    const res = await handleRuleStorms(createFakeEnv(), "req_1", ctx(), undefined, deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { suppressedRules: Array<Record<string, unknown>> } };
    expect(body.data.suppressedRules[0]!.ruleId).toBe("rule_abc");
    expect(body.data.suppressedRules[0]!.orgId).toBe(ORG_PUBLIC);
  });

  it("denies an unauthorized caller (deny-by-default)", async () => {
    const res = await handleLaneHealth(
      createFakeEnv(),
      "req_1",
      ctx({ actor: null, supportRoleClaim: null }),
      undefined,
      deps(),
    );
    expect(res.status).toBe(403);
  });

  it("surfaces a repo failure as 500", async () => {
    const res = await handleDeadLetterCounts(createFakeEnv(), "req_1", ctx(), undefined, deps({
      async deadLetterCounts() {
        return { ok: false, error: { kind: "internal", message: "boom" } };
      },
    }));
    expect(res.status).toBe(500);
  });
});
