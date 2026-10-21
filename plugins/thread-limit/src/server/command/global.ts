import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import { MAX_LIMIT_VALUE } from "../../shared/limits.ts";
import { parseLimitArgument } from "../lib/cli-format.ts";
import type { Limiter } from "../lib/limiter.ts";

export const global = defineCommand({
  summary: "Show or set the overall limit",
  positionals: [
    {
      name: "limit",
      description: `unlimited, or a whole number from 0 to ${MAX_LIMIT_VALUE} (0 holds every new turn); omit it to print the current limit`,
    },
  ],
  options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
  async execute(ctx: CommandContext<Context<{ limiter: Limiter }>>, { positionals, options }) {
    const requested = positionals.limit;
    if (requested !== undefined) {
      await ctx.limiter.save({
        ...ctx.limiter.configuration(),
        globalLimit: parseLimitArgument(requested, "unlimited"),
      });
    }
    const { globalLimit } = ctx.limiter.configuration();
    return {
      exitCode: 0,
      stdout: options.json
        ? JSON.stringify({ globalLimit })
        : globalLimit === null
          ? "Unlimited"
          : String(globalLimit),
    };
  },
});
