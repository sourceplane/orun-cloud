// Minimal Workers global shims for the jest typecheck: the app's own
// typecheck runs with @cloudflare/workers-types; this suite compiles the
// pure modules under plain Node, where only these structural stand-ins are
// needed (combining workers-types with Node's globals breaks lib crypto).
declare type Fetcher = {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
};
declare type DurableObjectStub = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};
declare type DurableObjectNamespace = {
  idFromName(name: string): { name?: string };
  get(id: { name?: string }): DurableObjectStub;
};
