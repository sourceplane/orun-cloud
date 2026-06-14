// Orun-Contract-Version enforcement (state-api-contract §0). A missing header
// is tolerated (older/internal callers); an explicit unsupported major is
// rejected with 409 contract_version_unsupported + the supported range.

import { enforceContractVersion } from "@state-worker/contract-version";

function req(version?: string): Request {
  const headers: Record<string, string> = {};
  if (version !== undefined) headers["orun-contract-version"] = version;
  return new Request("https://state.test/v1/organizations/x/projects/y/state/runs", {
    method: "POST",
    headers,
  });
}

describe("enforceContractVersion", () => {
  it("allows the supported major (1)", () => {
    expect(enforceContractVersion(req("1"), "req_1")).toBeNull();
  });

  it("tolerates a missing header", () => {
    expect(enforceContractVersion(req(), "req_1")).toBeNull();
  });

  it("tolerates a 1.x minor (major still 1)", () => {
    expect(enforceContractVersion(req("1.4"), "req_1")).toBeNull();
  });

  it("rejects an unsupported major with 409 + the supported range", async () => {
    const res = enforceContractVersion(req("2"), "req_1");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    const body = (await res!.json()) as {
      error: { code: string; details: { supported: { min: number; max: number } }; requestId: string };
    };
    expect(body.error.code).toBe("contract_version_unsupported");
    expect(body.error.details.supported).toEqual({ min: 1, max: 1 });
    expect(body.error.requestId).toBe("req_1");
  });

  it("rejects a non-numeric major", () => {
    const res = enforceContractVersion(req("garbage"), "req_1");
    expect(res!.status).toBe(409);
  });
});
