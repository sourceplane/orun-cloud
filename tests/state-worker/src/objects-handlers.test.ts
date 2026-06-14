// OP3 object & log plane — HTTP handler tests. Verify the exact {data,meta} /
// {error} envelopes, digest-verified PUT (match → store/idempotent; mismatch →
// 400), objects/missing negotiation, the multipart upload trio (with assembled-
// digest verify), log append with the live-lease check (no lease → lease_lost) +
// the fromSeq assembled read, catalog head advance (digest-exists + event), and
// that metering usage records flow. DB is a scripted fake executor; R2 is an
// in-memory FakeBucket; auth/projects are configurable fetchers (mirrors
// runs-handlers.test.ts / links.test.ts).

import {
  handleObjectsMissing,
  handlePutObject,
  handleGetObject,
  handleStartUpload,
  handleUploadPart,
  handleCompleteUpload,
} from "@state-worker/handlers/objects";
import { handleAppendLog, handleReadLog } from "@state-worker/handlers/logs";
import { handleAdvanceCatalogHead, handleGetCatalogHead } from "@state-worker/handlers/catalog";
import type { Env } from "@state-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/hyperdrive";
import { asUuid } from "@saas/db";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const RUN_ROW = "33333333-3333-4333-8333-333333333333";
const ORG_PUBLIC = `org_${ORG.replace(/-/g, "")}`;
const PROJECT_PUBLIC = `prj_${PROJECT.replace(/-/g, "")}`;
const ULID = "01J0000000000000000000ABCD";
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };
const NOW = new Date("2026-06-14T10:00:00.000Z");

// sha256 of the bytes "hello" — computed once, used as the canonical digest.
const HELLO = "hello";
const HELLO_DIGEST = "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function membershipFetcher(): Fetcher {
  return {
    fetch: (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("authorization-context")) {
        return Promise.resolve(
          Response.json({
            data: {
              memberships: [
                { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_PUBLIC } },
              ],
            },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

function policyFetcher(allow: boolean): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json({ data: { allow } })),
    connect() {
      throw new Error("ni");
    },
  } as unknown as Fetcher;
}

type Responder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: Responder): {
  executor: SqlExecutor;
  queries: { text: string; params: unknown[] }[];
} {
  const queries: { text: string; params: unknown[] }[] = [];
  const executor: SqlExecutor = {
    execute<T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  };
  return { executor, queries };
}

// ── In-memory R2 bucket modeling the subset OP3 uses. ──
interface FakeR2Object {
  bytes: Uint8Array;
  customMetadata?: Record<string, string> | undefined;
}

class FakeMultipart {
  parts = new Map<number, Uint8Array>();
  constructor(
    public key: string,
    public uploadId: string,
    private bucket: FakeBucket,
  ) {}
  uploadPart(partNumber: number, value: ArrayBuffer | Uint8Array | string): Promise<{ partNumber: number; etag: string }> {
    const bytes = toBytes(value);
    this.parts.set(partNumber, bytes);
    return Promise.resolve({ partNumber, etag: `etag-${partNumber}` });
  }
  complete(uploaded: { partNumber: number; etag: string }[]): Promise<{ key: string; size: number }> {
    const ordered = [...uploaded].sort((a, b) => a.partNumber - b.partNumber);
    let total = 0;
    for (const p of ordered) total += this.parts.get(p.partNumber)!.byteLength;
    const assembled = new Uint8Array(total);
    let offset = 0;
    for (const p of ordered) {
      const b = this.parts.get(p.partNumber)!;
      assembled.set(b, offset);
      offset += b.byteLength;
    }
    this.bucket.store.set(this.key, { bytes: assembled });
    return Promise.resolve({ key: this.key, size: total });
  }
  abort(): Promise<void> {
    return Promise.resolve();
  }
}

function toBytes(value: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value);
}

class FakeBucket {
  store = new Map<string, FakeR2Object>();
  uploads = new Map<string, FakeMultipart>();
  private counter = 0;

