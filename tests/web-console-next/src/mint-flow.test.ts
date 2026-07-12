import {
  classifyMintError,
  formatRelative,
  mintPurposeView,
  mintStatusView,
  nextMintState,
  validateMintForm,
  DEFAULT_MINT_TTL_SECONDS,
  MIN_MINT_TTL_SECONDS,
  type MintState,
  type MintTemplateLike,
} from "@web-console-next/components/integrations/mint-flow";

const TEMPLATE: MintTemplateLike = {
  id: "dns-edit",
  displayName: "Edit DNS",
  params: ["zoneIds"],
  maxTtlSeconds: 3600,
};

const NO_PARAMS: MintTemplateLike = {
  id: "workers-deploy",
  displayName: "Deploy Workers",
  params: [],
  maxTtlSeconds: 3600,
};

describe("mint state machine (pick → confirm → minting → revealed | error)", () => {
  const reviewed = nextMintState(
    { phase: "pick" },
    { type: "review", templateId: "dns-edit", params: { zoneIds: "z1" }, ttlSeconds: 900 },
  );

  it("review moves pick → confirm carrying the validated request", () => {
    expect(reviewed).toEqual({
      phase: "confirm",
      templateId: "dns-edit",
      params: { zoneIds: "z1" },
      ttlSeconds: 900,
    });
  });

  it("confirmMint is only honored from confirm", () => {
    expect(nextMintState({ phase: "pick" }, { type: "confirmMint" })).toEqual({ phase: "pick" });
    const minting = nextMintState(reviewed, { type: "confirmMint" });
    expect(minting.phase).toBe("minting");
  });

  it("back returns confirm and error to pick", () => {
    expect(nextMintState(reviewed, { type: "back" })).toEqual({ phase: "pick" });
    const err: MintState = {
      phase: "error",
      reason: { kind: "message", message: "boom", requestId: null },
    };
    expect(nextMintState(err, { type: "back" })).toEqual({ phase: "pick" });
  });

  it("mint results are only honored while minting", () => {
    const succeeded = {
      type: "mintSucceeded",
      credential: { token: "sekret" },
      mintId: "mint_1",
      expiresAt: "2026-07-12T00:15:00Z",
    } as const;
    // Not from confirm…
    expect(nextMintState(reviewed, succeeded)).toEqual(reviewed);
    // …only from minting.
    const minting = nextMintState(reviewed, { type: "confirmMint" });
    const revealed = nextMintState(minting, succeeded);
    expect(revealed).toEqual({
      phase: "revealed",
      credential: { token: "sekret" },
      mintId: "mint_1",
      expiresAt: "2026-07-12T00:15:00Z",
    });
    const failed = nextMintState(minting, {
      type: "mintFailed",
      reason: { kind: "message", message: "nope", requestId: "req_1" },
    });
    expect(failed.phase).toBe("error");
  });

  it("REVEAL-ONCE: close always resets to pick and drops the credential", () => {
    const minting = nextMintState(reviewed, { type: "confirmMint" });
    const revealed = nextMintState(minting, {
      type: "mintSucceeded",
      credential: { token: "sekret" },
      mintId: "mint_1",
      expiresAt: "2026-07-12T00:15:00Z",
    });
    const closed = nextMintState(revealed, { type: "close" });
    expect(closed).toEqual({ phase: "pick" });
    expect(JSON.stringify(closed)).not.toContain("sekret");
    // The revealed pane has exactly one exit — close. Other events are inert.
    expect(nextMintState(revealed, { type: "back" })).toBe(revealed);
    // close is honored from every phase.
    expect(nextMintState(minting, { type: "close" })).toEqual({ phase: "pick" });
    expect(nextMintState(reviewed, { type: "close" })).toEqual({ phase: "pick" });
  });
});

