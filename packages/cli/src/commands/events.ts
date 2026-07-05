// Event-stream commands (saas-event-streaming ES5b):
//
//   - events emit  → POST a custom.* event via `client.events.emitEvent`.
//   - events list  → single-page explorer read (table + cursor, mirroring
//                    `audit list`); `--all` streams every page via
//                    `client.events.iterEvents`.
//   - events tail  → a bounded poll loop over `client.events.listEvents`,
//                    printing events newer than the last-seen id each tick.
//
// Output honours the CLI's `--output=human|json` convention throughout. The
// tail loop body is the pure, unit-testable `tailOnce` seam; the command wraps
// it in a bounded loop (`--max-polls`, default unbounded) with an injectable
// sleep so tests never spin forever.

import type { CommandContext, CommandResult } from "../router.js";
import type { CustomEventInput, EventStreamFilters, OrunCloud, PublicEvent } from "@saas/sdk";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId, readIdempotencyKey } from "./helpers.js";

// Defensive cap on the --all loop, mirroring `audit list` / webhook deliveries.
const MAX_PAGES = 1000;
/** Default tail poll interval (seconds). */
const DEFAULT_TAIL_INTERVAL_SECONDS = 2;
/** Default tail page size when the user does not override `--limit`. */
const DEFAULT_TAIL_LIMIT = 50;

function strFlag(flag: string | boolean | undefined): string | undefined {
  return typeof flag === "string" && flag.length > 0 ? flag : undefined;
}

