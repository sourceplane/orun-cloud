// Harness-error presentation (shared by the conversation fold and the copilot
// lens). A runtime `error` event carries whatever the harness saw — which,
// when a model gateway is misconfigured, is an entire HTML 404 page. Dumping
// raw markup into a transcript is useless and ugly; this keeps the honest
// status line, names the likely cause, and caps everything else.

/** Hard cap for a non-HTML error line — enough for any real API error body. */
const MAX_ERROR_CHARS = 600;

/**
 * sanitizeHarnessError — render a harness/runtime error payload as one
 * human-readable line: HTML responses collapse to their leading status text
 * plus an actionable pointer (a page instead of an API answer means the model
 * connection's Base URL is wrong); everything else is trimmed + capped.
 */
export function sanitizeHarnessError(raw: string): string {
  const text = raw.trim();
  if (!text) return "The run reported an error with no detail.";
  const htmlAt = text.search(/<!DOCTYPE|<html[\s>]/i);
  if (htmlAt >= 0) {
    const head = text.slice(0, htmlAt).replace(/[\s:—–-]+$/, "").trim();
    const status = head || "The model endpoint returned an HTML page";
    return `${status} — the endpoint answered with an HTML page instead of an API response (markup omitted). This usually means the model connection's Base URL points at a website, not an Anthropic-compatible API — check it under Settings › AI providers.`;
  }
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}
