import {
  classifyTokenConnectFailure,
  isValidParentTokenFormat,
  nextTokenConnectState,
  type TokenConnectState,
} from "@web-console-next/components/integrations/token-connect-flow";

const idle: TokenConnectState = { phase: "idle" };
// A realistic Cloudflare API token shape: 40 url-safe chars.
const GOOD_TOKEN = "a".repeat(20) + "B9_-".repeat(5);

describe("parent-token format precheck (mirrors PARENT_TOKEN_RE)", () => {
  it("accepts 40 url-safe chars and the 20..256 band", () => {
    expect(GOOD_TOKEN).toHaveLength(40);
    expect(isValidParentTokenFormat(GOOD_TOKEN)).toBe(true);
    expect(isValidParentTokenFormat("a".repeat(20))).toBe(true);
    expect(isValidParentTokenFormat("a".repeat(256))).toBe(true);
    expect(isValidParentTokenFormat("A1._-" + "z".repeat(35))).toBe(true);
  });

  it("rejects too-short, too-long, and non-url-safe pastes", () => {
    expect(isValidParentTokenFormat("")).toBe(false);
    expect(isValidParentTokenFormat("a".repeat(19))).toBe(false);
    expect(isValidParentTokenFormat("a".repeat(257))).toBe(false);
    expect(isValidParentTokenFormat("token with spaces here padded out")).toBe(false);
    expect(isValidParentTokenFormat("Bearer%20" + "a".repeat(31))).toBe(false);
  });

  it("trims surrounding whitespace before checking", () => {
    expect(isValidParentTokenFormat(`  ${GOOD_TOKEN}\n`)).toBe(true);
  });
});

describe("token-connect state machine", () => {
  it("idle → submitting on a well-formed paste", () => {
    expect(nextTokenConnectState(idle, { type: "submit", token: GOOD_TOKEN })).toEqual({
      phase: "submitting",
    });
  });

  it("short-circuits a malformed paste to error(invalid_format) — no API call state", () => {
    const next = nextTokenConnectState(idle, { type: "submit", token: "nope" });
    expect(next.phase).toBe("error");
    if (next.phase === "error") {
      expect(next.kind).toBe("invalid_format");
      expect(next.requestId).toBeNull();
      // The paste is never echoed back in the state.
      expect(next.message).not.toContain("nope");
    }
  });

  it("never stores the token in any state", () => {
    const submitting = nextTokenConnectState(idle, { type: "submit", token: GOOD_TOKEN });
    expect(JSON.stringify(submitting)).not.toContain(GOOD_TOKEN);
  });

  it("submitting → connected on success", () => {
    const submitting = nextTokenConnectState(idle, { type: "submit", token: GOOD_TOKEN });
    expect(nextTokenConnectState(submitting, { type: "succeeded" })).toEqual({
      phase: "connected",
    });
  });

  it.each(["verify_failed", "parent_grant", "entitlement", "unavailable"] as const)(
    "submitting → error(%s) carrying the message and requestId",
    (kind) => {
      const submitting = nextTokenConnectState(idle, { type: "submit", token: GOOD_TOKEN });
      const next = nextTokenConnectState(submitting, {
        type: "failed",
        kind,
        message: "Cloudflare said no",
        requestId: "req_1",
      });
      expect(next).toEqual({
        phase: "error",
        kind,
        message: "Cloudflare said no",
        requestId: "req_1",
      });
    },
  );

  it("allows resubmit from an error state (retry the paste)", () => {
    const errored = nextTokenConnectState(idle, { type: "submit", token: "bad" });
    expect(nextTokenConnectState(errored, { type: "submit", token: GOOD_TOKEN })).toEqual({
      phase: "submitting",
    });
  });

  it("ignores a second submit while one is in flight", () => {
    const submitting = nextTokenConnectState(idle, { type: "submit", token: GOOD_TOKEN });
    expect(nextTokenConnectState(submitting, { type: "submit", token: GOOD_TOKEN })).toBe(
      submitting,
    );
  });

  it("reset returns idle from every phase, and a late API result after reset is a no-op", () => {
    const submitting = nextTokenConnectState(idle, { type: "submit", token: GOOD_TOKEN });
    for (const state of [
      idle,
      submitting,
      nextTokenConnectState(submitting, { type: "succeeded" }),
      nextTokenConnectState(idle, { type: "submit", token: "bad" }),
    ]) {
      expect(nextTokenConnectState(state, { type: "reset" })).toEqual({ phase: "idle" });
    }
    // Modal closed mid-flight: the in-flight call's late result must not
    // resurrect the flow.
    const closed = nextTokenConnectState(submitting, { type: "reset" });
    expect(
      nextTokenConnectState(closed, {
        type: "failed",
        kind: "unavailable",
        message: "late",
        requestId: null,
      }),
    ).toEqual({ phase: "idle" });
    expect(nextTokenConnectState(closed, { type: "succeeded" })).toEqual({ phase: "idle" });
  });
});

describe("classifyTokenConnectFailure (bounded 412 reasons → typed states)", () => {
  it("maps token_verification_failed → verify_failed", () => {
    expect(classifyTokenConnectFailure(412, { reason: "token_verification_failed" })).toBe(
      "verify_failed",
    );
  });

  it("maps no_account_visible → parent_grant", () => {
    expect(classifyTokenConnectFailure(412, { reason: "no_account_visible" })).toBe("parent_grant");
  });

  it("maps the entitlement-seam reasons → entitlement", () => {
    for (const reason of ["limit_reached", "disabled", "malformed_limit"]) {
      expect(classifyTokenConnectFailure(412, { reason })).toBe("entitlement");
    }
    // `not_configured` from the entitlement seam carries the entitlement key…
    expect(
      classifyTokenConnectFailure(412, {
        reason: "not_configured",
        details: { reason: "not_configured", entitlementKey: "integrations.cloudflare" },
      }),
    ).toBe("entitlement");
  });

  it("maps the custody/registration not_configured gate → unavailable", () => {
    // …while the custody gate carries `gate` instead (cloudflare-connect.ts).
    expect(
      classifyTokenConnectFailure(412, {
        reason: "not_configured",
        details: { reason: "not_configured", gate: "cloudflare_custody" },
      }),
    ).toBe("unavailable");
  });

  it("maps conflicts, server errors, and network failures → unavailable", () => {
    expect(classifyTokenConnectFailure(409, {})).toBe("unavailable");
    expect(classifyTokenConnectFailure(503, {})).toBe("unavailable");
    expect(classifyTokenConnectFailure(0, {})).toBe("unavailable");
    expect(classifyTokenConnectFailure(412, { reason: "something_new" })).toBe("unavailable");
  });
});
