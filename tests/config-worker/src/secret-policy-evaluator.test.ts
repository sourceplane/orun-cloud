// Layer-2 SecretPolicy evaluator (saas-secret-manager SM3) — the security core.
// Heavily unit-tested per orun-secrets policy-model.md §5-6 + §9 worked example.

import {
  evaluateSecretPolicy,
  parseSecretPolicyDocument,
  parseStringPredicate,
  parseWhen,
  type SecretPolicyDocument,
  type SecretPolicyFacts,
} from "@config-worker/secret-policy";

// ── The worked example (policy-model.md §9) ──────────────────
// Tier 1 (composition, terraform): component.type is injected by orun at author
// time; here we make it an explicit predicate so the fixture is self-contained.
const TERRAFORM_COMPOSITION: SecretPolicyDocument = {
  tier: "composition",
  rules: [
    {
      id: "release-bindings-ci-main",
      effect: "allow",
      subjects: ["workflow"],
      scope: { env: "*", key: "AWS_ROLE_ARN" },
      when: [
        { kind: "bool", fact: "trigger.declared" },
        { kind: "equals", fact: "trigger.branch", value: "main" },
        { kind: "platform", value: "ci-oidc" },
      ],
    },
  ],
};

const ACME_STACK: SecretPolicyDocument = {
  tier: "stack",
  rules: [
    {
      id: "admins-prod-from-ci",
      effect: "allow",
      subjects: ["team:platform-admins"],
      scope: { env: "prod", key: "*" },
      when: [{ kind: "platform", value: ["ci-oidc", "service"] }],
    },
    {
      id: "billing-stripe-main-deploys",
      effect: "allow",
      subjects: ["*authenticated"],
      scope: { env: "prod", key: "STRIPE_*" },
      when: [
        { kind: "equals", fact: "component.type", value: "billing-worker" },
        { kind: "bool", fact: "trigger.declared" },
        { kind: "equals", fact: "trigger.branch", value: "main" },
      ],
    },
    {
      id: "laptops-never-prod",
      effect: "deny",
      subjects: ["*authenticated"],
      scope: { env: "prod", key: "*" },
      when: [{ kind: "platform", value: "local-cli" }],
    },
  ],
};

const DOCS = [TERRAFORM_COMPOSITION, ACME_STACK];

function facts(over: Partial<SecretPolicyFacts>): SecretPolicyFacts {
  return {
    subject: { id: "usr_1", kind: "workflow", teams: [], ...(over.subject ?? {}) },
    env: over.env ?? "prod",
    platform: over.platform ?? "ci-oidc",
    ...(over.component ? { component: over.component } : {}),
    ...(over.trigger ? { trigger: over.trigger } : {}),
    ...(over.servesFrom ? { servesFrom: over.servesFrom } : {}),
  };
}

