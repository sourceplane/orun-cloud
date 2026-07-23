import {
  defaultOrgDestination,
  resolvePostAuthDestination,
} from "@web-console-next/lib/last-org";
import { qk } from "@web-console-next/lib/query-keys";

describe("defaultOrgDestination", () => {
  it("routes to the last-used org's Overview (the Workspace landing) when one is remembered", () => {
    expect(defaultOrgDestination("acme")).toBe("/orgs/acme");
  });

  it("falls back to onboarding when none is remembered — there is no org-less landing view", () => {
    expect(defaultOrgDestination(null)).toBe("/onboarding");
  });
});

describe("resolvePostAuthDestination", () => {
  const org = (id: string, slug: string, createdAt: string) => ({ id, slug, createdAt });
  const profile = (lastOrgSlug: string | null) => ({
    getProfile: async () => ({ user: { lastOrgSlug } }),
  });
  const failingProfile = {
    getProfile: async (): Promise<{ user: { lastOrgSlug?: string | null } }> => {
      throw new Error("api-key token");
    },
  };

  it("prefers the server-side last-org preference", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile("acme"),
      organizations: { list: async () => ({ organizations: [] }) },
    });
    expect(dest).toBe("/orgs/acme");
  });

  it("sends a first sign-in (no orgs) to mandatory onboarding", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile(null),
      organizations: { list: async () => ({ organizations: [] }) },
    });
    expect(dest).toBe("/onboarding");
  });

  it("lands on the account's billing-parent (earliest-created) org when no preference is set", async () => {
    const dest = await resolvePostAuthDestination({
      auth: profile(null),
      organizations: {
        list: async () => ({
          organizations: [
            org("org_b", "beta", "2026-02-01T00:00:00Z"),
            org("org_a", "alpha", "2026-01-01T00:00:00Z"),
          ],
        }),
      },
    });
    expect(dest).toBe("/orgs/alpha");
  });

  it("still resolves via the org list when the profile read fails", async () => {
    const dest = await resolvePostAuthDestination({
      auth: failingProfile,
      organizations: {
        list: async () => ({ organizations: [org("org_a", "alpha", "2026-01-01T00:00:00Z")] }),
      },
    });
    expect(dest).toBe("/orgs/alpha");
  });

  // IC2 — one boot, one fetch: the resolve reads seed the shared query cache
  // so the post-redirect boot paints without re-fetching profile/orgs.
  describe("query-cache seeding (IC2)", () => {
    const seedRecorder = () => {
      const writes: Array<{ key: readonly unknown[]; data: unknown }> = [];
      return {
        writes,
        seed: { setQueryData: (key: readonly unknown[], data: unknown) => writes.push({ key, data }) },
      };
    };

    it("seeds the profile under the shell's qk.profile() key (lockstep guard)", async () => {
      const { writes, seed } = seedRecorder();
      await resolvePostAuthDestination(
        {
          auth: profile("acme"),
          organizations: { list: async () => ({ organizations: [] }) },
        },
        seed,
      );
      expect(writes).toHaveLength(1);
      // Key must equal the shell's cache key or the seeding silently misses.
      expect(writes[0]!.key).toEqual(qk.profile());
      expect(writes[0]!.data).toEqual({ lastOrgSlug: "acme" });
    });

    it("seeds the org list under qk.orgs() when the org list decides", async () => {
      const { writes, seed } = seedRecorder();
      const orgs = [org("org_a", "alpha", "2026-01-01T00:00:00Z")];
      await resolvePostAuthDestination(
        {
          auth: profile(null),
          organizations: { list: async () => ({ organizations: orgs }) },
        },
        seed,
      );
      expect(writes).toHaveLength(2);
      expect(writes[0]!.key).toEqual(qk.profile());
      expect(writes[1]!.key).toEqual(qk.orgs());
      expect(writes[1]!.data).toEqual(orgs);
    });

    it("seeds nothing from failed reads", async () => {
      const { writes, seed } = seedRecorder();
      await resolvePostAuthDestination(
        {
          auth: failingProfile,
          organizations: {
            list: async () => {
              throw new Error("offline");
            },
          },
        },
        seed,
      );
      expect(writes).toHaveLength(0);
    });
  });

  it("falls back to the local cache (empty here) when every read fails", async () => {
    const dest = await resolvePostAuthDestination({
      auth: failingProfile,
      organizations: {
        list: async () => {
          throw new Error("offline");
        },
      },
    });
    // No window/localStorage in this environment, so the cache is empty and the
    // resolver defers to onboarding — which itself forwards once orgs load.
    expect(dest).toBe("/onboarding");
  });
});
