// ConnectionMintLock Durable Object (IH6 custody) — the runtime half of
// mint-lock.ts, split into its own module because `cloudflare:workers` only
// resolves inside the Workers runtime (the jest suites import the pure core +
// runner from mint-lock.ts). One instance per connection; see mint-lock.ts
// for the full design narrative.

import { DurableObject } from "cloudflare:workers";
import { MintLockCore, DEFAULT_LEASE_MS, DEFAULT_WAIT_MS, type LockGrant } from "./mint-lock.js";

interface Waiter {
  leaseMs: number;
  settled: boolean;
  grant: (grant: LockGrant) => void;
  giveUp: () => void;
  timer: ReturnType<typeof setTimeout>;
}

const HOLDER_KEY = "holder";

/**
 * One instance per connection. Requests:
 *   POST /acquire {leaseMs?, waitMs?} → {granted: true, token} | {granted: false}
 *   POST /release {token}            → {released: boolean}
 */
export class ConnectionMintLock extends DurableObject {
  private readonly core = new MintLockCore();
  private waiters: Waiter[] = [];
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const holder = await this.ctx.storage.get<LockGrant>(HOLDER_KEY);
    this.core.restore(holder ?? null);
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const holder = this.core.current();
    if (holder) {
      await this.ctx.storage.put(HOLDER_KEY, holder);
      await this.ctx.storage.setAlarm(holder.expiresAt);
    } else {
      await this.ctx.storage.delete(HOLDER_KEY);
    }
  }

  /** Grant the lock to the next live waiter (FIFO), if any. */
  private async grantNext(nowMs: number): Promise<void> {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.settled) continue;
      const grant = this.core.acquire(nowMs, waiter.leaseMs);
      if (!grant) {
        // Someone re-acquired between release and grant — put the waiter back.
        this.waiters.unshift(waiter);
        return;
      }
      waiter.settled = true;
      clearTimeout(waiter.timer);
      await this.persist();
      waiter.grant(grant);
      return;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const now = Date.now();

    if (url.pathname === "/acquire") {
      const leaseMs = typeof body.leaseMs === "number" && body.leaseMs > 0 ? body.leaseMs : DEFAULT_LEASE_MS;
      const waitMs = typeof body.waitMs === "number" && body.waitMs >= 0 ? body.waitMs : DEFAULT_WAIT_MS;

      const immediate = this.core.acquire(now, leaseMs);
      if (immediate) {
        await this.persist();
        return Response.json({ granted: true, token: immediate.token });
      }

      // Held: park FIFO until released/expired or the wait budget lapses.
      const outcome = await new Promise<LockGrant | null>((resolve) => {
        const waiter: Waiter = {
          leaseMs,
          settled: false,
          grant: (grant) => resolve(grant),
          giveUp: () => resolve(null),
          timer: setTimeout(() => {
            if (!waiter.settled) {
              waiter.settled = true;
              waiter.giveUp();
            }
          }, waitMs),
        };
        this.waiters.push(waiter);
      });
      if (!outcome) return Response.json({ granted: false });
      return Response.json({ granted: true, token: outcome.token });
    }

    if (url.pathname === "/release") {
      const token = typeof body.token === "string" ? body.token : "";
      const released = this.core.release(token);
      if (released) {
        await this.persist();
        await this.grantNext(Date.now());
      }
      return Response.json({ released });
    }

    return Response.json({ error: "unknown op" }, { status: 404 });
  }

  /** Lease-expiry backstop: clear a dead holder and grant the next waiter. */
  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    const now = Date.now();
    if (this.core.expireIfDue(now)) {
      await this.persist();
      await this.grantNext(now);
    } else if (this.core.current()) {
      await this.ctx.storage.setAlarm(this.core.current()!.expiresAt);
    }
  }
}