function parseLimit(flag: string | boolean | undefined): number | undefined {
  if (typeof flag !== "string" || flag.length === 0) return undefined;
  const n = Number.parseInt(flag, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--limit must be a positive integer (got ${flag})`);
  }
  return n;
}

/** Collect the shared explorer filter flags into the SDK `EventStreamFilters`. */
function parseEventFilterFlags(flags: Record<string, string | boolean | undefined>): EventStreamFilters {
  const filters: EventStreamFilters = {};
  const type = strFlag(flags["type"]);
  if (type !== undefined) filters.type = type;
  const source = strFlag(flags["source"]);
  if (source !== undefined) filters.source = source;
  const project = strFlag(flags["project"]);
  if (project !== undefined) filters.project = project;
  const environment = strFlag(flags["environment"]);
  if (environment !== undefined) filters.environment = environment;
  const from = strFlag(flags["from"]);
  if (from !== undefined) filters.from = from;
  const to = strFlag(flags["to"]);
  if (to !== undefined) filters.to = to;
  return filters;
}

function renderEventRows(events: ReadonlyArray<PublicEvent>): {
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<Record<string, string>>;
} {
  return {
    columns: ["occurredAt", "severity", "type", "source", "id"],
    rows: events.map((e) => ({
      occurredAt: e.occurredAt,
      severity: e.severity,
      type: e.type,
      source: e.source,
      id: e.id,
    })),
  };
}

// ---------------------------------------------------------------------------
// events emit
// ---------------------------------------------------------------------------

export async function eventsEmitCommand(ctx: CommandContext): Promise<CommandResult> {
  const type = strFlag(ctx.flags["type"]);
  if (type === undefined) {
    throw new UsageError(
      'usage: orun-cloud events emit --type <custom.type> [--title T] [--severity S] [--payload \'<json>\'] [--dedup-key K] [--project prj_…] [--environment env_…] [--idempotency-key K]',
    );
  }

  let payload: Record<string, unknown> | undefined;
  const payloadRaw = strFlag(ctx.flags["payload"]);
  if (payloadRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadRaw);
    } catch {
      throw new UsageError("--payload must be valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new UsageError("--payload must be a JSON object");
    }
    payload = parsed as Record<string, unknown>;
  }

  const title = strFlag(ctx.flags["title"]);
  const severity = strFlag(ctx.flags["severity"]);
  const dedupKey = strFlag(ctx.flags["dedup-key"]);
  const project = strFlag(ctx.flags["project"]);
  const environment = strFlag(ctx.flags["environment"]);
  const body: CustomEventInput = {
    type,
    ...(title !== undefined ? { title } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(payload !== undefined ? { payload } : {}),
    ...(dedupKey !== undefined ? { dedupKey } : {}),
    ...(project !== undefined ? { projectId: project } : {}),
    ...(environment !== undefined ? { environmentId: environment } : {}),
  };

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const result = await sdk.events.emitEvent(
    orgId,
    body,
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  const e = result.event;
  ctx.stdout(
    formatOutput({
      mode: "human",
      record: { id: e.id, type: e.type, severity: e.severity, title: e.title, occurredAt: e.occurredAt },
      title: `Event emitted in ${orgId}`,
    }),
  );
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// events list
// ---------------------------------------------------------------------------

export async function eventsListCommand(ctx: CommandContext): Promise<CommandResult> {
  const limit = parseLimit(ctx.flags["limit"]);
  const cursor = strFlag(ctx.flags["cursor"]);
  const all = ctx.flags["all"] === true;
  if (all && cursor !== undefined) {
    throw new UsageError("--all and --cursor are mutually exclusive");
  }
  const filters = parseEventFilterFlags(ctx.flags);

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const sdk = await ctx.sdk();

  function buildQuery(forCursor: string | undefined): EventStreamFilters {
    return {
      ...filters,
      ...(limit !== undefined ? { limit } : {}),
      ...(forCursor !== undefined ? { cursor: forCursor } : {}),
    };
  }

  if (!all) {
    const page = await sdk.events.listEventsPage(orgId, buildQuery(cursor));
    if (ctx.outputMode === "json") {
      ctx.stdout(
        formatOutput({ mode: "json", data: { events: page.events, next_cursor: page.cursor } }),
      );
      return { exitCode: 0 };
    }
    const { columns, rows } = renderEventRows(page.events);
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns,
        rows,
        title: `Events for ${orgId}` + (page.cursor !== null ? ` (next cursor: ${page.cursor})` : ""),
      }),
    );
    return { exitCode: 0 };
  }

  // --all: walk every page via the SDK iterator, batching rows into one flat
  // table (human) or a single JSON document (json). The iterator's own
  // seenCursors + MAX_PAGES guards bound the walk; we cap iterations too.
  const collected: PublicEvent[] = [];
  let iterations = 0;
  for await (const event of sdk.events.iterEvents(orgId, buildQuery(undefined))) {
    collected.push(event);
    iterations += 1;
    if (iterations >= MAX_PAGES * (limit ?? 100)) break;
  }

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: { events: collected } }));
    return { exitCode: 0 };
  }
  const { columns, rows } = renderEventRows(collected);
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns,
      rows,
      title: `All events for ${orgId} (${collected.length} rows)`,
    }),
  );
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// events tail
// ---------------------------------------------------------------------------

/**
 * One poll of the tail loop — the pure, unit-testable seam. Fetches the newest
 * page and returns the events strictly newer than `seenId` (in chronological
 * order, oldest→newest) plus the id of the newest event seen (the next
 * `seenId`). The explorer returns events newest-first; we walk until we reach
 * the previously-seen id, so a steady stream never re-prints.
 */
export async function tailOnce(
  sdk: OrunCloud,
  orgId: string,
  query: EventStreamFilters,
  seenId: string | null,
): Promise<{ fresh: PublicEvent[]; newestId: string | null }> {
  const { events } = await sdk.events.listEvents(orgId, query);
  const fresh: PublicEvent[] = [];
  for (const e of events) {
    if (seenId !== null && e.id === seenId) break;
    fresh.push(e);
  }
  fresh.reverse(); // chronological order for printing
  const newestId = events.length > 0 ? events[0]!.id : seenId;
  return { fresh, newestId };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function eventsTailCommand(ctx: CommandContext): Promise<CommandResult> {
  const limit = parseLimit(ctx.flags["limit"]) ?? DEFAULT_TAIL_LIMIT;
  const filters = parseEventFilterFlags(ctx.flags);

  let intervalSeconds = DEFAULT_TAIL_INTERVAL_SECONDS;
  const intervalRaw = ctx.flags["interval"];
  if (typeof intervalRaw === "string" && intervalRaw.length > 0) {
    const parsed = Number(intervalRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new UsageError(`--interval must be a non-negative number of seconds (got ${intervalRaw})`);
    }
    intervalSeconds = parsed;
  }

  // `--max-polls` bounds the loop (default: unbounded). Tests always pass it so
  // the poll never runs forever; the loop body itself is `tailOnce`.
  let maxPolls = Infinity;
  const maxPollsRaw = ctx.flags["max-polls"];
  if (typeof maxPollsRaw === "string" && maxPollsRaw.length > 0) {
    const parsed = Number.parseInt(maxPollsRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new UsageError(`--max-polls must be a positive integer (got ${maxPollsRaw})`);
    }
    maxPolls = parsed;
  }

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const sdk = await ctx.sdk();
  const query: EventStreamFilters = { ...filters, limit };

  const emit = (e: PublicEvent): void => {
    if (ctx.outputMode === "json") {
      ctx.stdout(formatOutput({ mode: "json", data: e }));
    } else {
      ctx.stdout(`${e.occurredAt}  ${e.severity.padEnd(8)}  ${e.type}  ${e.id}`);
    }
  };

  let seenId: string | null = null;
  for (let poll = 0; poll < maxPolls; poll++) {
    const { fresh, newestId } = await tailOnce(sdk, orgId, query, seenId);
    for (const e of fresh) emit(e);
    seenId = newestId;
    if (poll + 1 < maxPolls) await sleep(intervalSeconds * 1000);
  }
  return { exitCode: 0 };
}
