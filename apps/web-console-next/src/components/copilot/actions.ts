// The six client-tool handlers (saas-copilot-surface CX2/CX3, design §3.3):
// pure functions over an injected console surface — navigate, open, prefill,
// copy, highlight. Prefill never submit, open never approve: every handler
// either mutates pure UI state or performs a read the viewer could already
// make. Each execution is visible (the thread renders an action chip).

export interface ConsoleSurface {
  /** Org-scoped navigation, e.g. push("/orgs/acme/work"). */
  push(route: string): void;
  orgSlug: string;
  copy(text: string): Promise<void>;
  /** Highlight a Situation rail section (best-effort UI affordance). */
  highlight?(section: string): void;
}

export type ActionHandler = (input: Record<string, unknown>) => Promise<string>;

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === "string" ? v : "";
}

/** Only org-scoped console routes are navigable — never an absolute URL. */
export function safeRoute(orgSlug: string, route: string): string | null {
  if (!route.startsWith("/")) return null;
  if (route.startsWith("//") || route.includes("://")) return null;
  const prefix = `/orgs/${orgSlug}`;
  return route.startsWith(prefix) ? route : `${prefix}${route}`;
}

export function buildActionHandlers(surface: ConsoleSurface): Record<string, ActionHandler> {
  return {
    ui_navigate: async (input) => {
      const route = safeRoute(surface.orgSlug, str(input, "route"));
      if (!route) return "refused: not an org-scoped console route";
      surface.push(route);
      return `navigated to ${route}`;
    },
    ui_open_work_item: async (input) => {
      const key = str(input, "key");
      if (!key) return "refused: key required";
      surface.push(`/orgs/${surface.orgSlug}/work?item=${encodeURIComponent(key)}`);
      return `opened ${key}`;
    },
    ui_open_session: async (input) => {
      const id = str(input, "id");
      if (!id) return "refused: id required";
      surface.push(`/orgs/${surface.orgSlug}/agents/${encodeURIComponent(id)}`);
      return `opened session ${id}`;
    },
    ui_prefill_spawn: async (input) => {
      // Prefill NEVER submit: the spawn form opens with query-prefill; the
      // submit stays a human click.
      const qs = new URLSearchParams();
      const taskKey = str(input, "taskKey");
      const profileId = str(input, "profileId");
      if (taskKey) qs.set("task", taskKey);
      if (profileId) qs.set("profile", profileId);
      surface.push(`/orgs/${surface.orgSlug}/agents?spawn=1${qs.size ? `&${qs.toString()}` : ""}`);
      return `prefilled the spawn form${taskKey ? ` for ${taskKey}` : ""}`;
    },
    ui_copy: async (input) => {
      const text = str(input, "text");
      if (!text) return "refused: text required";
      await surface.copy(text);
      return "copied";
    },
    ui_highlight_situation: async (input) => {
      const section = str(input, "section");
      if (!["ready", "inFlight", "waitingOnMe", "budget"].includes(section)) {
        return "refused: unknown section";
      }
      surface.highlight?.(section);
      return `highlighted ${section}`;
    },
  };
}
