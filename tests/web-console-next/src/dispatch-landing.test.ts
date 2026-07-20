// The landing preference (saas-dispatch DX3): synchronous, per-workspace,
// dispatch-by-default, and storage-failure-tolerant — the front door never
// blocks or throws on a preference read.

import { landingKey, readLanding, writeLanding } from "@web-console-next/lib/dispatch/landing";

function memoryStore(): Pick<Storage, "getItem" | "setItem"> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("landing preference (DX3)", () => {
  it("defaults to dispatch — the swap is the default, not an opt-in", () => {
    expect(readLanding(memoryStore(), "acme")).toBe("dispatch");
    expect(readLanding(null, "acme")).toBe("dispatch");
  });

  it("round-trips overview per workspace", () => {
    const store = memoryStore();
    writeLanding(store, "acme", "overview");
    expect(readLanding(store, "acme")).toBe("overview");
    expect(readLanding(store, "other")).toBe("dispatch"); // scoped per slug
    writeLanding(store, "acme", "dispatch");
    expect(readLanding(store, "acme")).toBe("dispatch");
  });

  it("treats junk values as the default and never throws on storage denial", () => {
    const store = memoryStore();
    store.map.set(landingKey("acme"), "garbage");
    expect(readLanding(store, "acme")).toBe("dispatch");
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readLanding(throwing, "acme")).toBe("dispatch");
    expect(() => writeLanding(throwing, "acme", "overview")).not.toThrow();
  });
});
