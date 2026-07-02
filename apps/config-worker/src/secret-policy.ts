/**
 * Layer-2 SecretPolicy evaluator (saas-secret-manager SM3, orun-secrets
 * policy-model.md §5-6). A PURE library — no I/O, no worker deps — so it is
 * unit-testable in isolation and safe to evaluate inside a Worker.
 *
 * It is the security core: Layer 1 (policy-engine role×scope RBAC) decides the
 * CLASS of operation; this decides the INSTANCE — the four-axis conditions
 * (who / what / where / how) over the tier-ordered rules the plan pushed.
 *
 * Evaluation (policy-model §5), given rules already ordered composition → stack
 * → intent and facts for the concrete caller:
 *   applicable  = rules whose scope{env,key} matches AND whose when[] all hold
 *   deny-wins   → any applicable deny ⇒ DENY (reason = rule id)
 *   else allow  → the most-specific applicable allow ⇒ ALLOW (reason = rule id)
 *   else if env is protected (some rule targets it) ⇒ DENY (no-matching-grant)
 *   else        → ALLOW (rbac-only): unprotected env, Layer 1 sufficed
 *
 * The locked predicate vocabulary (SD-7): equals, `in`, glob `matches`, bool,
 * `subject in team`, and `platform` — AND-of-predicates within a rule, OR via
 * multiple rules. No secret value ever enters here.
 */

// ── Facts (the four axes) ────────────────────────────────────

export type Platform = "local-cli" | "ci-oidc" | "service";
export type ServesFrom = "environment" | "project" | "workspace" | "account";

export interface SecretPolicySubject {
  id: string;
  kind: "user" | "service_principal" | "workflow";
  teams: string[];
}

export interface SecretPolicyComponent {
  type?: string;
  domain?: string;
  name?: string;
  labels?: Record<string, string>;
}

export interface SecretPolicyTrigger {
  event?: string;
  action?: string;
  branch?: string;
  baseBranch?: string;
  tag?: string;
  declared?: boolean;
  actor?: string;
  repository?: string;
}

export interface SecretPolicyFacts {
  subject: SecretPolicySubject;
  component?: SecretPolicyComponent;
  env: string;
  servesFrom?: ServesFrom;
  trigger?: SecretPolicyTrigger;
  platform: Platform;
}

// ── Rule document (validated SecretPolicy spec, data-model §4) ─

export type RuleEffect = "allow" | "deny";

export interface SecretPolicyRule {
  id: string;
  effect: RuleEffect;
  /** Absent/empty ⇒ any subject (still gated by scope + when). */
  subjects?: string[];
  scope: { env: string; key: string };
  /** AND-of-predicates from the locked vocabulary; absent ⇒ unconstrained. */
  when?: SecretPolicyPredicate[];
}

/**
 * A predicate in the locked vocabulary. Documents author these; the loader
 * (orun `policy lint`) validates shapes at push time. We evaluate defensively:
 * a malformed predicate never matches (fail-closed).
 */
export type SecretPolicyPredicate =
  | { kind: "equals"; fact: string; value: string | number | boolean }
  | { kind: "in"; fact: string; values: Array<string | number | boolean> }
  | { kind: "matches"; fact: string; glob: string }
  | { kind: "bool"; fact: string; value?: boolean }
  | { kind: "team"; team: string }
  | { kind: "platform"; value: Platform | Platform[] };

/** One document's parsed rules, tagged with the tier it rode in on. */
export interface SecretPolicyDocument {
  tier: "composition" | "stack" | "intent";
  rules: SecretPolicyRule[];
}

export interface SecretPolicyDecision {
  allow: boolean;
  /** The matched rule id (allow or deny), when a rule decided it. */
  ruleId?: string;
  /** Stable reason code. Never reveals existence beyond the code itself. */
  reason: string;
}

// ── Glob matching (scope env/key + `matches` predicate) ──────

/** Compile a `*`-glob (the only wildcard the vocabulary allows) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  // Escape regex metacharacters, then turn the escaped `\*` back into `.*`.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function globMatch(glob: string, value: string): boolean {
  if (glob === "*") return true;
  if (!glob.includes("*")) return glob === value;
  return globToRegExp(glob).test(value);
}

// ── Scope specificity (most-specific-wins) ───────────────────

/**
 * A rule's specificity: an exact segment beats a glob, and a longer literal
 * prefix beats a shorter one. Key specificity dominates env specificity (the
 * key is what is being served). Higher wins.
 */
function scopeSpecificity(scope: { env: string; key: string }): number {
  return segmentSpecificity(scope.key) * 100 + segmentSpecificity(scope.env);
}