  put(key: string, value: ArrayBuffer | Uint8Array | string, opts?: { customMetadata?: Record<string, string> }): Promise<unknown> {
    this.store.set(key, { bytes: toBytes(value), customMetadata: opts?.customMetadata });
    return Promise.resolve({ key });
  }
  get(key: string): Promise<unknown> {
    const o = this.store.get(key);
    if (!o) return Promise.resolve(null);
    return Promise.resolve({
      key,
      body: o.bytes,
      arrayBuffer: () => Promise.resolve(o.bytes.slice().buffer),
      json: () => Promise.resolve(JSON.parse(new TextDecoder().decode(o.bytes))),
      text: () => Promise.resolve(new TextDecoder().decode(o.bytes)),
    });
  }
  head(key: string): Promise<unknown> {
    const o = this.store.get(key);
    return Promise.resolve(o ? { key, size: o.bytes.byteLength } : null);
  }
  delete(keys: string | string[]): Promise<void> {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) this.store.delete(k);
    return Promise.resolve();
  }
  createMultipartUpload(key: string): Promise<FakeMultipart> {
    const uploadId = `up-${++this.counter}`;
    const mp = new FakeMultipart(key, uploadId, this);
    this.uploads.set(uploadId, mp);
    return Promise.resolve(mp);
  }
  resumeMultipartUpload(key: string, uploadId: string): FakeMultipart {
    let mp = this.uploads.get(uploadId);
    if (!mp) {
      mp = new FakeMultipart(key, uploadId, this);
      this.uploads.set(uploadId, mp);
    }
    return mp;
  }
  list(opts: { prefix?: string }): Promise<{ objects: { key: string }[]; truncated: false; delimitedPrefixes: string[] }> {
    const prefix = opts.prefix ?? "";
    const objects = [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
    return Promise.resolve({ objects, truncated: false, delimitedPrefixes: [] });
  }
}

function createEnv(bucket: FakeBucket | null, allow = true): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    ORUN_STATE: bucket as unknown as R2Bucket,
    MEMBERSHIP_WORKER: membershipFetcher(),
    POLICY_WORKER: policyFetcher(allow),
  } as unknown as Env;
}

function objectRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "obj-1",
    org_id: ORG,
    project_id: PROJECT,
    digest: HELLO_DIGEST,
    kind: "plan",
    size_bytes: 5,
    created_by: ACTOR.subjectId,
    created_by_kind: "user",
    created_at: NOW.toISOString(),
    ...over,
  };
}

function runRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: RUN_ROW,
    org_id: ORG,
    project_id: PROJECT,
    environment: "production",
    run_ulid: ULID,
    plan_digest: HELLO_DIGEST,
    source: "cli",
    status: "running",
    git_commit: "c",
    git_ref: "r",
    git_dirty: false,
    labels: "{}",
    created_by: ACTOR.subjectId,
    created_by_kind: "user",
    started_at: NOW.toISOString(),
    finished_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

function jobRow(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-row-1",
    org_id: ORG,
    project_id: PROJECT,
    run_id: RUN_ROW,
    job_id: "build",
    component: "api",
    deps: "[]",
    status: "running",
    runner_id: "runner-1",
    lease_expires_at: new Date(Date.now() + 60000).toISOString(),
    attempt: 1,
    error_text: null,
    started_at: NOW.toISOString(),
    finished_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...over,
  };
}

function logChunkRow(seq: number): Record<string, unknown> {
  return {
    id: `chunk-${seq}`,
    org_id: ORG,
    project_id: PROJECT,
    run_id: RUN_ROW,
    job_id: "build",
    seq,
    byte_length: 5,
    created_at: NOW.toISOString(),
  };
}

// ── objects/missing ─────────────────────────────────────────