describe("validateMintForm", () => {
  it("requires every declared param non-empty (trimmed)", () => {
    const r = validateMintForm(TEMPLATE, { zoneIds: "   " }, "");
    expect(r).toEqual({ ok: false, errors: { zoneIds: "Required" } });
  });

  it("trims params and drops undeclared ones", () => {
    const r = validateMintForm(TEMPLATE, { zoneIds: " z1 ", stray: "x" }, "");
    expect(r).toEqual({ ok: true, params: { zoneIds: "z1" }, ttlSeconds: DEFAULT_MINT_TTL_SECONDS });
  });

  it("defaults the TTL to 900s clamped to the template max", () => {
    const short: MintTemplateLike = { ...NO_PARAMS, maxTtlSeconds: 600 };
    expect(validateMintForm(NO_PARAMS, {}, "")).toEqual({ ok: true, params: {}, ttlSeconds: 900 });
    expect(validateMintForm(short, {}, "")).toEqual({ ok: true, params: {}, ttlSeconds: 600 });
  });

  it("bounds an explicit TTL to [60, maxTtlSeconds] integers", () => {
    expect(validateMintForm(NO_PARAMS, {}, "120")).toEqual({ ok: true, params: {}, ttlSeconds: 120 });
    expect(validateMintForm(NO_PARAMS, {}, "59")).toEqual({
      ok: false,
      errors: { ttl: `Between ${MIN_MINT_TTL_SECONDS} and 3600 seconds` },
    });
    expect(validateMintForm(NO_PARAMS, {}, "3601").ok).toBe(false);
    expect(validateMintForm(NO_PARAMS, {}, "12.5").ok).toBe(false);
    expect(validateMintForm(NO_PARAMS, {}, "abc").ok).toBe(false);
  });

  it("reports param and TTL errors together", () => {
    const r = validateMintForm(TEMPLATE, {}, "banana");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.zoneIds).toBe("Required");
      expect(r.errors.ttl).toBe("Whole number of seconds");
    }
  });
});

describe("classifyMintError", () => {
  it("types 412 entitlement reasons for the upgrade card", () => {
    for (const reason of ["limit_reached", "disabled", "not_configured", "malformed_limit"]) {
      const r = classifyMintError(412, { code: "precondition_failed", message: "gate", reason });
      expect(r.kind).toBe("entitlement");
    }
  });

  it("renders non-entitlement 412s (parent grant) and other statuses inline", () => {
    const parent = classifyMintError(412, {
      code: "precondition_failed",
      message: "parent grant insufficient",
      reason: "parent_grant_insufficient",
      requestId: "req_9",
    });
    expect(parent).toEqual({ kind: "message", message: "parent grant insufficient", requestId: "req_9" });
    const forbidden = classifyMintError(403, { code: "forbidden", message: "no policy" });
    expect(forbidden).toEqual({ kind: "message", message: "no policy", requestId: null });
  });
});

describe("mint ledger views", () => {
  const now = new Date("2026-07-12T12:00:00Z");

  it("maps revoke status (+ expiry) to pills", () => {
    expect(mintStatusView({ revokeStatus: "pending", expiresAt: "2026-07-12T12:10:00Z" }, now)).toEqual({
      label: "Active",
      tone: "success",
    });
    // A pending row past expiry is honest about being dead even before the sweep.
    expect(mintStatusView({ revokeStatus: "pending", expiresAt: "2026-07-12T11:00:00Z" }, now)).toEqual({
      label: "Expired",
      tone: "neutral",
    });
    expect(mintStatusView({ revokeStatus: "revoked", expiresAt: "2026-07-12T12:10:00Z" }, now).label).toBe("Revoked");
    expect(mintStatusView({ revokeStatus: "expired", expiresAt: "2026-07-12T11:00:00Z" }, now).label).toBe("Expired");
    expect(mintStatusView({ revokeStatus: "orphaned", expiresAt: "2026-07-12T11:00:00Z" }, now)).toEqual({
      label: "Orphaned",
      tone: "warning",
    });
  });

  it("labels purposes", () => {
    expect(mintPurposeView("api")).toEqual({ label: "API", variant: "info" });
    expect(mintPurposeView("secret_resolve")).toEqual({ label: "Secret resolve", variant: "secondary" });
  });

  it("formats relative timestamps in both directions", () => {
    expect(formatRelative("2026-07-12T11:55:00Z", now)).toBe("5m ago");
    expect(formatRelative("2026-07-12T12:10:00Z", now)).toBe("in 10m");
    expect(formatRelative("2026-07-12T14:00:00Z", now)).toBe("in 2h");
    expect(formatRelative("2026-07-09T12:00:00Z", now)).toBe("3d ago");
    expect(formatRelative("garbage", now)).toBe("—");
  });
});