function segmentSpecificity(segment: string): number {
  if (segment === "*") return 0;
  if (!segment.includes("*")) return 40; // exact literal
  // Partial glob (e.g. STRIPE_*): more literal characters ⇒ more specific.
  return 1 + Math.min(segment.replace(/\*/g, "").length, 30);
}

// ── Fact lookup for authored predicates ──────────────────────

/**
 * Resolve a dotted fact path (e.g. `component.type`, `trigger.branch`,
 * `subject.kind`, `env`, `servesFrom`) to its value, or undefined. Only the
 * documented axes are addressable; anything else is undefined (fails closed).
 */
function factValue(facts: SecretPolicyFacts, path: string): string | number | boolean | undefined {
  switch (path) {
    case "env":
      return facts.env;
    case "servesFrom":
      return facts.servesFrom;
    case "platform":
      return facts.platform;
    case "subject.id":
      return facts.subject.id;
    case "subject.kind":
      return facts.subject.kind;
    case "component.type":
      return facts.component?.type;
    case "component.domain":
      return facts.component?.domain;
    case "component.name":
      return facts.component?.name;
    case "trigger.event":
      return facts.trigger?.event;
    case "trigger.action":
      return facts.trigger?.action;
    case "trigger.branch":
      return facts.trigger?.branch;
    case "trigger.baseBranch":
      return facts.trigger?.baseBranch;
    case "trigger.tag":
      return facts.trigger?.tag;
    case "trigger.declared":
      return facts.trigger?.declared;
    case "trigger.actor":
      return facts.trigger?.actor;
    case "trigger.repository":
      return facts.trigger?.repository;
    default: {
      if (path.startsWith("component.labels.")) {
        return facts.component?.labels?.[path.slice("component.labels.".length)];
      }
      return undefined;
    }
  }
}

// ── Predicate evaluation ─────────────────────────────────────

function predicateHolds(pred: SecretPolicyPredicate, facts: SecretPolicyFacts): boolean {
  switch (pred.kind) {
    case "equals":
      return factValue(facts, pred.fact) === pred.value;
    case "in":
      return pred.values.includes(factValue(facts, pred.fact) as string | number | boolean);
    case "matches": {
      const v = factValue(facts, pred.fact);
      return typeof v === "string" && globMatch(pred.glob, v);
    }
    case "bool": {
      const v = factValue(facts, pred.fact);
      return v === (pred.value ?? true);
    }
    case "team":
      return facts.subject.teams.includes(pred.team);
    case "platform": {
      const allowed = Array.isArray(pred.value) ? pred.value : [pred.value];
      return allowed.includes(facts.platform);
    }
    default:
      return false; // unknown predicate shape ⇒ fail closed
  }
}

// ── Subject matching ─────────────────────────────────────────

/**
 * A rule's `subjects[]` are OR-ed (any match qualifies). Absent/empty means
 * "any subject" (still gated by scope + when). Forms (policy-model §2):
 *   user:<id> | team:<slug> | service_principal:<id> |
 *   workflow | user | service_principal (actor-kind literals) | *authenticated
 */
function subjectMatches(subjects: string[] | undefined, subject: SecretPolicySubject): boolean {
  if (!subjects || subjects.length === 0) return true;
  for (const s of subjects) {
    if (s === "*authenticated") return true;
    if (s === subject.kind) return true; // actor-kind literal (workflow/user/service_principal)
    if (s.startsWith("user:") && s.slice(5) === subject.id) return true;
    if (s.startsWith("service_principal:") && s.slice(18) === subject.id) return true;
    if (s.startsWith("team:") && subject.teams.includes(s.slice(5))) return true;
  }
  return false;
}

// ── Applicability ────────────────────────────────────────────

function ruleApplies(rule: SecretPolicyRule, key: string, facts: SecretPolicyFacts): boolean {
  if (!globMatch(rule.scope.env, facts.env)) return false;
  if (!globMatch(rule.scope.key, key)) return false;
  if (!subjectMatches(rule.subjects, facts.subject)) return false;
  const when = rule.when ?? [];
  for (const pred of when) {
    if (!predicateHolds(pred, facts)) return false;
  }
  return true;
}

// ── Evaluate ─────────────────────────────────────────────────

/**
 * Decide Layer 2 for a single `(key, facts)` against the in-scope documents.
 * `documents` MUST already be tier-ordered composition → stack → intent; each
 * rule inside them keeps its authored order. Returns a stable decision.
 *
 * An env is **protected** iff any rule (in any tier) targets it via `scope.env`.
 * On a protected env with no matching allow, the default is deny; on an
 * unprotected env, Layer 1 alone sufficed (allow rbac-only).
 */
