/**
 * Pure (no-React) model for the guided create-organization flow, kept separate
 * so step/labels/routing logic is unit-testable without a DOM — the same split
 * the billing UI uses (`plan-actions.ts`).
 *
 * The flow is one unified wizard for both surfaces; only the steps differ.
 * "parent" mode is the account's first organization: it owns billing, so it
 * gets the full experience — details, a plan step, AND the starting-point step.
 * "child" mode is any additional organization: billing rolls up to the
 * account's billing parent (MO2), so it drops the plan step but keeps the same
 * details/starting-point/review path. Sharing the step set is what makes the
 * first-run onboarding and the in-app "add organization" feel like one product.
 */

export type CreateOrgMode = "parent" | "child";

export type StepId = "details" | "plan" | "source" | "review";

export interface StepDef {
  id: StepId;
  label: string;
  description: string;
}

const STEP_DETAILS: StepDef = { id: "details", label: "Organization", description: "Name and URL" };
const STEP_PLAN: StepDef = { id: "plan", label: "Plan", description: "Pick your pricing tier" };
const STEP_SOURCE: StepDef = { id: "source", label: "Starting point", description: "Import or start fresh" };
const STEP_REVIEW: StepDef = { id: "review", label: "Review", description: "Confirm and create" };

/**
 * The wizard's steps for a given mode. The parent (first) org adds a plan step
 * before the shared starting-point step; a child org omits the plan step
 * because its billing rolls up to the parent.
 */
export function flowSteps(mode: CreateOrgMode): StepDef[] {
  return mode === "parent"
    ? [STEP_DETAILS, STEP_PLAN, STEP_SOURCE, STEP_REVIEW]
    : [STEP_DETAILS, STEP_SOURCE, STEP_REVIEW];
}

// ---------------------------------------------------------------------------
// Plans (parent mode)
// ---------------------------------------------------------------------------

export interface PlanOption {
  /** Stable billing plan code — checkout runs against the real plan after create. */
  code: string;
  name: string;
  tagline: string;
  /** Display price, e.g. "$20". */
  price: string;
  /** Display billing period suffix, e.g. "/mo". */
  per?: string;
  popular?: boolean;
  /** Contact-sales tier with no self-serve checkout. */
  contact?: boolean;
}

/**
 * Display catalog for the plan step. It runs before the organization (and
 * therefore its org-scoped `/billing/plans` surface) exists, so the cards
 * render from this catalog; the selected `code` is what drives the real
 * checkout once the organization has been created.
 */
export const PLAN_OPTIONS: PlanOption[] = [
  {
    code: "free",
    name: "Free",
    tagline: "For personal projects and evaluation",
    price: "$0",
    per: "/mo",
  },
  {
    code: "pro",
    name: "Pro",
    tagline: "For small teams shipping to production",
    price: "$20",
    per: "/mo",
  },
  {
    code: "business",
    name: "Business",
    tagline: "For companies running multiple teams",
    price: "$100",
    per: "/mo",
    popular: true,
  },
  {
    code: "enterprise",
    name: "Enterprise",
    tagline: "Security, control, and support at scale",
    price: "Custom",
    contact: true,
  },
];

// ---------------------------------------------------------------------------
// Starting point (child mode)
// ---------------------------------------------------------------------------

export type GitProviderId = "github" | "gitlab" | "bitbucket";

/** What the new (child) organization starts from. */
export type SourceChoice =
  | { kind: "scratch" }
  | { kind: "git"; provider: GitProviderId }
  | { kind: "template"; templateId: string };

export interface GitProviderDef {
  id: GitProviderId;
  name: string;
  /** Only GitHub is wired up today (org-scoped GitHub App install). */
  available: boolean;
  note: string;
}

export const GIT_PROVIDERS: GitProviderDef[] = [
  {
    id: "github",
    name: "Continue with GitHub",
    available: true,
    note: "Install the GitHub App right after the organization is created.",
  },
  {
    id: "gitlab",
    name: "Continue with GitLab",
    available: false,
    note: "Import projects from GitLab groups and repositories.",
  },
  {
    id: "bitbucket",
    name: "Continue with Bitbucket",
    available: false,
    note: "Import projects from Bitbucket workspaces.",
  },
];

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: "web-app",
    name: "Web App Starter",
    description: "Next.js front end wired to org-scoped auth and projects.",
  },
  {
    id: "api-service",
    name: "API Service",
    description: "Typed REST service with environments and config baked in.",
  },
  {
    id: "worker",
    name: "Background Worker",
    description: "Queue-driven worker with metering and webhooks.",
  },
  {
    id: "ai-chatbot",
    name: "AI Chatbot",
    description: "Streaming chat app with usage-based billing hooks.",
  },
];

export function providerShortName(id: GitProviderId): string {
  return id === "github" ? "GitHub" : id === "gitlab" ? "GitLab" : "Bitbucket";
}

/** Short human label for the review step. */
export function sourceSummary(choice: SourceChoice): string {
  if (choice.kind === "git") return `Import from ${providerShortName(choice.provider)}`;
  if (choice.kind === "template") {
    const t = TEMPLATES.find((x) => x.id === choice.templateId);
    return `Template: ${t?.name ?? choice.templateId}`;
  }
  return "Start from scratch";
}

// ---------------------------------------------------------------------------
// Submit semantics
// ---------------------------------------------------------------------------

/** The primary button label on the review step, naming the hand-off it triggers. */
export function createButtonLabel(
  mode: CreateOrgMode,
  plan: PlanOption,
  source: SourceChoice,
): string {
  // A paid/contact plan hand-off (parent only) takes precedence over the
  // starting-point hand-off: checkout/sales happens first, and the GitHub App
  // can be installed afterward from the new org's Integrations page.
  if (mode === "parent" && plan.contact) return "Create & contact sales";
  if (mode === "parent" && plan.code !== "free") return "Create & continue to checkout";
  if (source.kind === "git" && source.provider === "github") {
    return "Create & connect GitHub";
  }
  return "Create organization";
}

/**
 * Where the console routes after a successful create (when it does not leave
 * for hosted checkout): the new org's Integrations page when the operator chose
 * the GitHub starting point — for either mode, since the parent flow now shares
 * the starting-point step — else the new org's projects dashboard.
 */
export function postCreatePath(_mode: CreateOrgMode, source: SourceChoice, orgSlug: string): string {
  if (source.kind === "git" && source.provider === "github") {
    return `/orgs/${orgSlug}/settings/integrations`;
  }
  return `/orgs/${orgSlug}/projects`;
}