describe("POST …/state/objects/missing — negotiation", () => {
  it("returns {data:{missing:[...]}} for the subset NOT already stored", async () => {
    const present = "sha256:" + "a".repeat(64);
    const absent = "sha256:" + "b".repeat(64);
    const { executor } = fakeExecutor((text) => {
      if (text.includes("SELECT digest FROM state.objects")) return [{ digest: present }];
      return [];
    });
    const req = new Request("https://s/v1/organizations/x/projects/y/state/objects/missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digests: [present, absent] }),
    });
    const res = await handleObjectsMissing(req, createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { missing: string[] }; meta: { requestId: string } };
    expect(body.data.missing).toEqual([absent]);
    expect(body.meta.requestId).toBe("req_1");
  });

  it("422 on a malformed digest", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request("https://s/.../objects/missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digests: ["not-a-digest"] }),
    });
    const res = await handleObjectsMissing(req, createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(422);
  });

  it("404 (resource hiding) when policy denies", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request("https://s/.../objects/missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digests: ["sha256:" + "a".repeat(64)] }),
    });
    const res = await handleObjectsMissing(req, createEnv(new FakeBucket(), false), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(404);
  });
});

// ── PUT object (digest-verified, idempotent) ────────────────

describe("PUT …/state/objects/{digest} — digest-verified, idempotent", () => {
  it("stores a fresh object (201), verifies the digest, emits metering", async () => {
    const bucket = new FakeBucket();
    const usage: unknown[][] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO state.objects")) return [objectRow()]; // created
      if (text.includes("INSERT INTO metering.usage_records")) {
        usage.push(params);
        return [{ id: "u", org_id: ORG, project_id: PROJECT, metric: params[5], quantity: params[6], idempotency_key: params[7], recorded_at: NOW.toISOString(), created_at: NOW.toISOString() }];
      }
      return [];
    });
    const req = new Request(`https://s/.../objects/${HELLO_DIGEST}`, {
      method: "PUT",
      headers: { "Orun-Object-Kind": "plan" },
      body: HELLO,
    });
    const res = await handlePutObject(req, createEnv(bucket), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, { executor });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { object: { digest: string; kind: string }; created: boolean } };
    expect(body.data.created).toBe(true);
    expect(body.data.object.digest).toBe(HELLO_DIGEST);
    expect(body.data.object.kind).toBe("plan");
    // Bytes landed in R2 at the scoped key.
    expect(bucket.store.has(`state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/objects/${HELLO_DIGEST}`)).toBe(true);
    // Two usage records flowed: object_bytes + object_count.
    const metrics = usage.map((p) => p[5]);
    expect(metrics).toContain("state.object_bytes");
    expect(metrics).toContain("state.object_count");
  });

  it("400 digest_mismatch when the body sha256 != path digest", async () => {
    const bucket = new FakeBucket();
    const { executor } = fakeExecutor(() => []);
    const wrongDigest = "sha256:" + "c".repeat(64);
    const req = new Request(`https://s/.../objects/${wrongDigest}`, {
      method: "PUT",
      headers: { "Orun-Object-Kind": "plan" },
      body: HELLO, // hashes to HELLO_DIGEST, not wrongDigest
    });
    const res = await handlePutObject(req, createEnv(bucket), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), wrongDigest, { executor });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { actual: string } } };
    expect(body.error.code).toBe("digest_mismatch");
    expect(body.error.details.actual).toBe(HELLO_DIGEST);
    // Nothing was written to R2.
    expect(bucket.store.size).toBe(0);
  });

  it("idempotent no-op (200, created:false) when the digest already exists", async () => {
    const bucket = new FakeBucket();
    const { executor } = fakeExecutor((text) => {
      if (text.includes("INSERT INTO state.objects")) return []; // ON CONFLICT DO NOTHING → no row
      if (text.includes("SELECT * FROM state.objects")) return [objectRow()];
      return [];
    });
    const req = new Request(`https://s/.../objects/${HELLO_DIGEST}`, {
      method: "PUT",
      headers: { "Orun-Object-Kind": "plan" },
      body: HELLO,
    });
    const res = await handlePutObject(req, createEnv(bucket), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { created: boolean } };
    expect(body.data.created).toBe(false);
    // No R2 re-write on an idempotent no-op.
    expect(bucket.store.size).toBe(0);
  });

  it("422 when the Orun-Object-Kind header is missing/invalid", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request(`https://s/.../objects/${HELLO_DIGEST}`, { method: "PUT", body: HELLO });
    const res = await handlePutObject(req, createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, { executor });
    expect(res.status).toBe(422);
  });

  it("503 storage_unavailable when R2 is unbound (the dev no-R2 case)", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request(`https://s/.../objects/${HELLO_DIGEST}`, {
      method: "PUT",
      headers: { "Orun-Object-Kind": "plan" },
      body: HELLO,
    });
    const res = await handlePutObject(req, createEnv(null), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, { executor });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("storage_unavailable");
  });
});

