import type {
  PublicFeatureFlag,
  PublicSecretMetadata,
  PublicSetting,
} from "@saas/contracts/config";
import { z } from "zod";

import { configScopeFromInput, projectArg, scopedShape } from "../scope.js";
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
  annotations: { readOnlyHint: true, idempotentHint: true },
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
  annotations: { readOnlyHint: true, idempotentHint: true },
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
