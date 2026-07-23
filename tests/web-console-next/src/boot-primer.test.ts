// IC3 — pre-hydration boot primer + persisted-cache policy. Pure logic: the
// script builder is string-in/string-out; the consumer is exercised with a
// stubbed `window` global (no DOM).

import {
  bootPrimerScript,
  consumePrimedBootResponse,
  PRIMED_PATHS,
  PRIMED_TTL_MS,
} from "@web-console-next/lib/boot-primer";
import { epochBuster, isPersistableQueryKey } from "@web-console-next/lib/query-persist";
import { qk } from "@web-console-next/lib/query-keys";

const TARGETS = [
  { name: "stage", url: "https://api-edge-stage.example.workers.dev" },
  { name: "prod", url: "https://api-edge-prod.example.workers.dev" },
];

describe("bootPrimerScript", () => {
  it("embeds the target table, storage prefix, and exactly the boot paths", () => {
    const js = bootPrimerScript(TARGETS, "orun.next");
    expect(js).toContain('"orun.next"');
    expect(js).toContain("https://api-edge-stage.example.workers.dev");
    expect(js).toContain("https://api-edge-prod.example.workers.dev");
    for (const p of PRIMED_PATHS) expect(js).toContain(p);
    // Bails without a token — never fires unauthenticated requests.
    expect(js).toContain('if(!token)return');
    // Defaults to the first target, mirroring session.tsx.
    expect(js).toContain('"stage"');
  });

  it("primes the same reads the shell boots from (profile + org list)", () => {
    expect(PRIMED_PATHS).toEqual(["/v1/auth/profile", "/v1/organizations"]);
  });
});

describe("consumePrimedBootResponse", () => {
  const BASE = "https://api-edge-prod.example.workers.dev";
  const g = globalThis as { window?: unknown };

  afterEach(() => {
    delete g.window;
  });

  function prime(over?: Partial<{ token: string; at: number; consumed: boolean }>) {
    const promise = Promise.resolve({} as Response);
    g.window = {
      __orunPrimedBoot: {
        token: over?.token ?? "tok_1",
        base: BASE,
        at: over?.at ?? Date.now(),
        entries: {
          "/v1/auth/profile": { promise, consumed: over?.consumed ?? false },
          "/v1/organizations": { promise, consumed: over?.consumed ?? false },
        },
      },
    };
    return promise;
  }

  it("adopts a primed GET exactly once (one-shot)", () => {
    const promise = prime();
    expect(consumePrimedBootResponse(`${BASE}/v1/auth/profile`, "GET", "tok_1")).toBe(promise);
    // Second consume of the same path falls through (Response body is single-use).
    expect(consumePrimedBootResponse(`${BASE}/v1/auth/profile`, "GET", "tok_1")).toBeNull();
    // The other path is independent.
    expect(consumePrimedBootResponse(`${BASE}/v1/organizations`, "GET", "tok_1")).toBe(promise);
  });

  it("refuses on token mismatch, wrong base, non-GET, unknown path, and TTL expiry", () => {
    prime();
    expect(consumePrimedBootResponse(`${BASE}/v1/auth/profile`, "GET", "tok_OTHER")).toBeNull();
    expect(consumePrimedBootResponse(`https://elsewhere.dev/v1/auth/profile`, "GET", "tok_1")).toBeNull();
    expect(consumePrimedBootResponse(`${BASE}/v1/auth/profile`, "PATCH", "tok_1")).toBeNull();
    expect(consumePrimedBootResponse(`${BASE}/v1/state/runs`, "GET", "tok_1")).toBeNull();
    prime({ at: Date.now() - PRIMED_TTL_MS - 1 });
    expect(consumePrimedBootResponse(`${BASE}/v1/auth/profile`, "GET", "tok_1")).toBeNull();
  });

  it("matches path ignoring query strings", () => {
    const promise = prime();
    expect(consumePrimedBootResponse(`${BASE}/v1/organizations?limit=50`, "GET", "tok_1")).toBe(promise);
  });
});

describe("persisted-cache policy (D3)", () => {
  it("busts on token change and on target change, without storing the token", () => {
    const a = epochBuster("prod", "tok_1");
    expect(a).toBe(epochBuster("prod", "tok_1")); // stable
    expect(a).not.toBe(epochBuster("prod", "tok_2"));
    expect(a).not.toBe(epochBuster("stage", "tok_1"));
    expect(a).not.toContain("tok_1");
    expect(a.length).toBeLessThan(10); // digest, not the credential
  });

  it("exempts secrets-adjacent keys from persistence", () => {
    expect(isPersistableQueryKey(qk.configSecrets("scope"))).toBe(false);
    expect(isPersistableQueryKey(qk.secretsCapabilities("org_1"))).toBe(false);
    expect(isPersistableQueryKey(qk.orgs())).toBe(true);
    expect(isPersistableQueryKey(qk.profile())).toBe(true);
    expect(isPersistableQueryKey(qk.projects("org_1"))).toBe(true);
  });
});
