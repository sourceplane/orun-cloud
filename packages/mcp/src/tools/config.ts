import type {
  CreateFeatureFlagRequest,
  PublicFeatureFlag,
  PublicSecretMetadata,
  PublicSetting,
  UpdateFeatureFlagRequest,
} from "@saas/contracts/config";
import { z } from "zod";

import { ToolInputError } from "../errors.js";
import { idempotencyKeyArg, resolveIdempotencyKey } from "../idempotency.js";
import { compact, configScopeFromInput, projectArg, scopedShape } from "../scope.js";
import { defineTool } from "../tool.js";

const configScopeShape = {
  ...scopedShape,
  project: projectArg
    .describe("Project scope (`prj_…`). Omit for organization scope.")
    .optional(),
  environment: z
    .string()
    .min(1)
    .describe("Environment scope (public id or slug); requires `project`.")
    .optional(),
};

export const configReadTool = defineTool({
  name: "config_read",
  title: "Read settings and feature flags",
  description:
    "Read the settings and feature flags at one config scope — organization (default), project, or project+environment. Never returns secret values; for secret metadata use `secrets_list`.",
  inputSchema: z.object(configScopeShape),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const scope = configScopeFromInput(input);
    const [settings, flags] = await Promise.all([
      ctx.sdk.config.listSettings(scope),
      ctx.sdk.config.listFeatureFlags(scope),
    ]);
    const data = {
      scope: scope.kind,
      settings: settings.settings,
      featureFlags: flags.featureFlags,
    } satisfies {
      scope: string;
      settings: PublicSetting[];
      featureFlags: PublicFeatureFlag[];
    };
    return {
      summary: `${settings.settings.length} setting(s), ${flags.featureFlags.length} feature flag(s) at ${scope.kind} scope`,
      data,
    };
  },
});

export const secretsListTool = defineTool({
  name: "secrets_list",
  title: "List secret metadata",
  description:
    "List secret METADATA (keys, versions, rotation state) at one config scope. Secret values are write-only platform-wide: no tool, flag, or argument can return one. Use `config_read` for settings/flags.",
  inputSchema: z.object(configScopeShape),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    const res = await ctx.sdk.config.listSecretMetadata(configScopeFromInput(input));
    // Defense-in-depth for the no-secret-values invariant (design §7): the
    // contract row is metadata-only, but fail loudly if anything value-shaped
    // ever appears rather than passing it to an agent.
    for (const secret of res.secrets) {
      if ("value" in secret || "ciphertext" in secret || "plaintext" in secret) {
        throw new Error(
          "secret metadata row unexpectedly carried value material; refusing to return it",
        );
      }
    }
    const data = { secrets: res.secrets } satisfies {
      secrets: PublicSecretMetadata[];
    };
    return {
      summary: `${res.secrets.length} secret(s) — metadata only, values are never readable`,
      data,
    };
  },
});

// ---------------------------------------------------------------------------
// Write tool (MCP5, design §4/§7). Same public feature-flag mutations as the
// console/CLI — policy-gated, audited, idempotency-keyed. There is no secret
// write here by design: the MCP plane never touches secret values.
// ---------------------------------------------------------------------------

export const flagSetTool = defineTool({
  name: "flag_set",
  title: "Set feature flag",
  description:
    "Set a feature flag at one config scope — organization (default), project, or project+environment: updates `enabled` and/or `value` for `flagKey`, creating the flag at that scope when it does not exist yet. This is a WRITE: policy-gated (builder-or-higher role) and audited like any console/CLI mutation; retries are replay-safe (an Idempotency-Key is generated per call unless you supply `idempotencyKey`). To read flags use `config_read`.",
  inputSchema: z.object({
    ...configScopeShape,
    flagKey: z.string().min(1).describe("Flag key to set, e.g. `checkout.new_flow`."),
    enabled: z
      .boolean()
      .describe("Turn the flag on or off. At least one of `enabled`/`value` is required.")
      .optional(),
    value: z
      .unknown()
      .describe("Optional JSON payload served with the flag (any JSON value).")
      .optional(),
    idempotencyKey: idempotencyKeyArg.optional(),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  handler: async (input, ctx) => {
    if (input.enabled === undefined && input.value === undefined) {
      throw new ToolInputError("set at least one of `enabled` or `value`");
    }
    const scope = configScopeFromInput(input);
    const idempotencyKey = resolveIdempotencyKey(input.idempotencyKey);
    // Set semantics over the SDK's create/update pair: the scope's flag list
    // is scope-exact, so a `flagKey` match means update-in-place.
    const listed = await ctx.sdk.config.listFeatureFlags(scope);
    const existing = listed.featureFlags.find((f) => f.flagKey === input.flagKey);
    if (existing !== undefined) {
      const body = compact<UpdateFeatureFlagRequest>({
        enabled: input.enabled,
        value: input.value,
      });
      const res = await ctx.sdk.config.updateFeatureFlag(scope, existing.id, body, {
        idempotencyKey,
      });
      const data = { featureFlag: res.featureFlag, action: "updated" } satisfies {
        featureFlag: PublicFeatureFlag;
        action: string;
      };
      return {
        summary: `updated flag ${res.featureFlag.flagKey} at ${scope.kind} scope (enabled: ${res.featureFlag.enabled})`,
        data,
      };
    }
    const body = compact<CreateFeatureFlagRequest>({
      flagKey: input.flagKey,
      enabled: input.enabled,
      value: input.value,
    });
    const res = await ctx.sdk.config.createFeatureFlag(scope, body, { idempotencyKey });
    const data = { featureFlag: res.featureFlag, action: "created" } satisfies {
      featureFlag: PublicFeatureFlag;
      action: string;
    };
    return {
      summary: `created flag ${res.featureFlag.flagKey} at ${scope.kind} scope (enabled: ${res.featureFlag.enabled})`,
      data,
    };
  },
});