// ── GET object ──────────────────────────────────────────────

describe("GET …/state/objects/{digest} — blob bytes", () => {
  it("returns the stored bytes with the kind header", async () => {
    const bucket = new FakeBucket();
    await bucket.put(`state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/objects/${HELLO_DIGEST}`, HELLO);
    const { executor } = fakeExecutor((text) => {
      if (text.includes("SELECT * FROM state.objects")) return [objectRow()];
      return [];
    });
    const res = await handleGetObject(createEnv(bucket), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, { executor });
    expect(res.status).toBe(200);
    expect(res.headers.get("orun-object-kind")).toBe("plan");
    expect(await res.text()).toBe(HELLO);
  });

  it("404 when the index row is absent (cross-tenant hiding)", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleGetObject(createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, { executor });
    expect(res.status).toBe(404);
  });
});

// ── Multipart upload trio ───────────────────────────────────

describe("chunked upload (R2 multipart) — start/part/complete", () => {
  it("round-trips a blob over multiple parts and verifies the assembled digest", async () => {
    const bucket = new FakeBucket();
    const usage: unknown[][] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO state.objects")) return [objectRow({ size_bytes: 5 })];
      if (text.includes("INSERT INTO metering.usage_records")) {
        usage.push(params);
        return [{ id: "u", org_id: ORG, project_id: PROJECT, metric: params[5], quantity: params[6], idempotency_key: params[7], recorded_at: NOW.toISOString(), created_at: NOW.toISOString() }];
      }
      return [];
    });
    const env = createEnv(bucket);

    // start
    const startRes = await handleStartUpload(env, "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST);
    expect(startRes.status).toBe(201);
    const start = (await startRes.json()) as { data: { uploadId: string; partSize: number } };
    const uploadId = start.data.uploadId;
    expect(typeof uploadId).toBe("string");
    expect(start.data.partSize).toBeGreaterThan(0);

    // two parts: "hel" + "lo" → assembles to "hello"
    const p1 = new Request("https://s/part1", { method: "PUT", body: "hel" });
    const r1 = await handleUploadPart(p1, env, "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, uploadId, 1);
    expect(r1.status).toBe(200);
    const p2 = new Request("https://s/part2", { method: "PUT", body: "lo" });
    const r2 = await handleUploadPart(p2, env, "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, uploadId, 2);
    expect(r2.status).toBe(200);

    // complete
    const cReq = new Request("https://s/complete", { method: "POST", headers: { "Orun-Object-Kind": "plan" } });
    const cRes = await handleCompleteUpload(cReq, env, "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), HELLO_DIGEST, uploadId, { executor });
    expect(cRes.status).toBe(201);
    const body = (await cRes.json()) as { data: { object: { digest: string }; created: boolean } };
    expect(body.data.created).toBe(true);
    expect(body.data.object.digest).toBe(HELLO_DIGEST);
    // The assembled blob is at the final object key.
    expect(bucket.store.has(`state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/objects/${HELLO_DIGEST}`)).toBe(true);
    expect(usage.map((p) => p[5])).toContain("state.object_bytes");
  });

  it("complete rejects (400 digest_mismatch) when the assembled bytes don't match the claimed digest", async () => {
    const bucket = new FakeBucket();
    const { executor } = fakeExecutor(() => []);
    const env = createEnv(bucket);
    const wrongDigest = "sha256:" + "d".repeat(64);

    const startRes = await handleStartUpload(env, "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), wrongDigest);
    const uploadId = ((await startRes.json()) as { data: { uploadId: string } }).data.uploadId;

    const p1 = new Request("https://s/p", { method: "PUT", body: "hello" }); // hashes to HELLO_DIGEST
    await handleUploadPart(p1, env, "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), wrongDigest, uploadId, 1);

    const cReq = new Request("https://s/c", { method: "POST", headers: { "Orun-Object-Kind": "plan" } });
    const cRes = await handleCompleteUpload(cReq, env, "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), wrongDigest, uploadId, { executor });
    expect(cRes.status).toBe(400);
    const body = (await cRes.json()) as { error: { code: string; details: { actual: string } } };
    expect(body.error.code).toBe("digest_mismatch");
    expect(body.error.details.actual).toBe(HELLO_DIGEST);
    // The corrupt assembled object was deleted.
    expect(bucket.store.has(`state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/objects/${wrongDigest}`)).toBe(false);
  });
});

// ── Logs: append (lease check) + read ───────────────────────

describe("POST …/runs/{runId}/logs/{jobId} — append with lease check", () => {
  it("appends a chunk (200 {seq}), stores it in R2, emits log_bytes metering", async () => {
    const bucket = new FakeBucket();
    const usage: unknown[][] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("FROM state.runs")) return [runRow()];
      if (text.includes("FROM state.run_jobs")) return [jobRow()]; // live lease
      if (text.includes("SELECT * FROM state.log_chunks")) return []; // no chunks yet → seq 0
      if (text.includes("INSERT INTO state.log_chunks")) return [logChunkRow(0)];
      if (text.includes("INSERT INTO metering.usage_records")) {
        usage.push(params);
        return [{ id: "u", org_id: ORG, project_id: PROJECT, metric: params[5], quantity: params[6], idempotency_key: params[7], recorded_at: NOW.toISOString(), created_at: NOW.toISOString() }];
      }
      return [];
    });
    const req = new Request("https://s/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", content: HELLO }),
    });
    const res = await handleAppendLog(req, createEnv(bucket), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), ULID, "build", { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { seq: number } };
    expect(body.data.seq).toBe(0);
    expect(bucket.store.has(`state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/runs/${ULID}/logs/build/0`)).toBe(true);
    expect(usage.map((p) => p[5])).toContain("state.log_bytes");
  });

  it("409 lease_lost when the runner does not hold a live lease", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM state.runs")) return [runRow()];
      if (text.includes("FROM state.run_jobs")) return [jobRow({ runner_id: "other-runner" })];
      return [];
    });
    const req = new Request("https://s/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", content: HELLO }),
    });
    const res = await handleAppendLog(req, createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), ULID, "build", { executor });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("lease_lost");
  });

  it("409 lease_lost when the lease has expired", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM state.runs")) return [runRow()];
      if (text.includes("FROM state.run_jobs")) return [jobRow({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })];
      return [];
    });
    const req = new Request("https://s/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "runner-1", content: HELLO }),
    });
    const res = await handleAppendLog(req, createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), ULID, "build", { executor });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("lease_lost");
  });
});