describe("worked example (policy-model §9)", () => {
  it("PR run by a non-admin on feature/x → deny by default (protected prod, no allow)", () => {
    const d = evaluateSecretPolicy(
      DOCS,
      "STRIPE_KEY",
      facts({
        subject: { id: "usr_dev", kind: "workflow", teams: [] },
        env: "prod",
        platform: "ci-oidc",
        component: { type: "billing-worker" },
        trigger: { branch: "feature/x", declared: false },
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("no-matching-grant");
  });

  it("declared push to main from CI → allow (billing-stripe-main-deploys)", () => {
    const d = evaluateSecretPolicy(
      DOCS,
      "STRIPE_KEY",
      facts({
        subject: { id: "usr_dev", kind: "workflow", teams: [] },
        env: "prod",
        platform: "ci-oidc",
        component: { type: "billing-worker" },
        trigger: { branch: "main", declared: true },
      }),
    );
    expect(d.allow).toBe(true);
    expect(d.ruleId).toBe("billing-stripe-main-deploys");
  });

  it("platform admin on a laptop → deny (laptops-never-prod)", () => {
    const d = evaluateSecretPolicy(
      DOCS,
      "DATABASE_URL",
      facts({
        subject: { id: "usr_admin", kind: "user", teams: ["platform-admins"] },
        env: "prod",
        platform: "local-cli",
      }),
    );
    expect(d.allow).toBe(false);
    expect(d.ruleId).toBe("laptops-never-prod");
  });

  it("same admin resolving dev/DB_URL → allow (rbac-only, dev untargeted)", () => {
    const d = evaluateSecretPolicy(
      DOCS,
      "DB_URL",
      facts({
        subject: { id: "usr_admin", kind: "user", teams: ["platform-admins"] },
        env: "dev",
        platform: "local-cli",
      }),
    );
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("rbac-only");
  });
});

describe("deny-wins + most-specific-wins", () => {
  it("an explicit deny beats a matching allow at any specificity", () => {
    const docs: SecretPolicyDocument[] = [
      {
        tier: "stack",
        rules: [
          { id: "allow-all", effect: "allow", subjects: ["*authenticated"], scope: { env: "prod", key: "*" } },
          { id: "deny-stripe", effect: "deny", subjects: ["*authenticated"], scope: { env: "prod", key: "STRIPE_KEY" } },
        ],
      },
    ];
    const d = evaluateSecretPolicy(docs, "STRIPE_KEY", facts({ env: "prod" }));
    expect(d.allow).toBe(false);
    expect(d.ruleId).toBe("deny-stripe");
  });

  it("the most-specific allow wins the grant provenance", () => {
    const docs: SecretPolicyDocument[] = [
      {
        tier: "stack",
        rules: [
          { id: "broad", effect: "allow", subjects: ["*authenticated"], scope: { env: "prod", key: "*" } },
          { id: "specific", effect: "allow", subjects: ["*authenticated"], scope: { env: "prod", key: "STRIPE_KEY" } },
        ],
      },
    ];
    const d = evaluateSecretPolicy(docs, "STRIPE_KEY", facts({ env: "prod" }));
    expect(d.allow).toBe(true);
    expect(d.ruleId).toBe("specific");
  });
});

describe("protected-env activation", () => {
  it("an unprotected env passes on Layer-1 alone (rbac-only)", () => {
    const docs: SecretPolicyDocument[] = [
      { tier: "stack", rules: [{ id: "r", effect: "allow", subjects: ["*authenticated"], scope: { env: "prod", key: "*" } }] },
    ];
    expect(evaluateSecretPolicy(docs, "K", facts({ env: "staging" })).reason).toBe("rbac-only");
  });

  it("a concrete rule marks its env protected → deny-by-default without a grant", () => {
    const docs: SecretPolicyDocument[] = [
      { tier: "stack", rules: [{ id: "r", effect: "deny", subjects: ["*authenticated"], scope: { env: "prod", key: "SECRET" }, when: [{ kind: "platform", value: "local-cli" }] }] },
    ];
    // env prod is targeted by the rule, but the deny's when[] doesn't match a
    // ci-oidc caller and there is no allow ⇒ deny-by-default.
    const d = evaluateSecretPolicy(docs, "OTHER", facts({ env: "prod", platform: "ci-oidc" }));
    expect(d.allow).toBe(false);
    expect(d.reason).toBe("no-matching-grant");
  });

  it("a bare env:* rule does NOT protect other envs", () => {
    const docs: SecretPolicyDocument[] = [
      { tier: "composition", rules: [{ id: "r", effect: "allow", subjects: ["workflow"], scope: { env: "*", key: "AWS" } }] },
    ];
    expect(evaluateSecretPolicy(docs, "DB", facts({ env: "dev" })).reason).toBe("rbac-only");
  });
});

describe("subject matching", () => {
  const rule = (subjects: string[]): SecretPolicyDocument => ({
    tier: "stack",
    rules: [{ id: "r", effect: "allow", subjects, scope: { env: "prod", key: "*" } }],
  });
  it("*authenticated matches any subject", () => {
    expect(evaluateSecretPolicy([rule(["*authenticated"])], "K", facts({ env: "prod" })).allow).toBe(true);
  });
  it("actor-kind literal matches by kind", () => {
    expect(evaluateSecretPolicy([rule(["workflow"])], "K", facts({ subject: { id: "x", kind: "workflow", teams: [] }, env: "prod" })).allow).toBe(true);
    expect(evaluateSecretPolicy([rule(["workflow"])], "K", facts({ subject: { id: "x", kind: "user", teams: [] }, env: "prod" })).allow).toBe(false);
  });
  it("user:<id> and team:<slug> match", () => {
    expect(evaluateSecretPolicy([rule(["user:usr_9"])], "K", facts({ subject: { id: "usr_9", kind: "user", teams: [] }, env: "prod" })).allow).toBe(true);
    expect(evaluateSecretPolicy([rule(["team:sec"])], "K", facts({ subject: { id: "x", kind: "user", teams: ["sec"] }, env: "prod" })).allow).toBe(true);
    expect(evaluateSecretPolicy([rule(["team:sec"])], "K", facts({ subject: { id: "x", kind: "user", teams: ["other"] }, env: "prod" })).allow).toBe(false);
  });
});

describe("predicate parsing (locked DSL string form)", () => {
  it("parses platform ==, in, equals, bool, team", () => {
    expect(parseStringPredicate('platform == "local-cli"')).toEqual({ kind: "platform", value: "local-cli" });
    expect(parseStringPredicate('platform in ["ci-oidc", "service"]')).toEqual({ kind: "platform", value: ["ci-oidc", "service"] });
    expect(parseStringPredicate('trigger.branch == "main"')).toEqual({ kind: "equals", fact: "trigger.branch", value: "main" });
    expect(parseStringPredicate("trigger.declared")).toEqual({ kind: "bool", fact: "trigger.declared" });
    expect(parseStringPredicate("subject in team:platform-admins")).toEqual({ kind: "team", team: "platform-admins" });
  });

  it("evaluates a document parsed from the string DSL like the structured form", () => {
    const doc = parseSecretPolicyDocument("stack", {
      rules: [
        {
          id: "laptops-never-prod",
          effect: "deny",
          subjects: ["*authenticated"],
          scope: { env: "prod", key: "*" },
          when: ['platform == "local-cli"'],
        },
      ],
    });
    const d = evaluateSecretPolicy([doc], "K", facts({ env: "prod", platform: "local-cli" }));
    expect(d.allow).toBe(false);
    expect(d.ruleId).toBe("laptops-never-prod");
  });

  it("drops malformed rules defensively (fail-closed)", () => {
    const doc = parseSecretPolicyDocument("stack", { rules: [{ id: "x" }, { effect: "allow", scope: { env: "p", key: "k" } }] });
    expect(doc.rules).toHaveLength(0);
    expect(parseWhen(undefined)).toEqual([]);
    // A non-array / unparseable when[] is a parse FAILURE (null), not an empty
    // constraint list — dropping constraints would widen the rule.
    expect(parseWhen("not-an-array")).toBeNull();
    expect(parseWhen(["definitely !~ not-a-predicate"])).toBeNull();
  });

  it("an unparseable when[] makes the rule unmatchable but keeps its scope protecting", () => {
    // An ALLOW that lost a constraint must grant NOTHING (not everything): the
    // rule never matches, yet its concrete env scope still protects prod, so
    // the outcome is deny-by-default — never a widened grant.
    const doc = parseSecretPolicyDocument("stack", {
      rules: [
        {
          id: "ci-only",
          effect: "allow",
          subjects: ["*authenticated"],
          scope: { env: "prod", key: "*" },
          when: ['platform == "ci-oidc"', "totally !~ unknown"],
        },
      ],
    });
    expect(doc.rules).toHaveLength(1);
    const onCi = evaluateSecretPolicy([doc], "K", facts({ env: "prod", platform: "ci-oidc" }));
    expect(onCi.allow).toBe(false);
    expect(onCi.reason).toBe("no-matching-grant");
  });
});

describe("glob key matching", () => {
  it("STRIPE_* matches STRIPE_KEY but not DATABASE_URL", () => {
    const docs: SecretPolicyDocument[] = [
      { tier: "stack", rules: [{ id: "r", effect: "allow", subjects: ["*authenticated"], scope: { env: "prod", key: "STRIPE_*" } }] },
    ];
    expect(evaluateSecretPolicy(docs, "STRIPE_KEY", facts({ env: "prod" })).allow).toBe(true);
    // DATABASE_URL: prod is protected (concrete rule), no allow matches ⇒ deny.
    expect(evaluateSecretPolicy(docs, "DATABASE_URL", facts({ env: "prod" })).allow).toBe(false);
  });
});