export function evaluateSecretPolicy(
  documents: SecretPolicyDocument[],
  key: string,
  facts: SecretPolicyFacts,
): SecretPolicyDecision {
  let protectedEnv = false;
  let bestAllow: { rule: SecretPolicyRule; specificity: number } | null = null;

  for (const doc of documents) {
    for (const rule of doc.rules) {
      // Protected-env activation: a rule whose env-scope TARGETS this env marks
      // it protected, regardless of subject/when/effect. A bare `*` env-scope is
      // a cross-cutting grant, not a per-env protection marker — otherwise one
      // broad rule would make every env deny-by-default and break out-of-the-box
      // onboarding (policy-model §5, worked example §9: dev stays rbac-only).
      if (rule.scope.env !== "*" && globMatch(rule.scope.env, facts.env)) {
        protectedEnv = true;
      }
      if (!ruleApplies(rule, key, facts)) continue;
      if (rule.effect === "deny") {
        // Explicit deny wins over any allow, at any specificity (policy-model §5).
        return { allow: false, ruleId: rule.id, reason: rule.id };
      }
      const specificity = scopeSpecificity(rule.scope);
      if (bestAllow === null || specificity > bestAllow.specificity) {
        bestAllow = { rule, specificity };
      }
    }
  }

  if (bestAllow) {
    return { allow: true, ruleId: bestAllow.rule.id, reason: bestAllow.rule.id };
  }
  if (protectedEnv) {
    return { allow: false, reason: "no-matching-grant" };
  }
  return { allow: true, reason: "rbac-only" };
}

// ── Document parsing (from the stored JSONB) ─────────────────

/**
 * Parse a stored SecretPolicy document body (`{ rules: [...] }`) plus its tier
 * into the evaluator shape, normalizing the authored `when[]` sugar into the
 * locked predicate vocabulary. Unknown/malformed rules are dropped defensively
 * (the authoritative validation is orun's compile-time `policy lint`).
 */
export function parseSecretPolicyDocument(
  tier: SecretPolicyDocument["tier"],
  body: Record<string, unknown>,
): SecretPolicyDocument {
  const rawRules = Array.isArray((body as { rules?: unknown }).rules)
    ? ((body as { rules: unknown[] }).rules)
    : [];
  const rules: SecretPolicyRule[] = [];
  for (const raw of rawRules) {
    const rule = parseRule(raw);
    if (rule) rules.push(rule);
  }
  return { tier, rules };
}

/**
 * A predicate that can never hold: `factValue` has no `__unparseable__` axis,
 * so `equals` is always false. Substituted for a rule's whole `when[]` when any
 * entry is outside the locked vocabulary — the rule then never matches (an
 * unmatchable allow grants nothing; an unmatchable deny still leaves its scope
 * PROTECTED, so deny-by-default holds). Dropping just the bad predicate would
 * do the opposite: it would WIDEN the rule beyond what its author constrained.
 * PUT-time validation (validateSecretPolicyDocument) rejects such documents,
 * so this is a defense for legacy/out-of-band rows only.
 */
const UNMATCHABLE_WHEN: SecretPolicyPredicate[] = [
  { kind: "equals", fact: "__unparseable__", value: "__never__" },
];

function parseRule(raw: unknown): SecretPolicyRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  if (r.effect !== "allow" && r.effect !== "deny") return null;
  const scope = r.scope as Record<string, unknown> | undefined;
  const env = scope && typeof scope.env === "string" ? scope.env : undefined;
  const keyScope = scope && typeof scope.key === "string" ? scope.key : undefined;
  if (env === undefined || keyScope === undefined) return null;
  const subjects = Array.isArray(r.subjects)
    ? r.subjects.filter((s): s is string => typeof s === "string")
    : undefined;
  const when = parseWhen(r.when);
  const rule: SecretPolicyRule = {
    id: r.id,
    effect: r.effect,
    scope: { env, key: keyScope },
  };
  if (subjects) rule.subjects = subjects;
  if (when === null) rule.when = UNMATCHABLE_WHEN;
  else if (when.length > 0) rule.when = when;
  return rule;
}

