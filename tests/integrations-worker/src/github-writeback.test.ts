// IG9 outbound write-back — GitHub API helpers. Verifies the Check Run and
// commit-status POSTs build the right URL/body/headers, parse the created
// resource, and fail closed (null) on a non-2xx or a network error — so a
// write-back failure can never break a run. fetchImpl is injected (no network).

import { createCheckRun, createCommitStatus } from "@integrations-worker/github-app";

interface Captured {
  url: string;
  init: RequestInit;
}

function capturingFetch(response: Response): { fetchImpl: (u: string, i?: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    fetchImpl: (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response.clone());
    },
    calls,
  };
}

describe("createCheckRun (IG9)", () => {
  it("POSTs a completed check run with output + details_url and parses the result", async () => {
    const { fetchImpl, calls } = capturingFetch(
      Response.json({ id: 555, html_url: "https://github.com/acme/storefront/runs/555" }, { status: 201 }),
    );
    const res = await createCheckRun(
      "ghs_tok",
      "acme/storefront",
      {
        name: "orun / affected components",
        headSha: "abc123",
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://app.orun.dev/runs/r1",
        title: "2 components affected",
        summary: "api, web",
      },
      fetchImpl,
    );
    expect(res).toEqual({ id: 555, url: "https://github.com/acme/storefront/runs/555" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/storefront/check-runs");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("token ghs_tok");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.head_sha).toBe("abc123");
    expect(body.conclusion).toBe("success");
    expect(body.details_url).toBe("https://app.orun.dev/runs/r1");
    expect(body.output).toEqual({ title: "2 components affected", summary: "api, web" });
  });

  it("omits conclusion/details_url when not provided (in_progress)", async () => {
    const { fetchImpl, calls } = capturingFetch(Response.json({ id: 1 }, { status: 201 }));
    await createCheckRun("t", "a/b", { name: "n", headSha: "s", status: "in_progress", title: "t", summary: "s" }, fetchImpl);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.status).toBe("in_progress");
    expect("conclusion" in body).toBe(false);
    expect("details_url" in body).toBe(false);
  });

  it("returns null on a non-201 response", async () => {
    const { fetchImpl } = capturingFetch(new Response("forbidden", { status: 403 }));
    const res = await createCheckRun("t", "a/b", { name: "n", headSha: "s", status: "completed", conclusion: "success", title: "t", summary: "s" }, fetchImpl);
    expect(res).toBeNull();
  });

  it("returns null on a network error (fail closed)", async () => {
    const res = await createCheckRun(
      "t",
      "a/b",
      { name: "n", headSha: "s", status: "completed", conclusion: "success", title: "t", summary: "s" },
      () => Promise.reject(new Error("network")),
    );
    expect(res).toBeNull();
  });
});

describe("createCommitStatus (IG9)", () => {
  it("POSTs to /statuses/{sha} with state + context and parses the id", async () => {
    const { fetchImpl, calls } = capturingFetch(Response.json({ id: 99, url: "https://api.github.com/.../99" }, { status: 201 }));
    const res = await createCommitStatus(
      "ghs_tok",
      "acme/storefront",
      { sha: "deadbeef", state: "success", context: "orun", description: "ok", targetUrl: "https://app.orun.dev/runs/r1" },
      fetchImpl,
    );
    expect(res!.id).toBe(99);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/storefront/statuses/deadbeef");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ state: "success", context: "orun", description: "ok", target_url: "https://app.orun.dev/runs/r1" });
  });

  it("returns null on failure", async () => {
    const { fetchImpl } = capturingFetch(new Response("", { status: 422 }));
    const res = await createCommitStatus("t", "a/b", { sha: "s", state: "error", context: "orun" }, fetchImpl);
    expect(res).toBeNull();
  });
});