describe("GET …/runs/{runId}/logs/{jobId}?fromSeq= — assembled read", () => {
  it("assembles chunks from fromSeq and returns nextSeq + complete", async () => {
    const bucket = new FakeBucket();
    await bucket.put(`state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/runs/${ULID}/logs/build/0`, "foo");
    await bucket.put(`state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/runs/${ULID}/logs/build/1`, "bar");
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM state.runs")) return [runRow()];
      if (text.includes("SELECT * FROM state.log_chunks")) return [logChunkRow(0), logChunkRow(1)];
      if (text.includes("FROM state.run_jobs")) return [jobRow({ status: "succeeded", runner_id: null, lease_expires_at: null })];
      return [];
    });
    const req = new Request("https://s/logs?fromSeq=0", { method: "GET" });
    const res = await handleReadLog(req, createEnv(bucket), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), ULID, "build", { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { content: string; nextSeq: number; complete: boolean } };
    expect(body.data.content).toBe("foobar");
    expect(body.data.nextSeq).toBe(2);
    expect(body.data.complete).toBe(true);
  });

  it("complete:false while the job is still running", async () => {
    const bucket = new FakeBucket();
    await bucket.put(`state/${ORG_PUBLIC}/${PROJECT_PUBLIC}/runs/${ULID}/logs/build/0`, "foo");
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM state.runs")) return [runRow()];
      if (text.includes("SELECT * FROM state.log_chunks")) return [logChunkRow(0)];
      if (text.includes("FROM state.run_jobs")) return [jobRow()]; // running
      return [];
    });
    const req = new Request("https://s/logs?fromSeq=0", { method: "GET" });
    const res = await handleReadLog(req, createEnv(bucket), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), ULID, "build", { executor });
    const body = (await res.json()) as { data: { complete: boolean; nextSeq: number } };
    expect(body.data.complete).toBe(false);
    expect(body.data.nextSeq).toBe(1);
  });
});