/**
 * Normalize the authored `when[]` into predicates. Two authoring forms are
 * accepted (data-model §4 shows the string form; a structured form is the wire
 * shape orun's loader emits): a structured predicate object, or a small locked
 * DSL string like `platform == "local-cli"`, `trigger.branch == "main"`,
 * `component.type in ["a","b"]`, `trigger.declared`, `subject in team:x`.
 *
 * Returns `null` when ANY entry is outside the locked vocabulary — the caller
 * must treat the rule as unmatchable (never silently drop a constraint, which
 * would widen the rule).
 */
export function parseWhen(raw: unknown): SecretPolicyPredicate[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: SecretPolicyPredicate[] = [];
  for (const entry of raw) {
    let p: SecretPolicyPredicate | null = null;
    if (entry && typeof entry === "object") {
      p = parseStructuredPredicate(entry as Record<string, unknown>);
    } else if (typeof entry === "string") {
      p = parseStringPredicate(entry);
    }
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

function parseStructuredPredicate(o: Record<string, unknown>): SecretPolicyPredicate | null {
  const kind = o.kind;
  switch (kind) {
    case "equals":
      return typeof o.fact === "string" && (typeof o.value === "string" || typeof o.value === "number" || typeof o.value === "boolean")
        ? { kind: "equals", fact: o.fact, value: o.value }
        : null;
    case "in":
      return typeof o.fact === "string" && Array.isArray(o.values)
        ? { kind: "in", fact: o.fact, values: o.values as Array<string | number | boolean> }
        : null;
    case "matches":
      return typeof o.fact === "string" && typeof o.glob === "string"
        ? { kind: "matches", fact: o.fact, glob: o.glob }
        : null;
    case "bool":
      return typeof o.fact === "string"
        ? { kind: "bool", fact: o.fact, ...(typeof o.value === "boolean" ? { value: o.value } : {}) }
        : null;
    case "team":
      return typeof o.team === "string" ? { kind: "team", team: o.team } : null;
    case "platform":
      return typeof o.value === "string" || Array.isArray(o.value)
        ? { kind: "platform", value: o.value as Platform | Platform[] }
        : null;
    default:
      return null;
  }
}

const STRING_LITERAL_RE = /^"(.*)"$|^'(.*)'$/;

/** Parse one locked-DSL `when` string into a predicate (fail-closed on any
 *  shape outside the vocabulary). */
export function parseStringPredicate(expr: string): SecretPolicyPredicate | null {
  const s = expr.trim();

  // subject in team:<slug>  |  subject in team "<slug>"
  const teamMatch = /^subject\s+in\s+team[:\s]\s*(.+)$/.exec(s);
  if (teamMatch) {
    return { kind: "team", team: unquote(teamMatch[1]!.trim()) };
  }

  // <fact> in [<v>, <v>, ...]
  const inMatch = /^([\w.]+)\s+in\s+\[(.*)\]$/.exec(s);
  if (inMatch) {
    const fact = inMatch[1]!;
    const values = inMatch[2]!
      .split(",")
      .map((v) => coerceLiteral(v.trim()))
      .filter((v) => v !== undefined) as Array<string | number | boolean>;
    if (fact === "platform") {
      return { kind: "platform", value: values as Platform[] };
    }
    return { kind: "in", fact, values };
  }

  // <fact> == <literal>
  const eqMatch = /^([\w.]+)\s*==\s*(.+)$/.exec(s);
  if (eqMatch) {
    const fact = eqMatch[1]!;
    const value = coerceLiteral(eqMatch[2]!.trim());
    if (value === undefined) return null;
    if (fact === "platform" && typeof value === "string") {
      return { kind: "platform", value: value as Platform };
    }
    return { kind: "equals", fact, value };
  }

  // bare boolean fact, e.g. `trigger.declared`
  if (/^[\w.]+$/.test(s)) {
    return { kind: "bool", fact: s };
  }
  return null;
}

function unquote(s: string): string {
  const m = STRING_LITERAL_RE.exec(s);
  return m ? (m[1] ?? m[2] ?? "") : s;
}

function coerceLiteral(s: string): string | number | boolean | undefined {
  const m = STRING_LITERAL_RE.exec(s);
  if (m) return m[1] ?? m[2] ?? "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return undefined;
}

// ── PUT-time document validation (SM3 pinned rule) ───────────
// "Unknown predicate = validation error at PUT time, never at resolve": the
// push route rejects any document whose rules fall outside the locked
// vocabulary, so the fail-closed parsing above (dropped rules, unmatchable
// when[]) only ever fires for legacy/out-of-band rows.

/** The addressable fact axes (factValue) an authored predicate may name. */
const KNOWN_FACT_PATHS = new Set([
  "env",
  "servesFrom",
  "platform",
  "subject.id",
  "subject.kind",
  "component.type",
  "component.domain",
  "component.name",
  "trigger.event",
  "trigger.action",
  "trigger.branch",
  "trigger.baseBranch",
  "trigger.tag",
  "trigger.declared",
  "trigger.actor",
  "trigger.repository",
]);

function isKnownFactPath(path: string): boolean {
  return KNOWN_FACT_PATHS.has(path) || path.startsWith("component.labels.");
}

const SUBJECT_KIND_LITERALS = new Set(["workflow", "user", "service_principal"]);
const SUBJECT_REF_RE = /^(user|team|service_principal):.+$/;

function validateSubjectSpelling(subject: unknown, path: string, errors: string[]): void {
  if (typeof subject !== "string" || subject.length === 0) {
    errors.push(`${path}: must be a non-empty string`);
    return;
  }
  if (subject === "*authenticated" || SUBJECT_KIND_LITERALS.has(subject) || SUBJECT_REF_RE.test(subject)) {
    return;
  }
  errors.push(
    `${path}: unknown subject "${subject}" (expected user:<id>, team:<slug>, service_principal:<id>, a kind literal, or *authenticated)`,
  );
}

function validateWhenEntry(entry: unknown, path: string, errors: string[]): void {
  let parsed: SecretPolicyPredicate | null = null;
  if (entry && typeof entry === "object") {
    parsed = parseStructuredPredicate(entry as Record<string, unknown>);
  } else if (typeof entry === "string") {
    parsed = parseStringPredicate(entry);
  }
  if (parsed === null) {
    errors.push(`${path}: unknown predicate ${JSON.stringify(entry)} — outside the locked vocabulary`);
    return;
  }
  // A predicate naming an unaddressable fact would never hold at resolve time
  // (fail-closed); reject it here so the typo is caught at push, not in prod.
  if ("fact" in parsed && !isKnownFactPath(parsed.fact)) {
    errors.push(`${path}: unknown fact "${parsed.fact}"`);
  }
}

const RULE_FIELDS = new Set(["id", "effect", "subjects", "scope", "when"]);
const SCOPE_FIELDS = new Set(["env", "key"]);

/**
 * Validate a pushed SecretPolicy document body against the locked shape +
 * vocabulary. Returns the full error list (empty = valid) so the PUT route can
 * surface every violation at once. A document that passes here parses without
 * any defensive drop in parseSecretPolicyDocument.
 */
export function validateSecretPolicyDocument(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["document must be a JSON object"];
  }
  const rules = (raw as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) {
    return ["document.rules must be an array"];
  }
  const seen = new Set<string>();
  rules.forEach((rule, i) => {
    const path = `rules[${i}]`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    const r = rule as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0 || r.id.length > 128) {
      errors.push(`${path}.id: required; a non-empty string (max 128 chars)`);
    } else if (seen.has(r.id)) {
      errors.push(`${path}.id: duplicate rule id "${r.id}"`);
    } else {
      seen.add(r.id);
    }
    if (r.effect !== "allow" && r.effect !== "deny") {
      errors.push(`${path}.effect: must be "allow" or "deny"`);
    }
    const scope = r.scope as Record<string, unknown> | undefined;
    if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
      errors.push(`${path}.scope: required; an object { env, key } (use "*" globs for breadth)`);
    } else {
      if (typeof scope.env !== "string" || scope.env.length === 0) {
        errors.push(`${path}.scope.env: required; a non-empty string or glob`);
      }
      if (typeof scope.key !== "string" || scope.key.length === 0) {
        errors.push(`${path}.scope.key: required; a non-empty string or glob`);
      }
      for (const field of Object.keys(scope)) {
        if (!SCOPE_FIELDS.has(field)) errors.push(`${path}.scope.${field}: unknown scope field`);
      }
    }
    if (r.subjects !== undefined) {
      if (!Array.isArray(r.subjects)) {
        errors.push(`${path}.subjects: must be an array of subject strings`);
      } else {
        r.subjects.forEach((s, j) => validateSubjectSpelling(s, `${path}.subjects[${j}]`, errors));
      }
    }
    if (r.when !== undefined) {
      if (!Array.isArray(r.when)) {
        errors.push(`${path}.when: must be an array of predicates`);
      } else {
        r.when.forEach((entry, j) => validateWhenEntry(entry, `${path}.when[${j}]`, errors));
      }
    }
    for (const field of Object.keys(r)) {
      if (!RULE_FIELDS.has(field)) errors.push(`${path}.${field}: unknown rule field`);
    }
  });
  return errors;
}