// ── Catalog head advance ────────────────────────────────────

describe("PUT …/state/catalog/head — advance", () => {
  it("advances when the digest exists, emits the event, returns {head, previous}", async () => {
    let eventEmitted = false;
    const { executor } = fakeExecutor((text) => {
      if (text.includes("SELECT * FROM state.objects")) return [objectRow({ kind: "catalog-snapshot" })];
      if (text.includes("FROM state.catalog_heads") && text.includes("SELECT")) return []; // no previous head
      if (text.includes("INSERT INTO state.catalog_heads")) {
        return [{ id: "head-1", org_id: ORG, project_id: PROJECT, environment: null, digest: HELLO_DIGEST, commit: "c1", advanced_by: ACTOR.subjectId, advanced_by_kind: "user", advanced_at: NOW.toISOString() }];
      }
      if (text.includes("events.event_log")) {
        eventEmitted = true;
        return [{ id: "e", _event: {}, _audit: {} }];
      }
      return [];
    });
    const req = new Request("https://s/catalog/head", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digest: HELLO_DIGEST, environment: null, commit: "c1" }),
    });
    const res = await handleAdvanceCatalogHead(req, createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { head: { digest: string }; previous: unknown } };
    expect(body.data.head.digest).toBe(HELLO_DIGEST);
    expect(body.data.previous).toBeNull();
    expect(eventEmitted).toBe(true);
  });

  it("412 object_missing when the digest is not in the object plane", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("SELECT * FROM state.objects")) return []; // digest absent
      return [];
    });
    const req = new Request("https://s/catalog/head", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digest: HELLO_DIGEST, environment: null }),
    });
    const res = await handleAdvanceCatalogHead(req, createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(412);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("object_missing");
  });
});

describe("GET …/state/catalog/head — current head", () => {
  it("returns {head:null} when no head exists for the scope", async () => {
    const { executor } = fakeExecutor(() => []);
    const req = new Request("https://s/catalog/head", { method: "GET" });
    const res = await handleGetCatalogHead(req, createEnv(new FakeBucket()), "req_1", ACTOR, asUuid(ORG), asUuid(PROJECT), { executor });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { head: unknown } }).data.head).toBeNull();
  });
});
